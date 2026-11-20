import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { livePhotoExpr } from '#src/features/files/files.repo.ts';
import { viewUrl } from '#src/features/files/files.service.ts';
import { markArrival } from '#src/features/scheduling/classes.service.ts';
import { addDays, daysBetween, dhakaInstant, type DhakaNow, dhakaNow } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import { evaluateAccess, type MemberStatus, type RuleFailure } from './access-rules.ts';

/**
 * Attendance (phase 2 step 6; D-059, D-062, D-066, D-070). A member trains at any branch: the desk scans a
 * code, the access rules decide, and the visit is written at the branch entered, with the member's code, name,
 * photo and home branch COPIED onto the row (D-066), which is all a visited branch ever sees of a visitor.
 * The cross-branch facts come from the narrow `member_access_facts(code)` function (migration 014).
 */
export interface AttendanceDeps {
    db: Db;
    jwtSecret: string;
    apiPrefix: string;
}

/** Back-dated entries: at most this many days back (D-070 b). */
export const BACKDATE_DAYS = 7;

interface Facts {
    oid: string;
    code: string;
    name: string;
    photo_file_oid: string | null;
    branch_oid: string;
    branch_name: string;
    dues_limit: number;
    pending: boolean;
    suspended: boolean;
    dues: number;
    subscriptions: { start_date: string; end_date: string; freezes: { from: string; to: string }[]; cancelled: boolean }[];
    /** `yyyy-MM-ddTHH:mm` in Dhaka, of an open visit anywhere. */
    open_check_in: string | null;
    open_check_in_branch: string | null;
}

interface BranchInfo {
    oid: string;
    name: string;
    capacity: number;
    hours: { days: number[]; open: string; close: string }[];
}

async function branchInfo(tx: Queryable, oid: string): Promise<BranchInfo> {
    const [b] = await tx.query<BranchInfo>(sql`select oid, name, capacity, hours from branch where oid = ${oid}`);
    if (!b) throw new AppError(404, 'Branch not found');
    return b;
}

async function factsByCode(tx: Queryable, code: string): Promise<Facts | null> {
    const [row] = await tx.query<{ facts: Facts | null }>(sql`select member_access_facts(${code}) as facts`);
    return row?.facts ?? null;
}

/** The member's state from the facts: the same order as the members list (no grace period). */
function stateOf(f: Facts, today: string) {
    const subs = f.subscriptions.filter(s => s.start_date <= s.end_date);
    const current = subs.find(s => s.start_date <= today && today <= s.end_date) ?? null;
    const upcoming = subs.filter(s => s.start_date > today).sort((a, b) => (a.start_date < b.start_date ? -1 : 1))[0] ?? null;
    const relevant = current ?? upcoming ?? [...subs].sort((a, b) => (a.end_date < b.end_date ? 1 : -1))[0] ?? null;
    const frozen = current?.freezes.some(z => z.from <= today && today <= z.to) ?? false;
    const status: MemberStatus = f.suspended ? 'Suspended' : f.pending ? 'Pending' : current ? (frozen ? 'Frozen' : 'Active') : upcoming ? 'Active' : 'Expired';
    return { status, relevant };
}

export interface Decision {
    allowed: boolean;
    failures: RuleFailure[];
    member: {
        oid: string;
        code: string;
        name: string;
        photo_url: string | null;
        status: MemberStatus;
        plan_name: string | null;
        valid_until: string | null;
        days_left: number | null;
        dues: number;
        /** Another branch's member (D-059): the plan and dues stay with their home branch. */
        visitor: boolean;
        home_branch_name: string;
    };
    can_override: boolean;
}

async function decide(deps: AttendanceDeps, tx: Queryable, ctx: BranchContext, now: DhakaNow, f: Facts, canOverride: boolean): Promise<Decision> {
    const branch = await branchInfo(tx, ctx.branchOid);
    const { status, relevant } = stateOf(f, now.date);
    const failures = evaluateAccess(
        {
            member: { status, dues: f.dues, home_branch_name: f.branch_name, dues_limit: f.dues_limit },
            subscription: relevant,
            branch: { name: branch.name, hours: branch.hours },
            open_check_in: f.open_check_in ? { branch_name: f.open_check_in_branch ?? 'another branch', time: f.open_check_in.slice(11, 16) } : null
        },
        now
    );
    const home = f.branch_oid === ctx.branchOid;
    // The plan name is the home branch's business; a visited branch reads only the outcome (D-059, D-066).
    const plan = home
        ? await tx.query<{ plan_name: string }>(
              sql`select plan_name from subscription where member_oid = ${f.oid} and kind = 'membership' and end_date = ${relevant?.end_date ?? null}::date limit 1`
          )
        : [];
    return {
        allowed: failures.length === 0,
        failures,
        member: {
            oid: f.oid,
            code: f.code,
            name: f.name,
            photo_url: f.photo_file_oid ? await viewUrl(deps, { oid: f.photo_file_oid, branch_oid: f.branch_oid }) : null,
            status,
            plan_name: home ? (plan[0]?.plan_name ?? null) : null,
            valid_until: home ? (relevant?.end_date ?? null) : null,
            days_left: home && relevant ? daysBetween(now.date, relevant.end_date) : null,
            dues: home ? f.dues : 0,
            visitor: !home,
            home_branch_name: f.branch_name
        },
        can_override: failures.length > 0 && failures.every(x => x.overridable) && canOverride
    };
}

/** By the scanned code, or (own members) by oid. */
async function findFacts(tx: Queryable, ctx: BranchContext, key: { member_oid?: string | undefined; code?: string | undefined }): Promise<Facts> {
    let code = key.code;
    if (!code && key.member_oid) {
        const [own] = await tx.query<{ code: string }>(sql`select code from member where oid = ${key.member_oid} and branch_oid = ${ctx.branchOid}`);
        code = own?.code;
    }
    const f = code ? await factsByCode(tx, code) : null;
    if (!f) throw new AppError(404, 'No member with this code');
    return f;
}

export async function evaluate(
    deps: AttendanceDeps,
    ctx: BranchContext,
    now: DhakaNow,
    key: { member_oid?: string | undefined; code?: string | undefined },
    canOverride: boolean
) {
    return withBranchTx(deps.db, ctx, async tx => decide(deps, tx, ctx, now, await findFacts(tx, ctx, key), canOverride));
}

export interface CheckInWire {
    oid: string;
    member_oid: string;
    member_code: string;
    member_name: string;
    photo_url: string | null;
    home_branch_name: string;
    visitor: boolean;
    checked_in_at: string;
    checked_out_at: string | null;
    auto_out: boolean;
    backdated: boolean;
    override: { reason: string; by: string } | null;
    by: string;
}

const CHECK_IN = sql.raw(`c.oid, c.branch_oid, c.member_oid, c.member_branch_oid, c.member_code, c.member_name,
    ${livePhotoExpr('c.member_photo_file_oid')} as member_photo_file_oid,
    c.member_branch_name, c.in_at, c.out_at, c.auto_out, c.backdated, c.override_reason, o.name as override_name, coalesce(u.name, 'System') as by_name
    from check_in c left join app_user u on u.oid = c.created_by left join app_user o on o.oid = c.override_by`);

interface CheckInRow {
    oid: string;
    branch_oid: string;
    member_oid: string;
    member_branch_oid: string;
    member_code: string;
    member_name: string;
    member_photo_file_oid: string | null;
    member_branch_name: string;
    in_at: Date;
    out_at: Date | null;
    auto_out: boolean;
    backdated: boolean;
    override_reason: string | null;
    override_name: string | null;
    by_name: string;
}

async function toWire(deps: AttendanceDeps, c: CheckInRow): Promise<CheckInWire> {
    return {
        oid: c.oid,
        member_oid: c.member_oid,
        member_code: c.member_code,
        member_name: c.member_name,
        photo_url: c.member_photo_file_oid ? await viewUrl(deps, { oid: c.member_photo_file_oid, branch_oid: c.member_branch_oid }) : null,
        home_branch_name: c.member_branch_name,
        visitor: c.member_branch_oid !== c.branch_oid,
        checked_in_at: c.in_at.toISOString(),
        checked_out_at: c.out_at?.toISOString() ?? null,
        auto_out: c.auto_out,
        backdated: c.backdated,
        override: c.override_reason ? { reason: c.override_reason, by: c.override_name ?? '' } : null,
        by: c.by_name
    };
}

async function insertVisit(
    tx: Queryable,
    ctx: BranchContext,
    f: Facts,
    v: { in_at: Date; out_at: Date | null; override: { reason: string; by: string } | null; backdate_reason: string | null; actor: string }
) {
    const [row] = await tx.query<{ oid: string }>(sql`
        insert into check_in (branch_oid, member_oid, member_branch_oid, member_code, member_name, member_photo_file_oid, member_branch_name,
            in_at, out_at, override_reason, override_by, backdated, backdate_reason, created_by)
        values (${ctx.branchOid}, ${f.oid}, ${f.branch_oid}, ${f.code}, ${f.name}, ${f.photo_file_oid}, ${f.branch_name},
            ${v.in_at}, ${v.out_at}, ${v.override?.reason ?? null}, ${v.override?.by ?? null}, ${v.backdate_reason !== null}, ${v.backdate_reason}, ${v.actor})
        returning oid`);
    if (!row) throw new Error('check_in insert returned no row');
    return row.oid;
}

async function visit(tx: Queryable, oid: string) {
    const [row] = await tx.query<CheckInRow>(sql`select ${CHECK_IN} where c.oid = ${oid}`);
    if (!row) throw new Error('check_in missing inside its own transaction');
    return row;
}

export async function checkIn(
    deps: AttendanceDeps,
    ctx: BranchContext,
    now: DhakaNow,
    input: { member_oid?: string | undefined; code?: string | undefined; override?: { reason: string } | null | undefined },
    canOverride: boolean
) {
    if (!ctx.actor) throw new AppError(401, 'Please sign in');
    const actor = ctx.actor;
    return withBranchTx(deps.db, ctx, async tx => {
        const f = await findFacts(tx, ctx, input);
        const decision = await decide(deps, tx, ctx, now, f, canOverride);
        let override: { reason: string; by: string } | null = null;
        if (!decision.allowed) {
            if (!input.override) throw new AppError(409, decision.failures.map(x => x.message).join(' '));
            if (!canOverride) throw new AppError(403, 'Only a branch manager can override a blocked check-in.');
            const blocked = decision.failures.filter(x => !x.overridable);
            if (blocked.length) throw new AppError(409, `This block cannot be overridden: ${blocked.map(x => x.message).join(' ')}`);
            if (input.override.reason.trim().length < 5)
                throw new AppError(400, 'Give a reason for the override (at least 5 characters).', [{ path: 'override.reason', message: 'Too short' }]);
            override = { reason: input.override.reason.trim(), by: actor.oid };
        }
        const oid = await insertVisit(tx, ctx, f, { in_at: now.at, out_at: null, override, backdate_reason: null, actor: actor.oid });
        const row = await visit(tx, oid);
        await recordAudit(tx, ctx, {
            action: override ? 'override' : 'check_in',
            entity: 'check_in',
            entityKey: f.code,
            before: null,
            after: { oid, at: now.at.toISOString(), override: override?.reason ?? null, failures: decision.failures.map(x => x.rule) }
        });
        // A booked class starting soon (or under way) at the member's home branch is marked Attended (D-081).
        const classes = f.branch_oid === ctx.branchOid ? await markArrival(tx, ctx, f.oid, now.at) : [];
        const base = override ? `${f.name} checked in with an override` : `${f.name} checked in`;
        return { visit: await toWire(deps, row), message: classes.length ? `${base}; marked present for ${classes.join(', ')}` : base };
    });
}

/** A visit entered after the fact (D-070 b): a manager, within 7 days, with a reason. No access rules: it happened. */
export async function backdate(
    deps: AttendanceDeps,
    ctx: BranchContext,
    now: DhakaNow,
    entries: { member_oid?: string | undefined; code?: string | undefined; in_at: string; out_at?: string | null | undefined; reason: string }[]
) {
    if (!ctx.actor) throw new AppError(401, 'Please sign in');
    const actor = ctx.actor;
    return withBranchTx(deps.db, ctx, async tx => {
        const out: CheckInWire[] = [];
        for (const [i, e] of entries.entries()) {
            const inAt = new Date(e.in_at);
            const outAt = e.out_at ? new Date(e.out_at) : null;
            const day = dhakaNow(inAt).date;
            const where = entries.length > 1 ? `Entry ${i + 1}: ` : '';
            if (inAt > now.at)
                throw new AppError(400, `${where}a back-dated visit cannot be in the future`, [{ path: `entries.${i}.in_at`, message: 'In the future' }]);
            if (daysBetween(day, now.date) > BACKDATE_DAYS)
                throw new AppError(400, `${where}at most ${BACKDATE_DAYS} days back`, [{ path: `entries.${i}.in_at`, message: 'Too far back' }]);
            if (outAt && outAt < inAt)
                throw new AppError(400, `${where}the check-out is before the check-in`, [{ path: `entries.${i}.out_at`, message: 'Before check-in' }]);
            const f = await findFacts(tx, ctx, e);
            const oid = await insertVisit(tx, ctx, f, {
                in_at: inAt,
                out_at: outAt ?? new Date(Math.min(inAt.getTime() + 2 * 3600_000, now.at.getTime())),
                override: null,
                backdate_reason: e.reason,
                actor: actor.oid
            });
            await recordAudit(tx, ctx, {
                action: 'backdate',
                entity: 'check_in',
                entityKey: f.code,
                before: null,
                after: { oid, in_at: inAt.toISOString(), reason: e.reason }
            });
            out.push(await toWire(deps, await visit(tx, oid)));
        }
        return out;
    });
}

export async function checkOut(deps: AttendanceDeps, ctx: BranchContext, now: DhakaNow, oid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [row] = await tx.query<{ out_at: Date | null; member_code: string }>(
            sql`select out_at, member_code from check_in where oid = ${oid} and branch_oid = ${ctx.branchOid} for update`
        );
        if (!row) throw new AppError(404, 'Check-in not found');
        if (row.out_at) throw new AppError(409, 'Already checked out');
        await tx.query(sql`update check_in set out_at = greatest(${now.at}::timestamptz, in_at) where oid = ${oid}`);
        await recordAudit(tx, ctx, {
            action: 'check_out',
            entity: 'check_in',
            entityKey: row.member_code,
            before: { oid, out_at: null },
            after: { oid, out_at: now.at.toISOString() }
        });
        return toWire(deps, await visit(tx, oid));
    });
}

export async function today(deps: AttendanceDeps, ctx: BranchContext, now: DhakaNow) {
    return withBranchTx(deps.db, ctx, async tx => {
        await closeFinishedVisits(tx, ctx.branchOid, now.at);
        const rows = await tx.query<CheckInRow>(sql`
            select ${CHECK_IN} where c.branch_oid = ${ctx.branchOid} and c.in_at >= ${dhakaInstant(now.date)} and c.in_at < ${dhakaInstant(addDays(now.date, 1))}
            order by c.in_at desc`);
        return Promise.all(rows.map(r => toWire(deps, r)));
    });
}

export async function occupancy(deps: AttendanceDeps, ctx: BranchContext, now: DhakaNow) {
    return withBranchTx(deps.db, ctx, async tx => {
        await closeFinishedVisits(tx, ctx.branchOid, now.at);
        const branch = await branchInfo(tx, ctx.branchOid);
        const [row] = await tx.query<{ inside: number; today: number }>(sql`
            select count(*) filter (where c.out_at is null)::int as inside, count(*)::int as today from check_in c
            where c.branch_oid = ${ctx.branchOid} and c.in_at >= ${dhakaInstant(now.date)} and c.in_at < ${dhakaInstant(addDays(now.date, 1))}`);
        // An open visit from an earlier day that is not yet over (a branch open past midnight) still counts as inside.
        const [older] = await tx.query<{ n: number }>(
            sql`select count(*)::int as n from check_in where branch_oid = ${ctx.branchOid} and out_at is null and in_at < ${dhakaInstant(now.date)}`
        );
        return { inside: (row?.inside ?? 0) + (older?.n ?? 0), capacity: branch.capacity, today: row?.today ?? 0 };
    });
}

/** Visit days for a member's heatmap, at every branch (the home branch reads its members' visits, D-066). */
export async function memberAttendance(deps: AttendanceDeps, ctx: BranchContext, now: DhakaNow, memberOid: string, days: number) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [own] = await tx.query<{ oid: string }>(sql`select oid from member where oid = ${memberOid} and branch_oid = ${ctx.branchOid}`);
        if (!own) throw new AppError(404, 'Member not found');
        const from = addDays(now.date, -days + 1);
        const rows = await tx.query<{ date: string; count: number }>(sql`
            select to_char(in_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD') as date, count(*)::int as count from check_in
            where member_oid = ${memberOid} and member_branch_oid = ${ctx.branchOid} and in_at >= ${dhakaInstant(from)}
            group by 1 order by 1`);
        return { from, to: now.date, days: rows };
    });
}

/**
 * Closes the branch's finished visits (D-070 a, D-075): every visit still open after the branch closed that day is
 * closed at the closing time, marked `auto_out`. A visit on a day with no opening hours is closed at the end of that
 * day. There is no scheduled job (D-075): this runs before the branch's floor is read (today's list, occupancy), so
 * the floor is right whenever someone looks at it. Safe to run at any time and more than once; concurrent runs
 * serialise on `for update`, and the second finds nothing left to close.
 */
export async function closeFinishedVisits(tx: Queryable, branchOid: string, nowAt: Date): Promise<number> {
    const open = await tx.query<{ oid: string; in_at: Date; member_code: string }>(
        sql`select oid, in_at, member_code from check_in where branch_oid = ${branchOid} and out_at is null and in_at < ${nowAt} for update`
    );
    if (!open.length) return 0;
    const branch = await branchInfo(tx, branchOid);
    let closed = 0;
    for (const v of open) {
        const local = dhakaNow(v.in_at);
        const blocks = branch.hours.filter(h => h.days.includes(local.weekday) && h.open <= local.time);
        const close =
            blocks
                .map(h => h.close)
                .sort()
                .at(-1) ?? '23:59';
        const closeAt = dhakaInstant(local.date, close);
        const at = closeAt > v.in_at ? closeAt : v.in_at;
        if (at > nowAt) continue;
        await tx.query(sql`update check_in set out_at = ${at}, auto_out = true where oid = ${v.oid}`);
        await recordAudit(tx, systemContext(branchOid), {
            action: 'auto_check_out',
            entity: 'check_in',
            entityKey: v.member_code,
            before: { oid: v.oid, out_at: null },
            after: { oid: v.oid, out_at: at.toISOString(), closing: close }
        });
        closed++;
    }
    return closed;
}
