import request from 'supertest';

import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, HQ } = DEMO_BRANCHES;
let t: TestApp;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => new Date('2026-11-19T12:00:00Z') });
});
afterAll(() => t.close());

describe('dashboards', () => {
    it('branch: KPIs follow a sale, a payment and a check-in; HQ sums the branches; a desk cannot read HQ', async () => {
        const desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
        const m = (
            await request(t.app)
                .post('/api/v1/members')
                .set(desk)
                .send({ name: 'Dash Board', phone: '01733330000', gender: 'Male', health_flags: [], health_declared: true })
                .expect(201)
        ).body.data;
        const plans = (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
        await request(t.app)
            .post('/api/v1/subscriptions')
            .set(desk)
            .send({
                member_oid: m.oid,
                plan_oid: plans.find(p => p.code === 'GUL-SIN-1M')?.oid,
                charge_admission: true,
                payment: { method: 'cash', amount: 1000 }
            })
            .expect(201);

        const manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
        await request(t.app)
            .post('/api/v1/attendance/check-in')
            .set(manager)
            .send({ member_oid: m.oid, override: { reason: 'Dues to be paid today' } })
            .expect(201);

        const d = (await request(t.app).get('/api/v1/dashboard').set(desk).expect(200)).body.data;
        const k = Object.fromEntries((d.kpis as { id: string; value: number }[]).map(x => [x.id, x.value]));
        expect(k).toMatchObject({ active_members: 1, revenue: 1000, check_ins_today: 1, new_members: 1 });
        expect(k['dues']).toBeGreaterThan(1000);
        expect(d.attention).toEqual([expect.objectContaining({ kind: 'dues', member_code: m.code })]);
        expect(d.revenue_trend[0].points).toHaveLength(30);
        expect(d.attendance_heatmap).toHaveLength(7);

        const owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
        const hq = (await request(t.app).get('/api/v1/hq/dashboard?from=2026-11-01&to=2026-11-19').set(owner).expect(200)).body.data;
        expect((hq.comparison as { branch: { code: string } }[]).map(c => c.branch.code)).toEqual(['DHA', 'GUL', 'UTT']);
        expect((hq.kpis as { id: string; value: number }[]).find(x => x.id === 'revenue')?.value).toBe(1000);
        await request(t.app).get('/api/v1/hq/dashboard').set(desk).expect(403);
        await request(t.app).get('/api/v1/dashboard?from=2026-11-19&to=2026-11-01').set(desk).expect(400);
    });
});
