import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { memberAt } from '#src/features/members/members.service.ts';
import { notify } from '#src/features/notifications/notifications.service.ts';
import { readOrgRules } from '#src/features/settings/settings.routes.ts';
import { addDays, clock12, dhakaInstant, dhakaIso, type DhakaNow, dhakaNow, shortDate } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import { endOf, firstClosedDay, type OpeningHours, overlaps, WEEKDAY_NAMES, withinHours } from './hours.ts';
import { type BookingRow, type ScheduleRow, schedulingRepo, type SessionRow } from './scheduling.repo.ts';
import type { OneOffCreate, ScheduleCreate, ScheduleUpdate, SessionUpdate } from './scheduling.schema.ts';
import { type Caller, type SchedulingDeps, trainerWire } from './trainers.service.ts';

/**
 * Classes and booking. A weekly rule makes one session a day; sessions are written when
 * the timetable is read (up to `FILL_DAYS` ahead), never by a job. Bookings: home-branch members with a
 * running membership; a full class puts the member on the waitlist, and a freed place goes to the first in line
 * with an in-app message. Cancelling inside the window counts like a no-show; so many of those block booking.
 * Bookings still `Booked` when their class ends become no-shows when read.
 */

/** How far ahead the timetable is filled in. */
export const FILL_DAYS = 28;
/** A desk check-in this long before a booked class (or during it) marks the booking Attended. */
export const ARRIVAL_MINUTES = 30;

/** The Saturday on or before `date` (the gym's week runs Saturday to Friday). */
export function weekStart(date: string): string {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    return addDays(date, -((wd + 1) % 7));
}

export function sessionWire(s: SessionRow) {
    return {
        oid: s.oid,
        branch_oid: s.branch_oid,
        schedule_oid: s.schedule_oid,
        type_oid: s.class_type_oid,
        type_name: s.title,
        color: s.color,
        title: s.title,
        trainer_oid: s.trainer_oid,
        trainer_name: s.trainer_name,
        room_oid: s.room_oid,
        room: s.room_name,
        starts_at: dhakaIso(s.starts_at),
        ends_at: dhakaIso(s.ends_at),
        capacity: s.capacity,
        booked: s.booked,
        waitlist: s.waitlist,
        ladies_only: s.ladies_only,
        detached: s.detached,
        cancelled: s.cancelled_at !== null,
        cancel_reason: s.cancel_reason,
        blocked: s.blocked
    };
}

export function bookingWire(b: BookingRow) {
    return {
        oid: b.oid,
        session_oid: b.session_oid,
        member_oid: b.member_oid,
        member_name: b.member_name,
        member_code: b.member_code,
        status: b.status,
        late_cancel: b.late_cancel,
        source: b.source,
        booked_at: b.booked_at.toISOString()
    };
}

export function scheduleWire(s: ScheduleRow) {
    return { ...s, end_time: endOf(s.start_time, s.minutes) };
}

async function hoursOf(tx: Queryable, branchOid: string) {
    const [row] = await tx.query<{ name: string; hours: OpeningHours[] }>(sql`select name, hours from branch where oid = ${branchOid}`);
    if (!row) throw new AppError(404, 'Branch not found');
    return row;
}

/** The time-based rules of the timetable for a range: settle what is over, fill in what is coming (clipped). */
async function prepare(tx: Queryable, ctx: BranchContext, now: DhakaNow, from: string, to: string) {
    const settled = await schedulingRepo.settle(tx, ctx.branchOid, now.at);
    if (settled.noShows || settled.lapsed)
        await recordAudit(tx, systemContext(ctx.branchOid, ctx.branchOids), {
            action: 'settle',
            entity: 'booking',
            entityKey: now.date,
            before: null,
            after: { no_shows: settled.noShows, waitlist_lapsed: settled.lapsed }
        });
    const last = addDays(now.date, FILL_DAYS);
    if (from <= last) await schedulingRepo.materialise(tx, ctx.branchOid, from, to < last ? to : last);
}

/** For other routes of the subsystem (PT, portal): the same settle-and-fill on read. */
export const prepareTimetable = prepare;

/** `GET /v1/classes/schedule`: one week (Saturday to Friday), the shape of the web mock's answer. */
export async function weekSchedule(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, week: string | undefined, userOid: string) {
    const from = weekStart(week ?? now.date);
    const to = addDays(from, 6);
    return withBranchTx(deps.db, ctx, async tx => {
        await prepare(tx, ctx, now, from, to);
        const [sessions, types, trainers, rooms, mine] = await Promise.all([
            schedulingRepo.sessions(tx, ctx.branchOid, from, to),
            schedulingRepo.classTypes(tx, false),
            schedulingRepo.trainers(tx, [ctx.branchOid]),
            schedulingRepo.rooms(tx, ctx.branchOid),
            schedulingRepo.trainerByUser(tx, userOid)
        ]);
        return {
            from,
            to,
            sessions: sessions.map(sessionWire),
            types,
            trainers: await Promise.all(trainers.filter(t => t.active).map(t => trainerWire(deps, t))),
            rooms,
            my_trainer_oid: mine?.oid ?? null
        };
    });
}

async function sessionAt(tx: Queryable, ctx: BranchContext, oid: string, forUpdate = false) {
    const s = await schedulingRepo.session(tx, oid, ctx.branchOid, forUpdate);
    if (!s) throw new AppError(404, 'Class not found');
    return s;
}

async function detailOf(tx: Queryable, s: SessionRow) {
    const list = await schedulingRepo.bookings(tx, s.oid);
    return {
        ...sessionWire(s),
        roster: list.filter(b => b.status !== 'Waitlist').map(bookingWire),
        waitlisted: list.filter(b => b.status === 'Waitlist').map(bookingWire)
    };
}

export async function sessionDetail(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, oid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        await schedulingRepo.settle(tx, ctx.branchOid, now.at);
        return detailOf(tx, await sessionAt(tx, ctx, oid));
    });
}

/* ---------- booking ---------- */

async function memberContact(tx: Queryable, memberOid: string) {
    const [m] = await tx.query<{ oid: string; code: string; name: string; email: string | null; phone: string | null }>(
        sql`select oid, code, name, email, phone from member where oid = ${memberOid}`
    );
    return m ?? null;
}

const whenOf = (s: Pick<SessionRow, 'starts_at'>) => {
    const local = dhakaNow(s.starts_at);
    return `${shortDate(local.date)} at ${clock12(local.time)}`;
};

/** Until when the member may not book, or null: `noshow_limit` strikes within `noshow_window_days`. */
export async function bookingBlockedUntil(tx: Queryable, memberOid: string, now: Date): Promise<Date | null> {
    const rules = await readOrgRules(tx);
    const strikes = await schedulingRepo.strikes(tx, memberOid, new Date(now.getTime() - rules.noshow_window_days * 86_400_000));
    if (strikes.length < rules.noshow_limit) return null;
    const until = new Date((strikes[0]?.starts_at ?? now).getTime() + rules.noshow_block_days * 86_400_000);
    return until > now ? until : null;
}

/** Books a home-branch member on a class, or puts them on the waitlist. Runs in the caller's transaction. */
export async function bookMember(tx: Queryable, ctx: BranchContext, now: DhakaNow, sessionOid: string, memberOid: string, source: 'portal' | 'desk') {
    const s = await sessionAt(tx, ctx, sessionOid, true);
    if (s.cancelled_at) throw new AppError(409, `This class was cancelled: ${s.cancel_reason ?? ''}`.trim());
    if (s.starts_at <= now.at) throw new AppError(409, 'This class has already started.');
    if (s.blocked) throw new AppError(409, `${s.room_name} is closed for maintenance at that time.`);
    const rules = await readOrgRules(tx);
    if (s.session_date > addDays(now.date, rules.booking_open_days)) throw new AppError(409, `Classes open for booking ${rules.booking_open_days} days ahead.`);
    const m = await memberAt(tx, ctx, memberOid, now.date);
    if (m.anonymised) throw new AppError(404, 'Member not found');
    if (m.status !== 'Active') throw new AppError(409, `${m.name} has no running membership (${m.status.toLowerCase()}).`);
    if (s.ladies_only && m.gender !== 'Female') throw new AppError(409, 'This is a ladies-only class.');
    const [dupe] = await tx.query<{ status: string }>(
        sql`select status from booking where session_oid = ${s.oid} and member_oid = ${m.oid} and status <> 'Cancelled'`
    );
    if (dupe) throw new AppError(409, `${m.name} is already ${dupe.status === 'Waitlist' ? 'on the waitlist' : 'booked'} for this class.`);
    const until = await bookingBlockedUntil(tx, m.oid, now.at);
    if (until)
        throw new AppError(
            409,
            `${m.name} missed ${rules.noshow_limit} classes in ${rules.noshow_window_days} days, so booking is paused until ${shortDate(dhakaNow(until).date)}.`
        );
    if ((await schedulingRepo.activeCount(tx, m.oid, now.at)) >= rules.booking_max_active)
        throw new AppError(409, `A member can hold at most ${rules.booking_max_active} upcoming bookings.`);
    const status = s.booked < s.capacity ? 'Booked' : 'Waitlist';
    const [row] = await tx.query<{ oid: string }>(sql`
        insert into booking (branch_oid, session_oid, member_oid, member_code, member_name, status, source, booked_at, updated_by)
        values (${ctx.branchOid}, ${s.oid}, ${m.oid}, ${m.code}, ${m.name}, ${status}, ${source}, ${now.at}, ${ctx.actor?.oid ?? null})
        returning oid`);
    const booking = row ? await schedulingRepo.booking(tx, row.oid, ctx.branchOid) : undefined;
    if (!booking) throw new Error('booking insert returned no row');
    await recordAudit(tx, ctx, {
        action: 'book',
        entity: 'booking',
        entityKey: `${m.code}/${s.title} ${s.session_date}`,
        before: null,
        after: bookingWire(booking)
    });
    return { booking: bookingWire(booking), message: status === 'Waitlist' ? `${m.name} added to the waitlist` : `${m.name} booked` };
}

/** Gives free places to the waitlist, oldest first, with a message each. */
async function promote(tx: Queryable, ctx: BranchContext, now: DhakaNow, sessionOid: string) {
    const s = await sessionAt(tx, ctx, sessionOid);
    if (s.cancelled_at || s.starts_at <= now.at) return;
    let free = s.capacity - s.booked;
    if (free <= 0) return;
    const waiting = (await schedulingRepo.bookings(tx, s.oid)).filter(b => b.status === 'Waitlist');
    for (const b of waiting) {
        if (free-- <= 0) break;
        await tx.query(sql`update booking set status = 'Booked', updated_at = now(), updated_by = ${ctx.actor?.oid ?? null} where oid = ${b.oid}`);
        await recordAudit(tx, ctx, {
            action: 'promote',
            entity: 'booking',
            entityKey: `${b.member_code}/${s.title} ${s.session_date}`,
            before: b,
            after: null
        });
        const member = await memberContact(tx, b.member_oid);
        if (member)
            await notify(tx, {
                branch_oid: ctx.branchOid,
                member,
                kind: 'waitlist_promoted',
                subject: `You are in: ${s.title}`,
                body: `Dear ${member.name}, a place came free and you are now booked for ${s.title} on ${whenOf(s)} in ${s.room_name}. Cancel in the portal if you cannot come.`,
                related_oid: b.oid,
                dedupe_key: `waitlist:${b.oid}`
            });
    }
}

/** Cancels a booking; inside the window a Booked place counts as a late cancel. Frees the place for the waitlist. */
async function cancelBooking(tx: Queryable, ctx: BranchContext, now: DhakaNow, b: BookingRow) {
    if (b.status !== 'Booked' && b.status !== 'Waitlist') throw new AppError(409, 'Only an upcoming booking can be cancelled.');
    const s = await sessionAt(tx, ctx, b.session_oid, true);
    if (s.starts_at <= now.at) throw new AppError(409, 'The class has started: mark attendance instead.');
    const rules = await readOrgRules(tx);
    const late = b.status === 'Booked' && s.starts_at.getTime() - now.at.getTime() < rules.booking_cancel_hours * 3_600_000;
    await tx.query(sql`
        update booking set status = 'Cancelled', late_cancel = ${late}, updated_at = now(), updated_by = ${ctx.actor?.oid ?? null} where oid = ${b.oid}`);
    await recordAudit(tx, ctx, {
        action: late ? 'late_cancel' : 'cancel',
        entity: 'booking',
        entityKey: `${b.member_code}/${s.title} ${s.session_date}`,
        before: bookingWire(b),
        after: { status: 'Cancelled', late_cancel: late }
    });
    if (b.status === 'Booked') await promote(tx, ctx, now, s.oid);
    return late
        ? `Cancelled less than ${rules.booking_cancel_hours} hours before the class: it counts as a missed class.`
        : b.status === 'Waitlist'
          ? 'Taken off the waitlist'
          : 'Booking cancelled';
}

/**
 * Staff on a booking: mark Attended or NoShow (from the start of the class's day), move someone in from the waitlist
 * (`Booked`, when there is room), or cancel. A trainer only on their own classes.
 */
export async function setBookingStatus(
    deps: SchedulingDeps,
    ctx: BranchContext,
    now: DhakaNow,
    oid: string,
    status: 'Booked' | 'Attended' | 'NoShow' | 'Cancelled',
    caller: Caller
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const b = await schedulingRepo.booking(tx, oid, ctx.branchOid, true);
        if (!b) throw new AppError(404, 'Booking not found');
        const s = await sessionAt(tx, ctx, b.session_oid, true);
        if (caller.selfOnly) {
            const mine = await schedulingRepo.trainerByUser(tx, caller.userOid);
            if (mine?.oid !== s.trainer_oid) throw new AppError(403, 'Trainers mark only their own classes');
        }
        if (status === 'Cancelled') return { booking: null, message: await cancelBooking(tx, ctx, now, b) };
        if (status === 'Booked') {
            if (b.status !== 'Waitlist') throw new AppError(409, 'Only someone on the waitlist can be moved in.');
            if (s.booked >= s.capacity) throw new AppError(409, 'The class is full. Cancel a booking first, or raise the capacity.');
            if (s.starts_at <= now.at) throw new AppError(409, 'This class has already started.');
        } else {
            if (b.status === 'Waitlist') throw new AppError(409, 'Move the member in from the waitlist first.');
            if (s.session_date > now.date) throw new AppError(409, 'Attendance is marked on the day of the class.');
            if (s.cancelled_at) throw new AppError(409, 'This class was cancelled.');
        }
        await tx.query(sql`update booking set status = ${status}, updated_at = now(), updated_by = ${ctx.actor?.oid ?? null} where oid = ${b.oid}`);
        const after = await schedulingRepo.booking(tx, b.oid, ctx.branchOid);
        await recordAudit(tx, ctx, {
            action: status === 'Booked' ? 'promote' : `mark_${status.toLowerCase()}`,
            entity: 'booking',
            entityKey: `${b.member_code}/${s.title} ${s.session_date}`,
            before: bookingWire(b),
            after: after ? bookingWire(after) : null
        });
        const message = status === 'Booked' ? `${b.member_name} moved from the waitlist` : `Marked ${status === 'NoShow' ? 'no-show' : status.toLowerCase()}`;
        return { booking: after ? bookingWire(after) : null, message };
    });
}

export async function deskBook(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, sessionOid: string, memberOid: string) {
    return withBranchTx(deps.db, ctx, tx => bookMember(tx, ctx, now, sessionOid, memberOid, 'desk'));
}

/**
 * For attendance: a desk check-in from `ARRIVAL_MINUTES` before a booked class until its end marks it
 * Attended. Runs in the check-in's transaction; returns the classes marked.
 */
export async function markArrival(tx: Queryable, ctx: BranchContext, memberOid: string, at: Date): Promise<string[]> {
    const rows = await tx.query<{ oid: string; title: string }>(sql`
        update booking k set status = 'Attended', updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
        from class_session c
        where c.oid = k.session_oid and k.member_oid = ${memberOid} and k.branch_oid = ${ctx.branchOid} and k.status = 'Booked'
          and c.cancelled_at is null and c.starts_at - make_interval(mins => ${ARRIVAL_MINUTES}) <= ${at} and ${at} < c.ends_at
        returning k.oid, c.title`);
    for (const r of rows)
        await recordAudit(tx, ctx, { action: 'mark_attended', entity: 'booking', entityKey: r.oid, before: null, after: { at, by: 'check-in' } });
    return rows.map(r => r.title);
}

/* ---------- the member portal ---------- */

/** For the portal home: the member's next booked (or waitlisted) class, with its session. Caller's transaction. */
export async function nextBooking(tx: Queryable, memberOid: string, now: Date) {
    const [b] = await tx.query<BookingRow>(sql`
        select k.oid, k.branch_oid, k.session_oid, k.member_oid, k.member_code, k.member_name, k.status, k.late_cancel, k.source, k.booked_at
        from booking k join class_session c on c.oid = k.session_oid
        where k.member_oid = ${memberOid} and k.status in ('Booked', 'Waitlist') and c.starts_at > ${now} and c.cancelled_at is null
        order by c.starts_at limit 1`);
    if (!b) return null;
    const s = await schedulingRepo.session(tx, b.session_oid, b.branch_oid);
    return s ? { ...bookingWire(b), session: sessionWire(s) } : null;
}

export async function memberBookings(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, memberOid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const rules = await readOrgRules(tx);
        const last = addDays(now.date, rules.booking_open_days);
        await prepare(tx, ctx, now, now.date, last);
        const m = await memberAt(tx, ctx, memberOid, now.date);
        const sessions = (await schedulingRepo.sessions(tx, ctx.branchOid, now.date, last)).filter(
            s => s.starts_at > now.at && !s.cancelled_at && (!s.ladies_only || m.gender === 'Female')
        );
        const mine = await tx.query<BookingRow>(sql`
            select k.oid, k.branch_oid, k.session_oid, k.member_oid, k.member_code, k.member_name, k.status, k.late_cancel, k.source, k.booked_at
            from booking k join class_session c on c.oid = k.session_oid
            where k.member_oid = ${memberOid} and k.status in ('Booked', 'Waitlist') and c.starts_at > ${now.at}
            order by c.starts_at`);
        const byOid = new Map((await Promise.all(mine.map(b => schedulingRepo.session(tx, b.session_oid, ctx.branchOid)))).map(s => [s?.oid, s]));
        const until = await bookingBlockedUntil(tx, memberOid, now.at);
        return {
            upcoming: mine.flatMap(b => {
                const s = byOid.get(b.session_oid);
                return s ? [{ ...bookingWire(b), session: sessionWire(s) }] : [];
            }),
            available: sessions.map(sessionWire),
            rules: {
                open_days: rules.booking_open_days,
                max_active: rules.booking_max_active,
                cancel_hours: rules.booking_cancel_hours,
                blocked_until: until ? dhakaIso(until) : null
            }
        };
    });
}

export async function portalBook(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, memberOid: string, sessionOid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const out = await bookMember(tx, ctx, now, sessionOid, memberOid, 'portal');
        return { booking: out.booking, message: out.booking.status === 'Waitlist' ? 'The class is full: you are on the waitlist' : 'Class booked' };
    });
}

export async function portalCancel(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, memberOid: string, bookingOid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const b = await schedulingRepo.booking(tx, bookingOid, ctx.branchOid, true);
        if (b?.member_oid !== memberOid) throw new AppError(404, 'Booking not found');
        return cancelBooking(tx, ctx, now, b);
    });
}

/* ---------- rules (weekly), one-off classes, changes and cancels ---------- */

interface Slot {
    trainer_oid: string;
    room_oid: string;
    class_type_oid: string;
    weekdays: number[];
    start_time: string;
    minutes: number;
    capacity: number;
    ladies_only: boolean;
    valid_from: string;
    valid_to: string | null;
}

/** The checks a rule must pass: the trainer works here (a woman for ladies-only), the room fits, the hours, no clash. */
async function checkSlot(tx: Queryable, ctx: BranchContext, slot: Slot, exceptRule: string | null) {
    const type = await schedulingRepo.classType(tx, slot.class_type_oid);
    if (!type?.active) throw new AppError(400, 'Choose an active class type', [{ path: 'class_type_oid', message: 'Unknown class type' }]);
    const { trainer, room } = await trainerAndRoom(tx, ctx, slot.trainer_oid, slot.room_oid, slot.capacity, slot.ladies_only);
    const end = endOf(slot.start_time, slot.minutes);
    if (!end) throw new AppError(400, 'The class must end by midnight', [{ path: 'start_time', message: 'Too late' }]);
    const branch = await hoursOf(tx, ctx.branchOid);
    const closed = firstClosedDay(branch.hours, slot.weekdays, slot.start_time, end);
    if (closed !== null)
        throw new AppError(400, `${branch.name} is not open for the whole class on ${WEEKDAY_NAMES[closed]}`, [
            { path: 'start_time', message: 'Outside opening hours' }
        ]);
    const others = (await schedulingRepo.schedules(tx, ctx.branchOid)).filter(
        r =>
            r.active &&
            r.oid !== exceptRule &&
            (r.trainer_oid === slot.trainer_oid || r.room_oid === slot.room_oid) &&
            r.weekdays.some(d => slot.weekdays.includes(d)) &&
            (r.valid_to === null || r.valid_to >= slot.valid_from) &&
            (slot.valid_to === null || slot.valid_to >= r.valid_from) &&
            overlaps(slot.start_time, end, r.start_time, endOf(r.start_time, r.minutes) ?? '24:00')
    );
    const [clash] = others;
    if (clash) {
        const day = WEEKDAY_NAMES[clash.weekdays.find(d => slot.weekdays.includes(d)) ?? 0];
        const who = clash.room_oid === slot.room_oid ? clash.room_name : clash.trainer_name;
        throw new AppError(409, `${who} already has ${clash.type_name} on ${day} at ${clock12(clash.start_time)}.`);
    }
    return { type, trainer, room };
}

export async function listSchedules(deps: SchedulingDeps, ctx: BranchContext) {
    return withBranchTx(deps.db, ctx, async tx => (await schedulingRepo.schedules(tx, ctx.branchOid)).map(scheduleWire));
}

export async function createSchedule(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, input: ScheduleCreate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const type = await schedulingRepo.classType(tx, input.class_type_oid);
        const slot: Slot = {
            ...input,
            minutes: input.minutes ?? type?.minutes ?? 60,
            valid_from: input.valid_from ?? now.date,
            valid_to: input.valid_to ?? null
        };
        if (slot.valid_from < now.date) throw new AppError(400, 'A new rule starts today or later', [{ path: 'valid_from', message: 'In the past' }]);
        if (slot.valid_to !== null && slot.valid_to < slot.valid_from)
            throw new AppError(400, 'Ends on or after its first day', [{ path: 'valid_to', message: 'Before the start' }]);
        await checkSlot(tx, ctx, slot, null);
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into class_schedule (branch_oid, class_type_oid, trainer_oid, room_oid, weekdays, start_time, minutes, capacity, ladies_only, valid_from, valid_to, created_by)
            values (${ctx.branchOid}, ${slot.class_type_oid}, ${slot.trainer_oid}, ${slot.room_oid}, ${slot.weekdays}::int[], ${slot.start_time}::time, ${slot.minutes},
                ${slot.capacity}, ${slot.ladies_only}, ${slot.valid_from}::date, ${slot.valid_to}::date, ${ctx.actor?.oid ?? null})
            returning oid`);
        const rule = row ? await schedulingRepo.schedule(tx, row.oid, ctx.branchOid) : undefined;
        if (!rule) throw new Error('schedule insert returned no row');
        await recordAudit(tx, ctx, { action: 'create', entity: 'class_schedule', entityKey: rule.oid, before: null, after: scheduleWire(rule) });
        await schedulingRepo.materialise(tx, ctx.branchOid, now.date, addDays(now.date, FILL_DAYS));
        return scheduleWire(rule);
    });
}

async function cancelSessionIn(tx: Queryable, ctx: BranchContext, s: SessionRow, reason: string) {
    await tx.query(sql`update class_session set cancelled_at = now(), cancel_reason = ${reason} where oid = ${s.oid}`);
    const affected = (await schedulingRepo.bookings(tx, s.oid)).filter(b => b.status === 'Booked' || b.status === 'Waitlist');
    for (const b of affected) {
        await tx.query(sql`update booking set status = 'Cancelled', updated_at = now(), updated_by = ${ctx.actor?.oid ?? null} where oid = ${b.oid}`);
        const member = await memberContact(tx, b.member_oid);
        if (member)
            await notify(tx, {
                branch_oid: ctx.branchOid,
                member,
                kind: 'class_cancelled',
                subject: `Cancelled: ${s.title} on ${shortDate(s.session_date)}`,
                body: `Dear ${member.name}, ${s.title} on ${whenOf(s)} is cancelled (${reason}). Your booking is cancelled too; sorry for the change.`,
                related_oid: s.oid,
                dedupe_key: `class_cancelled:${b.oid}`
            });
    }
    await recordAudit(tx, ctx, {
        action: 'cancel',
        entity: 'class_session',
        entityKey: `${s.title} ${s.session_date}`,
        before: sessionWire(s),
        after: { cancel_reason: reason, bookings_cancelled: affected.length }
    });
    return affected.length;
}

/**
 * Changes a rule. Future sessions that were not edited on their own follow it: with no bookings they are made
 * again; with bookings they change in place, or are cancelled (with a message) when the rule no longer runs that day.
 */
export async function updateSchedule(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, oid: string, input: ScheduleUpdate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await schedulingRepo.schedule(tx, oid, ctx.branchOid, true);
        if (!before) throw new AppError(404, 'Class rule not found');
        const slot: Slot = {
            class_type_oid: before.class_type_oid,
            trainer_oid: input.trainer_oid ?? before.trainer_oid,
            room_oid: input.room_oid ?? before.room_oid,
            weekdays: input.weekdays ?? before.weekdays,
            start_time: input.start_time ?? before.start_time,
            minutes: input.minutes ?? before.minutes,
            capacity: input.capacity ?? before.capacity,
            ladies_only: input.ladies_only ?? before.ladies_only,
            valid_from: before.valid_from,
            valid_to: input.valid_to !== undefined ? input.valid_to : before.valid_to
        };
        const active = input.active ?? before.active;
        if (slot.valid_to !== null && slot.valid_to < now.date)
            throw new AppError(400, 'End a rule today or later', [{ path: 'valid_to', message: 'In the past' }]);
        if (active) await checkSlot(tx, ctx, slot, oid);
        await tx.query(sql`
            update class_schedule set trainer_oid = ${slot.trainer_oid}, room_oid = ${slot.room_oid}, weekdays = ${slot.weekdays}::int[],
                start_time = ${slot.start_time}::time, minutes = ${slot.minutes}, capacity = ${slot.capacity}, ladies_only = ${slot.ladies_only},
                valid_to = ${slot.valid_to}::date, active = ${active}, updated_at = now()
            where oid = ${oid}`);
        const rule = await schedulingRepo.schedule(tx, oid, ctx.branchOid);
        if (!rule) throw new Error('schedule vanished inside its own transaction');
        const future = (await schedulingRepo.sessions(tx, ctx.branchOid, now.date, addDays(now.date, 366))).filter(
            s => s.schedule_oid === oid && !s.detached && !s.cancelled_at && s.starts_at > now.at
        );
        let moved = 0;
        let cancelled = 0;
        for (const s of future) {
            const wd = new Date(`${s.session_date}T00:00:00Z`).getUTCDay();
            const runs = active && rule.weekdays.includes(wd) && (rule.valid_to === null || s.session_date <= rule.valid_to);
            const live = s.booked + s.waitlist;
            if (live === 0) {
                await tx.query(sql`delete from booking where session_oid = ${s.oid}`);
                await tx.query(sql`delete from class_session where oid = ${s.oid}`);
            } else if (runs) {
                const [trainer] = await tx.query<{ name: string }>(
                    sql`select u.name from trainer t join app_user u on u.oid = t.user_oid where t.oid = ${rule.trainer_oid}`
                );
                await tx.query(sql`
                    update class_session set trainer_oid = ${rule.trainer_oid}, trainer_name = ${trainer?.name ?? s.trainer_name}, room_oid = ${rule.room_oid},
                        room_name = ${rule.room_name}, capacity = ${rule.capacity}, ladies_only = ${rule.ladies_only},
                        starts_at = ${dhakaInstant(s.session_date, rule.start_time)},
                        ends_at = ${new Date(dhakaInstant(s.session_date, rule.start_time).getTime() + rule.minutes * 60_000)}
                    where oid = ${s.oid}`);
                moved++;
            } else {
                await cancelSessionIn(tx, ctx, s, 'The timetable changed');
                cancelled++;
            }
        }
        if (active) await schedulingRepo.materialise(tx, ctx.branchOid, now.date, addDays(now.date, FILL_DAYS));
        await recordAudit(tx, ctx, {
            action: 'update',
            entity: 'class_schedule',
            entityKey: oid,
            before: scheduleWire(before),
            after: { ...scheduleWire(rule), sessions_changed: moved, sessions_cancelled: cancelled }
        });
        return { ...scheduleWire(rule), sessions_changed: moved, sessions_cancelled: cancelled };
    });
}

/** Checks one dated class against the trainer's and room's other classes and PT, the hours, leave and maintenance. */
async function checkDated(
    tx: Queryable,
    ctx: BranchContext,
    s: { date: string; start_time: string; minutes: number; trainer_oid: string; room_oid: string },
    except: string | null
) {
    const end = endOf(s.start_time, s.minutes);
    if (!end) throw new AppError(400, 'The class must end by midnight', [{ path: 'start_time', message: 'Too late' }]);
    const branch = await hoursOf(tx, ctx.branchOid);
    const wd = new Date(`${s.date}T00:00:00Z`).getUTCDay();
    if (!withinHours(branch.hours, wd, s.start_time, end))
        throw new AppError(400, `${branch.name} is not open for the whole class`, [{ path: 'start_time', message: 'Outside opening hours' }]);
    const from = dhakaInstant(s.date, s.start_time);
    const to = new Date(from.getTime() + s.minutes * 60_000);
    if (await schedulingRepo.onLeave(tx, s.trainer_oid, s.date)) throw new AppError(409, 'The trainer is off that day.');
    const blocked = await schedulingRepo.roomBlocked(tx, s.room_oid, from, to);
    if (blocked) throw new AppError(409, `The room is closed for maintenance then (${blocked}).`);
    const [clash] = await schedulingRepo.clashes(tx, ctx.branchOid, { from, to }, s, except);
    if (clash)
        throw new AppError(409, `${clash.trainer ? 'The trainer' : 'The room'} is taken then: ${clash.title} at ${clock12(dhakaNow(clash.starts_at).time)}.`);
    return { from, to };
}

export async function createOneOff(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, input: OneOffCreate) {
    return withBranchTx(deps.db, ctx, async tx => {
        if (input.date < now.date) throw new AppError(400, 'A class is added for today or later', [{ path: 'date', message: 'In the past' }]);
        const type = await schedulingRepo.classType(tx, input.class_type_oid);
        if (!type?.active) throw new AppError(400, 'Choose an active class type', [{ path: 'class_type_oid', message: 'Unknown class type' }]);
        const minutes = input.minutes ?? type.minutes;
        const { trainer, room } = await trainerAndRoom(tx, ctx, input.trainer_oid, input.room_oid, input.capacity, input.ladies_only);
        // A dated class is checked against the dated classes and PT around it (not against weekly rules).
        const { from, to } = await checkDated(tx, ctx, { ...input, minutes }, null);
        if (from <= now.at) throw new AppError(400, 'That time has passed', [{ path: 'start_time', message: 'In the past' }]);
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into class_session (branch_oid, schedule_oid, session_date, class_type_oid, title, color, trainer_oid, trainer_name, room_oid, room_name,
                starts_at, ends_at, capacity, ladies_only, detached)
            values (${ctx.branchOid}, null, ${input.date}::date, ${type.oid}, ${type.name}, ${type.color}, ${trainer.oid}, ${trainer.name},
                ${room.oid}, ${room.name}, ${from}, ${to}, ${input.capacity}, ${input.ladies_only}, true)
            returning oid`);
        const s = row ? await sessionAt(tx, ctx, row.oid) : undefined;
        if (!s) throw new Error('session insert returned no row');
        await recordAudit(tx, ctx, {
            action: 'create',
            entity: 'class_session',
            entityKey: `${s.title} ${s.session_date}`,
            before: null,
            after: sessionWire(s)
        });
        return sessionWire(s);
    });
}

/** The trainer works here (a woman for ladies-only) and the room is open and big enough. */
async function trainerAndRoom(tx: Queryable, ctx: BranchContext, trainerOid: string, roomOid: string, capacity: number, ladiesOnly: boolean) {
    const trainer = await schedulingRepo.trainer(tx, trainerOid, [ctx.branchOid]);
    if (!trainer || !(await schedulingRepo.worksAt(tx, trainerOid, ctx.branchOid)))
        throw new AppError(400, 'The trainer does not work at this branch', [{ path: 'trainer_oid', message: 'Not at this branch' }]);
    if (ladiesOnly && trainer.gender !== 'Female')
        throw new AppError(400, 'A ladies-only class has a female trainer', [{ path: 'trainer_oid', message: 'Choose a female trainer' }]);
    const room = await schedulingRepo.room(tx, roomOid, ctx.branchOid);
    if (!room?.active) throw new AppError(400, 'Choose an open room at this branch', [{ path: 'room_oid', message: 'Unknown room' }]);
    if (capacity > room.capacity)
        throw new AppError(400, `${room.name} holds ${room.capacity}`, [{ path: 'capacity', message: `At most ${room.capacity} in ${room.name}` }]);
    return { trainer, room };
}

/** Edits one class on its own (it no longer follows its rule). Booked members keep their places. */
export async function updateSession(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, oid: string, input: SessionUpdate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const s = await sessionAt(tx, ctx, oid, true);
        if (s.cancelled_at) throw new AppError(409, 'This class was cancelled.');
        if (s.starts_at <= now.at) throw new AppError(409, 'This class has already started.');
        const trainerOid = input.trainer_oid ?? s.trainer_oid;
        const roomOid = input.room_oid ?? s.room_oid;
        const startTime = input.start_time ?? dhakaNow(s.starts_at).time;
        const minutes = input.minutes ?? Math.round((s.ends_at.getTime() - s.starts_at.getTime()) / 60_000);
        const capacity = input.capacity ?? s.capacity;
        const { trainer, room } = await trainerAndRoom(tx, ctx, trainerOid, roomOid, capacity, s.ladies_only);
        if (capacity < s.booked) throw new AppError(409, `${s.booked} members are booked: cancel some bookings first, or keep at least ${s.booked} places.`);
        const { from, to } = await checkDated(
            tx,
            ctx,
            { date: s.session_date, start_time: startTime, minutes, trainer_oid: trainerOid, room_oid: roomOid },
            s.oid
        );
        await tx.query(sql`
            update class_session set trainer_oid = ${trainerOid}, trainer_name = ${trainer.name}, room_oid = ${roomOid}, room_name = ${room.name},
                starts_at = ${from}, ends_at = ${to}, capacity = ${capacity}, detached = true
            where oid = ${s.oid}`);
        await promote(tx, ctx, now, s.oid);
        const after = await sessionAt(tx, ctx, s.oid);
        await recordAudit(tx, ctx, {
            action: 'update',
            entity: 'class_session',
            entityKey: `${s.title} ${s.session_date}`,
            before: sessionWire(s),
            after: sessionWire(after)
        });
        return detailOf(tx, after);
    });
}

export async function cancelSession(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, oid: string, reason: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const s = await sessionAt(tx, ctx, oid, true);
        if (s.cancelled_at) throw new AppError(409, 'This class is already cancelled.');
        if (s.ends_at <= now.at) throw new AppError(409, 'This class is over.');
        const n = await cancelSessionIn(tx, ctx, s, reason);
        return { cancelled: true, bookings_cancelled: n };
    });
}

/* ---------- the public timetable ---------- */

export async function publicWeek(deps: SchedulingDeps, branchSlug: string, now: DhakaNow, week: string | undefined) {
    const [b] = await deps.db.query<{ oid: string }>(sql`select oid from branch where kind = 'BRANCH' and status = 'Active' and slug = ${branchSlug}`);
    if (!b) throw new AppError(404, 'Branch not found');
    const from = weekStart(week ?? now.date);
    const to = addDays(from, 6);
    const ctx = systemContext(b.oid);
    return withBranchTx(deps.db, ctx, async tx => {
        const last = addDays(now.date, FILL_DAYS);
        if (from <= last) await schedulingRepo.materialise(tx, b.oid, from, to < last ? to : last);
        const sessions = (await schedulingRepo.sessions(tx, b.oid, from, to)).filter(s => !s.cancelled_at);
        // Counts are the branch's business: the public sees the class, not who booked it.
        return { from, to, sessions: sessions.map(s => ({ ...sessionWire(s), booked: 0, waitlist: 0, full: s.booked >= s.capacity })) };
    });
}

/* ---------- class types (HQ) and rooms ---------- */

export async function listClassTypes(deps: SchedulingDeps, ctx: BranchContext) {
    return withBranchTx(deps.db, ctx, tx => schedulingRepo.classTypes(tx, false));
}

export async function saveClassType(
    deps: SchedulingDeps,
    ctx: BranchContext,
    oid: string | null,
    input: {
        name?: string | undefined;
        description?: string | null | undefined;
        color?: string | undefined;
        minutes?: number | undefined;
        sort_order?: number | undefined;
        active?: boolean | undefined;
    }
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = oid ? await schedulingRepo.classType(tx, oid) : null;
        if (oid && !before) throw new AppError(404, 'Class type not found');
        const name = input.name ?? before?.name;
        const [taken] = await tx.query<{ x: boolean }>(
            sql`select true as x from class_type where lower(name) = lower(${name ?? ''}) and oid is distinct from ${oid}::uuid`
        );
        if (taken) throw new AppError(409, 'A class type has this name', [{ path: 'name', message: 'Taken' }]);
        let key = oid;
        if (!oid) {
            const [row] = await tx.query<{ oid: string }>(sql`
                insert into class_type (branch_oid, name, description, color, minutes, sort_order, updated_by)
                values (${ctx.branchOid}, ${name}, ${input.description ?? null}, ${input.color}, ${input.minutes}, ${input.sort_order ?? 0}, ${ctx.actor?.oid ?? null})
                returning oid`);
            key = row?.oid ?? null;
        } else
            await tx.query(sql`
                update class_type set name = ${name}, description = case when ${input.description !== undefined} then ${input.description ?? null}::text else description end,
                    color = coalesce(${input.color ?? null}::text, color), minutes = coalesce(${input.minutes ?? null}::int, minutes),
                    sort_order = coalesce(${input.sort_order ?? null}::int, sort_order), active = coalesce(${input.active ?? null}::boolean, active),
                    updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
                where oid = ${oid}`);
        const after = key ? await schedulingRepo.classType(tx, key) : undefined;
        if (!after) throw new Error('class type vanished inside its own transaction');
        await recordAudit(tx, ctx, { action: oid ? 'update' : 'create', entity: 'class_type', entityKey: after.name, before: before ?? null, after });
        return after;
    });
}

export async function listRooms(deps: SchedulingDeps, ctx: BranchContext) {
    return withBranchTx(deps.db, ctx, tx => schedulingRepo.rooms(tx, ctx.branchOid));
}

export async function saveRoom(
    deps: SchedulingDeps,
    ctx: BranchContext,
    oid: string | null,
    input: { name?: string | undefined; capacity?: number | undefined; active?: boolean | undefined }
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = oid ? await schedulingRepo.room(tx, oid, ctx.branchOid) : null;
        if (oid && !before) throw new AppError(404, 'Room not found');
        const name = input.name ?? before?.name ?? '';
        const [taken] = await tx.query<{ x: boolean }>(sql`
            select true as x from room where branch_oid = ${ctx.branchOid} and lower(name) = lower(${name}) and oid is distinct from ${oid}::uuid`);
        if (taken) throw new AppError(409, 'A room has this name', [{ path: 'name', message: 'Taken' }]);
        let key = oid;
        if (!oid) {
            const [row] = await tx.query<{ oid: string }>(sql`
                insert into room (branch_oid, name, capacity, updated_by) values (${ctx.branchOid}, ${name}, ${input.capacity}, ${ctx.actor?.oid ?? null}) returning oid`);
            key = row?.oid ?? null;
        } else {
            if (input.active === false) {
                const [used] = await tx.query<{ n: number }>(sql`select count(*)::int as n from class_schedule where room_oid = ${oid} and active`);
                if (used && used.n > 0) throw new AppError(409, `${used.n} weekly classes use this room: move them first.`);
            }
            await tx.query(sql`
                update room set name = ${name}, capacity = coalesce(${input.capacity ?? null}::int, capacity), active = coalesce(${input.active ?? null}::boolean, active),
                    updated_by = ${ctx.actor?.oid ?? null}
                where oid = ${oid} and branch_oid = ${ctx.branchOid}`);
        }
        const after = key ? await schedulingRepo.room(tx, key, ctx.branchOid) : undefined;
        if (!after) throw new Error('room vanished inside its own transaction');
        await recordAudit(tx, ctx, { action: oid ? 'update' : 'create', entity: 'room', entityKey: after.name, before: before ?? null, after });
        return after;
    });
}
