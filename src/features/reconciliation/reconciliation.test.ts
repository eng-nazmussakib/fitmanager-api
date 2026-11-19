import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, HQ } = DEMO_BRANCHES;
let t: TestApp;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => new Date('2026-11-19T06:00:00Z') });
});
afterAll(() => t.close());

interface Report {
    ok: boolean;
    totals: { invoices: number; received: number; closings: number };
    checks: { key: string; ok: boolean; count: number; rows: Record<string, unknown>[] }[];
}

describe('reconciliation (the phase 2 exit check)', () => {
    it('is clean after normal work, and catches money written without the app (overpaid, wrong closing, no audit)', async () => {
        const desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
        const m = (
            await request(t.app)
                .post('/api/v1/members')
                .set(desk)
                .send({ name: 'Recon Check', phone: '01744440000', gender: 'Female', health_flags: [], health_declared: true })
                .expect(201)
        ).body.data;
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
        ).body.data;
        await request(t.app)
            .post('/api/v1/payments')
            .set(desk)
            .send({ invoice_oid: sale.invoice.oid, method: 'bkash', amount: 500, reference: 'TX1' })
            .expect(200);
        // A full refund to bKash (its own audited row): the invoice's net paid goes back to 0.
        await request(t.app)
            .post(`/api/v1/invoices/${sale.invoice.oid}/refund`)
            .set(desk)
            .send({ method: 'bkash', reference: 'RF1', reason: 'Changed mind' })
            .expect(200);
        await request(t.app).post('/api/v1/cash-closing').set(desk).send({ counted_cash: 990, note: 'Ten taka short' }).expect(201);

        const owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
        const clean = (await request(t.app).get('/api/v1/hq/reconciliation').set(owner).expect(200)).body.data as Report & {
            cash_differences: { difference: number }[];
        };
        expect(clean.ok).toBe(true);
        expect(clean.totals).toMatchObject({ invoices: 1, received: 1500, closings: 1 });
        expect(clean.cash_differences).toEqual([expect.objectContaining({ difference: -10 })]);

        // A cash payment written straight into the database: no audit row, the invoice is overpaid, and the
        // desk's closing no longer matches the cash the system has for the day.
        const [deskUser] = await t.ownerDb.query<{ oid: string }>(sql`select oid from app_user where username = 'desk.gulshan'`);
        // The owner role is under FORCE RLS on a real server too: name the branch for this transaction.
        await t.ownerDb.transaction(async tx => {
            await tx.query(sql`select set_config('app.branch_oids', ${`{${GUL.oid}}`}, true)`);
            await tx.query(sql`
                insert into payment (branch_oid, invoice_oid, member_oid, amount, method, received_at, received_by)
                values (${GUL.oid}, ${sale.invoice.oid}, ${m.oid}, 50000, 'cash', ${new Date('2026-11-19T06:00:00Z')}, ${deskUser?.oid})`);
        });
        const bad = (await request(t.app).get(`/api/v1/hq/reconciliation?from=2026-11-19&to=2026-11-19&branch_oid=${GUL.oid}`).set(owner).expect(200)).body
            .data as Report;
        expect(bad.ok).toBe(false);
        const byKey = Object.fromEntries(bad.checks.map(c => [c.key, c]));
        expect(byKey['invoice_paid']).toMatchObject({ ok: false, count: 1 });
        expect(byKey['closing_expected']).toMatchObject({ ok: false, rows: [expect.objectContaining({ expected_cash: 1000, system_cash: 51000 })] });
        expect(byKey['audit']).toMatchObject({ ok: false, rows: [expect.objectContaining({ kind: 'payment' })] });

        await request(t.app).get('/api/v1/hq/reconciliation').set(desk).expect(403);
        await request(t.app).get('/api/v1/hq/reconciliation?from=2026-11-19&to=2026-11-01').set(owner).expect(400);
    });
});
