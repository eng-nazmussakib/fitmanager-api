import request from 'supertest';

import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

let t: TestApp;
let desk: Record<string, string>;
let now = new Date('2026-11-01T06:00:00Z');

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, DEMO_BRANCHES.GUL.oid);
});
afterAll(() => t.close());

describe('expiry reminders, written when the messages are read', () => {
    it('7 days and 1 day before the end, once per plan; nothing for a member who renewed; in-app only', async () => {
        const plans = (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
        const monthly = plans.find(p => p.code === 'GUL-SIN-1M')?.oid;
        const make = async (phone: string, email: string | null) =>
            (
                await request(t.app)
                    .post('/api/v1/members')
                    .set(desk)
                    .send({ name: 'Reminder Person', phone, gender: 'Male', email, health_flags: [], health_declared: true })
                    .expect(201)
            ).body.data as { oid: string };
        const lapsing = await make('01711110001', 'lapse@example.com');
        const renewed = await make('01711110002', null);
        const noContact = await make('01711110003', null);
        for (const m of [lapsing, renewed, noContact])
            await request(t.app).post('/api/v1/subscriptions').set(desk).send({ member_oid: m.oid, plan_oid: monthly, start_date: '2026-11-01' }).expect(201); // ends 30 Nov
        await request(t.app).post('/api/v1/subscriptions').set(desk).send({ member_oid: renewed.oid, plan_oid: monthly, start_date: '2026-12-01' }).expect(201);

        const reminders = async (oid: string, at: string) => {
            now = new Date(at);
            const rows = (await request(t.app).get(`/api/v1/members/${oid}/notifications`).set(desk).expect(200)).body.data as {
                kind: string;
                channel: string;
                status: string;
                subject: string;
                created_at: string;
            }[];
            return rows.filter(r => r.kind.startsWith('expiry'));
        };
        expect(await reminders(lapsing.oid, '2026-11-22T12:00:00Z')).toEqual([]); // 22 Nov: 8 days before the end
        const due = await reminders(lapsing.oid, '2026-11-23T12:00:00Z'); // 23 Nov: 7 days before
        expect(due.map(r => [r.kind, r.channel, r.status, r.created_at])).toEqual([['expiry_7d', 'email', 'logged', '2026-11-22T18:05:00.000Z']]);
        expect(due[0]?.subject).toBe('Your membership ends in 7 days');
        expect(await reminders(lapsing.oid, '2026-11-23T13:00:00Z')).toHaveLength(1); // read again: nothing twice
        expect(await reminders(renewed.oid, '2026-11-29T12:00:00Z')).toEqual([]);
        // Read for the first time after both days: both reminders, each dated its own day.
        expect((await reminders(noContact.oid, '2026-11-29T12:00:00Z')).map(r => [r.kind, r.channel, r.created_at])).toEqual([
            ['expiry_1d', 'sms', '2026-11-28T18:05:00.000Z'],
            ['expiry_7d', 'sms', '2026-11-22T18:05:00.000Z']
        ]);
    });
});
