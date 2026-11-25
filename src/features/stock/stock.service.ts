import type { Db } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { viewUrl } from '#src/features/files/files.service.ts';
import { AppError } from '#src/lib/http.ts';

import { type AdjustReason, lockStock, moveStock } from './stock.repo.ts';

/**
 * A branch's stock: what is on hand of every active product, its average cost (managers only), the
 * reorder level and a "low" badge at or below it (listed, no messages); each product's ledger; adjustments
 * with a reason; and what the other branches hold, to ask for a transfer. HQ holds no stock and reads every
 * branch's (`read Stock` at HQ).
 */
export interface StockDeps {
    db: Db;
    jwtSecret: string;
    apiPrefix: string;
}

interface LevelRow {
    product_oid: string;
    code: string;
    name: string;
    category: string;
    unit: string;
    price: number;
    photo_file_oid: string | null;
    hq_oid: string;
    on_hand: number;
    avg_cost: number;
    reorder_level: number;
    last_cost: number | null;
    last_moved_at: Date | null;
    on_order: number;
    in_transit: number;
}

/** Every active product, with this branch's stock (none yet: 0 at the product's reorder level). */
const LEVELS = (branchOid: string) => sql`
    select p.oid as product_oid, p.code, p.name, p.category, p.unit, p.price::float8 as price, p.photo_file_oids[1] as photo_file_oid,
        p.branch_oid as hq_oid,
        coalesce(s.on_hand, 0) as on_hand, coalesce(s.avg_cost, 0)::float8 as avg_cost, coalesce(s.reorder_level, p.reorder_level) as reorder_level,
        (select m.unit_cost::float8 from stock_movement m where m.branch_oid = ${branchOid} and m.product_oid = p.oid and m.kind = 'received'
            order by m.seq desc limit 1) as last_cost,
        (select max(m.at) from stock_movement m where m.branch_oid = ${branchOid} and m.product_oid = p.oid) as last_moved_at,
        coalesce((select sum(l.qty - l.received)::int from purchase_order_line l join purchase_order o on o.oid = l.po_oid
            where o.branch_oid = ${branchOid} and l.product_oid = p.oid and o.status in ('pending', 'approved', 'sent', 'partial')), 0) as on_order,
        coalesce((select sum(l.qty_sent)::int from stock_transfer_line l join stock_transfer t on t.oid = l.transfer_oid
            where t.to_branch_oid = ${branchOid} and l.product_oid = p.oid and t.status = 'in_transit'), 0) as in_transit
    from product p left join stock s on s.product_oid = p.oid and s.branch_oid = ${branchOid}
    where p.active`;

async function levelWire(deps: Pick<StockDeps, 'jwtSecret' | 'apiPrefix'>, r: LevelRow, costs: boolean) {
    return {
        product_oid: r.product_oid,
        code: r.code,
        name: r.name,
        category: r.category,
        unit: r.unit,
        price: r.price,
        photo_url: r.photo_file_oid ? await viewUrl(deps, { oid: r.photo_file_oid, branch_oid: r.hq_oid }) : null,
        on_hand: r.on_hand,
        reorder_level: r.reorder_level,
        low: r.on_hand <= r.reorder_level,
        on_order: r.on_order,
        in_transit: r.in_transit,
        // What it cost is the branch manager's and HQ's (`update Stock` / HQ): the desk sees counts only.
        avg_cost: costs ? r.avg_cost : null,
        value: costs ? Math.round(r.avg_cost * r.on_hand) : null,
        last_cost: costs ? r.last_cost : null,
        last_moved_at: r.last_moved_at?.toISOString() ?? null
    };
}

export async function stockLevels(deps: StockDeps, ctx: BranchContext, q: { low?: '0' | '1' | undefined; q?: string | undefined }, costs: boolean) {
    const rows = await withBranchTx(deps.db, ctx, tx => tx.query<LevelRow>(sql`${LEVELS(ctx.branchOid)} order by p.name`));
    const term = q.q?.toLowerCase();
    const list = rows.filter(
        r => (q.low !== '1' || r.on_hand <= r.reorder_level) && (!term || r.name.toLowerCase().includes(term) || r.code.toLowerCase().includes(term))
    );
    return {
        rows: await Promise.all(list.map(r => levelWire(deps, r, costs))),
        low: rows.filter(r => r.on_hand <= r.reorder_level).length,
        value: costs ? Math.round(rows.reduce((s, r) => s + r.avg_cost * r.on_hand, 0)) : null
    };
}

interface MovementRow {
    oid: string;
    kind: string;
    qty: number;
    unit_cost: number;
    on_hand_after: number;
    avg_cost_after: number;
    reason: string | null;
    note: string | null;
    ref_oid: string | null;
    ref_label: string | null;
    by_name: string;
    at: Date;
}

/** One product's ledger at the branch, newest first (the last 200). */
export async function movements(deps: StockDeps, ctx: BranchContext, productOid: string, costs: boolean) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [level] = await tx.query<LevelRow>(sql`${LEVELS(ctx.branchOid)} and p.oid = ${productOid}`);
        if (!level) throw new AppError(404, 'Product not found');
        const rows = await tx.query<MovementRow>(sql`
            select oid, kind, qty, unit_cost::float8 as unit_cost, on_hand_after, avg_cost_after::float8 as avg_cost_after, reason, note, ref_oid,
                ref_label, by_name, at
            from stock_movement where branch_oid = ${ctx.branchOid} and product_oid = ${productOid} order by seq desc limit 200`);
        return {
            product: await levelWire(deps, level, costs),
            movements: rows.map(r => ({
                ...r,
                unit_cost: costs ? r.unit_cost : null,
                avg_cost_after: costs ? r.avg_cost_after : null,
                at: r.at.toISOString()
            }))
        };
    });
}

export async function adjust(
    deps: StockDeps,
    ctx: BranchContext,
    at: Date,
    productOid: string,
    input: { qty: number; reason: AdjustReason; note?: string | null | undefined }
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await lockStock(tx, ctx.branchOid, productOid);
        if (input.reason !== 'count' && input.qty > 0)
            throw new AppError(400, 'Only a count adds stock. Received goods come in on a purchase order.', [
                { path: 'qty', message: 'Take away, or choose Count' }
            ]);
        if ((input.reason === 'other' || input.reason === 'count') && !input.note)
            throw new AppError(400, 'Say what happened', [{ path: 'note', message: 'Required' }]);
        const after = await moveStock(tx, ctx, at, {
            product_oid: productOid,
            kind: 'adjustment',
            qty: input.qty,
            reason: input.reason,
            note: input.note ?? null
        });
        await recordAudit(tx, ctx, {
            action: 'adjust',
            entity: 'stock',
            entityKey: before.name,
            before: { on_hand: before.on_hand },
            after: { on_hand: after.on_hand, qty: input.qty, reason: input.reason, note: input.note ?? null }
        });
        return { product_oid: productOid, on_hand: after.on_hand };
    });
}

export async function setReorderLevel(deps: StockDeps, ctx: BranchContext, productOid: string, level: number) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await lockStock(tx, ctx.branchOid, productOid);
        await tx.query(sql`update stock set reorder_level = ${level} where branch_oid = ${ctx.branchOid} and product_oid = ${productOid}`);
        await recordAudit(tx, ctx, {
            action: 'update',
            entity: 'stock',
            entityKey: before.name,
            before: { reorder_level: before.reorder_level },
            after: { reorder_level: level }
        });
        return { product_oid: productOid, reorder_level: level, low: before.on_hand <= level };
    });
}

/** What the other branches hold of some products (counts only), to ask for a transfer. */
export async function stockElsewhere(deps: StockDeps, ctx: BranchContext, productOids: readonly string[]) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [row] = await tx.query<{ v: { product_oid: string; branch_oid: string; branch_name: string; on_hand: number }[] | null }>(
            sql`select stock_elsewhere(${productOids}::uuid[]) as v`
        );
        return (row?.v ?? []).filter(r => r.branch_oid !== ctx.branchOid);
    });
}

/** HQ: every active product's stock at each branch the user reaches, with the low ones flagged. */
export async function hqStock(deps: StockDeps, ctx: BranchContext) {
    return withBranchTx(deps.db, ctx, async tx => {
        const branches = await tx.query<{ oid: string; code: string; name: string }>(sql`
            select oid, code, name from branch where kind = 'BRANCH' and oid = any (${ctx.branchOids}::uuid[]) order by name`);
        const products = await tx.query<{ oid: string; code: string; name: string; category: string; reorder_level: number }>(sql`
            select oid, code, name, category, reorder_level from product where active order by name`);
        const stock = await tx.query<{ branch_oid: string; product_oid: string; on_hand: number; avg_cost: number; reorder_level: number }>(sql`
            select branch_oid, product_oid, on_hand, avg_cost::float8 as avg_cost, reorder_level from stock where branch_oid = any (${ctx.branchOids}::uuid[])`);
        const at = (b: string, p: string) => stock.find(s => s.branch_oid === b && s.product_oid === p);
        return {
            branches,
            rows: products.map(p => ({
                product_oid: p.oid,
                code: p.code,
                name: p.name,
                category: p.category,
                cells: branches.map(b => {
                    const s = at(b.oid, p.oid);
                    const level = s?.reorder_level ?? p.reorder_level;
                    return { branch_oid: b.oid, on_hand: s?.on_hand ?? 0, reorder_level: level, low: (s?.on_hand ?? 0) <= level };
                })
            })),
            value: Math.round(stock.reduce((s, r) => s + r.on_hand * r.avg_cost, 0))
        };
    });
}
