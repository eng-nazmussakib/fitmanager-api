import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import type { BranchContext } from '#src/db/tenancy.ts';
import { averageCost } from '#src/features/pos/pos-pricing.ts';
import { AppError } from '#src/lib/http.ts';

/**
 * The stock ledger: every change to a branch's stock is one `stock_movement` row, written here only,
 * in the caller's transaction, with the stock row locked. Units coming in (received, returned, a transfer in, a
 * positive adjustment) move the weighted average cost; units going out leave the branch at it. Stock never goes
 * below zero: the move is refused (409) first, and the table's check would catch one that slipped through.
 */
export type MoveKind = 'received' | 'sold' | 'returned' | 'transfer_out' | 'transfer_in' | 'adjustment';
export type AdjustReason = 'damaged' | 'expired' | 'count' | 'shortfall' | 'other';

export interface Move {
    product_oid: string;
    kind: MoveKind;
    /** Signed: in > 0, out < 0. */
    qty: number;
    /** For units coming in at a cost of their own (a delivery, a transfer in, a return); else the average. */
    unit_cost?: number | undefined;
    reason?: AdjustReason | null | undefined;
    note?: string | null | undefined;
    ref_oid?: string | null | undefined;
    ref_label?: string | null | undefined;
}

export interface StockRow {
    product_oid: string;
    on_hand: number;
    avg_cost: number;
    reorder_level: number;
}

/** The branch's stock row for a product, made at the product's reorder level the first time, locked for the move. */
export async function lockStock(tx: Queryable, branchOid: string, productOid: string): Promise<StockRow & { name: string }> {
    await tx.query(sql`
        insert into stock (branch_oid, product_oid, reorder_level)
        select ${branchOid}, p.oid, p.reorder_level from product p where p.oid = ${productOid}
        on conflict (branch_oid, product_oid) do nothing`);
    const [row] = await tx.query<StockRow & { name: string }>(sql`
        select s.product_oid, s.on_hand, s.avg_cost::float8 as avg_cost, s.reorder_level, p.name
        from stock s join product p on p.oid = s.product_oid
        where s.branch_oid = ${branchOid} and s.product_oid = ${productOid}
        for update of s`);
    if (!row) throw new AppError(404, 'Product not found');
    return row;
}

/** Applies one movement at the context's branch and returns the stock after it. */
export async function moveStock(tx: Queryable, ctx: BranchContext, at: Date, m: Move): Promise<{ on_hand: number; avg_cost: number; unit_cost: number }> {
    if (!Number.isInteger(m.qty) || m.qty === 0) throw new Error('moveStock: a whole, non-zero quantity');
    const s = await lockStock(tx, ctx.branchOid, m.product_oid);
    const onHand = s.on_hand + m.qty;
    if (onHand < 0) {
        throw new AppError(409, s.on_hand === 0 ? `${s.name} is out of stock.` : `Only ${s.on_hand} of ${s.name} in stock.`, [
            { path: 'qty', message: `Only ${s.on_hand} in stock` }
        ]);
    }
    const unitCost = m.qty > 0 && m.unit_cost !== undefined ? m.unit_cost : s.avg_cost;
    const avg = m.qty > 0 ? averageCost(s.on_hand, s.avg_cost, m.qty, unitCost) : s.avg_cost;
    await tx.query(sql`
        update stock set on_hand = ${onHand}, avg_cost = ${avg}, updated_at = ${at}
        where branch_oid = ${ctx.branchOid} and product_oid = ${m.product_oid}`);
    await tx.query(sql`
        insert into stock_movement (branch_oid, product_oid, kind, qty, unit_cost, on_hand_after, avg_cost_after, reason, note, ref_oid, ref_label,
            by_oid, by_name, at)
        values (${ctx.branchOid}, ${m.product_oid}, ${m.kind}, ${m.qty}, ${unitCost}, ${onHand}, ${avg}, ${m.reason ?? null}, ${m.note ?? null},
            ${m.ref_oid ?? null}, ${m.ref_label ?? null}, ${ctx.actor?.oid ?? null}, ${ctx.actor?.name ?? 'System'}, ${at})`);
    return { on_hand: onHand, avg_cost: avg, unit_cost: unitCost };
}

/** A per-branch number: `PO-GUL-2026-0001`, `TRF-GUL-2026-0001`, `TKT-GUL-00001`. */
export async function nextCode(tx: Queryable, branchOid: string, prefix: string, counter: string, width: number, year: string | null): Promise<string> {
    const [seq] = await tx.query<{ value: number }>(sql`
        insert into branch_counter (branch_oid, name, value) values (${branchOid}, ${counter}, 1)
        on conflict (branch_oid, name) do update set value = branch_counter.value + 1 returning value`);
    const [branch] = await tx.query<{ code: string }>(sql`select code from branch where oid = ${branchOid}`);
    return [prefix, branch?.code ?? 'XXX', ...(year ? [year] : []), String(seq?.value ?? 0).padStart(width, '0')].join('-');
}
