import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { catalogueRepo } from '#src/features/catalogue/catalogue.service.ts';
import { hqOid, tellStaff } from '#src/features/notifications/inbox.service.ts';
import { addDays, type DhakaNow, taka as takaText } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import { moveStock, nextCode } from './stock.repo.ts';
import type { DeliveryInput, PoCreate } from './stock.schema.ts';
import type { StockDeps } from './stock.service.ts';

/**
 * Purchase orders (phase 6, D-100). A branch manager raises one to a supplier (`create PurchaseOrder`); HQ approves or
 * rejects it (`update PurchaseOrder` at HQ). It is sent by hand: the web app makes a PDF or copies the text, and the
 * manager marks it sent. The branch receives it in one or more deliveries, each line at the cost entered then
 * (default: the ordered cost), which adds the stock (`received`). It closes when everything has arrived, or when it is
 * cancelled (what arrived stays). Supplier invoices and payments are not recorded.
 *
 * pending → approved | rejected; approved → sent → partial → received; pending, approved, sent, partial → cancelled.
 */
export type PoStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'partial' | 'received' | 'cancelled';
const OPEN: readonly PoStatus[] = ['pending', 'approved', 'sent', 'partial'];
/** A delivery may be dated at most this many days back. */
const MAX_BACKDATE_DAYS = 7;

interface PoRow {
    oid: string;
    branch_oid: string;
    branch_name: string;
    branch_code: string;
    code: string;
    supplier_oid: string;
    supplier_name: string;
    supplier_phone: string | null;
    supplier_email: string | null;
    supplier_contact: string | null;
    status: PoStatus;
    note: string | null;
    total: number;
    raised_by_name: string;
    raised_at: Date;
    decided_by_name: string | null;
    decided_at: Date | null;
    decision_note: string | null;
    sent_at: Date | null;
    closed_at: Date | null;
    cancel_reason: string | null;
}

interface LineRow {
    oid: string;
    po_oid: string;
    product_oid: string;
    product_code: string;
    product_name: string;
    qty: number;
    unit_cost: number;
    received: number;
}

interface DeliveryRow {
    oid: string;
    po_oid: string;
    received_on: string;
    lines: { line_oid: string; product_oid: string; qty: number; unit_cost: number }[];
    note: string | null;
    by_name: string;
    at: Date;
}

const PO = sql.raw(`o.oid, o.branch_oid, b.name as branch_name, b.code as branch_code, o.code, o.supplier_oid, o.supplier_name, s.phone as supplier_phone,
    s.email as supplier_email, s.contact_name as supplier_contact, o.status, o.note, o.total::float8 as total, o.raised_by_name, o.raised_at,
    o.decided_by_name, o.decided_at, o.decision_note, o.sent_at, o.closed_at, o.cancel_reason
    from purchase_order o join branch b on b.oid = o.branch_oid join supplier s on s.oid = o.supplier_oid`);

const iso = (d: Date | null) => d?.toISOString() ?? null;

async function linesOf(tx: Queryable, poOids: readonly string[]): Promise<LineRow[]> {
    if (!poOids.length) return [];
    return tx.query<LineRow>(sql`
        select oid, po_oid, product_oid, product_code, product_name, qty, unit_cost::float8 as unit_cost, received
        from purchase_order_line where po_oid = any (${poOids}::uuid[]) order by po_oid, position`);
}

function poWire(o: PoRow, lines: LineRow[], deliveries: DeliveryRow[] | null) {
    const own = lines.filter(l => l.po_oid === o.oid);
    return {
        oid: o.oid,
        code: o.code,
        branch: { oid: o.branch_oid, name: o.branch_name, code: o.branch_code },
        supplier: { oid: o.supplier_oid, name: o.supplier_name, phone: o.supplier_phone, email: o.supplier_email, contact_name: o.supplier_contact },
        status: o.status,
        note: o.note,
        total: o.total,
        raised_by_name: o.raised_by_name,
        raised_at: o.raised_at.toISOString(),
        decided_by_name: o.decided_by_name,
        decided_at: iso(o.decided_at),
        decision_note: o.decision_note,
        sent_at: iso(o.sent_at),
        closed_at: iso(o.closed_at),
        cancel_reason: o.cancel_reason,
        lines: own.map(l => ({
            oid: l.oid,
            product_oid: l.product_oid,
            code: l.product_code,
            name: l.product_name,
            qty: l.qty,
            unit_cost: l.unit_cost,
            received: l.received,
            outstanding: l.qty - l.received
        })),
        ordered: own.reduce((s, l) => s + l.qty, 0),
        received: own.reduce((s, l) => s + l.received, 0),
        ...(deliveries && {
            deliveries: deliveries.map(d => ({
                oid: d.oid,
                received_on: d.received_on,
                note: d.note,
                by_name: d.by_name,
                at: d.at.toISOString(),
                lines: d.lines.map(x => ({ ...x, name: own.find(l => l.oid === x.line_oid)?.product_name ?? '' }))
            }))
        })
    };
}

async function poOut(tx: Queryable, oid: string, branchOids: readonly string[]) {
    const [o] = await tx.query<PoRow>(sql`select ${PO} where o.oid = ${oid} and o.branch_oid = any (${branchOids}::uuid[])`);
    if (!o) throw new AppError(404, 'Purchase order not found');
    const deliveries = await tx.query<DeliveryRow>(sql`
        select oid, po_oid, received_on::text as received_on, lines, note, by_name, at from delivery where po_oid = ${oid} order by at`);
    return poWire(o, await linesOf(tx, [o.oid]), deliveries);
}

async function locked(tx: Queryable, oid: string, branchOids: readonly string[]): Promise<PoRow> {
    const [o] = await tx.query<PoRow>(sql`select ${PO} where o.oid = ${oid} and o.branch_oid = any (${branchOids}::uuid[]) for update of o`);
    if (!o) throw new AppError(404, 'Purchase order not found');
    return o;
}

/** `GET /v1/purchase-orders`: a branch's own; at HQ every branch's (`status=open` by default there: pending first). */
export async function listPurchaseOrders(deps: StockDeps, ctx: BranchContext, q: { status?: string | undefined; branch_oid?: string | undefined }) {
    return withBranchTx(deps.db, ctx, async tx => {
        const status = q.status ?? 'all';
        const filter =
            status === 'all' ? sql`` : status === 'open' ? sql`and o.status in ('pending', 'approved', 'sent', 'partial')` : sql`and o.status = ${status}`;
        const branch = q.branch_oid ? sql`and o.branch_oid = ${q.branch_oid}` : sql``;
        const rows = await tx.query<PoRow>(sql`
            select ${PO} where o.branch_oid = any (${ctx.branchOids}::uuid[]) ${filter} ${branch}
            order by (o.status = 'pending') desc, o.raised_at desc limit 200`);
        const lines = await linesOf(
            tx,
            rows.map(r => r.oid)
        );
        return rows.map(r => poWire(r, lines, null));
    });
}

export const getPurchaseOrder = (deps: StockDeps, ctx: BranchContext, oid: string) => withBranchTx(deps.db, ctx, tx => poOut(tx, oid, ctx.branchOids));

export async function raisePurchaseOrder(deps: StockDeps, ctx: BranchContext, now: DhakaNow, input: PoCreate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const supplier = await catalogueRepo.supplier(tx, input.supplier_oid);
        if (!supplier?.active) throw new AppError(400, 'Choose an active supplier', [{ path: 'supplier_oid', message: 'Unknown supplier' }]);
        const products = await catalogueRepo.productsByOid(
            tx,
            input.lines.map(l => l.product_oid)
        );
        for (const l of input.lines) {
            if (!products.find(p => p.oid === l.product_oid)?.active)
                throw new AppError(400, 'A product on the order is not in the catalogue', [{ path: 'lines', message: 'Unknown product' }]);
        }
        const code = await nextCode(tx, ctx.branchOid, 'PO', `po:${now.date.slice(0, 4)}`, 4, now.date.slice(0, 4));
        const total = Math.round(input.lines.reduce((s, l) => s + l.qty * l.unit_cost, 0) * 100) / 100;
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into purchase_order (branch_oid, code, supplier_oid, supplier_name, note, total, raised_by, raised_by_name, raised_at)
            values (${ctx.branchOid}, ${code}, ${supplier.oid}, ${supplier.name}, ${input.note ?? null}, ${total}, ${ctx.actor?.oid ?? null},
                ${ctx.actor?.name ?? ''}, ${now.at})
            returning oid`);
        if (!row) throw new Error('purchase_order insert returned no row');
        let position = 0;
        for (const l of input.lines) {
            const p = products.find(x => x.oid === l.product_oid);
            if (!p) throw new AppError(400, 'A product is not in the catalogue', [{ path: 'lines', message: 'Unknown product' }]);
            await tx.query(sql`
                insert into purchase_order_line (branch_oid, po_oid, position, product_oid, product_code, product_name, qty, unit_cost)
                values (${ctx.branchOid}, ${row.oid}, ${++position}, ${p.oid}, ${p.code}, ${p.name}, ${l.qty}, ${l.unit_cost})`);
        }
        const out = await poOut(tx, row.oid, [ctx.branchOid]);
        await recordAudit(tx, ctx, { action: 'create', entity: 'purchase_order', entityKey: code, before: null, after: out });
        await tellStaff(tx, ctx, {
            to_branch_oid: await hqOid(tx),
            kind: 'po_submitted',
            subject: `${out.branch.name}: ${code} waits for approval`,
            body: `${ctx.actor?.name ?? 'The branch'} raised ${code} to ${supplier.name}, ${takaText(total)}. Approve or reject it.`,
            link: 'purchase-orders',
            related_oid: row.oid,
            dedupe_key: `po_submitted:${row.oid}`,
            at: now.at
        });
        return out;
    });
}

/** HQ approves or rejects a pending order. */
export async function decidePurchaseOrder(deps: StockDeps, ctx: BranchContext, now: DhakaNow, oid: string, approve: boolean, note: string | null) {
    return withBranchTx(deps.db, ctx, async tx => {
        const o = await locked(tx, oid, ctx.branchOids);
        if (o.status !== 'pending')
            throw new AppError(409, `This order was already ${o.status === 'rejected' ? 'rejected' : o.status === 'cancelled' ? 'cancelled' : 'approved'}.`);
        if (!approve && !note) throw new AppError(400, 'Say why it is rejected', [{ path: 'note', message: 'Required' }]);
        await tx.query(sql`
            update purchase_order set status = ${approve ? 'approved' : 'rejected'}, decided_by_name = ${ctx.actor?.name ?? ''}, decided_at = ${now.at},
                decision_note = ${note}, closed_at = ${approve ? null : now.at}
            where oid = ${oid}`);
        const out = await poOut(tx, oid, ctx.branchOids);
        await tellStaff(tx, ctx, {
            to_branch_oid: o.branch_oid,
            kind: approve ? 'po_approved' : 'po_rejected',
            subject: approve ? `${o.code} approved` : `${o.code} rejected`,
            body: approve
                ? `HQ approved ${o.code} to ${o.supplier_name}. Send it to the supplier, then receive the delivery.`
                : `HQ rejected ${o.code} to ${o.supplier_name}: ${note ?? ''}`,
            link: 'stock?tab=orders',
            related_oid: o.oid,
            dedupe_key: `po_decided:${o.oid}`,
            at: now.at
        });
        await recordAudit(tx, ctx, {
            action: approve ? 'approve' : 'reject',
            entity: 'purchase_order',
            entityKey: o.code,
            before: { status: o.status },
            after: { status: out.status, note }
        });
        return out;
    });
}

/** The manager sent it to the supplier (by hand: the PDF or the copied text). */
export async function markSent(deps: StockDeps, ctx: BranchContext, now: DhakaNow, oid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const o = await locked(tx, oid, [ctx.branchOid]);
        if (o.status === 'pending') throw new AppError(409, 'HQ has not approved this order yet.');
        if (o.status !== 'approved') throw new AppError(409, o.status === 'sent' ? 'This order was already sent.' : 'This order is closed.');
        await tx.query(sql`update purchase_order set status = 'sent', sent_at = ${now.at} where oid = ${oid}`);
        const out = await poOut(tx, oid, [ctx.branchOid]);
        await recordAudit(tx, ctx, { action: 'send', entity: 'purchase_order', entityKey: o.code, before: { status: o.status }, after: { status: 'sent' } });
        return out;
    });
}

/** A delivery: what arrived of each line, at the cost entered (default the ordered cost). Adds the stock. */
export async function receiveDelivery(deps: StockDeps, ctx: BranchContext, now: DhakaNow, oid: string, input: DeliveryInput) {
    return withBranchTx(deps.db, ctx, async tx => {
        const o = await locked(tx, oid, [ctx.branchOid]);
        if (o.status === 'pending') throw new AppError(409, 'HQ has not approved this order yet.');
        if (!(['approved', 'sent', 'partial'] as PoStatus[]).includes(o.status)) throw new AppError(409, 'This order is closed.');
        const day = input.received_on ?? now.date;
        if (day > now.date || day < addDays(now.date, -MAX_BACKDATE_DAYS))
            throw new AppError(400, `A delivery is dated today or up to ${MAX_BACKDATE_DAYS} days back.`, [{ path: 'received_on', message: 'Out of range' }]);
        const lines = await linesOf(tx, [o.oid]);
        const got: DeliveryRow['lines'] = [];
        for (const d of input.lines.filter(x => x.qty > 0)) {
            const line = lines.find(l => l.oid === d.line_oid);
            if (!line) throw new AppError(400, 'A line is not on this order', [{ path: 'lines', message: 'Unknown line' }]);
            if (d.qty > line.qty - line.received)
                throw new AppError(400, `${line.product_name}: only ${line.qty - line.received} still to come.`, [
                    { path: 'lines', message: 'More than ordered' }
                ]);
            const unitCost = d.unit_cost ?? line.unit_cost;
            await moveStock(tx, ctx, now.at, {
                product_oid: line.product_oid,
                kind: 'received',
                qty: d.qty,
                unit_cost: unitCost,
                ref_oid: o.oid,
                ref_label: o.code
            });
            await tx.query(sql`update purchase_order_line set received = received + ${d.qty} where oid = ${line.oid}`);
            line.received += d.qty;
            got.push({ line_oid: line.oid, product_oid: line.product_oid, qty: d.qty, unit_cost: unitCost });
        }
        const done = lines.every(l => l.received >= l.qty);
        const [delivery] = await tx.query<{ oid: string }>(sql`
            insert into delivery (branch_oid, po_oid, received_on, lines, note, by_oid, by_name, at)
            values (${ctx.branchOid}, ${o.oid}, ${day}, ${JSON.stringify(got)}::jsonb, ${input.note ?? null}, ${ctx.actor?.oid ?? null}, ${ctx.actor?.name ?? ''}, ${now.at})
            returning oid`);
        await tx.query(sql`
            update purchase_order set status = ${done ? 'received' : 'partial'}, sent_at = coalesce(sent_at, ${now.at}), closed_at = ${done ? now.at : null}
            where oid = ${o.oid}`);
        const out = await poOut(tx, oid, [ctx.branchOid]);
        await recordAudit(tx, ctx, {
            action: 'receive',
            entity: 'purchase_order',
            entityKey: o.code,
            before: { status: o.status },
            after: { status: out.status, delivery: delivery?.oid, lines: got }
        });
        return out;
    });
}

/** Cancelled by the branch while open: nothing more is expected (what arrived stays in stock). */
export async function cancelPurchaseOrder(deps: StockDeps, ctx: BranchContext, now: DhakaNow, oid: string, reason: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const o = await locked(tx, oid, [ctx.branchOid]);
        if (!OPEN.includes(o.status)) throw new AppError(409, 'This order is closed.');
        await tx.query(sql`update purchase_order set status = 'cancelled', cancel_reason = ${reason}, closed_at = ${now.at} where oid = ${oid}`);
        const out = await poOut(tx, oid, [ctx.branchOid]);
        await recordAudit(tx, ctx, {
            action: 'cancel',
            entity: 'purchase_order',
            entityKey: o.code,
            before: { status: o.status },
            after: { status: 'cancelled', reason }
        });
        return out;
    });
}
