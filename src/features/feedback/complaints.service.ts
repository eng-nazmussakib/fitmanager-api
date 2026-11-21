import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { claimKindFile, viewUrl } from '#src/features/files/files.service.ts';
import { membersRepo } from '#src/features/members/members.repo.ts';
import { AppError } from '#src/lib/http.ts';

import type { ComplaintCreate, ComplaintQuery, PortalComplaintCreate } from './feedback.schema.ts';

/**
 * Complaints (phase 5, D-095). Filed by a member in the portal or by the desk on someone's behalf, at the member's
 * home branch (the desk's branch for a visitor). Status `open → in_progress → resolved`, then `closed` when the
 * member accepts the resolution, or by itself 7 days after it with no reply (worked out when read, D-075).
 * A complaint with no staff reply after `complaint_response_hours` is overdue (when read); HQ sees every overdue one.
 * A manager escalates to HQ; the member escalates a resolution they are not happy with, within those 7 days.
 * A complaint naming a staff member is hidden from that person; one naming a branch manager goes to HQ only.
 */
export interface ComplaintDeps {
    db: Db;
    jwtSecret: string;
    apiPrefix: string;
}

/** A resolution closes by itself after this many days without a reply. */
export const AUTO_CLOSE_DAYS = 7;

type Status = 'open' | 'in_progress' | 'resolved' | 'closed';

interface ComplaintRow {
    oid: string;
    branch_oid: string;
    branch_name: string;
    code: string;
    member_oid: string | null;
    member_code: string | null;
    member_name: string;
    category: string;
    subject: string;
    body: string;
    photo_file_oid: string | null;
    named_staff_oid: string | null;
    named_staff_name: string | null;
    hq_only: boolean;
    filed_via: 'portal' | 'desk';
    status: Status;
    first_response_at: Date | null;
    resolution: string | null;
    resolved_at: Date | null;
    escalated_at: Date | null;
    escalated_by: 'manager' | 'member' | null;
    escalation_reason: string | null;
    member_accepted_at: Date | null;
    closed_at: Date | null;
    created_at: Date;
    response_hours: number;
}

const COMPLAINT = sql.raw(`c.oid, c.branch_oid, b.name as branch_name, c.code, c.member_oid, c.member_code, c.member_name, c.category, c.subject,
    c.body, c.photo_file_oid, c.named_staff_oid, c.named_staff_name, c.hq_only, c.filed_via, c.status, c.first_response_at, c.resolution,
    c.resolved_at, c.escalated_at, c.escalated_by, c.escalation_reason, c.member_accepted_at, c.closed_at, c.created_at,
    (select complaint_response_hours from org_settings) as response_hours
    from complaint c join branch b on b.oid = c.branch_oid`);

const DAY_MS = 86_400_000;

/** The status as read now: a resolution left 7 days without a reply is closed. */
export function effectiveStatus(c: Pick<ComplaintRow, 'status' | 'resolved_at'>, now: Date): Status {
    if (c.status === 'resolved' && c.resolved_at && now.getTime() - c.resolved_at.getTime() > AUTO_CLOSE_DAYS * DAY_MS) return 'closed';
    return c.status;
}

/** No staff reply yet, past the deadline. */
export function isOverdue(c: Pick<ComplaintRow, 'status' | 'first_response_at' | 'created_at' | 'response_hours'>, now: Date): boolean {
    return c.status === 'open' && c.first_response_at === null && now.getTime() > c.created_at.getTime() + c.response_hours * 3_600_000;
}

async function updatesOf(tx: Queryable, oid: string) {
    return tx.query<{ oid: string; author: 'staff' | 'member'; author_name: string; body: string; status: Status | null; created_at: Date }>(sql`
        select oid, author, author_name, body, status, created_at from complaint_update where complaint_oid = ${oid} order by created_at`);
}

async function wire(deps: ComplaintDeps, tx: Queryable, c: ComplaintRow, now: Date, withThread: boolean) {
    const status = effectiveStatus(c, now);
    const resolvedFor = c.resolved_at ? now.getTime() - c.resolved_at.getTime() : 0;
    return {
        oid: c.oid,
        code: c.code,
        branch: { oid: c.branch_oid, name: c.branch_name },
        member_oid: c.member_oid,
        member_code: c.member_code,
        member_name: c.member_name,
        category: c.category,
        subject: c.subject,
        body: c.body,
        photo_url: c.photo_file_oid ? await viewUrl(deps, { oid: c.photo_file_oid, branch_oid: c.branch_oid }) : null,
        named_staff_name: c.named_staff_name,
        hq_only: c.hq_only,
        filed_via: c.filed_via,
        status,
        overdue: isOverdue(c, now),
        due_at: new Date(c.created_at.getTime() + c.response_hours * 3_600_000).toISOString(),
        first_response_at: c.first_response_at?.toISOString() ?? null,
        resolution: c.resolution,
        resolved_at: c.resolved_at?.toISOString() ?? null,
        escalated: c.escalated_at ? { at: c.escalated_at.toISOString(), by: c.escalated_by, reason: c.escalation_reason } : null,
        member_accepted_at: c.member_accepted_at?.toISOString() ?? null,
        closes_at: status === 'resolved' && c.resolved_at ? new Date(c.resolved_at.getTime() + AUTO_CLOSE_DAYS * DAY_MS).toISOString() : null,
        /** The member may accept or escalate the resolution (portal). */
        can_respond: status === 'resolved' && resolvedFor <= AUTO_CLOSE_DAYS * DAY_MS,
        created_at: c.created_at.toISOString(),
        updates: withThread
            ? (await updatesOf(tx, c.oid)).map(u => ({
                  oid: u.oid,
                  author: u.author,
                  author_name: u.author_name,
                  body: u.body,
                  status: u.status,
                  at: u.created_at.toISOString()
              }))
            : undefined
    };
}

/** Staff: HQ sees every complaint in context; a branch its own, never HQ-only ones; nobody one that names them. */
function visible(ctx: BranchContext, hq: boolean, userOid: string) {
    return sql`(${hq} or (c.branch_oid = ${ctx.branchOid} and not c.hq_only)) and c.named_staff_oid is distinct from ${userOid}::uuid`;
}

export interface StaffCaller {
    userOid: string;
    hq: boolean;
}

/** `GET /v1/complaints`: newest first; `status=active` = not closed. */
export async function listComplaints(deps: ComplaintDeps, ctx: BranchContext, caller: StaffCaller, q: ComplaintQuery, now: Date) {
    return withBranchTx(deps.db, ctx, async tx => {
        const rows = await tx.query<ComplaintRow>(
            sql`select ${COMPLAINT} where ${visible(ctx, caller.hq, caller.userOid)} order by c.created_at desc limit 300`
        );
        const list = await Promise.all(rows.map(r => wire(deps, tx, r, now, false)));
        return list.filter(
            c =>
                (!q.status || (q.status === 'active' ? c.status !== 'closed' : c.status === q.status)) &&
                (q.overdue !== '1' || c.overdue) &&
                (q.escalated !== '1' || c.escalated !== null)
        );
    });
}

async function complaintIn(tx: Queryable, where: ReturnType<typeof sql>, oid: string) {
    const [row] = await tx.query<ComplaintRow>(sql`select ${COMPLAINT} where c.oid = ${oid} and ${where}`);
    if (!row) throw new AppError(404, 'Complaint not found');
    return row;
}

export async function getComplaint(deps: ComplaintDeps, ctx: BranchContext, caller: StaffCaller, oid: string, now: Date) {
    return withBranchTx(deps.db, ctx, async tx => wire(deps, tx, await complaintIn(tx, visible(ctx, caller.hq, caller.userOid), oid), now, true));
}

/** The staff a complaint may name: anyone working at the branch. A branch manager's goes to HQ (D-095). */
export async function complaintStaff(tx: Queryable, branchOid: string) {
    return tx.query<{ oid: string; name: string; role: string }>(sql`
        select u.oid, u.name, a.role_code as role from staff_assignment a join app_user u on u.oid = a.user_oid
        where a.branch_oid = ${branchOid} and u.kind = 'staff' and u.status = 'Active' and a.role_code in ('BRANCH_MANAGER', 'FRONT_DESK', 'TRAINER')
        order by u.name`);
}

async function insertComplaint(
    tx: Queryable,
    ctx: BranchContext,
    input: PortalComplaintCreate & { member: { oid: string | null; code: string | null; name: string } },
    via: 'portal' | 'desk',
    now: Date
) {
    let named: { oid: string; name: string; role: string } | null = null;
    if (input.named_staff_oid) {
        named = (await complaintStaff(tx, ctx.branchOid)).find(s => s.oid === input.named_staff_oid) ?? null;
        if (!named) throw new AppError(400, 'No such staff member at this branch', [{ path: 'named_staff_oid', message: 'Not here' }]);
        if (via === 'desk' && named.oid === ctx.actor?.oid) throw new AppError(400, 'Ask a colleague to file a complaint about you.');
    }
    if (input.photo_file_oid) await claimKindFile(tx, ctx.branchOid, input.photo_file_oid, 'complaint_photo', input.member.oid);
    const [branch] = await tx.query<{ code: string }>(sql`select code from branch where oid = ${ctx.branchOid}`);
    const seq = await membersRepo.nextNumber(tx, ctx.branchOid, 'complaint');
    const code = `CMP-${branch?.code ?? 'X'}-${String(seq).padStart(5, '0')}`;
    const [row] = await tx.query<{ oid: string }>(sql`
        insert into complaint (branch_oid, code, member_oid, member_code, member_name, category, subject, body, photo_file_oid,
            named_staff_oid, named_staff_name, hq_only, filed_via, filed_by, created_at, updated_at)
        values (${ctx.branchOid}, ${code}, ${input.member.oid}, ${input.member.code}, ${input.member.name}, ${input.category}, ${input.subject},
            ${input.body}, ${input.photo_file_oid ?? null}, ${named?.oid ?? null}, ${named?.name ?? null}, ${named?.role === 'BRANCH_MANAGER'}, ${via},
            ${ctx.actor?.oid ?? null}, ${now}, ${now})
        returning oid`);
    if (!row) throw new Error('complaint insert returned nothing');
    await recordAudit(tx, ctx, {
        action: 'create',
        entity: 'complaint',
        entityKey: code,
        before: null,
        after: { via, category: input.category, subject: input.subject, named_staff: named?.name ?? null, hq_only: named?.role === 'BRANCH_MANAGER' }
    });
    return { oid: row.oid, hq_only: named?.role === 'BRANCH_MANAGER' };
}

/** `POST /v1/complaints` (`create Complaint`): the desk files for a member of this branch, or a visitor by name. */
export async function createComplaint(deps: ComplaintDeps, ctx: BranchContext, caller: StaffCaller, input: ComplaintCreate, now: Date) {
    return withBranchTx(deps.db, ctx, async tx => {
        let member = { oid: null as string | null, code: null as string | null, name: input.member_name ?? '' };
        if (input.member_oid) {
            const [m] = await tx.query<{ oid: string; code: string; name: string }>(
                sql`select oid, code, name from member where oid = ${input.member_oid} and branch_oid = ${ctx.branchOid} and anonymised_at is null`
            );
            if (!m) throw new AppError(404, 'Member not found');
            member = m;
        }
        const out = await insertComplaint(tx, ctx, { ...input, member }, 'desk', now);
        if (out.hq_only && !caller.hq) return { oid: out.oid, sent_to_hq: true };
        return wire(deps, tx, await complaintIn(tx, visible(ctx, caller.hq, caller.userOid), out.oid), now, true);
    });
}

/** `POST /v1/complaints/:oid/updates` (`update Complaint`): a reply, optionally moving it on (in progress, resolved). */
export async function replyComplaint(
    deps: ComplaintDeps,
    ctx: BranchContext,
    caller: StaffCaller,
    oid: string,
    input: { body: string; status?: 'in_progress' | 'resolved' | undefined },
    now: Date
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const c = await complaintIn(tx, visible(ctx, caller.hq, caller.userOid), oid);
        const status = effectiveStatus(c, now);
        if (status === 'closed') throw new AppError(409, 'This complaint is closed.');
        const next: Status = input.status ?? (status === 'open' ? 'in_progress' : status);
        await tx.query(sql`
            insert into complaint_update (branch_oid, complaint_oid, author, author_name, body, status, created_at)
            values (${c.branch_oid}, ${oid}, 'staff', ${ctx.actor?.name ?? 'Staff'}, ${input.body}, ${next === status ? null : next}, ${now})`);
        await tx.query(sql`
            update complaint set status = ${next}, first_response_at = coalesce(first_response_at, ${now}),
                resolution = case when ${next} = 'resolved' then ${input.body} else resolution end,
                resolved_at = case when ${next} = 'resolved' then ${now}::timestamptz else resolved_at end,
                updated_at = ${now}
            where oid = ${oid}`);
        await recordAudit(tx, ctx, {
            action: next === 'resolved' ? 'resolve' : 'reply',
            entity: 'complaint',
            entityKey: c.code,
            before: { status },
            after: { status: next }
        });
        return wire(deps, tx, await complaintIn(tx, visible(ctx, caller.hq, caller.userOid), oid), now, true);
    });
}

/** `POST /v1/complaints/:oid/escalate` (`manage Complaint`, a branch manager): to HQ. */
export async function escalateComplaint(deps: ComplaintDeps, ctx: BranchContext, caller: StaffCaller, oid: string, reason: string, now: Date) {
    return withBranchTx(deps.db, ctx, async tx => {
        const c = await complaintIn(tx, visible(ctx, caller.hq, caller.userOid), oid);
        if (caller.hq) throw new AppError(409, 'HQ already has it.');
        if (c.escalated_at) throw new AppError(409, 'This complaint is already with HQ.');
        if (effectiveStatus(c, now) === 'closed') throw new AppError(409, 'This complaint is closed.');
        await escalate(tx, ctx, c, 'manager', reason, now);
        return wire(deps, tx, await complaintIn(tx, visible(ctx, caller.hq, caller.userOid), oid), now, true);
    });
}

async function escalate(tx: Queryable, ctx: BranchContext, c: ComplaintRow, by: 'manager' | 'member', reason: string, now: Date) {
    const status = effectiveStatus(c, now);
    const next: Status = status === 'resolved' || status === 'open' ? 'in_progress' : status;
    await tx.query(sql`
        update complaint set escalated_at = ${now}, escalated_by = ${by}, escalation_reason = ${reason}, status = ${next}, updated_at = ${now}
        where oid = ${c.oid}`);
    await tx.query(sql`
        insert into complaint_update (branch_oid, complaint_oid, author, author_name, body, status, created_at)
        values (${c.branch_oid}, ${c.oid}, ${by === 'member' ? 'member' : 'staff'}, ${ctx.actor?.name ?? c.member_name}, ${`Escalated to HQ: ${reason}`},
            ${next === status ? null : next}, ${now})`);
    await recordAudit(tx, ctx, { action: 'escalate', entity: 'complaint', entityKey: c.code, before: { status }, after: { status: next, by, reason } });
}

/* ---------- the member portal ---------- */

const mine = (memberOid: string) => sql`c.member_oid = ${memberOid}`;

export async function myComplaints(deps: ComplaintDeps, ctx: BranchContext, memberOid: string, now: Date) {
    return withBranchTx(deps.db, ctx, async tx => {
        const rows = await tx.query<ComplaintRow>(sql`select ${COMPLAINT} where ${mine(memberOid)} order by c.created_at desc`);
        // The member's own view: who it named is theirs to see, HQ routing is not.
        return Promise.all(rows.map(async r => ({ ...(await wire(deps, tx, r, now, true)), hq_only: false })));
    });
}

export async function portalStaff(deps: ComplaintDeps, ctx: BranchContext) {
    return withBranchTx(deps.db, ctx, async tx => (await complaintStaff(tx, ctx.branchOid)).map(s => ({ oid: s.oid, name: s.name, role: s.role })));
}

export async function fileMyComplaint(deps: ComplaintDeps, ctx: BranchContext, memberOid: string, input: PortalComplaintCreate, now: Date) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [m] = await tx.query<{ oid: string; code: string; name: string }>(sql`select oid, code, name from member where oid = ${memberOid}`);
        if (!m) throw new AppError(404, 'Member not found');
        const out = await insertComplaint(tx, ctx, { ...input, member: m }, 'portal', now);
        return { ...(await wire(deps, tx, await complaintIn(tx, mine(memberOid), out.oid), now, true)), hq_only: false };
    });
}

/** The member replies, accepts the resolution (closed) or escalates it to HQ (within 7 days of it). */
export async function memberAction(
    deps: ComplaintDeps,
    ctx: BranchContext,
    memberOid: string,
    oid: string,
    action: { kind: 'reply'; body: string } | { kind: 'accept' } | { kind: 'escalate'; reason: string },
    now: Date
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const c = await complaintIn(tx, mine(memberOid), oid);
        const view = await wire(deps, tx, c, now, false);
        if (view.status === 'closed') throw new AppError(409, 'This complaint is closed.');
        if (action.kind === 'reply') {
            await tx.query(sql`
                insert into complaint_update (branch_oid, complaint_oid, author, author_name, body, created_at)
                values (${c.branch_oid}, ${oid}, 'member', ${c.member_name}, ${action.body}, ${now})`);
            await recordAudit(tx, ctx, { action: 'reply', entity: 'complaint', entityKey: c.code, before: null, after: { by: 'member' } });
        } else {
            if (!view.can_respond) throw new AppError(409, 'There is no resolution to answer yet.');
            if (action.kind === 'accept') {
                await tx.query(
                    sql`update complaint set status = 'closed', member_accepted_at = ${now}, closed_at = ${now}, updated_at = ${now} where oid = ${oid}`
                );
                await tx.query(sql`
                    insert into complaint_update (branch_oid, complaint_oid, author, author_name, body, status, created_at)
                    values (${c.branch_oid}, ${oid}, 'member', ${c.member_name}, 'Accepted the resolution', 'closed', ${now})`);
                await recordAudit(tx, ctx, {
                    action: 'accept',
                    entity: 'complaint',
                    entityKey: c.code,
                    before: { status: 'resolved' },
                    after: { status: 'closed' }
                });
            } else {
                if (c.escalated_by === 'member') throw new AppError(409, 'You have already sent this to HQ.');
                await escalate(tx, ctx, c, 'member', action.reason, now);
            }
        }
        return { ...(await wire(deps, tx, await complaintIn(tx, mine(memberOid), oid), now, true)), hq_only: false };
    });
}
