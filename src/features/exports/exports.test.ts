import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, stockUp, type TestApp } from '#src/testing/test-app.ts';

const { GUL, HQ } = DEMO_BRANCHES;
let t: TestApp;
let owner: Record<string, string>;
let hq: Record<string, string>;
let manager: Record<string, string>;
let desk: Record<string, string>;
let trainer: Record<string, string>;

interface Page {
    columns: { key: string; unit: string }[];
    rows: Record<string, unknown>[];
    next: string | null;
    total: number | null;
}

const exportsOf = async (as: Record<string, string>, kind: string) =>
    (
        await request(t.app)
            .get(`/api/v1/${as === owner ? 'hq' : 'branch'}/audit?entity=export&entity_key=${kind}`)
            .set(as)
            .expect(200)
    ).body.data.rows as {
        action: string;
        after: Record<string, unknown>;
    }[];

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => new Date('2026-11-19T06:00:00Z') });
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
    hq = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
    const plans = (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
    for (const [i, name] of ['Export One', 'Export Two', 'Export Three'].entries()) {
        const m = (
            await request(t.app)
                .post('/api/v1/members')
                .set(desk)
                .send({ name, phone: `0174445000${i}`, gender: 'Male', health_flags: [], health_declared: true })
                .expect(201)
        ).body.data as { oid: string };
        await request(t.app)
            .post('/api/v1/subscriptions')
            .set(desk)
            .send({
                member_oid: m.oid,
                plan_oid: plans.find(p => p.code === 'GUL-SIN-1M')?.oid,
                charge_admission: false,
                payment: { method: 'cash', amount: 500 + i }
            })
            .expect(201);
    }
    await stockUp(t.app, manager, hq, [{ code: 'PRD-000007', qty: 12, unit_cost: 15 }]);
});
afterAll(() => t.close());

describe('exports', () => {
    it('member data leaves only through branch managers and HQ: not the desk or a trainer', async () => {
        await request(t.app).post('/api/v1/exports/members').set(desk).send({ format: 'xlsx' }).expect(403);
        await request(t.app).post('/api/v1/exports/members').set(trainer).send({ format: 'xlsx' }).expect(403);
        await request(t.app).post('/api/v1/exports/payments').set(desk).send({ format: 'pdf' }).expect(403);
        await request(t.app).post('/api/v1/exports/members').set(manager).send({ format: 'docx' }).expect(400);
        await request(t.app).post('/api/v1/exports/members').set(manager).send({ format: 'xlsx', extra: 1 }).expect(400);
    });

    it('the member list: its columns, the rows by the list’s filters, and one audit row for the first page only', async () => {
        const page = (
            await request(t.app)
                .post('/api/v1/exports/members')
                .set(manager)
                .send({ format: 'xlsx', filters: { q: 'Export' } })
                .expect(200)
        ).body.data as Page;
        expect(page.total).toBe(3);
        expect(page.next).toBeNull();
        expect(page.columns.map(c => c.key)).toEqual([
            'code',
            'name',
            'phone',
            'gender',
            'status',
            'plan_name',
            'valid_until',
            'dues',
            'last_visit',
            'joined_on'
        ]);
        expect(page.rows.map(r => r['name']).sort()).toEqual(['Export One', 'Export Three', 'Export Two']);
        expect(page.rows[0]).not.toHaveProperty('photo_url');
        await request(t.app)
            .post('/api/v1/exports/members')
            .set(manager)
            .send({ format: 'xlsx', filters: { q: 'Export' }, page: 2 })
            .expect(200);
        const logged = await exportsOf(manager, 'members');
        expect(logged).toEqual([expect.objectContaining({ action: 'export', after: { format: 'xlsx', filters: { q: 'Export' }, rows: 3 } })]);
    });

    it('payments in a range, a page at a time', async () => {
        const page = (
            await request(t.app)
                .post('/api/v1/exports/payments')
                .set(manager)
                .send({ format: 'pdf', filters: { from: '2026-11-19', to: '2026-11-19' } })
                .expect(200)
        ).body.data as Page;
        expect(page.total).toBe(3);
        // Oldest first; the fixed clock gives them one time, so their order is by id.
        expect(page.rows.map(r => r['amount']).sort()).toEqual([500, 501, 502]);
        expect(page.rows.find(r => r['amount'] === 500)).toMatchObject({ kind: 'payment', method: 'cash', member_name: 'Export One' });
        await request(t.app)
            .post('/api/v1/exports/payments')
            .set(manager)
            .send({ format: 'pdf', filters: { from: '2025-01-01', to: '2026-11-19' } })
            .expect(400);
        await request(t.app).post('/api/v1/exports/payments').set(manager).send({ format: 'pdf', after: 'not-a-cursor' }).expect(400);
        expect(await exportsOf(manager, 'payments')).toHaveLength(1);
    });

    it('stock, with the costs for a manager', async () => {
        const page = (await request(t.app).post('/api/v1/exports/stock').set(manager).send({ format: 'xlsx' }).expect(200)).body.data as Page;
        expect(page.rows.find(r => r['code'] === 'PRD-000007')).toMatchObject({ on_hand: 12, avg_cost: 15, value: 180 });
        expect(page.columns.map(c => c.key)).toContain('avg_cost');
    });

    it('the audit log, at HQ and at a branch; HQ admin may export too', async () => {
        const page = (
            await request(t.app)
                .post('/api/v1/exports/audit')
                .set(owner)
                .send({ format: 'xlsx', filters: { entity: 'subscription' } })
                .expect(200)
        ).body.data as Page;
        expect(page.total).toBe(3);
        expect(page.rows[0]).toMatchObject({ action: 'create', entity: 'subscription', branch_name: 'Gulshan' });
        await request(t.app).post('/api/v1/exports/audit').set(hq).send({ format: 'pdf' }).expect(200);
        await request(t.app).post('/api/v1/exports/audit').set(desk).send({ format: 'pdf' }).expect(403);
        expect(await exportsOf(owner, 'audit')).toHaveLength(2);
    });

    it('refuses more than 50 000 rows, before writing anything', async () => {
        await t.ownerDb.transaction(async tx => {
            await tx.query(sql`select set_config('app.branch_oids', ${`{${GUL.oid}}`}, true)`);
            await tx.query(sql`
                insert into audit_log (branch_oid, actor_name, action, entity, entity_key, created_at)
                select ${GUL.oid}, 'Load test', 'note', 'bulk', 'row ' || n, now() from generate_series(1, 50001) n`);
        });
        const res = await request(t.app)
            .post('/api/v1/exports/audit')
            .set(manager)
            .send({ format: 'xlsx', filters: { entity: 'bulk' } })
            .expect(400);
        expect(res.body.message).toMatch(/50,001 rows; the most is 50,000/);
        expect(await exportsOf(manager, 'audit')).toHaveLength(0);
    });

    it('a report table: only the audit row', async () => {
        const body = { format: 'pdf', report: 'revenue', table: 'by_method', from: '2026-11-01', to: '2026-11-19', rows: 4 };
        await request(t.app).post('/api/v1/exports/report').set(desk).send(body).expect(403);
        await request(t.app)
            .post('/api/v1/exports/report')
            .set(manager)
            .send({ ...body, rows: 50_001 })
            .expect(400);
        await request(t.app).post('/api/v1/exports/report').set(manager).send(body).expect(200);
        expect(await exportsOf(manager, 'report:revenue/by_method')).toEqual([
            expect.objectContaining({ after: { format: 'pdf', from: '2026-11-01', to: '2026-11-19', rows: 4 } })
        ]);
    });
});
