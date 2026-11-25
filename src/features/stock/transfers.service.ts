import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { catalogueRepo } from '#src/features/catalogue/catalogue.service.ts';
import { tellStaff } from '#src/features/notifications/inbox.service.ts';
import type { DhakaNow } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import { moveStock, nextCode } from './stock.repo.ts';
import type { TransferCreate } from './stock.schema.ts';
import type { StockDeps } from './stock.service.ts';

/**
 * Stock transfers between branches. The receiving branch's manager asks another branch for products;
 * that branch's manager sends what they can (`transfer_out` at their average cost) or rejects it, and the goods are in
 * transit until the asking branch receives them (`transfer_in` at the sender's cost). Less arriving than was sent is a
 * shortfall: the sent quantity comes in, then an adjustment (`shortfall`) takes the missing units off, so both ledgers
 * show what happened. The asker may cancel before it is sent. Each side writes and audits at its own branch.
 *
 * requested → in_transit → received; requested → rejected (by the sender) | cancelled (by the asker).
 */
export type TransferStatus = 'requested' | 'in_transit' | 'received' | 'rejected' | 'cancelled';

interface TransferRow {
    oid: string;
    code: string;
    from_branch_oid: string;
    from_name: string;
    to_branch_oid: string;
    to_name: string;
    status: TransferStatus;
    note: string | null;
    requested_by_name: string;
    requested_at: Date;
    sent_by_name: string | null;
    sent_at: Date | null;
    received_by_name: string | null;
    received_at: Date | null;
    closing_note: string | null;
    closed_at: Date | null;
}

interface LineRow {
    oid: string;
    transfer_oid: string;
    product_oid: string;
    product_code: string;
    product_name: string;
    qty_requested: number;
    qty_sent: number | null;
    qty_received: number | null;
    unit_cost: number | null;
}

const TRANSFER = sql.raw(`t.oid, t.code, t.from_branch_oid, f.name as from_name, t.to_branch_oid, d.name as to_name, t.status, t.note,
    t.requested_by_name, t.requested_at, t.sent_by_name, t.sent_at, t.received_by_name, t.received_at, t.closing_note, t.closed_at
    from stock_transfer t join branch f on f.oid = t.from_branch_oid join branch d on d.oid = t.to_branch_oid`);

const iso = (d: Date | null) => d?.toISOString() ?? null;

async function linesOf(tx: Queryable, oids: readonly string[]): Promise<LineRow[]> {
    if (!oids.length) return [];
    return tx.query<LineRow>(sql`
        select oid, transfer_oid, product_oid, product_code, product_name, qty_requested, qty_sent, qty_received, unit_cost::float8 as unit_cost
        from stock_transfer_line where transfer_oid = any (${oids}::uuid[]) order by transfer_oid, position`);
}

function transferWire(t: TransferRow, lines: LineRow[], branchOid: string, costs: boolean) {
    return {
        oid: t.oid,
        code: t.code,
        from: { oid: t.from_branch_oid, name: t.from_name },
        to: { oid: t.to_branch_oid, name: t.to_name },
        /** Which side the caller's branch is on. */
        direction: t.to_branch_oid === branchOid ? ('in' as const) : ('out' as const),
        status: t.status,
        note: t.note,
        requested_by_name: t.requested_by_name,
        requested_at: t.requested_at.toISOString(),
        sent_by_name: t.sent_by_name,
        sent_at: iso(t.sent_at),
        received_by_name: t.received_by_name,
        received_at: iso(t.received_at),
        closing_note: t.closing_note,
        closed_at: iso(t.closed_at),
        lines: lines
            .filter(l => l.transfer_oid === t.oid)
            .map(l => ({
                oid: l.oid,
                product_oid: l.product_oid,
                code: l.product_code,
                name: l.product_name,
                qty_requested: l.qty_requested,
                qty_sent: l.qty_sent,
                qty_received: l.qty_received,
                unit_cost: costs ? l.unit_cost : null
            }))
    };
}

async function one(tx: Queryable, oid: string, branchOid: string, lock = false): Promise<TransferRow> {
    const [t] = await tx.query<TransferRow>(sql`
        select ${TRANSFER} where t.oid = ${oid} and (t.from_branch_oid = ${branchOid} or t.to_branch_oid = ${branchOid})
        ${lock ? sql.raw('for update of t') : sql.raw('')}`);
    if (!t) throw new AppError(404, 'Transfer not found');
    return t;
}

const out = async (tx: Queryable, oid: string, branchOid: string) => {
    const t = await one(tx, oid, branchOid);
    return transferWire(t, await linesOf(tx, [oid]), branchOid, true);
};

export async function listTransfers(deps: StockDeps, ctx: BranchContext, direction: 'in' | 'out' | 'all') {
    return withBranchTx(deps.db, ctx, async tx => {
        const side =
            direction === 'in'
                ? sql`t.to_branch_oid = ${ctx.branchOid}`
                : direction === 'out'
                  ? sql`t.from_branch_oid = ${ctx.branchOid}`
                  : sql`(t.to_branch_oid = ${ctx.branchOid} or t.from_branch_oid = ${ctx.branchOid})`;
        const rows = await tx.query<TransferRow>(sql`
            select ${TRANSFER} where ${side}
            order by (t.status in ('requested', 'in_transit')) desc, t.requested_at desc limit 200`);
        const lines = await linesOf(
            tx,
            rows.map(r => r.oid)
        );
        return rows.map(r => transferWire(r, lines, ctx.branchOid, true));
    });
}

export const getTransfer = (deps: StockDeps, ctx: BranchContext, oid: string) => withBranchTx(deps.db, ctx, tx => out(tx, oid, ctx.branchOid));

/** The receiving branch asks another branch for products. */
export async function requestTransfer(deps: StockDeps, ctx: BranchContext, now: DhakaNow, input: TransferCreate) {
    if (input.from_branch_oid === ctx.branchOid) throw new AppError(400, 'Ask another branch', [{ path: 'from_branch_oid', message: 'This branch' }]);
    return withBranchTx(deps.db, ctx, async tx => {
        const [from] = await tx.query<{ oid: string; name: string }>(sql`
            select oid, name from branch where oid = ${input.from_branch_oid} and kind = 'BRANCH' and status = 'Active'`);
        if (!from) throw new AppError(400, 'Choose a branch', [{ path: 'from_branch_oid', message: 'Unknown branch' }]);
        const products = await catalogueRepo.productsByOid(
            tx,
            input.lines.map(l => l.product_oid)
        );
        for (const l of input.lines)
            if (!products.find(p => p.oid === l.product_oid)?.active)
                throw new AppError(400, 'A product is not in the catalogue', [{ path: 'lines', message: 'Unknown product' }]);
        const code = await nextCode(tx, ctx.branchOid, 'TRF', `transfer:${now.date.slice(0, 4)}`, 4, now.date.slice(0, 4));
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into stock_transfer (code, from_branch_oid, to_branch_oid, note, requested_by, requested_by_name, requested_at)
            values (${code}, ${from.oid}, ${ctx.branchOid}, ${input.note ?? null}, ${ctx.actor?.oid ?? null}, ${ctx.actor?.name ?? ''}, ${now.at})
            returning oid`);
        if (!row) throw new Error('stock_transfer insert returned no row');
        let position = 0;
        for (const l of input.lines) {
            const p = products.find(x => x.oid === l.product_oid);
            if (!p) throw new AppError(400, 'A product is not in the catalogue', [{ path: 'lines', message: 'Unknown product' }]);
            await tx.query(sql`
                insert into stock_transfer_line (transfer_oid, from_branch_oid, to_branch_oid, position, product_oid, product_code, product_name, qty_requested)
                values (${row.oid}, ${from.oid}, ${ctx.branchOid}, ${++position}, ${p.oid}, ${p.code}, ${p.name}, ${l.qty})`);
        }
        const result = await out(tx, row.oid, ctx.branchOid);
        await recordAudit(tx, ctx, { action: 'request', entity: 'stock_transfer', entityKey: code, before: null, after: result });
        await tellStaff(tx, ctx, {
            to_branch_oid: from.oid,
            kind: 'transfer_requested',
            subject: `${result.to.name} asks for stock: ${code}`,
            body: `${ctx.actor?.name ?? result.to.name} asked for ${input.lines.length} product${input.lines.length === 1 ? '' : 's'}. Send what you can, or reject it.`,
            link: 'stock?tab=transfers',
            related_oid: row.oid,
            dedupe_key: `transfer_requested:${row.oid}`,
            at: now.at
        });
        return result;
    });
}

/** The sending branch sends what it can of each line (0 for none); the goods are in transit. */
export async function sendTransfer(
    deps: StockDeps,
    ctx: BranchContext,
    now: DhakaNow,
    oid: string,
    input: { lines: { line_oid: string; qty: number }[]; note?: string | null | undefined }
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const t = await one(tx, oid, ctx.branchOid, true);
        if (t.from_branch_oid !== ctx.branchOid) throw new AppError(403, `${t.from_name} sends this transfer.`);
        if (t.status !== 'requested') throw new AppError(409, t.status === 'in_transit' ? 'This transfer was already sent.' : 'This transfer is closed.');
        const lines = await linesOf(tx, [oid]);
        const qtyOf = (l: LineRow) => input.lines.find(x => x.line_oid === l.oid)?.qty ?? 0;
        if (input.lines.some(x => !lines.some(l => l.oid === x.line_oid)))
            throw new AppError(400, 'A line is not on this transfer', [{ path: 'lines', message: 'Unknown line' }]);
        if (!lines.some(l => qtyOf(l) > 0))
            throw new AppError(400, 'Send at least one item, or reject the request.', [{ path: 'lines', message: 'Nothing to send' }]);
        for (const l of lines) {
            const qty = qtyOf(l);
            let cost: number | null = null;
            if (qty > 0)
                cost = (await moveStock(tx, ctx, now.at, { product_oid: l.product_oid, kind: 'transfer_out', qty: -qty, ref_oid: t.oid, ref_label: t.code }))
                    .unit_cost;
            await tx.query(sql`update stock_transfer_line set qty_sent = ${qty}, unit_cost = ${cost ?? 0} where oid = ${l.oid}`);
        }
        await tx.query(sql`
            update stock_transfer set status = 'in_transit', sent_by_name = ${ctx.actor?.name ?? ''}, sent_at = ${now.at},
                note = coalesce(${input.note ?? null}, note)
            where oid = ${oid}`);
        const result = await out(tx, oid, ctx.branchOid);
        await recordAudit(tx, ctx, { action: 'send', entity: 'stock_transfer', entityKey: t.code, before: { status: t.status }, after: result });
        await tellStaff(tx, ctx, {
            to_branch_oid: t.to_branch_oid,
            kind: 'transfer_sent',
            subject: `${t.code} is on its way from ${t.from_name}`,
            body: `${ctx.actor?.name ?? t.from_name} sent ${t.code}. Receive it when it arrives, and note any shortfall.`,
            link: 'stock?tab=transfers',
            related_oid: t.oid,
            dedupe_key: `transfer_sent:${t.oid}`,
            at: now.at
        });
        return result;
    });
}

/** The asking branch receives it; less than was sent is a shortfall (an adjustment, with the note). */
export async function receiveTransfer(
    deps: StockDeps,
    ctx: BranchContext,
    now: DhakaNow,
    oid: string,
    input: { lines: { line_oid: string; qty: number }[]; note?: string | null | undefined }
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const t = await one(tx, oid, ctx.branchOid, true);
        if (t.to_branch_oid !== ctx.branchOid) throw new AppError(403, `${t.to_name} receives this transfer.`);
        if (t.status !== 'in_transit') throw new AppError(409, t.status === 'requested' ? 'This transfer has not been sent yet.' : 'This transfer is closed.');
        const lines = await linesOf(tx, [oid]);
        let short = 0;
        for (const l of lines) {
            const sent = l.qty_sent ?? 0;
            const given = input.lines.find(x => x.line_oid === l.oid);
            const qty = given ? given.qty : sent;
            if (qty > sent) throw new AppError(400, `${l.product_name}: ${sent} were sent.`, [{ path: 'lines', message: 'More than sent' }]);
            if (sent > 0) {
                await moveStock(tx, ctx, now.at, {
                    product_oid: l.product_oid,
                    kind: 'transfer_in',
                    qty: sent,
                    unit_cost: l.unit_cost ?? 0,
                    ref_oid: t.oid,
                    ref_label: t.code
                });
                if (qty < sent) {
                    short += sent - qty;
                    await moveStock(tx, ctx, now.at, {
                        product_oid: l.product_oid,
                        kind: 'adjustment',
                        qty: qty - sent,
                        reason: 'shortfall',
                        note: input.note ?? `Short on ${t.code}`,
                        ref_oid: t.oid,
                        ref_label: t.code
                    });
                }
            }
            await tx.query(sql`update stock_transfer_line set qty_received = ${qty} where oid = ${l.oid}`);
        }
        await tx.query(sql`
            update stock_transfer set status = 'received', received_by_name = ${ctx.actor?.name ?? ''}, received_at = ${now.at},
                closing_note = ${short > 0 ? (input.note ?? `${short} short on arrival`) : (input.note ?? null)}, closed_at = ${now.at}
            where oid = ${oid}`);
        const result = await out(tx, oid, ctx.branchOid);
        await recordAudit(tx, ctx, {
            action: 'receive',
            entity: 'stock_transfer',
            entityKey: t.code,
            before: { status: t.status },
            after: { ...result, short }
        });
        return result;
    });
}

/** The sender rejects (`reject`) or the asker cancels (`cancel`) a request not yet sent. */
export async function closeTransfer(deps: StockDeps, ctx: BranchContext, now: DhakaNow, oid: string, how: 'reject' | 'cancel', note: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const t = await one(tx, oid, ctx.branchOid, true);
        if (how === 'reject' && t.from_branch_oid !== ctx.branchOid) throw new AppError(403, `Only ${t.from_name} can reject this request.`);
        if (how === 'cancel' && t.to_branch_oid !== ctx.branchOid) throw new AppError(403, `Only ${t.to_name} can cancel this request.`);
        if (t.status !== 'requested')
            throw new AppError(409, t.status === 'in_transit' ? 'This transfer is on its way: receive it.' : 'This transfer is closed.');
        await tx.query(sql`
            update stock_transfer set status = ${how === 'reject' ? 'rejected' : 'cancelled'}, closing_note = ${note}, closed_at = ${now.at} where oid = ${oid}`);
        const result = await out(tx, oid, ctx.branchOid);
        if (how === 'reject')
            await tellStaff(tx, ctx, {
                to_branch_oid: t.to_branch_oid,
                kind: 'transfer_rejected',
                subject: `${t.from_name} rejected ${t.code}`,
                body: `${t.from_name} cannot send ${t.code}: ${note}`,
                link: 'stock?tab=transfers',
                related_oid: t.oid,
                dedupe_key: `transfer_rejected:${t.oid}`,
                at: now.at
            });
        await recordAudit(tx, ctx, {
            action: how,
            entity: 'stock_transfer',
            entityKey: t.code,
            before: { status: t.status },
            after: { status: result.status, note }
        });
        return result;
    });
}
