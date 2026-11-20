import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { endDate } from '#src/features/pricing/pricing.ts';
import { chargeItem, type PaymentInput } from '#src/features/sales/sales.service.ts';
import { addDays, dhakaIso, type DhakaNow, shortDate } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import type { RentInput } from './scheduling.schema.ts';
import type { SchedulingDeps } from './trainers.service.ts';

/**
 * Facilities (phase 3, D-082): lockers and their rentals, and maintenance blocks on a room or a locker. A rental is
 * charged on its own invoice (kind `locker`), through the sales service. It ends on its end date (worked out when
 * read, D-075) or early, when the desk takes the key back. A blocked locker cannot be rented; a blocked room takes
 * no new classes or PT, and the classes already in it show as blocked for the manager to move or cancel.
 */
interface LockerRow {
    oid: string;
    number: string;
    size: 'S' | 'M' | 'L';
    monthly_fee: number;
    active: boolean;
    rental_oid: string | null;
    member_oid: string | null;
    member_code: string | null;
    member_name: string | null;
    start_date: string | null;
    end_date: string | null;
    invoice_oid: string | null;
    blocked_reason: string | null;
    blocked_until: Date | null;
}

/** A rental is running on `today` when it started, has not passed its end date, and was not ended (`ended_on`: the day the key came back). */
const running = (today: string) => sql`r.start_date <= ${today}::date and ${today}::date <= r.end_date and (r.ended_on is null or r.ended_on > ${today}::date)`;

async function lockerRows(tx: Queryable, branchOid: string, now: DhakaNow, oid: string | null = null) {
    return tx.query<LockerRow>(sql`
        select l.oid, l.number, l.size, l.monthly_fee::float8 as monthly_fee, l.active,
            r.oid as rental_oid, r.member_oid, r.member_code, r.member_name, r.start_date::text as start_date, r.end_date::text as end_date, r.invoice_oid,
            mb.reason as blocked_reason, mb.ends_at as blocked_until
        from locker l
        left join lateral (select * from locker_rental r where r.locker_oid = l.oid and ${running(now.date)} order by r.start_date desc limit 1) r on true
        left join lateral (select reason, ends_at from maintenance_block b where b.locker_oid = l.oid and b.removed_at is null
            and b.starts_at <= ${now.at} and ${now.at} < b.ends_at limit 1) mb on true
        where l.branch_oid = ${branchOid} ${oid ? sql`and l.oid = ${oid}` : sql``}
        order by l.number`);
}

function lockerWire(l: LockerRow, today: string) {
    const status = !l.active ? 'Inactive' : l.blocked_reason ? 'Blocked' : l.rental_oid ? 'Rented' : 'Free';
    return {
        oid: l.oid,
        number: l.number,
        size: l.size,
        monthly_fee: l.monthly_fee,
        active: l.active,
        status,
        rental: l.rental_oid
            ? {
                  oid: l.rental_oid,
                  member_oid: l.member_oid,
                  member_code: l.member_code,
                  member_name: l.member_name,
                  start_date: l.start_date,
                  end_date: l.end_date,
                  invoice_oid: l.invoice_oid,
                  ends_soon: l.end_date !== null && l.end_date <= addDays(today, 7)
              }
            : null,
        blocked: l.blocked_reason ? { reason: l.blocked_reason, until: l.blocked_until ? dhakaIso(l.blocked_until) : null } : null
    };
}

export async function listLockers(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow) {
    return withBranchTx(deps.db, ctx, async tx => {
        const rows = (await lockerRows(tx, ctx.branchOid, now)).map(l => lockerWire(l, now.date));
        const count = (s: string) => rows.filter(r => r.status === s).length;
        return { lockers: rows, totals: { free: count('Free'), rented: count('Rented'), blocked: count('Blocked'), inactive: count('Inactive') } };
    });
}

export async function saveLocker(
    deps: SchedulingDeps,
    ctx: BranchContext,
    now: DhakaNow,
    oid: string | null,
    input: { number?: string | undefined; size?: 'S' | 'M' | 'L' | undefined; monthly_fee?: number | undefined; active?: boolean | undefined }
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [before] = oid ? await lockerRows(tx, ctx.branchOid, now, oid) : [];
        if (oid && !before) throw new AppError(404, 'Locker not found');
        let key = oid;
        if (!oid) {
            const [taken] = await tx.query<{ x: boolean }>(
                sql`select true as x from locker where branch_oid = ${ctx.branchOid} and number = ${input.number ?? ''}`
            );
            if (taken) throw new AppError(409, 'A locker has this number', [{ path: 'number', message: 'Taken' }]);
            const [row] = await tx.query<{ oid: string }>(sql`
                insert into locker (branch_oid, number, size, monthly_fee, updated_by)
                values (${ctx.branchOid}, ${input.number}, ${input.size}, ${input.monthly_fee}, ${ctx.actor?.oid ?? null}) returning oid`);
            key = row?.oid ?? null;
        } else {
            if (input.active === false && before?.rental_oid) throw new AppError(409, 'This locker is rented: end the rental first.');
            await tx.query(sql`
                update locker set size = coalesce(${input.size ?? null}::text, size), monthly_fee = coalesce(${input.monthly_fee ?? null}::numeric, monthly_fee),
                    active = coalesce(${input.active ?? null}::boolean, active), updated_by = ${ctx.actor?.oid ?? null}
                where oid = ${oid} and branch_oid = ${ctx.branchOid}`);
        }
        const [after] = await lockerRows(tx, ctx.branchOid, now, key);
        if (!after) throw new Error('locker vanished inside its own transaction');
        await recordAudit(tx, ctx, { action: oid ? 'update' : 'create', entity: 'locker', entityKey: after.number, before: before ?? null, after });
        return lockerWire(after, now.date);
    });
}

/** Rents a free locker to a home-branch member for whole months, on an invoice of its own. */
export async function rentLocker(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, lockerOid: string, input: RentInput) {
    return withBranchTx(deps.db, ctx, async tx => {
        await tx.query(sql`select 1 from locker where oid = ${lockerOid} and branch_oid = ${ctx.branchOid} for update`);
        const [l] = await lockerRows(tx, ctx.branchOid, now, lockerOid);
        if (!l) throw new AppError(404, 'Locker not found');
        if (!l.active) throw new AppError(409, 'This locker is not in use.');
        if (l.blocked_reason) throw new AppError(409, `Locker ${l.number} is out of use: ${l.blocked_reason}.`);
        if (l.rental_oid) throw new AppError(409, `Locker ${l.number} is rented to ${l.member_name ?? 'someone'} until ${shortDate(l.end_date ?? now.date)}.`);
        const start = input.start_date ?? now.date;
        if (start < now.date) throw new AppError(400, 'A rental starts today or later', [{ path: 'start_date', message: 'In the past' }]);
        const end = endDate(start, input.months);
        const [other] = await tx.query<{ number: string }>(sql`
            select l.number from locker_rental r join locker l on l.oid = r.locker_oid
            where r.member_oid = ${input.member_oid} and ${running(now.date)}`);
        if (other) throw new AppError(409, `This member already rents locker ${other.number}.`);
        const amount = Math.round(l.monthly_fee * input.months);
        const label = `Locker ${l.number} (${l.size}) · ${input.months} month${input.months === 1 ? '' : 's'}, ${shortDate(start)} to ${shortDate(end)}`;
        const payment: PaymentInput = { method: input.payment.method, amount: input.payment.amount, reference: input.payment.reference };
        const { invoice, member } = await chargeItem(tx, ctx, now, input.member_oid, { label, amount, months: input.months, kind: 'locker' }, payment);
        if (member.status === 'Pending' || member.status === 'Suspended')
            throw new AppError(409, `${member.name} cannot rent a locker (${member.status.toLowerCase()}).`);
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into locker_rental (branch_oid, locker_oid, member_oid, member_code, member_name, start_date, end_date, months, invoice_oid, created_by)
            values (${ctx.branchOid}, ${l.oid}, ${member.oid}, ${member.code}, ${member.name}, ${start}::date, ${end}::date, ${input.months}, ${invoice.oid}, ${ctx.actor?.oid ?? null})
            returning oid`);
        await recordAudit(tx, ctx, {
            action: 'rent',
            entity: 'locker',
            entityKey: l.number,
            before: null,
            after: { rental_oid: row?.oid, member_code: member.code, start_date: start, end_date: end, invoice: invoice.number }
        });
        const [after] = await lockerRows(tx, ctx.branchOid, start === now.date ? now : { ...now, date: start }, l.oid);
        return { locker: after ? lockerWire(after, now.date) : null, invoice };
    });
}

/** The desk takes the key back early: the rental ends today (no money moves; a refund is a separate step). */
export async function endRental(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow, rentalOid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [r] = await tx.query<{
            locker_oid: string;
            number: string;
            member_code: string;
            end_date: string;
            ended_on: string | null;
            start_date: string;
        }>(sql`
            select r.locker_oid, l.number, r.member_code, r.end_date::text as end_date, r.ended_on::text as ended_on, r.start_date::text as start_date
            from locker_rental r join locker l on l.oid = r.locker_oid
            where r.oid = ${rentalOid} and r.branch_oid = ${ctx.branchOid} for update of r`);
        if (!r) throw new AppError(404, 'Rental not found');
        if (r.ended_on !== null || r.end_date < now.date) throw new AppError(409, 'This rental has already ended.');
        // Not started yet: it ends on the day it would have started, so it never runs.
        const ended = r.start_date > now.date ? r.start_date : now.date;
        await tx.query(sql`update locker_rental set ended_on = ${ended}::date, ended_by = ${ctx.actor?.oid ?? null} where oid = ${rentalOid}`);
        await recordAudit(tx, ctx, { action: 'end_rental', entity: 'locker', entityKey: r.number, before: r, after: { ended_on: ended } });
        const [after] = await lockerRows(tx, ctx.branchOid, now, r.locker_oid);
        return after ? lockerWire(after, now.date) : null;
    });
}

/* ---------- maintenance blocks ---------- */

interface BlockRow {
    oid: string;
    room_oid: string | null;
    room_name: string | null;
    locker_oid: string | null;
    locker_number: string | null;
    starts_at: Date;
    ends_at: Date;
    reason: string;
    created_by_name: string | null;
}

const blockWire = (b: BlockRow, now: Date) => ({
    ...b,
    starts_at: dhakaIso(b.starts_at),
    ends_at: dhakaIso(b.ends_at),
    current: b.starts_at <= now && now < b.ends_at
});

/** Blocks not yet over, and the classes they put out of action. */
export async function listBlocks(deps: SchedulingDeps, ctx: BranchContext, now: DhakaNow) {
    return withBranchTx(deps.db, ctx, async tx => {
        const rows = await tx.query<BlockRow>(sql`
            select b.oid, b.room_oid, r.name as room_name, b.locker_oid, l.number as locker_number, b.starts_at, b.ends_at, b.reason, u.name as created_by_name
            from maintenance_block b left join room r on r.oid = b.room_oid left join locker l on l.oid = b.locker_oid
            left join app_user u on u.oid = b.created_by
            where b.branch_oid = ${ctx.branchOid} and b.removed_at is null and b.ends_at > ${now.at} order by b.starts_at`);
        const affected = await tx.query<{ oid: string; title: string; starts_at: Date; room_name: string; booked: number }>(sql`
            select c.oid, c.title, c.starts_at, c.room_name,
                (select count(*)::int from booking k where k.session_oid = c.oid and k.status in ('Booked', 'Waitlist')) as booked
            from class_session c
            where c.branch_oid = ${ctx.branchOid} and c.cancelled_at is null and c.ends_at > ${now.at}
              and exists (select from maintenance_block b where b.room_oid = c.room_oid and b.removed_at is null and b.starts_at < c.ends_at and c.starts_at < b.ends_at)
            order by c.starts_at limit 50`);
        return { blocks: rows.map(b => blockWire(b, now.at)), affected_classes: affected.map(a => ({ ...a, starts_at: dhakaIso(a.starts_at) })) };
    });
}

export async function createBlock(
    deps: SchedulingDeps,
    ctx: BranchContext,
    now: DhakaNow,
    input: { room_oid?: string | undefined; locker_oid?: string | undefined; starts_at: string; ends_at: string; reason: string }
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const from = new Date(input.starts_at);
        const to = new Date(input.ends_at);
        if (to <= now.at) throw new AppError(400, 'The block must end in the future', [{ path: 'ends_at', message: 'In the past' }]);
        if (input.room_oid) {
            const [r] = await tx.query(sql`select 1 from room where oid = ${input.room_oid} and branch_oid = ${ctx.branchOid}`);
            if (!r) throw new AppError(404, 'Room not found');
        }
        if (input.locker_oid) {
            const [l] = await tx.query(sql`select 1 from locker where oid = ${input.locker_oid} and branch_oid = ${ctx.branchOid}`);
            if (!l) throw new AppError(404, 'Locker not found');
        }
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into maintenance_block (branch_oid, room_oid, locker_oid, starts_at, ends_at, reason, created_by)
            values (${ctx.branchOid}, ${input.room_oid ?? null}, ${input.locker_oid ?? null}, ${from}, ${to}, ${input.reason}, ${ctx.actor?.oid ?? null})
            returning oid`);
        await recordAudit(tx, ctx, { action: 'create', entity: 'maintenance_block', entityKey: row?.oid ?? '', before: null, after: input });
        const [n] = input.room_oid
            ? await tx.query<{ n: number }>(sql`
                select count(*)::int as n from class_session where room_oid = ${input.room_oid} and cancelled_at is null and starts_at < ${to} and ${from} < ends_at`)
            : [{ n: 0 }];
        return { oid: row?.oid ?? null, classes_affected: n?.n ?? 0 };
    });
}

export async function removeBlock(deps: SchedulingDeps, ctx: BranchContext, oid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const rows = await tx.query<{ reason: string; room_oid: string | null; locker_oid: string | null }>(sql`
            update maintenance_block set removed_at = now(), removed_by = ${ctx.actor?.oid ?? null}
            where oid = ${oid} and branch_oid = ${ctx.branchOid} and removed_at is null returning reason, room_oid, locker_oid`);
        if (!rows.length) throw new AppError(404, 'Block not found');
        await recordAudit(tx, ctx, { action: 'remove', entity: 'maintenance_block', entityKey: oid, before: rows[0], after: null });
    });
}

/** The kind of a block's target, for the route's permission check (rooms: `manage Room`; lockers: `manage Locker`). */
export async function blockTarget(deps: SchedulingDeps, ctx: BranchContext, oid: string): Promise<'room' | 'locker'> {
    return withBranchTx(deps.db, ctx, async tx => {
        const [b] = await tx.query<{ room_oid: string | null }>(
            sql`select room_oid from maintenance_block where oid = ${oid} and branch_oid = ${ctx.branchOid}`
        );
        if (!b) throw new AppError(404, 'Block not found');
        return b.room_oid ? 'room' : 'locker';
    });
}
