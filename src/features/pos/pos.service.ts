import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { catalogueRepo, effectiveVat, photoLinks } from '#src/features/catalogue/catalogue.service.ts';
import { memberAt } from '#src/features/members/members.service.ts';
import { notify } from '#src/features/notifications/notifications.service.ts';
import { salesRepo } from '#src/features/sales/sales.repo.ts';
import { checkPayment, invoiceOut, newInvoice, REFUND_WINDOW_DAYS } from '#src/features/sales/sales.service.ts';
import { readOrgRules } from '#src/features/settings/settings.routes.ts';
import { moveStock } from '#src/features/stock/stock.repo.ts';
import { addDays, daysBetween, dhakaInstant, type DhakaNow, taka } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import type { CartInput, ReturnInput, SaleInput } from './pos.schema.ts';
import { type PosLine, posQuote, returnAmount } from './pos-pricing.ts';

/**
 * The POS (phase 6, D-102). The desk sells products to a member of the branch or a walk-in, on an invoice of kind
 * `pos` through the sales service: numbered like every invoice, VAT per line (the product's rate or HQ's), a receipt,
 * the same payment methods, in the cash closing. A walk-in pays it all; a member may pay part or none, and the rest
 * is charged to their account: the invoice stays unpaid and counts toward dues (access rule 5 at check-in). A branch
 * manager (`manage Sale`) may take money off a line, with a reason. Each line takes the stock off (`sold`, at the
 * average cost). A return gives money back through the refund step (a `refund` payment) and puts the items back
 * unless they are damaged; the desk may return within 3 days of the sale, a manager after that. Only money paid
 * comes back: a sale still owed is paid first (D-104).
 */
export interface PosDeps {
    db: Db;
    jwtSecret: string;
    apiPrefix: string;
}

/** The code and name on a walk-in's invoice. */
export const WALK_IN = { code: 'WALK-IN', name: 'Walk-in customer' } as const;

interface Customer {
    oid: string | null;
    code: string;
    name: string;
    phone: string | null;
    email: string | null;
    dues: number;
    dues_limit: number;
}

async function customerOf(
    tx: Queryable,
    ctx: BranchContext,
    today: string,
    memberOid: string | null | undefined,
    walkInName?: string | null
): Promise<Customer> {
    if (!memberOid) return { oid: null, code: WALK_IN.code, name: walkInName ?? WALK_IN.name, phone: null, email: null, dues: 0, dues_limit: 0 };
    const m = await memberAt(tx, ctx, memberOid, today);
    if (m.anonymised) throw new AppError(409, 'This member was anonymised');
    if (m.status === 'Banned') throw new AppError(409, 'This member is banned from their home branch.');
    if (m.status === 'Suspended') throw new AppError(409, 'This member is suspended. Sell after the suspension ends.');
    const [b] = await tx.query<{ dues_limit: number }>(sql`select dues_limit::float8 as dues_limit from branch where oid = ${ctx.branchOid}`);
    return { oid: m.oid, code: m.code, name: m.name, phone: m.phone, email: m.email, dues: m.dues, dues_limit: b?.dues_limit ?? 0 };
}

/** Prices the cart from the catalogue (never the browser's prices) and checks the stock. */
async function price(tx: Queryable, ctx: BranchContext, input: CartInput, canDiscount: boolean) {
    const rules = await readOrgRules(tx);
    const products = await catalogueRepo.productsByOid(
        tx,
        input.lines.map(l => l.product_oid)
    );
    const stock = await tx.query<{ product_oid: string; on_hand: number }>(sql`
        select product_oid, on_hand from stock where branch_oid = ${ctx.branchOid} and product_oid = any (${products.map(p => p.oid)}::uuid[])`);
    if (input.lines.some(l => l.discount) && !canDiscount) throw new AppError(403, 'Line discounts need a branch manager.');
    const lines = input.lines.map(l => {
        const p = products.find(x => x.oid === l.product_oid);
        if (!p?.active) throw new AppError(400, 'A product in the cart is not on sale', [{ path: 'lines', message: 'Unknown product' }]);
        return {
            product_oid: p.oid,
            code: p.code,
            name: p.name,
            unit_price: p.price,
            qty: l.qty,
            vat_rate: effectiveVat(p, rules.vat_rate),
            discount: l.discount ?? 0,
            discount_reason: l.discount_reason ?? null
        };
    });
    const q = posQuote(lines, rules.vat_inclusive);
    const onHand = (oid: string) => stock.find(s => s.product_oid === oid)?.on_hand ?? 0;
    const short = q.lines.filter(l => l.qty > onHand(l.product_oid)).map(l => ({ product_oid: l.product_oid, name: l.name, on_hand: onHand(l.product_oid) }));
    return { q, rules, short };
}

/** `GET /v1/pos/products`: what can be sold here: every active product with its price, VAT, first photo and stock. */
export async function posProducts(deps: PosDeps, ctx: BranchContext) {
    const { rows, rate, stock } = await withBranchTx(deps.db, ctx, async tx => ({
        rows: await catalogueRepo.products(tx, false),
        rate: (await readOrgRules(tx)).vat_rate,
        stock: await tx.query<{ product_oid: string; on_hand: number }>(sql`select product_oid, on_hand from stock where branch_oid = ${ctx.branchOid}`)
    }));
    return Promise.all(
        rows.map(async p => ({
            oid: p.oid,
            code: p.code,
            name: p.name,
            category: p.category,
            unit: p.unit,
            price: p.price,
            vat_rate: effectiveVat(p, rate),
            photo_url: (await photoLinks(deps, { ...p, photo_file_oids: p.photo_file_oids.slice(0, 1) }))[0]?.url ?? null,
            on_hand: stock.find(s => s.product_oid === p.oid)?.on_hand ?? 0
        }))
    );
}

const customerWire = (c: Customer, charged: number) => ({
    member_oid: c.oid,
    code: c.code,
    name: c.name,
    dues: c.dues,
    dues_limit: c.dues_limit,
    dues_after: c.dues + charged,
    over_limit: c.oid !== null && c.dues + charged > c.dues_limit
});

/** `POST /v1/pos/quote`: the cart priced, with the stock short and what charging it all would do to the dues. */
export async function quotePos(deps: PosDeps, ctx: BranchContext, now: DhakaNow, input: CartInput, canDiscount: boolean) {
    return withBranchTx(deps.db, ctx, async tx => {
        const { q, short } = await price(tx, ctx, input, canDiscount);
        const c = await customerOf(tx, ctx, now.date, input.member_oid);
        return { ...q, short, customer: customerWire(c, q.total) };
    });
}

/** The invoice's lines: the product lines, then one line per discount (as a plan sale's discount line). */
function invoiceLines(lines: PosLine[]) {
    return [
        ...lines.map(l => ({
            label: l.label,
            amount: l.amount,
            product_oid: l.product_oid,
            code: l.code,
            qty: l.qty,
            unit_price: l.unit_price,
            vat_rate: l.vat_rate,
            discount: l.discount,
            discount_reason: l.discount_reason,
            vat: l.vat,
            total: l.total
        })),
        ...lines.filter(l => l.discount).map(l => ({ label: `Discount on ${l.name}: ${l.discount_reason ?? ''}`.trim(), amount: -l.discount }))
    ];
}

/** `POST /v1/pos/sales`. */
export async function sellPos(deps: PosDeps, ctx: BranchContext, now: DhakaNow, input: SaleInput, canDiscount: boolean) {
    return withBranchTx(deps.db, ctx, async tx => {
        const { q, rules, short } = await price(tx, ctx, input, canDiscount);
        const first = short[0];
        if (first) throw new AppError(409, first.on_hand === 0 ? `${first.name} is out of stock.` : `Only ${first.on_hand} of ${first.name} in stock.`);
        const c = await customerOf(tx, ctx, now.date, input.member_oid, input.walk_in_name);
        if (q.total <= 0) throw new AppError(400, 'Nothing to charge.');
        if (c.oid === null && input.payment.amount !== q.total)
            throw new AppError(400, `A walk-in pays it all: ${taka(q.total)}.`, [{ path: 'payment.amount', message: 'Pay the total' }]);
        checkPayment({ method: input.payment.method, amount: input.payment.amount, reference: input.payment.reference }, q.total);
        const invoiceOid = await newInvoice(
            tx,
            ctx,
            now,
            c,
            {
                lines: invoiceLines(q.lines),
                subtotal: q.subtotal,
                discount: q.discount,
                discount_label: q.discount ? 'Line discounts' : null,
                vat_rate: rules.vat_rate,
                vat_inclusive: q.vat_inclusive,
                vat: q.vat,
                total: q.total
            },
            rules.vat_bin,
            null,
            'pos'
        );
        const [inv] = await tx.query<{ number: string }>(sql`select number from invoice where oid = ${invoiceOid}`);
        const number = inv?.number ?? '';
        for (const l of q.lines)
            await moveStock(tx, ctx, now.at, { product_oid: l.product_oid, kind: 'sold', qty: -l.qty, ref_oid: invoiceOid, ref_label: number });
        if (input.payment.amount > 0) {
            await salesRepo.insertPayment(
                tx,
                {
                    branch_oid: ctx.branchOid,
                    invoice_oid: invoiceOid,
                    member_oid: c.oid,
                    kind: 'payment',
                    amount: input.payment.amount,
                    method: input.payment.method,
                    reference: input.payment.reference?.trim() ? input.payment.reference.trim() : null,
                    reason: null,
                    approved_by: null,
                    received_at: now.at
                },
                ctx.actor?.oid ?? ''
            );
        }
        const charged = q.total - input.payment.amount;
        const invoice = await invoiceOut(tx, invoiceOid, [ctx.branchOid]);
        // The same audit row as a locker rental's invoice: `<member code>/<number>`, which the reconciliation report finds.
        await recordAudit(tx, ctx, { action: 'create', entity: 'invoice', entityKey: `${c.code}/${number}`, before: null, after: { invoice, charged } });
        // A member's shop receipt (D-108 a): what they bought, what they paid, and what is on their account.
        if (c.oid) {
            const items = q.lines.map(l => l.label).join(', ');
            await notify(tx, {
                branch_oid: ctx.branchOid,
                member: { ...c, oid: c.oid },
                kind: 'shop_receipt',
                subject: `Shop receipt ${number}`,
                body: `Dear ${c.name}, thank you for shopping with us: ${items}. Total ${taka(q.total)}${
                    input.payment.amount > 0 ? `, paid ${taka(input.payment.amount)}` : ''
                }${charged > 0 ? `, ${taka(charged)} added to your account` : ''}.`,
                related_oid: invoiceOid,
                dedupe_key: `shop_receipt:${invoiceOid}`,
                at: now.at
            });
        }
        return { invoice, charged, customer: customerWire(c, charged) };
    });
}

interface ReturnRow {
    oid: string;
    invoice_oid: string;
    lines: { index: number; product_oid: string; qty: number; damaged: boolean; amount: number }[];
    amount: number;
    reason: string;
    by_name: string;
    at: Date;
}

async function returnsOf(tx: Queryable, invoiceOids: readonly string[]): Promise<ReturnRow[]> {
    if (!invoiceOids.length) return [];
    return tx.query<ReturnRow>(sql`
        select oid, invoice_oid, lines, amount::float8 as amount, reason, by_name, at from pos_return where invoice_oid = any (${invoiceOids}::uuid[]) order by at`);
}

interface ProductLine {
    label: string;
    amount: number;
    product_oid: string;
    code: string;
    qty: number;
    unit_price: number;
    vat_rate: number;
    discount: number;
    total: number;
}
const productLines = (lines: { label: string; amount: number }[]): ProductLine[] => lines.filter((l): l is ProductLine => 'product_oid' in l);

function saleWire(invoice: Awaited<ReturnType<typeof invoiceOut>>, returns: ReturnRow[], today: string) {
    const own = returns.filter(r => r.invoice_oid === invoice.oid);
    const returned = (i: number) => own.reduce((s, r) => s + r.lines.filter(l => l.index === i).reduce((t, l) => t + l.qty, 0), 0);
    const day = new Date(new Date(invoice.issued_at).getTime() + 6 * 3600_000).toISOString().slice(0, 10);
    return {
        invoice,
        walk_in: invoice.member_oid === null,
        items: productLines(invoice.lines).map((l, index) => ({ index, ...l, returned: returned(index), returnable: l.qty - returned(index) })),
        returns: own.map(r => ({ ...r, at: r.at.toISOString() })),
        returned_amount: own.reduce((s, r) => s + r.amount, 0),
        /** The desk may return until this day; a manager after it. */
        desk_return_until: addDays(day, REFUND_WINDOW_DAYS),
        desk_may_return: daysBetween(day, today) <= REFUND_WINDOW_DAYS
    };
}

/** `GET /v1/pos/sales[?day=&q=]`: the branch's POS sales, newest first (a day's, or the last 100). */
export async function listPosSales(deps: PosDeps, ctx: BranchContext, now: DhakaNow, q: { day?: string | undefined; q?: string | undefined }) {
    return withBranchTx(deps.db, ctx, async tx => {
        const range = q.day ? sql`and i.issued_at >= ${dhakaInstant(q.day)} and i.issued_at < ${dhakaInstant(addDays(q.day, 1))}` : sql``;
        const term = q.q ? sql`and (i.number ilike ${`%${q.q}%`} or i.member_name ilike ${`%${q.q}%`} or i.member_code ilike ${`%${q.q}%`})` : sql``;
        const rows = await tx.query<{ oid: string }>(sql`
            select i.oid from invoice i where i.branch_oid = ${ctx.branchOid} and i.kind = 'pos' ${range} ${term} order by i.issued_at desc limit 100`);
        const out = await Promise.all(rows.map(r => invoiceOut(tx, r.oid, [ctx.branchOid])));
        const returns = await returnsOf(
            tx,
            rows.map(r => r.oid)
        );
        return out.map(i => saleWire(i, returns, now.date));
    });
}

async function posInvoice(tx: Queryable, ctx: BranchContext, oid: string) {
    const invoice = await invoiceOut(tx, oid, [ctx.branchOid]);
    if (invoice.kind !== 'pos') throw new AppError(404, 'Sale not found');
    return invoice;
}

export async function getPosSale(deps: PosDeps, ctx: BranchContext, now: DhakaNow, oid: string) {
    return withBranchTx(deps.db, ctx, async tx => saleWire(await posInvoice(tx, ctx, oid), await returnsOf(tx, [oid]), now.date));
}

/** `POST /v1/pos/sales/:oid/return`: items back, money back (what was paid only), the undamaged ones on the shelf. */
export async function returnPos(deps: PosDeps, ctx: BranchContext, now: DhakaNow, oid: string, input: ReturnInput, isManager: boolean) {
    return withBranchTx(deps.db, ctx, async tx => {
        await tx.query(sql`select oid from invoice where oid = ${oid} and branch_oid = ${ctx.branchOid} for update`);
        const before = saleWire(await posInvoice(tx, ctx, oid), await returnsOf(tx, [oid]), now.date);
        if (!before.desk_may_return && !isManager)
            throw new AppError(403, `The desk takes returns until ${before.desk_return_until} (${REFUND_WINDOW_DAYS} days). Ask a branch manager.`);
        const back: ReturnRow['lines'] = [];
        for (const r of input.lines) {
            const item = before.items[r.index];
            if (!item) throw new AppError(400, 'A line is not on this sale', [{ path: 'lines', message: 'Unknown line' }]);
            if (r.qty > item.returnable)
                throw new AppError(400, item.returnable ? `Only ${item.returnable} of ${item.label} can come back.` : `${item.label} has already come back.`, [
                    { path: 'lines', message: 'More than sold' }
                ]);
            back.push({
                index: r.index,
                product_oid: item.product_oid,
                qty: r.qty,
                damaged: r.damaged ?? false,
                amount: returnAmount(item, item.returned, r.qty)
            });
        }
        const amount = back.reduce((s, l) => s + l.amount, 0);
        const net = before.invoice.paid;
        if (amount > net) {
            throw new AppError(
                409,
                net <= 0
                    ? `Nothing has been paid on this sale yet (${taka(before.invoice.due)} on the account). Take the payment first, then the return.`
                    : `Only ${taka(net)} was paid on this sale. Take the rest of the payment first, then the return.`
            );
        }
        const refundOid = await salesRepo.insertPayment(
            tx,
            {
                branch_oid: ctx.branchOid,
                invoice_oid: oid,
                member_oid: before.invoice.member_oid,
                kind: 'refund',
                amount,
                method: input.method,
                reference: input.reference?.trim() ? input.reference.trim() : null,
                reason: input.reason,
                approved_by: ctx.actor?.oid ?? null,
                received_at: now.at
            },
            ctx.actor?.oid ?? ''
        );
        const [ret] = await tx.query<{ oid: string }>(sql`
            insert into pos_return (branch_oid, invoice_oid, payment_oid, lines, amount, reason, by_oid, by_name, at)
            values (${ctx.branchOid}, ${oid}, ${refundOid}, ${JSON.stringify(back)}::jsonb, ${amount}, ${input.reason}, ${ctx.actor?.oid ?? null},
                ${ctx.actor?.name ?? ''}, ${now.at})
            returning oid`);
        for (const l of back.filter(x => !x.damaged)) {
            // Back at what it cost when it was sold, so the average cost is not moved by the return.
            const [sold] = await tx.query<{ unit_cost: number }>(sql`
                select unit_cost::float8 as unit_cost from stock_movement
                where branch_oid = ${ctx.branchOid} and ref_oid = ${oid} and product_oid = ${l.product_oid} and kind = 'sold' limit 1`);
            await moveStock(tx, ctx, now.at, {
                product_oid: l.product_oid,
                kind: 'returned',
                qty: l.qty,
                unit_cost: sold?.unit_cost,
                ref_oid: ret?.oid,
                ref_label: before.invoice.number
            });
        }
        const after = saleWire(await posInvoice(tx, ctx, oid), await returnsOf(tx, [oid]), now.date);
        // The refund's audit row, as the refund step writes it (the reconciliation report looks for `after.refund`).
        await recordAudit(tx, ctx, {
            action: 'refund',
            entity: 'invoice',
            entityKey: before.invoice.number,
            before: { paid: net },
            after: { paid: after.invoice.paid, refund: refundOid, amount, reason: input.reason, lines: back, policy: before.desk_may_return }
        });
        return after;
    });
}
