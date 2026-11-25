import { refreshTokens, type StaffRole } from '#src/auth/auth.repo.ts';
import { forgetUser } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { claimKindFile, viewUrl } from '#src/features/files/files.service.ts';
import { hqOid, tellStaff } from '#src/features/notifications/inbox.service.ts';
import { memberContact, notify } from '#src/features/notifications/notifications.service.ts';
import { addDays, daysBetween, dhakaNow, shortDate } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import type { IncidentCreate, IncidentQuery, IncidentUpdate, SanctionCreate } from './discipline.schema.ts';
import {
    allowedLevels,
    appealDeadline,
    banScopes,
    type GiverRole,
    type Level,
    LEVEL_LABEL,
    MAX_SUSPENSION_DAYS,
    MAX_SUSPENSION_LEAD_DAYS,
    mayDecideAppeal,
    mayLift,
    strikes,
    suggestLevel
} from './ladder.ts';

/**
 * Discipline: incidents about members and staff, the sanctions given on them, appeals.
 *
 * - An incident is written at the branch where it happened (HQ names the branch). A member's home branch reads it
 *   too; a case about a branch manager is HQ's only and hidden from the branch; nobody sees a case about themselves
 *   in the case lists (they see their sanctions in their own record).
 * - A sanction's effects are worked out when read: a member suspension in force blocks every branch's
 *   check-in, a ban the branches it covers (`member_access_facts`), and the member's status shows it. Writing them
 *   does two things at once: a ban covering the member's home branch cancels their membership (no refund on its
 *   own), and staff sanctions act on the account (a suspension ends its sessions, a ban deactivates it).
 * - The person sees their sanctions with the reason and the clause, never the notes, witnesses or evidence, and may
 *   appeal for 7 days; someone else decides (HQ for a ban). An upheld appeal overturns the sanction.
 */
export interface DisciplineDeps {
    db: Db;
    cache: AppDeps['cache'];
    jwtSecret: string;
    apiPrefix: string;
    /** "Now" for the messages' time. */
    clock?: () => Date;
}

/** Who is acting, and as what on the ladder. */
export interface Caller {
    userOid: string;
    role: StaffRole;
    giver: GiverRole;
}

type SanctionState = 'recorded' | 'upcoming' | 'in_force' | 'ended' | 'lifted' | 'overturned';

interface IncidentRow {
    oid: string;
    branch_oid: string;
    branch_name: string;
    subject_kind: 'member' | 'staff';
    member_oid: string | null;
    member_branch_oid: string | null;
    staff_oid: string | null;
    subject_name: string;
    subject_code: string;
    subject_role: string | null;
    occurred_at: Date;
    category: string;
    summary: string;
    description: string;
    clause_oid: string | null;
    clause_label: string | null;
    witnesses: string | null;
    internal_notes: string | null;
    evidence_file_oids: string[];
    hq_only: boolean;
    reported_by: string | null;
    reported_by_name: string | null;
    reported_role: string | null;
    closed_at: Date | null;
    created_at: Date;
}

interface SanctionRow {
    oid: string;
    branch_oid: string;
    branch_name: string;
    incident_oid: string;
    subject_kind: 'member' | 'staff';
    member_oid: string | null;
    member_branch_oid: string | null;
    staff_oid: string | null;
    level: Level;
    starts_on: string;
    ends_on: string | null;
    scope: 'branch' | 'all' | null;
    reason: string;
    suggested_level: Level;
    choice_reason: string | null;
    given_by: string | null;
    given_by_name: string;
    given_role: GiverRole;
    given_on: string;
    membership_cancelled: boolean;
    lifted_at: Date | null;
    lifted_by_name: string | null;
    lift_reason: string | null;
    overturned_at: Date | null;
    created_at: Date;
    hq_only: boolean;
    clause_label: string | null;
    appeal_oid: string | null;
    appeal_body: string | null;
    appeal_status: 'open' | 'upheld' | 'rejected' | null;
    appeal_filed_at: Date | null;
    appeal_filed_by_name: string | null;
    appeal_decided_by_name: string | null;
    appeal_decision_note: string | null;
    appeal_decided_at: Date | null;
}

const INCIDENT = sql.raw(`i.oid, i.branch_oid, b.name as branch_name, i.subject_kind, i.member_oid, i.member_branch_oid, i.staff_oid,
    i.subject_name, i.subject_code, i.subject_role, i.occurred_at, i.category, i.summary, i.description, i.clause_oid, i.clause_label,
    i.witnesses, i.internal_notes, i.evidence_file_oids, i.hq_only, i.reported_by, i.reported_by_name, i.reported_role, i.closed_at, i.created_at
    from incident i join branch b on b.oid = i.branch_oid`);

const SANCTION = sql.raw(`x.oid, x.branch_oid, b.name as branch_name, x.incident_oid, x.subject_kind, x.member_oid, x.member_branch_oid, x.staff_oid,
    x.level, x.starts_on::text as starts_on, x.ends_on::text as ends_on, x.scope, x.reason, x.suggested_level, x.choice_reason,
    x.given_by, x.given_by_name, x.given_role, x.given_on::text as given_on,
    x.membership_cancelled, x.lifted_at, x.lifted_by_name, x.lift_reason, x.overturned_at, x.created_at, i.hq_only, i.clause_label,
    a.oid as appeal_oid, a.body as appeal_body, a.status as appeal_status, a.filed_at as appeal_filed_at, a.filed_by_name as appeal_filed_by_name,
    a.decided_by_name as appeal_decided_by_name, a.decision_note as appeal_decision_note, a.decided_at as appeal_decided_at
    from sanction x join incident i on i.oid = x.incident_oid join branch b on b.oid = x.branch_oid left join appeal a on a.sanction_oid = x.oid`);

export function sanctionState(s: Pick<SanctionRow, 'level' | 'starts_on' | 'ends_on' | 'lifted_at' | 'overturned_at'>, today: string): SanctionState {
    if (s.overturned_at) return 'overturned';
    if (s.level === 'ban') return s.lifted_at ? 'lifted' : 'in_force';
    if (s.level === 'suspension') return today < s.starts_on ? 'upcoming' : s.ends_on !== null && today > s.ends_on ? 'ended' : 'in_force';
    return 'recorded';
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** The list filter for a caller: HQ sees every case in context; a branch never sees HQ-only cases; nobody their own. */
function visible(ctx: BranchContext, caller: Caller) {
    const hq = caller.giver === 'hq';
    return sql`(${hq} or ((i.branch_oid = ${ctx.branchOid} or i.member_branch_oid = ${ctx.branchOid}) and not i.hq_only))
        and i.staff_oid is distinct from ${caller.userOid}::uuid`;
}

async function sanctionsOf(tx: Queryable, incidentOids: string[]): Promise<SanctionRow[]> {
    if (!incidentOids.length) return [];
    return tx.query<SanctionRow>(sql`select ${SANCTION} where x.incident_oid = any (${incidentOids}::uuid[]) order by x.created_at`);
}

function appealWire(s: SanctionRow, caller: Caller | null) {
    if (!s.appeal_oid) return null;
    return {
        oid: s.appeal_oid,
        body: s.appeal_body ?? '',
        status: s.appeal_status ?? 'open',
        filed_at: iso(s.appeal_filed_at),
        filed_by_name: s.appeal_filed_by_name,
        decided_by_name: s.appeal_decided_by_name,
        decision_note: s.appeal_decision_note,
        decided_at: iso(s.appeal_decided_at),
        can_decide: caller !== null && s.appeal_status === 'open' && mayDecideAppeal(caller.giver, s, caller.userOid)
    };
}

function sanctionWire(s: SanctionRow, today: string, caller: Caller | null) {
    const state = sanctionState(s, today);
    return {
        oid: s.oid,
        incident_oid: s.incident_oid,
        level: s.level,
        state,
        starts_on: s.starts_on,
        ends_on: s.ends_on,
        scope: s.scope,
        reason: s.reason,
        suggested_level: s.suggested_level,
        choice_reason: s.choice_reason,
        given_by_name: s.given_by_name,
        given_role: s.given_role,
        given_on: s.given_on,
        branch_name: s.branch_name,
        membership_cancelled: s.membership_cancelled,
        lifted: s.lifted_at ? { at: iso(s.lifted_at), by: s.lifted_by_name, reason: s.lift_reason } : null,
        overturned_at: iso(s.overturned_at),
        appeal: appealWire(s, caller),
        appeal_deadline: appealDeadline(s.given_on),
        can_lift: caller !== null && state === 'in_force' && mayLift(caller.giver, s)
    };
}

function listItem(i: IncidentRow, sanctions: SanctionRow[], today: string) {
    const mine = sanctions.filter(s => s.incident_oid === i.oid);
    const latest = mine.at(-1);
    return {
        oid: i.oid,
        branch: { oid: i.branch_oid, name: i.branch_name },
        subject: { kind: i.subject_kind, member_oid: i.member_oid, staff_oid: i.staff_oid, name: i.subject_name, code: i.subject_code, role: i.subject_role },
        occurred_at: i.occurred_at.toISOString(),
        category: i.category,
        summary: i.summary,
        clause_label: i.clause_label,
        hq_only: i.hq_only,
        reported_by_name: i.reported_by_name,
        reported_role: i.reported_role,
        closed: i.closed_at !== null,
        latest: latest ? { level: latest.level, state: sanctionState(latest, today) } : null,
        steps: mine.length,
        open_appeal: mine.some(s => s.appeal_status === 'open'),
        created_at: i.created_at.toISOString()
    };
}

/** `GET /v1/incidents`: the cases the caller may see, newest first. */
export async function listIncidents(deps: DisciplineDeps, ctx: BranchContext, caller: Caller, q: IncidentQuery, today: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const like = q.q ? `%${q.q.toLowerCase()}%` : null;
        const rows = await tx.query<IncidentRow>(sql`
            select ${INCIDENT}
            where ${visible(ctx, caller)}
              and (${q.status ?? ''} = '' or (${q.status ?? ''} = 'open') = (i.closed_at is null))
              and (${q.kind ?? ''} = '' or i.subject_kind = ${q.kind ?? ''})
              and (${like}::text is null or lower(i.subject_name) like ${like} or lower(i.subject_code) like ${like} or lower(i.summary) like ${like})
              and (${q.appeal ?? ''} = '' or exists (select from sanction x join appeal a on a.sanction_oid = x.oid where x.incident_oid = i.oid and a.status = 'open'))
            order by i.occurred_at desc
            limit 200`);
        const sanctions = await sanctionsOf(
            tx,
            rows.map(r => r.oid)
        );
        return rows.map(r => listItem(r, sanctions, today));
    });
}

interface StrikeInfo {
    level: Level;
    starts_on: string;
    overturned: boolean;
    branch_name: string;
}

async function strikesFor(tx: Queryable, subject: { member_oid: string | null; staff_oid: string | null }, today: string) {
    const [row] = await tx.query<{ rows: StrikeInfo[] | null }>(
        sql`select discipline_strikes(${subject.member_oid}::uuid, ${subject.staff_oid}::uuid) as rows`
    );
    const list = strikes(row?.rows ?? [], today);
    return { list, suggestion: suggestLevel(list.length) };
}

async function incidentIn(tx: Queryable, ctx: BranchContext, caller: Caller, oid: string): Promise<IncidentRow> {
    const [row] = await tx.query<IncidentRow>(sql`select ${INCIDENT} where i.oid = ${oid} and ${visible(ctx, caller)}`);
    if (!row) throw new AppError(404, 'Case not found');
    return row;
}

async function detailIn(deps: DisciplineDeps, tx: Queryable, ctx: BranchContext, caller: Caller, oid: string, today: string) {
    const i = await incidentIn(tx, ctx, caller, oid);
    const sanctions = await sanctionsOf(tx, [i.oid]);
    const { list, suggestion } = await strikesFor(tx, i, today);
    const files = i.evidence_file_oids.length
        ? await tx.query<{ oid: string; name: string; content_type: string; branch_oid: string }>(sql`
              select oid, name, content_type, branch_oid from file where oid = any (${i.evidence_file_oids}::uuid[]) and status = 'ready'`)
        : [];
    const about = { hq_only: i.hq_only, about_caller: i.staff_oid === caller.userOid };
    const open = i.closed_at === null;
    return {
        ...listItem(i, sanctions, today),
        description: i.description,
        witnesses: i.witnesses,
        internal_notes: i.internal_notes,
        evidence: await Promise.all(files.map(async f => ({ oid: f.oid, name: f.name, content_type: f.content_type, url: await viewUrl(deps, f) }))),
        sanctions: sanctions.map(s => sanctionWire(s, today, caller)),
        strikes: list.map(s => ({ level: s.level, starts_on: s.starts_on, branch_name: s.branch_name })),
        suggestion,
        actions: {
            levels: open ? allowedLevels(caller.giver, about) : [],
            ban_scopes: open ? banScopes(caller.giver) : [],
            can_edit: caller.giver === 'hq' || (caller.giver === 'manager' && !i.hq_only)
        }
    };
}

/** `GET /v1/incidents/:oid`: the case, its steps and appeals, the strikes and the suggested step, what the caller may do. */
export async function getIncident(deps: DisciplineDeps, ctx: BranchContext, caller: Caller, oid: string, today: string) {
    return withBranchTx(deps.db, ctx, tx => detailIn(deps, tx, ctx, caller, oid, today));
}

/** Staff of a branch a case may be about: not HQ staff, not the caller. */
export async function staffSubjects(deps: DisciplineDeps, ctx: BranchContext, caller: Caller, branchOid: string) {
    return withBranchTx(deps.db, ctx, tx =>
        tx.query<{ oid: string; name: string; username: string; role: StaffRole }>(sql`
            select u.oid, u.name, u.username, a.role_code as role
            from staff_assignment a join app_user u on u.oid = a.user_oid
            where a.branch_oid = ${branchOid} and u.kind = 'staff' and u.oid <> ${caller.userOid}
              and a.role_code in ('BRANCH_MANAGER', 'FRONT_DESK', 'TRAINER')
            order by u.name`)
    );
}

const ROLE_LABEL: Record<string, string> = { BRANCH_MANAGER: 'Branch manager', FRONT_DESK: 'Front desk', TRAINER: 'Trainer' };

/** `POST /v1/incidents` (`create Incident`): recorded at the branch where it happened. */
export async function createIncident(deps: DisciplineDeps, ctx: BranchContext, caller: Caller, input: IncidentCreate, now: Date) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [here] = await tx.query<{ kind: string }>(sql`select kind from branch where oid = ${ctx.branchOid}`);
        const branchOid = here?.kind === 'HQ' ? input.branch_oid : ctx.branchOid;
        if (!branchOid || !ctx.branchOids.includes(branchOid))
            throw new AppError(400, 'Choose the branch where it happened', [{ path: 'branch_oid', message: 'Required at HQ' }]);
        const [branch] = await tx.query<{ kind: string }>(sql`select kind from branch where oid = ${branchOid}`);
        if (branch?.kind !== 'BRANCH') throw new AppError(400, 'Choose the branch where it happened', [{ path: 'branch_oid', message: 'A branch' }]);
        if (new Date(input.occurred_at) > new Date(now.getTime() + 5 * 60_000))
            throw new AppError(400, 'An incident cannot be in the future', [{ path: 'occurred_at', message: 'In the future' }]);
        if (daysBetween(dhakaNow(new Date(input.occurred_at)).date, dhakaNow(now).date) > 30)
            throw new AppError(400, 'Record an incident within 30 days', [{ path: 'occurred_at', message: 'At most 30 days back' }]);

        let subject: { member_oid: string | null; member_branch_oid: string | null; staff_oid: string | null; name: string; code: string; role: string | null };
        let hqOnly = false;
        if (input.subject_kind === 'member') {
            const [f] = await tx.query<{ facts: { oid: string; name: string; code: string; branch_oid: string } | null }>(
                sql`select member_access_facts(${input.member_code ?? ''}) as facts`
            );
            if (!f?.facts) throw new AppError(404, 'No member with this code', [{ path: 'member_code', message: 'Unknown code' }]);
            subject = { member_oid: f.facts.oid, member_branch_oid: f.facts.branch_oid, staff_oid: null, name: f.facts.name, code: f.facts.code, role: null };
        } else {
            if (input.staff_oid === caller.userOid) throw new AppError(400, 'Someone else records a case about you');
            const [s] = await tx.query<{ oid: string; name: string; username: string; role: string }>(sql`
                select u.oid, u.name, u.username, a.role_code as role from staff_assignment a join app_user u on u.oid = a.user_oid
                where a.user_oid = ${input.staff_oid ?? null} and a.branch_oid = ${branchOid} and u.kind = 'staff'`);
            if (!s || !ROLE_LABEL[s.role]) throw new AppError(404, 'No such staff member at this branch', [{ path: 'staff_oid', message: 'Not here' }]);
            subject = { member_oid: null, member_branch_oid: null, staff_oid: s.oid, name: s.name, code: s.username, role: s.role };
            hqOnly = s.role === 'BRANCH_MANAGER';
        }

        let clauseLabel: string | null = null;
        if (input.clause_oid) {
            const [c] = await tx.query<{ label: string }>(sql`
                select p.title || ' v' || v.version || ' §' || c.number || ': ' || c.heading as label
                from policy_clause c join policy_version v on v.oid = c.version_oid join policy p on p.oid = v.policy_oid where c.oid = ${input.clause_oid}`);
            if (!c) throw new AppError(400, 'Unknown clause', [{ path: 'clause_oid', message: 'Unknown clause' }]);
            clauseLabel = c.label;
        }
        const evidence = input.evidence_file_oids ?? [];
        for (const f of evidence) await claimKindFile(tx, ctx.branchOid, f, 'incident_evidence');

        const [row] = await tx.query<{ oid: string }>(sql`
            insert into incident (branch_oid, subject_kind, member_oid, member_branch_oid, staff_oid, subject_name, subject_code, subject_role,
                occurred_at, category, summary, description, clause_oid, clause_label, witnesses, internal_notes, evidence_file_oids, hq_only,
                reported_by, reported_by_name, reported_role)
            values (${branchOid}, ${input.subject_kind}, ${subject.member_oid}, ${subject.member_branch_oid}, ${subject.staff_oid}, ${subject.name},
                ${subject.code}, ${subject.role}, ${input.occurred_at}, ${input.category}, ${input.summary}, ${input.description}, ${input.clause_oid ?? null},
                ${clauseLabel}, ${input.witnesses ?? null}, ${input.internal_notes ?? null}, ${evidence}::uuid[], ${hqOnly}, ${caller.userOid},
                ${ctx.actor?.name ?? null}, ${caller.giver})
            returning oid`);
        if (!row) throw new Error('incident insert returned nothing');
        await recordAudit(tx, ctx, {
            action: 'create',
            entity: 'incident',
            entityKey: subject.code,
            before: null,
            after: { oid: row.oid, subject_kind: input.subject_kind, category: input.category, summary: input.summary, clause: clauseLabel, hq_only: hqOnly }
        });
        // The reporter of a case about their branch manager cannot open it afterwards (HQ's): answer with the list item.
        const reporterSees = caller.giver === 'hq' || !hqOnly;
        if (!reporterSees) return { oid: row.oid, hq_only: true, sent_to_hq: true };
        return detailIn(deps, tx, ctx, caller, row.oid, dhakaNow(now).date);
    });
}

/** `PATCH /v1/incidents/:oid` (`manage Incident`): notes, witnesses, evidence; close or reopen the case. */
export async function updateIncident(deps: DisciplineDeps, ctx: BranchContext, caller: Caller, oid: string, input: IncidentUpdate, today: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await incidentIn(tx, ctx, caller, oid);
        if (!(caller.giver === 'hq' || (caller.giver === 'manager' && !before.hq_only))) throw new AppError(403, 'HQ handles this case');
        if (input.evidence_file_oids) {
            for (const f of input.evidence_file_oids.filter(x => !before.evidence_file_oids.includes(x)))
                await claimKindFile(tx, before.branch_oid, f, 'incident_evidence');
        }
        await tx.query(sql`
            update incident set
                witnesses = case when ${input.witnesses !== undefined} then ${input.witnesses ?? null}::text else witnesses end,
                internal_notes = case when ${input.internal_notes !== undefined} then ${input.internal_notes ?? null}::text else internal_notes end,
                evidence_file_oids = coalesce(${input.evidence_file_oids ?? null}::uuid[], evidence_file_oids),
                closed_at = case when ${input.closed ?? null}::boolean is null then closed_at when ${input.closed ?? false} then coalesce(closed_at, now()) else null end,
                updated_at = now()
            where oid = ${oid}`);
        const after = await incidentIn(tx, ctx, caller, oid);
        const view = (r: IncidentRow) => ({
            evidence: r.evidence_file_oids.length,
            witnesses: r.witnesses !== null,
            notes: r.internal_notes !== null,
            closed: r.closed_at !== null
        });
        await recordAudit(tx, ctx, { action: 'update', entity: 'incident', entityKey: before.subject_code, before: view(before), after: view(after) });
        return detailIn(deps, tx, ctx, caller, oid, today);
    });
}

async function cancelMemberships(tx: Queryable, ctx: BranchContext, memberOid: string, code: string, today: string, reason: string, actor: string | null) {
    const subs = await tx.query<{ oid: string; start_date: string; end_date: string }>(sql`
        select oid, start_date::text as start_date, end_date::text as end_date from subscription
        where member_oid = ${memberOid} and kind = 'membership' and cancelled_at is null and end_date >= ${today}::date`);
    for (const s of subs) {
        const end = s.start_date > today ? addDays(s.start_date, -1) : addDays(today, -1);
        await tx.query(sql`
            update subscription set end_date = ${end}, cancelled_at = now(), cancel_reason = ${reason}, cancelled_by = ${actor}
            where oid = ${s.oid}`);
        await recordAudit(tx, ctx, {
            action: 'cancel',
            entity: 'subscription',
            entityKey: code,
            before: { oid: s.oid, end_date: s.end_date },
            after: { oid: s.oid, end_date: end, reason }
        });
    }
    return subs.length > 0;
}

/** `POST /v1/incidents/:oid/sanctions`: the next step on the case, with its effects. */
export async function giveSanction(deps: DisciplineDeps, ctx: BranchContext, caller: Caller, oid: string, input: SanctionCreate, today: string) {
    const out = await withBranchTx(deps.db, ctx, async tx => {
        const i = await incidentIn(tx, ctx, caller, oid);
        if (i.closed_at) throw new AppError(409, 'This case is closed. Reopen it first.');
        const levels = allowedLevels(caller.giver, { hq_only: i.hq_only, about_caller: i.staff_oid === caller.userOid });
        if (!levels.includes(input.level)) {
            throw new AppError(
                403,
                i.hq_only
                    ? 'HQ handles cases about a branch manager.'
                    : levels.length
                      ? `You can give a ${levels.map(l => LEVEL_LABEL[l].toLowerCase()).join(' or ')}. Ask a branch manager for more.`
                      : 'You cannot give a step on this case.'
            );
        }
        const { suggestion } = await strikesFor(tx, i, today);
        if (input.level !== suggestion && !input.choice_reason)
            throw new AppError(400, `The suggested step is a ${LEVEL_LABEL[suggestion].toLowerCase()}. Say why you chose another.`, [
                { path: 'choice_reason', message: 'Required when not the suggested step' }
            ]);

        let startsOn = today;
        let endsOn: string | null = null;
        let scope: 'branch' | 'all' | null = null;
        if (input.level === 'suspension') {
            startsOn = input.starts_on ?? today;
            endsOn = input.ends_on ?? null;
            if (!endsOn) throw new AppError(400, 'A suspension needs an end date', [{ path: 'ends_on', message: 'Required' }]);
            if (startsOn < today || daysBetween(today, startsOn) > MAX_SUSPENSION_LEAD_DAYS)
                throw new AppError(400, `Start a suspension today or within ${MAX_SUSPENSION_LEAD_DAYS} days`, [
                    { path: 'starts_on', message: 'Out of range' }
                ]);
            if (endsOn < startsOn || daysBetween(startsOn, endsOn) + 1 > MAX_SUSPENSION_DAYS)
                throw new AppError(400, `A suspension lasts 1 to ${MAX_SUSPENSION_DAYS} days`, [{ path: 'ends_on', message: 'Out of range' }]);
        }
        if (input.level === 'ban') {
            scope = input.scope ?? 'branch';
            if (!banScopes(caller.giver).includes(scope)) throw new AppError(403, 'Only HQ bans at every branch.');
            const [already] = await tx.query(sql`
                select 1 from sanction where incident_oid in (select oid from incident where ${i.member_oid}::uuid is not null and member_oid = ${i.member_oid}::uuid
                        or ${i.staff_oid}::uuid is not null and staff_oid = ${i.staff_oid}::uuid)
                  and level = 'ban' and lifted_at is null and overturned_at is null and (scope = 'all' or branch_oid = ${i.branch_oid})`);
            if (already) throw new AppError(409, `${i.subject_name} is already banned here.`);
        }

        let cancelled = false;
        if (input.level === 'ban' && i.member_oid && (scope === 'all' || i.branch_oid === i.member_branch_oid)) {
            cancelled = await cancelMemberships(tx, ctx, i.member_oid, i.subject_code, today, `Banned: ${input.reason}`, ctx.actor?.oid ?? null);
        }
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into sanction (branch_oid, incident_oid, subject_kind, member_oid, member_branch_oid, staff_oid, level, starts_on, ends_on, scope,
                reason, suggested_level, choice_reason, given_by, given_by_name, given_role, given_on, membership_cancelled)
            values (${i.branch_oid}, ${i.oid}, ${i.subject_kind}, ${i.member_oid}, ${i.member_branch_oid}, ${i.staff_oid}, ${input.level}, ${startsOn},
                ${endsOn}, ${scope}, ${input.reason}, ${suggestion}, ${input.level === suggestion ? null : (input.choice_reason ?? null)}, ${caller.userOid},
                ${ctx.actor?.name ?? ''}, ${caller.giver}, ${today}, ${cancelled})
            returning oid`);
        if (!row) throw new Error('sanction insert returned nothing');

        // Staff: the account. A suspension in force ends every session now; a ban deactivates the account.
        if (i.staff_oid && input.level === 'ban') {
            await tx.query(sql`update app_user set status = 'Inactive', updated_at = now() where oid = ${i.staff_oid}`);
            await refreshTokens.revokeAll(tx, i.staff_oid);
        }
        if (i.staff_oid && input.level === 'suspension' && startsOn <= today) await refreshTokens.revokeAll(tx, i.staff_oid);

        // The member hears of it in the portal, with the time they have to appeal.
        const member = i.member_oid ? await memberContact(tx, i.member_oid) : null;
        if (member) {
            const what =
                input.level === 'suspension' && endsOn
                    ? `a suspension from ${shortDate(startsOn)} to ${shortDate(endsOn)}`
                    : input.level === 'ban'
                      ? `a ban ${scope === 'all' ? 'from every branch' : `from ${i.branch_name}`}${cancelled ? '; your membership there is cancelled' : ''}`
                      : `a ${LEVEL_LABEL[input.level].toLowerCase()}`;
            await notify(tx, {
                branch_oid: i.branch_oid,
                member,
                kind: 'sanction',
                subject: `${LEVEL_LABEL[input.level]} at ${i.branch_name}`,
                body: `Dear ${member.name}, you were given ${what}. Reason: ${input.reason.replace(/[.!?]\s*$/, '')}. You can appeal under My record in the portal by ${shortDate(appealDeadline(today))}.`,
                related_oid: row.oid,
                dedupe_key: `sanction:${row.oid}`,
                at: deps.clock?.()
            });
        }

        await recordAudit(tx, ctx, {
            action: 'sanction',
            entity: 'sanction',
            entityKey: i.subject_code,
            before: null,
            after: {
                oid: row.oid,
                incident: i.oid,
                level: input.level,
                suggested: suggestion,
                starts_on: startsOn,
                ends_on: endsOn,
                scope,
                reason: input.reason,
                membership_cancelled: cancelled
            }
        });
        return { staffOid: i.staff_oid, detail: await detailIn(deps, tx, ctx, caller, oid, today) };
    });
    if (out.staffOid) await forgetUser(deps.cache, { oid: out.staffOid });
    return out.detail;
}

async function sanctionIn(tx: Queryable, ctx: BranchContext, caller: Caller, oid: string) {
    const [s] = await tx.query<SanctionRow>(sql`select ${SANCTION} where x.oid = ${oid} and ${visible(ctx, caller)}`);
    if (!s) throw new AppError(404, 'Not found');
    return s;
}

/** `POST /v1/sanctions/:oid/lift` (`manage Incident`): a ban ends, with a reason. A cancelled plan stays cancelled. */
export async function liftBan(deps: DisciplineDeps, ctx: BranchContext, caller: Caller, oid: string, reason: string, today: string) {
    const out = await withBranchTx(deps.db, ctx, async tx => {
        const s = await sanctionIn(tx, ctx, caller, oid);
        if (sanctionState(s, today) !== 'in_force' || s.level !== 'ban') throw new AppError(409, 'Only a ban in force can be lifted.');
        if (!mayLift(caller.giver, s)) throw new AppError(403, 'HQ lifts this ban.');
        await tx.query(sql`update sanction set lifted_at = now(), lifted_by_name = ${ctx.actor?.name ?? null}, lift_reason = ${reason} where oid = ${oid}`);
        if (s.staff_oid) await tx.query(sql`update app_user set status = 'Active', updated_at = now() where oid = ${s.staff_oid}`);
        const [code] = await tx.query<{ code: string }>(sql`select subject_code as code from incident where oid = ${s.incident_oid}`);
        await recordAudit(tx, ctx, {
            action: 'lift',
            entity: 'sanction',
            entityKey: code?.code ?? oid,
            before: { level: 'ban', scope: s.scope },
            after: { reason }
        });
        return { staffOid: s.staff_oid, detail: await detailIn(deps, tx, ctx, caller, s.incident_oid, today) };
    });
    if (out.staffOid) await forgetUser(deps.cache, { oid: out.staffOid });
    return out.detail;
}

/** `POST /v1/appeals/:oid/decide` (`manage Incident`): upheld overturns the sanction. */
export async function decideAppeal(
    deps: DisciplineDeps,
    ctx: BranchContext,
    caller: Caller,
    appealOid: string,
    input: { decision: 'upheld' | 'rejected'; note: string },
    today: string
) {
    const out = await withBranchTx(deps.db, ctx, async tx => {
        const [ref] = await tx.query<{ sanction_oid: string }>(sql`select sanction_oid from appeal where oid = ${appealOid}`);
        if (!ref) throw new AppError(404, 'Appeal not found');
        const s = await sanctionIn(tx, ctx, caller, ref.sanction_oid);
        if (s.appeal_status !== 'open') throw new AppError(409, 'This appeal is already decided.');
        if (!mayDecideAppeal(caller.giver, s, caller.userOid))
            throw new AppError(
                403,
                s.given_by === caller.userOid ? 'Someone other than you decides an appeal against your own step.' : 'HQ decides this appeal.'
            );
        await tx.query(sql`
            update appeal set status = ${input.decision}, decided_by = ${caller.userOid}, decided_by_name = ${ctx.actor?.name ?? null},
                decision_note = ${input.note}, decided_at = now()
            where oid = ${appealOid}`);
        if (input.decision === 'upheld') {
            await tx.query(sql`update sanction set overturned_at = now() where oid = ${s.oid}`);
            // An overturned staff ban gives the account back; a member's cancelled plan is not restored.
            if (s.staff_oid && s.level === 'ban' && !s.lifted_at)
                await tx.query(sql`update app_user set status = 'Active', updated_at = now() where oid = ${s.staff_oid}`);
        }
        const [code] = await tx.query<{ code: string }>(sql`select subject_code as code from incident where oid = ${s.incident_oid}`);
        const member = s.member_oid ? await memberContact(tx, s.member_oid) : null;
        if (member)
            await notify(tx, {
                branch_oid: s.branch_oid,
                member,
                kind: 'appeal_decided',
                subject: input.decision === 'upheld' ? 'Your appeal was upheld' : 'Your appeal was not upheld',
                body: `Dear ${member.name}, ${
                    input.decision === 'upheld'
                        ? `your appeal was upheld: the ${LEVEL_LABEL[s.level].toLowerCase()} no longer counts`
                        : `the ${LEVEL_LABEL[s.level].toLowerCase()} stands`
                }. ${input.note}`,
                related_oid: appealOid,
                dedupe_key: `appeal_decided:${appealOid}`,
                at: deps.clock?.()
            });
        await recordAudit(tx, ctx, {
            action: input.decision === 'upheld' ? 'uphold' : 'reject',
            entity: 'appeal',
            entityKey: code?.code ?? appealOid,
            before: { status: 'open', level: s.level },
            after: { status: input.decision, note: input.note }
        });
        return { staffOid: s.staff_oid, detail: await detailIn(deps, tx, ctx, caller, s.incident_oid, today) };
    });
    if (out.staffOid) await forgetUser(deps.cache, { oid: out.staffOid });
    return out.detail;
}

/* ---------- a member's record (staff view, at the home branch) ---------- */

/** `GET /v1/members/:oid/discipline`: the cases about the member the caller may see, their strikes and the next step. */
export async function memberRecord(deps: DisciplineDeps, ctx: BranchContext, caller: Caller, memberOid: string, today: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const rows = await tx.query<IncidentRow>(
            sql`select ${INCIDENT} where i.member_oid = ${memberOid} and ${visible(ctx, caller)} order by i.occurred_at desc`
        );
        const sanctions = await sanctionsOf(
            tx,
            rows.map(r => r.oid)
        );
        const { list, suggestion } = await strikesFor(tx, { member_oid: memberOid, staff_oid: null }, today);
        return {
            incidents: rows.map(r => listItem(r, sanctions, today)),
            sanctions: sanctions.map(s => sanctionWire(s, today, caller)).reverse(),
            strikes: list.length,
            suggestion
        };
    });
}

/* ---------- the person's own record: portal and "My record" ---------- */

/** What the person sees: the sanction, the clause and the reason; never notes, witnesses or evidence. */
function ownWire(s: SanctionRow, today: string) {
    const state = sanctionState(s, today);
    const deadline = appealDeadline(s.given_on);
    return {
        oid: s.oid,
        level: s.level,
        state,
        starts_on: s.starts_on,
        ends_on: s.ends_on,
        scope: s.scope,
        branch_name: s.branch_name,
        reason: s.reason,
        clause_label: s.clause_label,
        given_on: s.given_on,
        appeal: s.appeal_oid
            ? {
                  status: s.appeal_status ?? 'open',
                  body: s.appeal_body ?? '',
                  filed_at: iso(s.appeal_filed_at),
                  decision_note: s.appeal_decision_note,
                  decided_at: iso(s.appeal_decided_at)
              }
            : null,
        appeal_deadline: deadline,
        can_appeal: !s.appeal_oid && state !== 'overturned' && today <= deadline
    };
}

/** Every branch: a person's own sanctions can be anywhere they trained or worked. Filtered to them by the caller. */
async function everyBranch(db: Db, branchOid: string | null, actor: { oid: string; name: string }): Promise<BranchContext> {
    const rows = await db.query<{ oid: string; kind: string }>(sql`select oid, kind from branch order by kind = 'HQ' desc`);
    const all = rows.map(r => r.oid);
    return { branchOid: branchOid ?? all[0] ?? '', branchOids: all, actor, requestId: null };
}

export async function ownRecord(
    deps: DisciplineDeps,
    who: { member_oid: string | null; staff_oid: string | null },
    actor: { oid: string; name: string },
    today: string
) {
    const ctx = await everyBranch(deps.db, null, actor);
    return withBranchTx(deps.db, ctx, async tx => {
        const rows = await tx.query<SanctionRow>(sql`
            select ${SANCTION}
            where (${who.member_oid}::uuid is not null and x.member_oid = ${who.member_oid}::uuid) or (${who.staff_oid}::uuid is not null and x.staff_oid = ${who.staff_oid}::uuid)
            order by x.created_at desc`);
        return rows.map(s => ownWire(s, today));
    });
}

/** `POST /v1/me/record/:oid/appeal` and `POST /v1/my-record/:oid/appeal`: within 7 days, once. */
export async function fileAppeal(
    deps: DisciplineDeps,
    who: { member_oid: string | null; staff_oid: string | null },
    actor: { oid: string; name: string },
    sanctionOid: string,
    body: string,
    today: string
) {
    const probe = await everyBranch(deps.db, null, actor);
    const [found] = await withBranchTx(deps.db, probe, tx =>
        tx.query<SanctionRow>(sql`
            select ${SANCTION} where x.oid = ${sanctionOid}
              and ((${who.member_oid}::uuid is not null and x.member_oid = ${who.member_oid}::uuid) or (${who.staff_oid}::uuid is not null and x.staff_oid = ${who.staff_oid}::uuid))`)
    );
    if (!found) throw new AppError(404, 'Not found');
    const own = ownWire(found, today);
    if (found.appeal_oid) throw new AppError(409, 'You have already appealed this.');
    if (!own.can_appeal) throw new AppError(409, `Appeals are filed within 7 days, by ${shortDate(own.appeal_deadline)}.`);
    // Written at the branch that gave the sanction; the audit row too.
    const ctx = { ...probe, branchOid: found.branch_oid };
    return withBranchTx(deps.db, ctx, async tx => {
        await tx.query(sql`
            insert into appeal (branch_oid, member_branch_oid, sanction_oid, body, filed_by, filed_by_name)
            values (${found.branch_oid}, ${found.member_branch_oid}, ${sanctionOid}, ${body}, ${actor.oid}, ${actor.name})`);
        const [code] = await tx.query<{ code: string }>(sql`select subject_code as code from incident where oid = ${found.incident_oid}`);
        await recordAudit(tx, ctx, { action: 'appeal', entity: 'appeal', entityKey: code?.code ?? sanctionOid, before: null, after: { level: found.level } });
        // To whoever decides it: the branch's manager when the desk or a trainer gave it, else HQ.
        const atBranch = found.level !== 'ban' && !found.hq_only && (found.given_role === 'desk' || found.given_role === 'trainer');
        await tellStaff(tx, ctx, {
            to_branch_oid: atBranch ? found.branch_oid : await hqOid(tx),
            kind: 'appeal_filed',
            subject: `Appeal: ${LEVEL_LABEL[found.level]} for ${code?.code ?? 'a case'}`,
            body: `${actor.name} appealed the ${LEVEL_LABEL[found.level].toLowerCase()} given by ${found.given_by_name || 'staff'}. Decide it on the case.`,
            link: `incidents/${found.incident_oid}`,
            related_oid: sanctionOid,
            dedupe_key: `appeal_filed:${sanctionOid}`,
            at: deps.clock?.()
        });
        const rows = await tx.query<SanctionRow>(sql`select ${SANCTION} where x.oid = ${sanctionOid}`);
        const [row] = rows;
        if (!row) throw new Error('appeal: the sanction vanished');
        return ownWire(row, today);
    });
}
