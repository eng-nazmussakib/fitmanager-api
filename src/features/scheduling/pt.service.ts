import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { memberAt } from '#src/features/members/members.service.ts';
import { notify } from '#src/features/notifications/notifications.service.ts';
import { readOrgRules } from '#src/features/settings/settings.routes.ts';
import { addDays, clock12, dhakaInstant, dhakaIso, type DhakaNow, dhakaNow, shortDate } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import { weekStart } from './classes.service.ts';
import { freeSlots, type OpeningHours, type Window } from './hours.ts';
import { schedulingRepo } from './scheduling.repo.ts';
import type { PtCreate } from './scheduling.schema.ts';
import { type Caller, type SchedulingDeps, trainerWire } from './trainers.service.ts';

/**
 * PT sessions. A member with a PT package books an hour with a trainer who works at their home
 * branch, in a free slot: inside the trainer's availability and the branch's hours, not on leave, clashing with none
 * of the trainer's classes or PT. Each session uses one credit of the package that ends first; a cancel by the
 * trainer or staff, or by the member in good time, gives it back; a late cancel or a no-show by the member uses it.
 * Sessions still `Booked` when they end are completed when read (the trainer was there).
 */
interface PtRow {
    oid: string;
    branch_oid: string;
    trainer_oid: string;
    trainer_name: string;
    member_oid: string;
    member_code: string;
    member_name: string;
    subscription_oid: string;
    plan_name: string;
    room_oid: string | null;
    room_name: string | null;
    starts_at: Date;
    ends_at: Date;
    status: 'Booked' | 'Completed' | 'NoShow' | 'Cancelled';
    charged: boolean;
    cancelled_by: string | null;
    cancel_reason: string | null;
    notes: string | null;
    source: 'portal' | 'desk';
}

const PT = sql.raw(`p.oid, p.branch_oid, p.trainer_oid, p.trainer_name, p.member_oid, p.member_code, p.member_name, p.subscription_oid, s.plan_name,
    p.room_oid, p.room_name, p.starts_at, p.ends_at, p.status, p.charged, p.cancelled_by, p.cancel_reason, p.notes, p.source
    from pt_session p join subscription s on s.oid = p.subscription_oid`);

export function ptWire(p: PtRow) {
    return {
        ...p,
        starts_at: dhakaIso(p.starts_at),
        ends_at: dhakaIso(p.ends_at),
        date: dhakaNow(p.starts_at).date,
        start_time: dhakaNow(p.starts_at).time
    };
}

async function settle(tx: Queryable, branchOid: string, now: Date) {
    const rows = await tx.query<{ oid: string }>(sql`
        update pt_session set status = 'Completed', updated_at = now() where branch_oid = ${branchOid} and status = 'Booked' and ends_at <= ${now} returning oid`);
    if (rows.length)
        await recordAudit(tx, systemContext(branchOid), {
            action: 'settle',
            entity: 'pt_session',
            entityKey: dhakaNow(now).date,
            before: null,
            after: { completed: rows.length }
        });
}

async function ptAt(tx: Queryable, ctx: BranchContext, oid: string) {
    const [row] = await tx.query<PtRow>(sql`select ${PT} where p.oid = ${oid} and p.branch_oid = ${ctx.branchOid} for update of p`);
    if (!row) throw new AppError(404, 'PT session not found');
    return row;
}

/** The member's PT packages at their home branch with what is left, ending soonest first. */
export async function packages(tx: Queryable, memberOid: string, today: string) {
    return tx.query<{ oid: string; plan_name: string; start_date: string; end_date: string; sessions: number; used: number; left: number }>(sql`
        select s.oid, s.plan_name, s.start_date::text as start_date, s.end_date::text as end_date, s.sessions,
            (select count(*)::int from pt_session p where p.subscription_oid = s.oid and p.charged) as used,
            s.sessions - (select count(*)::int from pt_session p where p.subscription_oid = s.oid and p.charged) as left
        from subscription s
        where s.member_oid = ${memberOid} and s.kind = 'pt' and s.cancelled_at is null and s.end_date >= ${today}::date
        order by s.end_date, s.start_date`);
}

/** The trainer's busy times on a day at this branch: classes and PT (leave is checked separately). */
async function busyOn(tx: Queryable, branchOid: string, trainerOid: string, date: string, except: string | null): Promise<Window[]> {
    const rows = await tx.query<{ starts_at: Date; ends_at: Date }>(sql`
        select starts_at, ends_at from class_session where branch_oid = ${branchOid} and trainer_oid = ${trainerOid} and cancelled_at is null and session_date = ${date}::date
        union all
        select starts_at, ends_at from pt_session where branch_oid = ${branchOid} and trainer_oid = ${trainerOid} and status = 'Booked'
            and oid is distinct from ${except}::uuid and (starts_at at time zone 'Asia/Dhaka')::date = ${date}::date`);
    return rows.map(r => ({ start: dhakaNow(r.starts_at).time, end: dhakaNow(r.ends_at).time }));
}

/** Free start times for `minutes` with the trainer on `date` (none on leave or past days). */
async function slotsFor(tx: Queryable, ctx: BranchContext, now: DhakaNow, trainerOid: string, date: string, minutes: number) {
    if (date < now.date) return [];
    if (await schedulingRepo.onLeave(tx, trainerOid, date)) return [];
    if (!(await schedulingRepo.worksAt(tx, trainerOid, ctx.branchOid))) return [];
    // The timetable for that day must exist before the trainer's classes can be counted as busy.
    if (date <= addDays(now.date, 28)) await schedulingRepo.materialise(tx, ctx.branchOid, date, date);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const availability = (await schedulingRepo.availability(tx, trainerOid, ctx.branchOid))
        .filter(a => a.weekday === weekday)
        .map(a => ({ start: a.start_time, end: a.end_time }));
    const [branch] = await tx.query<{ hours: OpeningHours[] }>(sql`select hours from branch where oid = ${ctx.branchOid}`);
    return freeSlots({
        availability,
        hours: branch?.hours ?? [],
        weekday,
        busy: await busyOn(tx, ctx.branchOid, trainerOid, date, null),
        length: minutes,
        notBefore: date === now.date ? now.time : null
    });
}

export async function trainerSlots(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, trainerOid: string, date: string, minutes: number) {
    return withBranchTx(deps.db, ctx, async tx => {
        const t = await schedulingRepo.trainer(tx, trainerOid, [ctx.branchOid]);
        if (!t) throw new AppError(404, 'Trainer not found');
        return { trainer_oid: t.oid, date, minutes, slots: await slotsFor(tx, ctx, now, t.oid, date, minutes) };
    });
}

/** Books one PT session (desk, trainer, or the member in the portal). Runs in the caller's transaction. */
async function book(tx: Queryable, ctx: BranchContext, now: DhakaNow, input: PtCreate, source: 'portal' | 'desk', caller: Caller | null) {
    const m = await memberAt(tx, ctx, input.member_oid, now.date);
    if (m.status !== 'Active') throw new AppError(409, `${m.name} has no running membership (${m.status.toLowerCase()}).`);
    const t = await schedulingRepo.trainer(tx, input.trainer_oid, [ctx.branchOid]);
    if (!t) throw new AppError(404, 'Trainer not found');
    if (caller?.selfOnly && t.user_oid !== caller.userOid) throw new AppError(403, 'Trainers book only their own sessions');
    const free = await slotsFor(tx, ctx, now, t.oid, input.date, input.minutes);
    if (!free.includes(input.start_time))
        throw new AppError(409, `${t.name} is not free at ${clock12(input.start_time)} on ${shortDate(input.date)}. Pick one of the free times.`, [
            { path: 'start_time', message: 'Not free' }
        ]);
    const pack = (await packages(tx, m.oid, now.date)).find(p => p.left > 0 && p.start_date <= input.date && input.date <= p.end_date);
    if (!pack) throw new AppError(409, `${m.name} has no PT sessions left for that day. Sell a PT package first.`);
    const from = dhakaInstant(input.date, input.start_time);
    const to = new Date(from.getTime() + input.minutes * 60_000);
    const [own] = await tx.query<{ x: boolean }>(sql`
        select true as x from pt_session where member_oid = ${m.oid} and status = 'Booked' and starts_at < ${to} and ${from} < ends_at`);
    if (own) throw new AppError(409, `${m.name} already has a PT session then.`);
    let room: { oid: string; name: string } | null = null;
    if (input.room_oid) {
        const r = await schedulingRepo.room(tx, input.room_oid, ctx.branchOid);
        if (!r?.active) throw new AppError(400, 'Choose an open room at this branch', [{ path: 'room_oid', message: 'Unknown room' }]);
        const blocked = await schedulingRepo.roomBlocked(tx, r.oid, from, to);
        if (blocked) throw new AppError(409, `${r.name} is closed for maintenance then (${blocked}).`);
        room = r;
    }
    const [row] = await tx.query<{ oid: string }>(sql`
        insert into pt_session (branch_oid, trainer_oid, trainer_name, member_oid, member_code, member_name, subscription_oid, room_oid, room_name,
            starts_at, ends_at, status, charged, source, created_by)
        values (${ctx.branchOid}, ${t.oid}, ${t.name}, ${m.oid}, ${m.code}, ${m.name}, ${pack.oid}, ${room?.oid ?? null}, ${room?.name ?? null},
            ${from}, ${to}, 'Booked', true, ${source}, ${ctx.actor?.oid ?? null})
        returning oid`);
    const p = await ptAt(tx, ctx, row?.oid ?? '');
    await recordAudit(tx, ctx, {
        action: 'book',
        entity: 'pt_session',
        entityKey: `${m.code}/${input.date} ${input.start_time}`,
        before: null,
        after: ptWire(p)
    });
    await notify(tx, {
        branch_oid: ctx.branchOid,
        member: { oid: m.oid, code: m.code, name: m.name, email: m.email, phone: m.phone },
        kind: 'pt_booked',
        subject: `PT with ${t.name} on ${shortDate(input.date)}`,
        body: `Dear ${m.name}, your PT session with ${t.name} is on ${shortDate(input.date)} at ${clock12(input.start_time)}. ${pack.left - 1} of ${pack.sessions} sessions left on ${pack.plan_name}.`,
        related_oid: p.oid,
        dedupe_key: `pt_booked:${p.oid}`
    });
    return ptWire(p);
}

export async function bookPt(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, input: PtCreate, caller: Caller) {
    return withBranchTx(deps.db, ctx, tx => book(tx, ctx, now, input, 'desk', caller));
}

/** The PT week at the branch (optionally one trainer's), and each session's package. */
export async function ptWeek(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, week: string | undefined, trainerOid: string | undefined) {
    const from = weekStart(week ?? now.date);
    const to = addDays(from, 6);
    return withBranchTx(deps.db, ctx, async tx => {
        await settle(tx, ctx.branchOid, now.at);
        const rows = await tx.query<PtRow>(sql`
            select ${PT} where p.branch_oid = ${ctx.branchOid} and (p.starts_at at time zone 'Asia/Dhaka')::date between ${from}::date and ${to}::date
              ${trainerOid ? sql`and p.trainer_oid = ${trainerOid}` : sql``}
            order by p.starts_at`);
        const trainers = (await schedulingRepo.trainers(tx, [ctx.branchOid])).filter(t => t.active);
        return { from, to, sessions: rows.map(ptWire), trainers: await Promise.all(trainers.map(t => trainerWire(deps, t))) };
    });
}

/** A member's PT: their trainer, packages, and sessions (upcoming and the last 20). */
export async function memberPt(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, memberOid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        await settle(tx, ctx.branchOid, now.at);
        const [m] = await tx.query<{ trainer_oid: string | null }>(
            sql`select trainer_oid from member where oid = ${memberOid} and branch_oid = ${ctx.branchOid}`
        );
        if (!m) throw new AppError(404, 'Member not found');
        const trainer = m.trainer_oid ? await schedulingRepo.trainer(tx, m.trainer_oid, [ctx.branchOid]) : undefined;
        const rows = await tx.query<PtRow>(sql`select ${PT} where p.member_oid = ${memberOid} order by p.starts_at desc limit 60`);
        const rules = await readOrgRules(tx);
        return {
            trainer: trainer ? await trainerWire(deps, trainer) : null,
            packages: await packages(tx, memberOid, now.date),
            upcoming: rows
                .filter(r => r.status === 'Booked')
                .reverse()
                .map(ptWire),
            past: rows
                .filter(r => r.status !== 'Booked')
                .slice(0, 20)
                .map(ptWire),
            cancel_hours: rules.booking_cancel_hours
        };
    });
}

export async function memberSlots(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, memberOid: string, date: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [m] = await tx.query<{ trainer_oid: string | null }>(
            sql`select trainer_oid from member where oid = ${memberOid} and branch_oid = ${ctx.branchOid}`
        );
        if (!m?.trainer_oid) throw new AppError(409, 'You have no trainer yet: ask the front desk to assign one.');
        return { trainer_oid: m.trainer_oid, date, minutes: 60, slots: await slotsFor(tx, ctx, now, m.trainer_oid, date, 60) };
    });
}

export async function portalBookPt(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, memberOid: string, input: { date: string; start_time: string }) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [m] = await tx.query<{ trainer_oid: string | null }>(
            sql`select trainer_oid from member where oid = ${memberOid} and branch_oid = ${ctx.branchOid}`
        );
        if (!m?.trainer_oid) throw new AppError(409, 'You have no trainer yet: ask the front desk to assign one.');
        return book(
            tx,
            ctx,
            now,
            { member_oid: memberOid, trainer_oid: m.trainer_oid, date: input.date, start_time: input.start_time, minutes: 60, room_oid: null },
            'portal',
            null
        );
    });
}

/** Cancels a booked session. The member's credit comes back unless the member cancels inside the window. */
async function cancel(tx: Queryable, ctx: BranchContext, now: DhakaNow, p: PtRow, by: 'member' | 'trainer' | 'staff', reason: string) {
    if (p.status !== 'Booked') throw new AppError(409, 'Only a booked session can be cancelled.');
    if (p.starts_at <= now.at) throw new AppError(409, 'The session has started: mark it done or a no-show.');
    const rules = await readOrgRules(tx);
    const late = by === 'member' && p.starts_at.getTime() - now.at.getTime() < rules.booking_cancel_hours * 3_600_000;
    await tx.query(sql`
        update pt_session set status = 'Cancelled', cancelled_by = ${by}, cancel_reason = ${reason}, charged = ${late}, updated_at = now() where oid = ${p.oid}`);
    const local = dhakaNow(p.starts_at);
    await recordAudit(tx, ctx, {
        action: 'cancel',
        entity: 'pt_session',
        entityKey: `${p.member_code}/${local.date} ${local.time}`,
        before: ptWire(p),
        after: { status: 'Cancelled', cancelled_by: by, charged: late, reason }
    });
    const [member] = await tx.query<{ oid: string; code: string; name: string; email: string | null; phone: string | null }>(
        sql`select oid, code, name, email, phone from member where oid = ${p.member_oid}`
    );
    if (member && by !== 'member')
        await notify(tx, {
            branch_oid: ctx.branchOid,
            member,
            kind: 'pt_cancelled',
            subject: `PT on ${shortDate(local.date)} cancelled`,
            body: `Dear ${member.name}, your PT session with ${p.trainer_name} on ${shortDate(local.date)} at ${clock12(local.time)} is cancelled (${reason}). The session is back on your package.`,
            related_oid: p.oid,
            dedupe_key: `pt_cancelled:${p.oid}`
        });
    return late
        ? `Cancelled less than ${rules.booking_cancel_hours} hours before: the session is used.`
        : 'PT session cancelled; the session is back on the package';
}

export async function cancelPt(
    deps: SchedulingDeps,
    ctx: BranchContext,
    now: DhakaNow,
    oid: string,
    by: 'member' | 'trainer' | 'staff',
    reason: string,
    caller: Caller
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const p = await ptAt(tx, ctx, oid);
        await ownSession(tx, p, caller);
        return cancel(tx, ctx, now, p, by, reason);
    });
}

export async function portalCancelPt(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, memberOid: string, oid: string, reason: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const p = await ptAt(tx, ctx, oid);
        if (p.member_oid !== memberOid) throw new AppError(404, 'PT session not found');
        return cancel(tx, ctx, now, p, 'member', reason);
    });
}

async function ownSession(tx: Queryable, p: PtRow, caller: Caller) {
    if (!caller.selfOnly) return;
    const mine = await schedulingRepo.trainerByUser(tx, caller.userOid);
    if (mine?.oid !== p.trainer_oid) throw new AppError(403, 'Trainers change only their own sessions');
}

/** Marks a session done (with notes) or a no-show (the credit stays used). From its start onwards. */
export async function finishPt(
    deps: SchedulingDeps,
    ctx: BranchContext,
    now: DhakaNow,
    oid: string,
    status: 'Completed' | 'NoShow',
    notes: string | null,
    caller: Caller
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const p = await ptAt(tx, ctx, oid);
        await ownSession(tx, p, caller);
        if (p.status === 'Cancelled') throw new AppError(409, 'This session was cancelled.');
        if (p.starts_at > now.at) throw new AppError(409, 'Mark a session once it has started.');
        await tx.query(sql`
            update pt_session set status = ${status}, charged = true, notes = coalesce(${notes}, notes), updated_at = now() where oid = ${p.oid}`);
        const after = await ptAt(tx, ctx, p.oid);
        await recordAudit(tx, ctx, {
            action: status === 'Completed' ? 'complete' : 'mark_noshow',
            entity: 'pt_session',
            entityKey: `${p.member_code}/${dhakaNow(p.starts_at).date}`,
            before: ptWire(p),
            after: ptWire(after)
        });
        return ptWire(after);
    });
}
