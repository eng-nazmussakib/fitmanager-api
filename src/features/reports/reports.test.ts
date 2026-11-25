import request from 'supertest';

import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, stockUp, type TestApp } from '#src/testing/test-app.ts';

import { REPORT_KEYS } from './reports.service.ts';

const { GUL, DHA, HQ } = DEMO_BRANCHES;
const NOW = new Date('2026-11-19T06:00:00Z'); // 12:00 in Dhaka
let t: TestApp;
let owner: Record<string, string>;
let hq: Record<string, string>;
let manager: Record<string, string>;
let desk: Record<string, string>;
let deskDha: Record<string, string>;
let trainer: Record<string, string>;

interface Kpi {
    key: string;
    value: number | null;
    previous: number | null;
    by_branch: Record<string, number | null>;
}
interface Table {
    key: string;
    columns: { key: string }[];
    rows: Record<string, unknown>[];
    total: Record<string, unknown> | null;
}
interface Report {
    key: string;
    from: string;
    to: string;
    previous: { from: string; to: string } | null;
    branches: { code: string }[];
    kpis: Kpi[];
    tables: Table[];
    charts: { key: string; categories: string[]; series: { name: string; data: (number | null)[] }[] }[];
}

const kpi = (r: Report, key: string) => r.kpis.find(k => k.key === key);
const table = (r: Report, key: string) => r.tables.find(x => x.key === key);
const report = async (key: string, as = manager, query = '') =>
    (await request(t.app).get(`/api/v1/reports/${key}${query}`).set(as).expect(200)).body.data as Report;

let saleTotal = 0;
let posTotal = 0;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => NOW });
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
    hq = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    deskDha = atBranch((await signIn(t.app, 'desk.dhanmondi', 'Desk@123')).access_token, DHA.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);

    // A member sold a month's plan who still owes most of it, and one who paid it all and comes in once.
    const m = (
        await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send({ name: 'Report Person', phone: '01744441111', gender: 'Female', health_flags: [], health_declared: true })
            .expect(201)
    ).body.data as { oid: string; code: string };
    const plans = (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
    const sale = (
        await request(t.app)
            .post('/api/v1/subscriptions')
            .set(desk)
            .send({
                member_oid: m.oid,
                plan_oid: plans.find(p => p.code === 'GUL-SIN-1M')?.oid,
                charge_admission: false,
                payment: { method: 'cash', amount: 1000 }
            })
            .expect(201)
    ).body.data as { invoice: { total: number } };
    saleTotal = sale.invoice.total;
    const paidUp = (
        await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send({ name: 'Paid Up', phone: '01744441112', gender: 'Male', health_flags: [], health_declared: true })
            .expect(201)
    ).body.data as { oid: string };
    await request(t.app)
        .post('/api/v1/subscriptions')
        .set(desk)
        .send({
            member_oid: paidUp.oid,
            plan_oid: plans.find(p => p.code === 'GUL-SIN-1M')?.oid,
            charge_admission: false,
            payment: { method: 'cash', amount: saleTotal }
        })
        .expect(201);
    await request(t.app).post('/api/v1/attendance/check-in').set(desk).send({ member_oid: paidUp.oid }).expect(201);

    // Two protein bars sold to a walk-in, at an average cost of 110.
    await stockUp(t.app, manager, hq, [{ code: 'PRD-000005', qty: 10, unit_cost: 110 }]);
    const products = (await request(t.app).get('/api/v1/pos/products').set(desk).expect(200)).body.data as { oid: string; code: string; price: number }[];
    const bar = products.find(p => p.code === 'PRD-000005');
    const quote = (
        await request(t.app)
            .post('/api/v1/pos/quote')
            .set(desk)
            .send({ lines: [{ product_oid: bar?.oid, qty: 2 }] })
    ).body.data as { total?: number } | undefined;
    posTotal = quote?.total ?? 414;
    await request(t.app)
        .post('/api/v1/pos/sales')
        .set(desk)
        .send({ lines: [{ product_oid: bar?.oid, qty: 2 }], payment: { method: 'bkash', amount: posTotal, reference: 'BK1' } })
        .expect(201);

    // Something at Dhanmondi, for HQ's comparison.
    const d = (
        await request(t.app)
            .post('/api/v1/members')
            .set(deskDha)
            .send({ name: 'Other Branch', phone: '01744442222', gender: 'Male', health_flags: [], health_declared: true })
            .expect(201)
    ).body.data as { oid: string };
    const dhaPlans = (await request(t.app).get('/api/v1/plans').set(deskDha).expect(200)).body.data as { oid: string; code: string }[];
    await request(t.app)
        .post('/api/v1/subscriptions')
        .set(deskDha)
        .send({
            member_oid: d.oid,
            plan_oid: dhaPlans.find(p => p.code === 'DHA-SIN-1M')?.oid,
            charge_admission: false,
            payment: { method: 'card', amount: 100, reference: 'POS1' }
        })
        .expect(201);
});
afterAll(() => t.close());

describe('reports', () => {
    it('are for branch managers and HQ: not the desk or trainers, and HQ reports only at HQ', async () => {
        await request(t.app).get('/api/v1/reports/revenue').set(desk).expect(403);
        await request(t.app).get('/api/v1/reports/revenue').set(trainer).expect(403);
        await request(t.app).get('/api/v1/hq/reports/revenue').set(manager).expect(403);
        await request(t.app).get('/api/v1/reports/revenue').set(owner).expect(400); // a branch route, opened at HQ
        await request(t.app).get('/api/v1/reports/revenue').expect(401);
        await request(t.app).get('/api/v1/hq/reports/revenue').set(hq).expect(200);
    });

    it('checks the key and the range: at most 366 days, the start not after the end', async () => {
        await request(t.app).get('/api/v1/reports/payroll').set(manager).expect(400);
        await request(t.app).get('/api/v1/reports/revenue?from=2026-11-10&to=2026-11-01').set(manager).expect(400);
        await request(t.app).get('/api/v1/reports/revenue?from=2025-11-01&to=2026-11-19').set(manager).expect(400);
        const year = await report('revenue', manager, '?from=2025-11-19&to=2026-11-19');
        expect(year.charts[0]?.categories.length).toBe(13); // over 200 days: by month
        const def = await report('revenue');
        expect(def).toMatchObject({ from: '2026-10-21', to: '2026-11-19', previous: null });
        expect(def.charts[0]?.categories).toHaveLength(30); // up to 62 days: by day
    });

    it('answers every report at a branch and at HQ', async () => {
        for (const key of REPORT_KEYS) {
            const r = await report(key);
            expect(r.branches.map(b => b.code)).toEqual(['GUL']);
            expect(r.kpis.length).toBeGreaterThan(0);
            const all = (await request(t.app).get(`/api/v1/hq/reports/${key}?compare=1`).set(owner).expect(200)).body.data as Report;
            expect(all.branches.map(b => b.code).sort()).toEqual(['DHA', 'GUL', 'UTT']);
            expect(all.previous).toEqual({ from: '2026-09-21', to: '2026-10-20' });
        }
    });

    it('revenue: invoiced, received and the shop, by method and by plan; HQ has a column per branch', async () => {
        const r = await report('revenue');
        expect(kpi(r, 'invoiced')?.value).toBe(2 * saleTotal + posTotal);
        expect(kpi(r, 'received')?.value).toBe(1000 + saleTotal + posTotal);
        expect(kpi(r, 'shop')?.value).toBe(posTotal);
        expect(table(r, 'by_method')?.rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ method: 'Cash', received: 1000 + saleTotal }),
                expect.objectContaining({ method: 'bKash', received: posTotal })
            ])
        );
        expect(table(r, 'by_source')?.rows).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'Shop', invoiced: posTotal })]));

        const all = (await request(t.app).get('/api/v1/hq/reports/revenue').set(owner).expect(200)).body.data as Report;
        expect(kpi(all, 'received')?.by_branch).toMatchObject({ GUL: 1000 + saleTotal + posTotal, DHA: 100, UTT: 0 });
        expect(kpi(all, 'received')?.value).toBe(1100 + saleTotal + posTotal);
        expect(table(all, 'by_method')?.columns.map(c => c.key)).toEqual(expect.arrayContaining(['b_GUL', 'b_DHA', 'b_UTT', 'net']));
        expect(all.charts[0]?.series.map(s => s.name).sort()).toEqual(['Dhanmondi', 'Gulshan', 'Uttara']);
        // One branch from HQ, and none it does not reach.
        const one = (await request(t.app).get(`/api/v1/hq/reports/revenue?branch_oid=${DHA.oid}`).set(owner).expect(200)).body.data as Report;
        expect(one.branches.map(b => b.code)).toEqual(['DHA']);
    });

    it('dues: what is still owed at the end of the range, by age and by member', async () => {
        const r = await report('dues');
        expect(kpi(r, 'due')?.value).toBe(saleTotal - 1000);
        expect(table(r, 'largest')?.rows).toEqual([expect.objectContaining({ member_name: 'Report Person', due: saleTotal - 1000, oldest: 0 })]);
        expect(table(r, 'by_age')?.rows[0]).toMatchObject({ age: '0–30 days', due: saleTotal - 1000 });
        // Before the sale nothing was owed.
        expect(kpi(await report('dues', manager, '?from=2026-10-01&to=2026-10-31'), 'due')?.value).toBe(0);
    });

    it('members, attendance and the shop margin at average cost', async () => {
        const m = await report('members');
        expect(kpi(m, 'joined')?.value).toBe(2);
        expect(kpi(m, 'active')?.value).toBe(2);
        expect(table(m, 'plans')?.rows).toEqual([expect.objectContaining({ sold: 2, renewals: 0 })]);

        const a = await report('attendance');
        expect(kpi(a, 'visits')?.value).toBe(1);
        expect(kpi(a, 'unique_members')?.value).toBe(1);

        const s = await report('shop');
        const net = kpi(s, 'net_sales')?.value ?? 0;
        expect(kpi(s, 'qty')?.value).toBe(2);
        expect(kpi(s, 'cost')?.value).toBe(220);
        expect(kpi(s, 'margin')?.value).toBe(net - 220);
        expect(table(s, 'by_product')?.rows).toEqual([expect.objectContaining({ product: 'Protein bar, 60 g', qty: 2, cost: 220 })]);
    });

    it('compares with the previous period of the same length', async () => {
        const r = await report('revenue', manager, '?from=2026-11-10&to=2026-11-19&compare=1');
        expect(r.previous).toEqual({ from: '2026-10-31', to: '2026-11-09' });
        expect(kpi(r, 'received')).toMatchObject({ value: 1000 + saleTotal + posTotal, previous: 0 });
        // Figures "as of now" (stock value) have nothing to compare with.
        expect(kpi(await report('operations', manager, '?compare=1'), 'value')?.previous).toBeNull();
    });
});

describe('a trainer’s numbers', () => {
    let sam = '';
    let tom = '';
    beforeAll(async () => {
        const list = (await request(t.app).get('/api/v1/trainers').set(desk).expect(200)).body.data as { oid: string; slug: string }[];
        sam = list.find(x => x.slug === 'sam-cole')?.oid ?? '';
        tom = list.find(x => x.slug === 'tom-blake')?.oid ?? '';
    });

    it('a trainer sees their own, not a colleague’s; managers see anyone’s; the desk no one’s', async () => {
        const own = (await request(t.app).get(`/api/v1/trainers/${sam}/numbers`).set(trainer).expect(200)).body.data as Report;
        expect(own.kpis.map(k => k.key)).toEqual(expect.arrayContaining(['pt_completed', 'classes', 'rating']));
        await request(t.app).get(`/api/v1/trainers/${tom}/numbers`).set(trainer).expect(403);
        await request(t.app).get(`/api/v1/trainers/${tom}/numbers`).set(manager).expect(200);
        await request(t.app).get(`/api/v1/trainers/${tom}/numbers`).set(desk).expect(403);
        await request(t.app).get('/api/v1/trainers/00000000-0000-4000-8000-0000000000aa/numbers').set(manager).expect(404);
    });
});
