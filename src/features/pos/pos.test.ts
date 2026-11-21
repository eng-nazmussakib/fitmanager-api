import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, portalMember, signIn, stockUp, type TestApp } from '#src/testing/test-app.ts';

const { GUL, HQ } = DEMO_BRANCHES;
/** Thursday 19 Nov 2026, 12:00 in Dhaka. */
const NOON = new Date('2026-11-19T06:00:00Z');
let now = NOON;
let t: TestApp;
let hq: Record<string, string>;
let manager: Record<string, string>;
let desk: Record<string, string>;
let trainer: Record<string, string>;
let products: { oid: string; code: string; on_hand: number; price: number; vat_rate: number }[];
const product = (code: string) => products.find(p => p.code === code)!.oid;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    hq = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
    await stockUp(t.app, manager, hq, [
        { code: 'PRD-000001', qty: 5, unit_cost: 3000 },
        { code: 'PRD-000005', qty: 20, unit_cost: 110 },
        { code: 'PRD-000007', qty: 24, unit_cost: 15 }
    ]);
    products = (await request(t.app).get('/api/v1/pos/products').set(desk).expect(200)).body.data;
});
afterAll(() => t.close());
afterEach(() => {
    now = NOON;
});

let phoneSeq = 0;
const phone = () => `0195${String(1_000_000 + ++phoneSeq).padStart(7, '0')}`;

interface Sale {
    invoice: {
        oid: string;
        number: string;
        kind: string;
        member_oid: string | null;
        member_code: string;
        total: number;
        vat: number;
        paid: number;
        due: number;
        status: string;
    };
    charged: number;
    customer: { dues_after: number; over_limit: boolean };
}
interface SaleDetail {
    invoice: Sale['invoice'];
    items: { index: number; qty: number; returned: number; returnable: number; total: number }[];
    returned_amount: number;
    desk_may_return: boolean;
}

const onHand = async (code: string) =>
    ((await request(t.app).get('/api/v1/pos/products').set(desk).expect(200)).body.data as typeof products).find(p => p.code === code)!.on_hand;
const sell = (body: Record<string, unknown>, as = desk) => request(t.app).post('/api/v1/pos/sales').set(as).send(body);

describe('the POS (D-102)', () => {
    it('lists what is on sale here, with the price, the VAT and the stock', () => {
        expect(products.find(p => p.code === 'PRD-000005')).toMatchObject({ price: 180, vat_rate: 0.15, on_hand: 20 });
        expect(products.find(p => p.code === 'PRD-000007')).toMatchObject({ price: 30, vat_rate: 0.05, on_hand: 24 });
        expect(products.find(p => p.code === 'PRD-000012')?.on_hand).toBe(0);
    });

    it('a walk-in pays it all: an invoice of kind pos, VAT per line, the stock goes down', async () => {
        const body = {
            member_oid: null,
            lines: [
                { product_oid: product('PRD-000005'), qty: 2 },
                { product_oid: product('PRD-000007'), qty: 3 }
            ]
        };
        const q = (await request(t.app).post('/api/v1/pos/quote').set(desk).send(body).expect(200)).body.data as {
            total: number;
            vat: number;
            short: unknown[];
        };
        // 360 + 15 % = 414; 90 + 5 % = 94.5 → 95 (exclusive VAT, rounded per line).
        expect(q).toMatchObject({ total: 509, vat: 59, short: [] });
        await sell({ ...body, payment: { method: 'cash', amount: 400 } }).expect(400);
        const sale = (await sell({ ...body, walk_in_name: 'Rahim', payment: { method: 'cash', amount: 509 } }).expect(201)).body.data as Sale;
        expect(sale.invoice).toMatchObject({ kind: 'pos', member_oid: null, member_code: 'WALK-IN', total: 509, paid: 509, status: 'Paid' });
        expect(sale.invoice.number).toMatch(/^INV-GUL-2026-\d{5}$/);
        expect(await onHand('PRD-000005')).toBe(18);
        // The receipt is the invoice.
        await request(t.app).get(`/api/v1/invoices/${sale.invoice.oid}`).set(desk).expect(200);
    });

    it('refuses what is not in stock, and a line discount from the desk; a manager gives one with a reason', async () => {
        await sell({ lines: [{ product_oid: product('PRD-000012'), qty: 1 }], payment: { method: 'cash', amount: 1610 } }).expect(409);
        await sell({ lines: [{ product_oid: product('PRD-000001'), qty: 6 }], payment: { method: 'cash', amount: 0 } }).expect(409);
        const discounted = { lines: [{ product_oid: product('PRD-000001'), qty: 1, discount: 200, discount_reason: 'Dented tub' }] };
        await sell({ ...discounted, payment: { method: 'cash', amount: 4600 } }).expect(403);
        await sell({ lines: [{ product_oid: product('PRD-000001'), qty: 1, discount: 200 }], payment: { method: 'cash', amount: 4600 } }, manager).expect(400);
        // (4200 − 200) + 15 % = 4600.
        const sale = (await sell({ ...discounted, payment: { method: 'bkash', amount: 4600, reference: 'BK123' } }, manager).expect(201)).body.data as Sale;
        expect(sale.invoice.total).toBe(4600);
        await sell({ lines: [{ product_oid: product('PRD-000005'), qty: 1 }], payment: { method: 'cash', amount: 207 } }, trainer).expect(403);
    });

    it('a member charges it to the account: the invoice stays due and counts toward their dues', async () => {
        const m = await portalMember(t.app, desk, phone());
        const sale = (
            await sell({ member_oid: m.oid, lines: [{ product_oid: product('PRD-000001'), qty: 1 }], payment: { method: 'cash', amount: 0 } }).expect(201)
        ).body.data as Sale;
        expect(sale).toMatchObject({ charged: 4830, invoice: { status: 'Due', due: 4830 }, customer: { dues_after: 4830, over_limit: true } });
        const member = (await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data as { dues: number };
        expect(member.dues).toBe(4830);
        // The member sees it in the portal with their other invoices.
        const mine = (await request(t.app).get('/api/v1/me/payments').set(m.me).expect(200)).body.data as { oid: string; kind: string }[];
        expect(mine.find(i => i.oid === sale.invoice.oid)?.kind).toBe('pos');
        // Nothing paid: no money to give back until it is paid.
        const back = { lines: [{ index: 0, qty: 1 }], method: 'cash', reason: 'Wrong flavour' };
        expect((await request(t.app).post(`/api/v1/pos/sales/${sale.invoice.oid}/return`).set(desk).send(back).expect(409)).body.message).toMatch(
            /payment first/
        );
        await request(t.app).post('/api/v1/payments').set(desk).send({ invoice_oid: sale.invoice.oid, method: 'cash', amount: 4830 }).expect(200);
        const returned = (await request(t.app).post(`/api/v1/pos/sales/${sale.invoice.oid}/return`).set(desk).send(back).expect(200)).body.data as SaleDetail;
        expect(returned).toMatchObject({ returned_amount: 4830, invoice: { status: 'Refunded', due: 0 }, items: [{ returnable: 0 }] });
        expect(((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data as { dues: number }).dues).toBe(0);
    });

    it('returns: part of a line, damaged ones stay off the shelf, never more than sold; the desk until 3 days', async () => {
        const sale = (await sell({ lines: [{ product_oid: product('PRD-000005'), qty: 3 }], payment: { method: 'cash', amount: 621 } }).expect(201)).body
            .data as Sale;
        const before = await onHand('PRD-000005');
        const url = `/api/v1/pos/sales/${sale.invoice.oid}/return`;
        const one = (
            await request(t.app)
                .post(url)
                .set(desk)
                .send({ lines: [{ index: 0, qty: 1 }], method: 'cash', reason: 'Not wanted' })
                .expect(200)
        ).body.data as SaleDetail;
        expect(one).toMatchObject({ returned_amount: 207, items: [{ returned: 1, returnable: 2 }] });
        expect(await onHand('PRD-000005')).toBe(before + 1);
        await request(t.app)
            .post(url)
            .set(desk)
            .send({ lines: [{ index: 0, qty: 1, damaged: true }], method: 'cash', reason: 'Wrapper torn' })
            .expect(200);
        expect(await onHand('PRD-000005')).toBe(before + 1);
        await request(t.app)
            .post(url)
            .set(desk)
            .send({ lines: [{ index: 0, qty: 2 }], method: 'cash', reason: 'Again' })
            .expect(400);
        // The plan refund step is not for POS sales: the stock would not move.
        await request(t.app).post(`/api/v1/invoices/${sale.invoice.oid}/refund`).set(manager).send({ method: 'cash', reason: 'Back' }).expect(409);
        now = new Date('2026-11-23T06:00:00Z');
        const late = (
            await request(t.app)
                .post(url)
                .set(desk)
                .send({ lines: [{ index: 0, qty: 1 }], method: 'cash', reason: 'Late' })
                .expect(403)
        ).body;
        expect(late.message).toMatch(/Ask a branch manager/);
        const last = (
            await request(t.app)
                .post(url)
                .set(manager)
                .send({ lines: [{ index: 0, qty: 1 }], method: 'cash', reason: 'Late, approved' })
                .expect(200)
        ).body.data as SaleDetail;
        // 207 + 207 + 207 = 621: the whole line back.
        expect(last).toMatchObject({ returned_amount: 621, invoice: { status: 'Refunded' } });
    });

    it('the day’s cash counts POS sales on their own; the reconciliation report still adds up', async () => {
        const day = (await request(t.app).get('/api/v1/cash-closing/today').set(desk).expect(200)).body.data as { pos_sales: number; renewals: number };
        expect(day.pos_sales).toBe(4);
        const sales = (await request(t.app).get('/api/v1/pos/sales').set(desk).expect(200)).body.data as SaleDetail[];
        expect(sales).toHaveLength(4);
        const rec = (await request(t.app).get('/api/v1/hq/reconciliation?from=2026-11-19&to=2026-11-23').set(hq).expect(200)).body.data as {
            ok: boolean;
            checks: { key: string; ok: boolean; rows: unknown[] }[];
        };
        expect(rec.checks.filter(c => !c.ok)).toEqual([]);
        expect(rec.ok).toBe(true);
    });
});

describe('POS: audit log', () => {
    it('each sale and return writes the audit rows the reconciliation report looks for', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ action: string; key: string }>(sql`
                select a.action, a.entity_key as key from audit_log a join invoice i on i.number = split_part(a.entity_key, '/', 2) or i.number = a.entity_key
                where a.entity = 'invoice' and i.kind = 'pos' order by a.created_at`)
        );
        expect(rows.filter(r => r.action === 'create').map(r => r.key.split('/')[0])).toEqual([
            'WALK-IN',
            'WALK-IN',
            expect.stringMatching(/^MEM-GUL-/),
            'WALK-IN'
        ]);
        expect(rows.filter(r => r.action === 'refund')).toHaveLength(4);
    });
});
