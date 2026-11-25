import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, DHA } = DEMO_BRANCHES;
const NOW = new Date('2026-11-19T12:00:00Z');
let t: TestApp;
let desk: Record<string, string>;
let deskDha: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => NOW });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    deskDha = atBranch((await signIn(t.app, 'desk.dhanmondi', 'Desk@123')).access_token, DHA.oid);
});
afterAll(() => t.close());

async function soldMember(phone: string) {
    const m = (
        await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send({ name: 'Portal Person', phone, gender: 'Female', email: 'pp@example.com', health_flags: [], health_declared: true })
            .expect(201)
    ).body.data as { oid: string; code: string };
    const plans = (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
    const sale = await request(t.app)
        .post('/api/v1/subscriptions')
        .set(desk)
        .send({ member_oid: m.oid, plan_oid: plans.find(p => p.code === 'GUL-SIN-1M')?.oid, charge_admission: true, payment: { method: 'cash', amount: 2000 } })
        .expect(201);
    return { ...m, invoice: sale.body.data.invoice as { oid: string; number: string; due: number } };
}

describe('member portal', () => {
    it('the desk gives access; the member signs in with the code, must change the password, then sees their portal', async () => {
        const m = await soldMember('01611111111');
        await request(t.app).post(`/api/v1/members/${m.oid}/portal-access`).set(deskDha).send({ password: 'Temp1234' }).expect(404);
        await request(t.app).post(`/api/v1/members/${m.oid}/portal-access`).set(desk).send({ password: 'short' }).expect(400);
        const given = await request(t.app).post(`/api/v1/members/${m.oid}/portal-access`).set(desk).send({ password: 'Temp1234' }).expect(200);
        expect(given.body).toMatchObject({ message: `Portal access given: username ${m.code}`, data: { username: m.code, must_change_password: true } });

        const login = await request(t.app).post('/api/v1/auth/login').send({ username: m.code.toLowerCase(), password: 'Temp1234' }).expect(200);
        const temp = bearer(login.body.data.access_token as string);
        await request(t.app)
            .get('/api/v1/me/summary')
            .set(...temp)
            .expect(403);
        await request(t.app)
            .post('/api/v1/auth/change-password')
            .set(...temp)
            .send({ current_password: 'Temp1234', new_password: 'Mine5678x' })
            .expect(200);

        const again = await request(t.app).post('/api/v1/auth/login').send({ username: m.code, password: 'Mine5678x' }).expect(200);
        const me = bearer(again.body.data.access_token as string);
        const who = (
            await request(t.app)
                .get('/api/v1/auth/me')
                .set(...me)
                .expect(200)
        ).body.data;
        expect(who).toMatchObject({
            kind: 'member',
            member: { oid: m.oid, code: m.code, branch: { code: 'GUL' } },
            rules: [{ action: 'manage', subject: 'Portal' }]
        });

        const sum = (
            await request(t.app)
                .get('/api/v1/me/summary')
                .set(...me)
                .expect(200)
        ).body.data;
        expect(sum).toMatchObject({
            member: { code: m.code, status: 'Active', branch_name: 'Gulshan' },
            subscription: { status: 'Active', plan_name: 'Single · Monthly' },
            days_left: 29,
            days_total: 30,
            dues: m.invoice.due,
            next_booking: null
        });
        const pays = (
            await request(t.app)
                .get('/api/v1/me/payments')
                .set(...me)
                .expect(200)
        ).body.data as { number: string; paid: number }[];
        expect(pays).toEqual([expect.objectContaining({ number: m.invoice.number, paid: 2000 })]);
        expect(
            (
                await request(t.app)
                    .get('/api/v1/me/attendance')
                    .set(...me)
                    .expect(200)
            ).body.data
        ).toMatchObject({ to: '2026-11-19', days: [] });
        const msgs = (
            await request(t.app)
                .get('/api/v1/me/notifications')
                .set(...me)
                .expect(200)
        ).body.data as { kind: string; status: string }[];
        expect(msgs.filter(m => m.kind === 'receipt')).toEqual([expect.objectContaining({ kind: 'receipt', status: 'logged' })]);
        // The policies the new member still has to accept are messages too, written when the list is read.
        expect(msgs.filter(m => m.kind === 'policy_to_accept').length).toBeGreaterThan(0);

        // A member cannot reach staff routes.
        await request(t.app)
            .get('/api/v1/members')
            .set(...me)
            .set('X-Branch-Id', GUL.oid)
            .expect(403);
    });

    it('a reset ends the member’s sessions and asks for a new password again; staff cannot use /v1/me', async () => {
        const m = await soldMember('01622222222');
        await request(t.app).post(`/api/v1/members/${m.oid}/portal-access`).set(desk).send({ password: 'Temp1234' }).expect(200);
        const login = await request(t.app).post('/api/v1/auth/login').send({ username: m.code, password: 'Temp1234' }).expect(200);
        const reset = await request(t.app).post(`/api/v1/members/${m.oid}/portal-access`).set(desk).send({ password: 'Other1234' }).expect(200);
        expect(reset.body.data).toMatchObject({ reset: true });
        await request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: login.body.data.refresh_token }).expect(401);
        await request(t.app).post('/api/v1/auth/login').send({ username: m.code, password: 'Temp1234' }).expect(400);
        await request(t.app).post('/api/v1/auth/login').send({ username: m.code, password: 'Other1234' }).expect(200);
        await request(t.app).get('/api/v1/me/summary').set(desk).expect(403);
    });

    it('a join request gets no portal yet; an anonymised member’s account stops working', async () => {
        const pending = (
            await request(t.app)
                .post('/api/v1/members')
                .set(desk)
                .send({ name: 'Not Yet', phone: '01633333333', gender: 'Male', health_flags: [], health_declared: true })
                .expect(201)
        ).body.data as { oid: string };
        await request(t.app).post(`/api/v1/members/${pending.oid}/portal-access`).set(desk).send({ password: 'Temp1234' }).expect(409);
        const m = await soldMember('01644444444');
        await request(t.app).post(`/api/v1/members/${m.oid}/portal-access`).set(desk).send({ password: 'Temp1234' }).expect(200);
        const manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
        await request(t.app).post(`/api/v1/members/${m.oid}/anonymise`).set(manager).send({ confirm_code: m.code }).expect(200);
        await request(t.app).post('/api/v1/auth/login').send({ username: m.code, password: 'Temp1234' }).expect(403); // account inactive
    });

    it('portal access is audited at the branch', async () => {
        const rows = await withBranchTx(t.deps.db, systemContext(GUL.oid), tx =>
            tx.query<{ action: string }>(sql`select distinct action from audit_log where action in ('grant_portal', 'reset_portal_password') order by action`)
        );
        expect(rows.map(r => r.action)).toEqual(['grant_portal', 'reset_portal_password']);
    });
});
