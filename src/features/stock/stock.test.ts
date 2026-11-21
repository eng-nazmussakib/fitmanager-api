import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, DHA, HQ } = DEMO_BRANCHES;
let t: TestApp;
let hq: Record<string, string>;
let manager: Record<string, string>;
let desk: Record<string, string>;
let dhaManager: Record<string, string>;
let products: { oid: string; code: string; name: string }[];
let supplier: string;
const product = (code: string) => products.find(p => p.code === code)!.oid;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => new Date('2026-11-19T06:00:00Z') });
    hq = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    dhaManager = atBranch((await signIn(t.app, 'manager.dhanmondi', 'Manager@123')).access_token, DHA.oid);
    products = (await request(t.app).get('/api/v1/products').set(manager).expect(200)).body.data;
    supplier = ((await request(t.app).get('/api/v1/suppliers').set(manager).expect(200)).body.data as { oid: string }[])[0]!.oid;
});
afterAll(() => t.close());

interface Po {
    oid: string;
    code: string;
    status: string;
    total: number;
    lines: { oid: string; product_oid: string; qty: number; received: number; outstanding: number }[];
    deliveries?: { lines: { qty: number; unit_cost: number }[] }[];
}
interface Level {
    product_oid: string;
    on_hand: number;
    low: boolean;
    reorder_level: number;
    avg_cost: number | null;
    on_order: number;
    in_transit: number;
}
const level = async (as: Record<string, string>, oid: string) =>
    ((await request(t.app).get('/api/v1/stock').set(as).expect(200)).body.data as { rows: Level[] }).rows.find(r => r.product_oid === oid)!;

describe('purchase orders (D-100)', () => {
    let po: Po;

    it('a manager raises one; it waits for HQ; HQ approves it; the manager marks it sent', async () => {
        po = (
            await request(t.app)
                .post('/api/v1/purchase-orders')
                .set(manager)
                .send({
                    supplier_oid: supplier,
                    note: 'Monthly order',
                    lines: [
                        { product_oid: product('PRD-000001'), qty: 10, unit_cost: 3000 },
                        { product_oid: product('PRD-000005'), qty: 48, unit_cost: 110 }
                    ]
                })
                .expect(201)
        ).body.data as Po;
        expect(po).toMatchObject({ code: 'PO-GUL-2026-0001', status: 'pending', total: 35280 });
        expect((await level(manager, product('PRD-000001'))).on_order).toBe(10);
        await request(t.app).post('/api/v1/purchase-orders').set(desk).send({ supplier_oid: supplier, lines: [] }).expect(403);
        await request(t.app)
            .post(`/api/v1/purchase-orders/${po.oid}/deliveries`)
            .set(manager)
            .send({ lines: [{ line_oid: po.lines[0]!.oid, qty: 1 }] })
            .expect(409);
        await request(t.app).post(`/api/v1/purchase-orders/${po.oid}/sent`).set(manager).expect(409);
        // HQ sees every branch's open orders; a branch manager cannot approve.
        const open = (await request(t.app).get('/api/v1/purchase-orders?status=pending').set(hq).expect(200)).body.data as Po[];
        expect(open.map(x => x.oid)).toContain(po.oid);
        await request(t.app).post(`/api/v1/hq/purchase-orders/${po.oid}/approve`).set(manager).expect(403);
        await request(t.app).get(`/api/v1/purchase-orders/${po.oid}`).set(dhaManager).expect(404);
        await request(t.app).post(`/api/v1/hq/purchase-orders/${po.oid}/approve`).set(hq).send({ note: 'OK for November' }).expect(200);
        await request(t.app).post(`/api/v1/hq/purchase-orders/${po.oid}/reject`).set(hq).send({ note: 'Too late' }).expect(409);
        expect((await request(t.app).post(`/api/v1/purchase-orders/${po.oid}/sent`).set(manager).expect(200)).body.data.status).toBe('sent');
    });

    it('arrives in two deliveries, each at its own cost: the average cost moves, the order closes', async () => {
        const [whey, bars] = po.lines;
        const first = (
            await request(t.app)
                .post(`/api/v1/purchase-orders/${po.oid}/deliveries`)
                .set(manager)
                .send({
                    lines: [
                        { line_oid: whey!.oid, qty: 4 },
                        { line_oid: bars!.oid, qty: 48 }
                    ]
                })
                .expect(201)
        ).body.data as Po;
        expect(first.status).toBe('partial');
        await request(t.app)
            .post(`/api/v1/purchase-orders/${po.oid}/deliveries`)
            .set(manager)
            .send({ lines: [{ line_oid: whey!.oid, qty: 7 }] })
            .expect(400);
        const done = (
            await request(t.app)
                .post(`/api/v1/purchase-orders/${po.oid}/deliveries`)
                .set(manager)
                .send({ received_on: '2026-11-18', lines: [{ line_oid: whey!.oid, qty: 6, unit_cost: 3200 }] })
                .expect(201)
        ).body.data as Po;
        expect(done.status).toBe('received');
        expect(done.deliveries?.map(d => d.lines.map(l => `${l.qty}@${l.unit_cost}`))).toEqual([['4@3000', '48@110'], ['6@3200']]);
        expect(await level(manager, whey!.product_oid)).toMatchObject({ on_hand: 10, avg_cost: 3120, on_order: 0, low: false });
        // The desk sees counts, not costs.
        expect(await level(desk, whey!.product_oid)).toMatchObject({ on_hand: 10, avg_cost: null });
        await request(t.app).post(`/api/v1/purchase-orders/${po.oid}/cancel`).set(manager).send({ reason: 'Too late' }).expect(409);
    });

    it('HQ rejects with a reason; the branch cancels an open one', async () => {
        const raise = async () =>
            (
                await request(t.app)
                    .post('/api/v1/purchase-orders')
                    .set(manager)
                    .send({ supplier_oid: supplier, lines: [{ product_oid: product('PRD-000009'), qty: 5, unit_cost: 250 }] })
                    .expect(201)
            ).body.data as Po;
        const a = await raise();
        await request(t.app).post(`/api/v1/hq/purchase-orders/${a.oid}/reject`).set(hq).send({}).expect(400);
        expect(
            (await request(t.app).post(`/api/v1/hq/purchase-orders/${a.oid}/reject`).set(hq).send({ note: 'Shakers are overstocked' }).expect(200)).body.data
                .status
        ).toBe('rejected');
        const b = await raise();
        expect(
            (await request(t.app).post(`/api/v1/purchase-orders/${b.oid}/cancel`).set(manager).send({ reason: 'Ordered by phone' }).expect(200)).body.data
                .status
        ).toBe('cancelled');
    });
});

describe('stock (D-101)', () => {
    it('adjustments with a reason; never below zero; only a count adds; the ledger shows each move', async () => {
        const whey = product('PRD-000001');
        await request(t.app).post(`/api/v1/stock/${whey}/adjust`).set(manager).send({ qty: -1, reason: 'damaged', note: 'Tub split' }).expect(200);
        await request(t.app).post(`/api/v1/stock/${whey}/adjust`).set(manager).send({ qty: -50, reason: 'damaged' }).expect(409);
        await request(t.app).post(`/api/v1/stock/${whey}/adjust`).set(manager).send({ qty: 2, reason: 'damaged' }).expect(400);
        await request(t.app).post(`/api/v1/stock/${whey}/adjust`).set(manager).send({ qty: 1, reason: 'count' }).expect(400);
        await request(t.app).post(`/api/v1/stock/${whey}/adjust`).set(manager).send({ qty: 1, reason: 'count', note: 'Found behind the desk' }).expect(200);
        await request(t.app).post(`/api/v1/stock/${whey}/adjust`).set(desk).send({ qty: -1, reason: 'expired' }).expect(403);
        const ledger = (await request(t.app).get(`/api/v1/stock/${whey}/movements`).set(manager).expect(200)).body.data as {
            movements: { kind: string; qty: number; on_hand_after: number; reason: string | null }[];
        };
        expect(ledger.movements.map(m => `${m.kind}:${m.qty}:${m.on_hand_after}`)).toEqual([
            'adjustment:1:10',
            'adjustment:-1:9',
            'received:6:10',
            'received:4:4'
        ]);
    });

    it('a reorder level per branch, with the low list', async () => {
        const bars = product('PRD-000005');
        await request(t.app).put(`/api/v1/stock/${bars}/reorder-level`).set(manager).send({ reorder_level: 60 }).expect(200);
        const low = (await request(t.app).get('/api/v1/stock?low=1').set(desk).expect(200)).body.data as { rows: Level[]; low: number };
        expect(low.rows.find(r => r.product_oid === bars)).toMatchObject({ on_hand: 48, reorder_level: 60, low: true });
        // Never stocked here: 0, at the product's own level, low.
        expect(low.rows.find(r => r.product_oid === product('PRD-000012'))).toMatchObject({ on_hand: 0, low: true });
        await request(t.app).put(`/api/v1/stock/${bars}/reorder-level`).set(desk).send({ reorder_level: 1 }).expect(403);
        const matrix = (await request(t.app).get('/api/v1/hq/stock').set(hq).expect(200)).body.data as {
            branches: { oid: string }[];
            rows: { product_oid: string; cells: { branch_oid: string; on_hand: number; low: boolean }[] }[];
        };
        expect(matrix.branches.map(b => b.oid)).toEqual(expect.arrayContaining([GUL.oid, DHA.oid]));
        expect(matrix.rows.find(r => r.product_oid === bars)?.cells.find(c => c.branch_oid === GUL.oid)).toMatchObject({ on_hand: 48, low: true });
    });
});

describe('transfers between branches (D-101)', () => {
    interface Transfer {
        oid: string;
        code: string;
        status: string;
        direction: string;
        lines: { oid: string; qty_requested: number; qty_sent: number | null; qty_received: number | null; unit_cost: number | null }[];
    }

    it('Dhanmondi asks Gulshan; Gulshan sends part of it at its cost; two arrive short of three', async () => {
        const bars = product('PRD-000005');
        const elsewhere = (await request(t.app).get(`/api/v1/stock/elsewhere?product_oid=${bars}`).set(dhaManager).expect(200)).body.data as {
            branch_oid: string;
            on_hand: number;
        }[];
        expect(elsewhere).toEqual([expect.objectContaining({ branch_oid: GUL.oid, on_hand: 48 })]);
        const asked = (
            await request(t.app)
                .post('/api/v1/transfers')
                .set(dhaManager)
                .send({ from_branch_oid: GUL.oid, note: 'Out of bars', lines: [{ product_oid: bars, qty: 12 }] })
                .expect(201)
        ).body.data as Transfer;
        expect(asked).toMatchObject({ code: 'TRF-DHA-2026-0001', status: 'requested', direction: 'in' });
        await request(t.app)
            .post(`/api/v1/transfers/${asked.oid}/send`)
            .set(dhaManager)
            .send({ lines: [{ line_oid: asked.lines[0]!.oid, qty: 3 }] })
            .expect(403);
        await request(t.app)
            .post(`/api/v1/transfers/${asked.oid}/send`)
            .set(manager)
            .send({ lines: [{ line_oid: asked.lines[0]!.oid, qty: 99 }] })
            .expect(409);
        const sent = (
            await request(t.app)
                .post(`/api/v1/transfers/${asked.oid}/send`)
                .set(manager)
                .send({ lines: [{ line_oid: asked.lines[0]!.oid, qty: 3 }] })
                .expect(200)
        ).body.data as Transfer;
        expect(sent).toMatchObject({ status: 'in_transit', direction: 'out', lines: [{ qty_sent: 3, unit_cost: 110 }] });
        expect((await level(manager, bars)).on_hand).toBe(45);
        expect((await level(dhaManager, bars)).in_transit).toBe(3);
        await request(t.app).post(`/api/v1/transfers/${asked.oid}/cancel`).set(dhaManager).send({ note: 'Changed my mind' }).expect(409);
        const got = (
            await request(t.app)
                .post(`/api/v1/transfers/${asked.oid}/receive`)
                .set(dhaManager)
                .send({ lines: [{ line_oid: asked.lines[0]!.oid, qty: 2 }] })
                .expect(200)
        ).body.data as Transfer;
        expect(got).toMatchObject({ status: 'received', lines: [{ qty_sent: 3, qty_received: 2 }] });
        const ledger = (await request(t.app).get(`/api/v1/stock/${bars}/movements`).set(dhaManager).expect(200)).body.data as {
            product: { on_hand: number; avg_cost: number };
            movements: { kind: string; qty: number; reason: string | null }[];
        };
        expect(ledger.product).toMatchObject({ on_hand: 2, avg_cost: 110 });
        expect(ledger.movements.map(m => `${m.kind}:${m.qty}:${m.reason}`)).toEqual(['adjustment:-1:shortfall', 'transfer_in:3:null']);
    });

    it('the sender rejects, the asker cancels; only before it is sent; the desk has no part in it', async () => {
        const ask = async () =>
            (
                await request(t.app)
                    .post('/api/v1/transfers')
                    .set(dhaManager)
                    .send({ from_branch_oid: GUL.oid, lines: [{ product_oid: product('PRD-000001'), qty: 2 }] })
                    .expect(201)
            ).body.data as Transfer;
        const a = await ask();
        await request(t.app).post(`/api/v1/transfers/${a.oid}/reject`).set(dhaManager).send({ note: 'Not ours to reject' }).expect(403);
        expect(
            (await request(t.app).post(`/api/v1/transfers/${a.oid}/reject`).set(manager).send({ note: 'We need them ourselves' }).expect(200)).body.data.status
        ).toBe('rejected');
        const b = await ask();
        expect(
            (await request(t.app).post(`/api/v1/transfers/${b.oid}/cancel`).set(dhaManager).send({ note: 'Bought locally' }).expect(200)).body.data.status
        ).toBe('cancelled');
        await request(t.app).get('/api/v1/transfers').set(desk).expect(403);
        await request(t.app)
            .post('/api/v1/transfers')
            .set(manager)
            .send({ from_branch_oid: GUL.oid, lines: [{ product_oid: product('PRD-000001'), qty: 1 }] })
            .expect(400);
        const out = (await request(t.app).get('/api/v1/transfers?direction=out').set(manager).expect(200)).body.data as Transfer[];
        expect(out.map(x => x.status).sort()).toEqual(['cancelled', 'received', 'rejected']);
    });
});

describe('stock: audit log', () => {
    it('every order, delivery, adjustment and transfer step writes an audit row at the branch that did it', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ entity: string; action: string }>(sql`
                select distinct entity, action from audit_log where entity in ('purchase_order', 'stock', 'stock_transfer') order by 1, 2`)
        );
        expect(rows.map(r => `${r.entity}:${r.action}`)).toEqual([
            'purchase_order:approve',
            'purchase_order:cancel',
            'purchase_order:create',
            'purchase_order:receive',
            'purchase_order:reject',
            'purchase_order:send',
            'stock:adjust',
            'stock:update',
            'stock_transfer:cancel',
            'stock_transfer:receive',
            'stock_transfer:reject',
            'stock_transfer:request',
            'stock_transfer:send'
        ]);
        // The ledger is append-only.
        await expect(acrossBranches(t.ownerDb, tx => tx.query(sql`update stock_movement set qty = 1`))).rejects.toThrow(/never changed/);
    });
});
