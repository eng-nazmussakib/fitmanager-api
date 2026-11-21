import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { claimKindFile, viewUrl } from '#src/features/files/files.service.ts';
import { nextCode } from '#src/features/stock/stock.repo.ts';
import { addDays, daysBetween, type DhakaNow } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import type { EquipmentCreate, EquipmentQuery, EquipmentUpdate, ServiceInput, TicketCreate, TicketUpdate } from './equipment.schema.ts';

/**
 * The equipment register and maintenance tickets (phase 6, D-098). Each branch keeps its own register. Any staff
 * member raises a ticket (`create Equipment`), with a photo and a priority, and may put the equipment out of order
 * while it is open; a manager runs it (`update Equipment`): open → in progress → fixed or cannot fix, with the
 * technician (free text) and the cost. Fixing the last ticket that put it out of order puts it back in use. A service
 * is recorded as a ticket of kind `service`, fixed on the day, and moves `last_serviced_on`; the next one is due
 * `service_every_days` later (worked out when read, D-075). Equipment is retired, never deleted.
 */
export interface EquipmentDeps {
    db: Db;
    jwtSecret: string;
    apiPrefix: string;
}

type Links = Pick<EquipmentDeps, 'jwtSecret' | 'apiPrefix'>;

/** A service is "due soon" this many days ahead. */
export const SERVICE_SOON_DAYS = 7;

interface EquipmentRow {
    oid: string;
    branch_oid: string;
    name: string;
    category: string;
    brand: string | null;
    model: string | null;
    serial: string | null;
    purchased_on: string | null;
    cost: number | null;
    warranty_until: string | null;
    room_oid: string | null;
    room_name: string | null;
    photo_file_oid: string | null;
    status: 'in_use' | 'out_of_order' | 'retired';
    service_every_days: number | null;
    last_serviced_on: string | null;
    notes: string | null;
    retired_on: string | null;
    retired_reason: string | null;
    created_on: string;
    open_tickets: number;
    spent: number;
}

interface TicketRow {
    oid: string;
    branch_oid: string;
    equipment_oid: string;
    equipment_name: string;
    code: string;
    kind: 'repair' | 'service';
    description: string;
    photo_file_oid: string | null;
    priority: 'low' | 'normal' | 'urgent';
    out_of_order: boolean;
    status: 'open' | 'in_progress' | 'fixed' | 'cannot_fix';
    technician: string | null;
    cost: number | null;
    resolution: string | null;
    raised_by_name: string;
    raised_at: Date;
    updated_at: Date;
    closed_at: Date | null;
    closed_by_name: string | null;
}

const EQUIPMENT = sql.raw(`e.oid, e.branch_oid, e.name, e.category, e.brand, e.model, e.serial, e.purchased_on::text as purchased_on,
    e.cost::float8 as cost, e.warranty_until::text as warranty_until, e.room_oid, r.name as room_name, e.photo_file_oid, e.status,
    e.service_every_days, e.last_serviced_on::text as last_serviced_on, e.notes, e.retired_on::text as retired_on, e.retired_reason,
    (e.created_at at time zone 'Asia/Dhaka')::date::text as created_on,
    (select count(*)::int from maintenance_ticket t where t.equipment_oid = e.oid and t.status in ('open', 'in_progress')) as open_tickets,
    coalesce((select sum(t.cost) from maintenance_ticket t where t.equipment_oid = e.oid), 0)::float8 as spent
    from equipment e left join room r on r.oid = e.room_oid`);

const TICKET = sql.raw(`t.oid, t.branch_oid, t.equipment_oid, e.name as equipment_name, t.code, t.kind, t.description, t.photo_file_oid, t.priority,
    t.out_of_order, t.status, t.technician, t.cost::float8 as cost, t.resolution, t.raised_by_name, t.raised_at, t.updated_at, t.closed_at, t.closed_by_name
    from maintenance_ticket t join equipment e on e.oid = t.equipment_oid`);

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** When the next service is due, from the last one (or the purchase, or when it was added). */
export function nextService(e: Pick<EquipmentRow, 'service_every_days' | 'last_serviced_on' | 'purchased_on' | 'created_on' | 'status'>): string | null {
    if (!e.service_every_days || e.status === 'retired') return null;
    return addDays(e.last_serviced_on ?? e.purchased_on ?? e.created_on, e.service_every_days);
}

export function serviceState(next: string | null, today: string): 'none' | 'ok' | 'soon' | 'due' {
    if (!next) return 'none';
    if (next <= today) return 'due';
    return daysBetween(today, next) <= SERVICE_SOON_DAYS ? 'soon' : 'ok';
}

async function equipmentWire(deps: Links, e: EquipmentRow, today: string) {
    const next = nextService(e);
    return {
        oid: e.oid,
        name: e.name,
        category: e.category,
        brand: e.brand,
        model: e.model,
        serial: e.serial,
        purchased_on: e.purchased_on,
        cost: e.cost,
        warranty_until: e.warranty_until,
        in_warranty: e.warranty_until !== null && e.warranty_until >= today,
        room: e.room_oid ? { oid: e.room_oid, name: e.room_name ?? '' } : null,
        photo_file_oid: e.photo_file_oid,
        photo_url: e.photo_file_oid ? await viewUrl(deps, { oid: e.photo_file_oid, branch_oid: e.branch_oid }) : null,
        status: e.status,
        service_every_days: e.service_every_days,
        last_serviced_on: e.last_serviced_on,
        next_service_on: next,
        service: serviceState(next, today),
        notes: e.notes,
        retired_on: e.retired_on,
        retired_reason: e.retired_reason,
        open_tickets: e.open_tickets,
        spent: e.spent
    };
}

async function ticketWire(deps: Links, t: TicketRow) {
    return {
        oid: t.oid,
        code: t.code,
        equipment: { oid: t.equipment_oid, name: t.equipment_name },
        kind: t.kind,
        description: t.description,
        photo_url: t.photo_file_oid ? await viewUrl(deps, { oid: t.photo_file_oid, branch_oid: t.branch_oid }) : null,
        priority: t.priority,
        out_of_order: t.out_of_order,
        status: t.status,
        technician: t.technician,
        cost: t.cost,
        resolution: t.resolution,
        raised_by_name: t.raised_by_name,
        raised_at: t.raised_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        closed_at: iso(t.closed_at),
        closed_by_name: t.closed_by_name
    };
}

async function equipmentRow(tx: Queryable, ctx: BranchContext, oid: string, lock = false): Promise<EquipmentRow> {
    const [e] = await tx.query<EquipmentRow>(sql`
        select ${EQUIPMENT} where e.oid = ${oid} and e.branch_oid = ${ctx.branchOid} ${lock ? sql.raw('for update of e') : sql.raw('')}`);
    if (!e) throw new AppError(404, 'Equipment not found');
    return e;
}

async function checkRoom(tx: Queryable, ctx: BranchContext, roomOid: string | null | undefined): Promise<void> {
    if (!roomOid) return;
    const [r] = await tx.query<{ oid: string }>(sql`select oid from room where oid = ${roomOid} and branch_oid = ${ctx.branchOid}`);
    if (!r) throw new AppError(400, 'Choose a room at this branch', [{ path: 'room_oid', message: 'Unknown room' }]);
}

export async function listEquipment(deps: EquipmentDeps, ctx: BranchContext, today: string, q: EquipmentQuery) {
    const rows = await withBranchTx(deps.db, ctx, tx => tx.query<EquipmentRow>(sql`select ${EQUIPMENT} where e.branch_oid = ${ctx.branchOid} order by e.name`));
    // Left out: everything but retired; `all`: retired too.
    const status = q.status;
    const term = q.q?.toLowerCase();
    const list = await Promise.all(rows.map(e => equipmentWire(deps, e, today)));
    const shown = list.filter(
        e =>
            (status === undefined ? e.status !== 'retired' : status === 'all' || e.status === status) &&
            (q.due !== '1' || e.service === 'due' || e.service === 'soon') &&
            (!term || [e.name, e.brand, e.model, e.serial].some(x => x?.toLowerCase().includes(term)))
    );
    return {
        rows: shown,
        counts: {
            in_use: list.filter(e => e.status === 'in_use').length,
            out_of_order: list.filter(e => e.status === 'out_of_order').length,
            retired: list.filter(e => e.status === 'retired').length,
            service_due: list.filter(e => e.service === 'due').length
        }
    };
}

export async function getEquipment(deps: EquipmentDeps, ctx: BranchContext, today: string, oid: string) {
    const { e, tickets } = await withBranchTx(deps.db, ctx, async tx => ({
        e: await equipmentRow(tx, ctx, oid),
        tickets: await tx.query<TicketRow>(sql`select ${TICKET} where t.equipment_oid = ${oid} order by t.raised_at desc`)
    }));
    return { ...(await equipmentWire(deps, e, today)), tickets: await Promise.all(tickets.map(t => ticketWire(deps, t))) };
}

export async function createEquipment(deps: EquipmentDeps, ctx: BranchContext, today: string, input: EquipmentCreate) {
    const e = await withBranchTx(deps.db, ctx, async tx => {
        await checkRoom(tx, ctx, input.room_oid);
        if (input.photo_file_oid) await claimKindFile(tx, ctx.branchOid, input.photo_file_oid, 'equipment_photo');
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into equipment (branch_oid, name, category, brand, model, serial, purchased_on, cost, warranty_until, room_oid, photo_file_oid,
                service_every_days, last_serviced_on, notes, updated_by)
            values (${ctx.branchOid}, ${input.name}, ${input.category}, ${input.brand ?? null}, ${input.model ?? null}, ${input.serial ?? null},
                ${input.purchased_on ?? null}, ${input.cost ?? null}, ${input.warranty_until ?? null}, ${input.room_oid ?? null},
                ${input.photo_file_oid ?? null}, ${input.service_every_days ?? null}, ${input.last_serviced_on ?? null}, ${input.notes ?? null},
                ${ctx.actor?.oid ?? null})
            returning oid`);
        if (!row) throw new Error('equipment insert returned no row');
        const saved = await equipmentRow(tx, ctx, row.oid);
        await recordAudit(tx, ctx, { action: 'create', entity: 'equipment', entityKey: saved.name, before: null, after: saved });
        return saved;
    });
    return equipmentWire(deps, e, today);
}

export async function updateEquipment(deps: EquipmentDeps, ctx: BranchContext, today: string, oid: string, input: EquipmentUpdate) {
    const e = await withBranchTx(deps.db, ctx, async tx => {
        const before = await equipmentRow(tx, ctx, oid, true);
        if (before.status === 'retired') throw new AppError(409, 'This equipment is retired.');
        if (input.room_oid !== undefined && input.room_oid !== before.room_oid) await checkRoom(tx, ctx, input.room_oid);
        if (input.photo_file_oid && input.photo_file_oid !== before.photo_file_oid)
            await claimKindFile(tx, ctx.branchOid, input.photo_file_oid, 'equipment_photo');
        const pick = <K extends keyof EquipmentUpdate & keyof EquipmentRow>(k: K) => (input[k] === undefined ? before[k] : input[k]);
        await tx.query(sql`
            update equipment set name = ${pick('name')}, category = ${pick('category')}, brand = ${pick('brand')}, model = ${pick('model')},
                serial = ${pick('serial')}, purchased_on = ${pick('purchased_on')}, cost = ${pick('cost')}, warranty_until = ${pick('warranty_until')},
                room_oid = ${pick('room_oid')}, photo_file_oid = ${pick('photo_file_oid')}, service_every_days = ${pick('service_every_days')},
                last_serviced_on = ${pick('last_serviced_on')}, notes = ${pick('notes')}, updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
            where oid = ${oid}`);
        const after = await equipmentRow(tx, ctx, oid);
        await recordAudit(tx, ctx, { action: 'update', entity: 'equipment', entityKey: before.name, before, after });
        return after;
    });
    return equipmentWire(deps, e, today);
}

export async function retireEquipment(deps: EquipmentDeps, ctx: BranchContext, now: DhakaNow, oid: string, reason: string) {
    const e = await withBranchTx(deps.db, ctx, async tx => {
        const before = await equipmentRow(tx, ctx, oid, true);
        if (before.status === 'retired') throw new AppError(409, 'This equipment is already retired.');
        if (before.open_tickets > 0) throw new AppError(409, 'Close its open tickets first.');
        await tx.query(sql`
            update equipment set status = 'retired', retired_on = ${now.date}, retired_reason = ${reason}, updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
            where oid = ${oid}`);
        const after = await equipmentRow(tx, ctx, oid);
        await recordAudit(tx, ctx, {
            action: 'retire',
            entity: 'equipment',
            entityKey: before.name,
            before: { status: before.status },
            after: { status: 'retired', reason }
        });
        return after;
    });
    return equipmentWire(deps, e, now.date);
}

/** A service done on a day: a `service` ticket recorded fixed, with the technician and cost; the next one is due from it. */
export async function recordService(deps: EquipmentDeps, ctx: BranchContext, now: DhakaNow, oid: string, input: ServiceInput) {
    const day = input.on ?? now.date;
    if (day > now.date || day < addDays(now.date, -30))
        throw new AppError(400, 'A service is dated today or up to 30 days back.', [{ path: 'on', message: 'Out of range' }]);
    await withBranchTx(deps.db, ctx, async tx => {
        const e = await equipmentRow(tx, ctx, oid, true);
        if (e.status === 'retired') throw new AppError(409, 'This equipment is retired.');
        const code = await nextCode(tx, ctx.branchOid, 'TKT', 'ticket', 5, null);
        await tx.query(sql`
            insert into maintenance_ticket (branch_oid, equipment_oid, code, kind, description, priority, status, technician, cost, resolution,
                raised_by, raised_by_name, raised_at, updated_at, closed_at, closed_by_name)
            values (${ctx.branchOid}, ${oid}, ${code}, 'service', 'Scheduled service', 'normal', 'fixed', ${input.technician}, ${input.cost ?? null},
                ${input.note ?? null}, ${ctx.actor?.oid ?? null}, ${ctx.actor?.name ?? ''}, ${now.at}, ${now.at}, ${now.at}, ${ctx.actor?.name ?? ''})`);
        await tx.query(sql`
            update equipment set last_serviced_on = greatest(coalesce(last_serviced_on, ${day}::date), ${day}::date), updated_at = now() where oid = ${oid}`);
        await recordAudit(tx, ctx, {
            action: 'service',
            entity: 'equipment',
            entityKey: e.name,
            before: { last_serviced_on: e.last_serviced_on },
            after: { ticket: code, on: day, technician: input.technician, cost: input.cost ?? null }
        });
    });
    return getEquipment(deps, ctx, now.date, oid);
}

/* ---------- tickets ---------- */

export async function listTickets(deps: EquipmentDeps, ctx: BranchContext, status: 'open' | 'closed' | 'all') {
    const filter =
        status === 'open' ? sql`and t.status in ('open', 'in_progress')` : status === 'closed' ? sql`and t.status in ('fixed', 'cannot_fix')` : sql``;
    const rows = await withBranchTx(deps.db, ctx, tx =>
        tx.query<TicketRow>(sql`
            select ${TICKET} where t.branch_oid = ${ctx.branchOid} and t.kind = 'repair' ${filter}
            order by (t.status in ('open', 'in_progress')) desc, (t.priority = 'urgent') desc, t.raised_at desc limit 200`)
    );
    return Promise.all(rows.map(t => ticketWire(deps, t)));
}

async function ticketRow(tx: Queryable, ctx: BranchContext, oid: string): Promise<TicketRow> {
    const [t] = await tx.query<TicketRow>(sql`select ${TICKET} where t.oid = ${oid} and t.branch_oid = ${ctx.branchOid} for update of t`);
    if (!t) throw new AppError(404, 'Ticket not found');
    return t;
}

export async function raiseTicket(deps: EquipmentDeps, ctx: BranchContext, now: DhakaNow, equipmentOid: string, input: TicketCreate) {
    const t = await withBranchTx(deps.db, ctx, async tx => {
        const e = await equipmentRow(tx, ctx, equipmentOid, true);
        if (e.status === 'retired') throw new AppError(409, 'This equipment is retired.');
        if (input.photo_file_oid) await claimKindFile(tx, ctx.branchOid, input.photo_file_oid, 'ticket_photo');
        const code = await nextCode(tx, ctx.branchOid, 'TKT', 'ticket', 5, null);
        const outOfOrder = input.out_of_order ?? false;
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into maintenance_ticket (branch_oid, equipment_oid, code, description, photo_file_oid, priority, out_of_order, raised_by, raised_by_name,
                raised_at, updated_at)
            values (${ctx.branchOid}, ${equipmentOid}, ${code}, ${input.description}, ${input.photo_file_oid ?? null}, ${input.priority ?? 'normal'},
                ${outOfOrder}, ${ctx.actor?.oid ?? null}, ${ctx.actor?.name ?? ''}, ${now.at}, ${now.at})
            returning oid`);
        if (outOfOrder && e.status === 'in_use')
            await tx.query(sql`update equipment set status = 'out_of_order', updated_at = now() where oid = ${equipmentOid}`);
        if (!row) throw new Error('maintenance_ticket insert returned no row');
        const saved = await ticketRow(tx, ctx, row.oid);
        await recordAudit(tx, ctx, {
            action: 'create',
            entity: 'maintenance_ticket',
            entityKey: code,
            before: null,
            after: { equipment: e.name, description: input.description, priority: saved.priority, out_of_order: outOfOrder }
        });
        return saved;
    });
    return ticketWire(deps, t);
}

export async function updateTicket(deps: EquipmentDeps, ctx: BranchContext, now: DhakaNow, oid: string, input: TicketUpdate) {
    const t = await withBranchTx(deps.db, ctx, async tx => {
        const before = await ticketRow(tx, ctx, oid);
        if (before.status === 'fixed' || before.status === 'cannot_fix') throw new AppError(409, 'This ticket is closed.');
        const status = input.status ?? before.status;
        const closing = status === 'fixed' || status === 'cannot_fix';
        const resolution = input.resolution === undefined ? before.resolution : input.resolution;
        if (status === 'cannot_fix' && !resolution) throw new AppError(400, 'Say why it cannot be fixed', [{ path: 'resolution', message: 'Required' }]);
        await tx.query(sql`
            update maintenance_ticket set status = ${status}, priority = ${input.priority ?? before.priority},
                technician = ${input.technician === undefined ? before.technician : input.technician},
                cost = ${input.cost === undefined ? before.cost : input.cost}, resolution = ${resolution}, updated_at = ${now.at},
                closed_at = ${closing ? now.at : null}, closed_by_name = ${closing ? (ctx.actor?.name ?? '') : null}
            where oid = ${oid}`);
        // Fixed, and no other open ticket keeps it out of order: back in use.
        if (status === 'fixed') {
            const [other] = await tx.query<{ n: number }>(sql`
                select count(*)::int as n from maintenance_ticket
                where equipment_oid = ${before.equipment_oid} and oid <> ${oid} and out_of_order and status in ('open', 'in_progress')`);
            if (!other?.n)
                await tx.query(sql`update equipment set status = 'in_use', updated_at = now() where oid = ${before.equipment_oid} and status = 'out_of_order'`);
        }
        const after = await ticketRow(tx, ctx, oid);
        await recordAudit(tx, ctx, {
            action: closing ? 'close' : 'update',
            entity: 'maintenance_ticket',
            entityKey: before.code,
            before: { status: before.status, technician: before.technician, cost: before.cost },
            after: { status: after.status, technician: after.technician, cost: after.cost, resolution: after.resolution }
        });
        return after;
    });
    return ticketWire(deps, t);
}
