import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { rlsScoped } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, suspendMember, type TestApp } from '#src/testing/test-app.ts';

const { GUL, DHA, UTT } = DEMO_BRANCHES;
let now = new Date('2026-11-19T12:00:00Z'); // Thursday 18:00 in Dhaka
let t: TestApp;
let desk: Record<string, string>;
let manager: Record<string, string>;
let deskDha: Record<string, string>;
let managerDha: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    deskDha = atBranch((await signIn(t.app, 'desk.dhanmondi', 'Desk@123')).access_token, DHA.oid);
    managerDha = atBranch((await signIn(t.app, 'manager.dhanmondi', 'Manager@123')).access_token, DHA.oid);
});
afterAll(() => t.close());

let phoneSeq = 0;
/** A Gulshan member with a running, paid monthly plan (or as `opts` say). */
async function member(opts: { sell?: boolean; pay?: 'all' | number } = {}) {
    const phone = `0191${String(10_000_000 + ++phoneSeq).slice(1)}`;
    const m = (
        await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send({ name: 'Visit Tester', phone, gender: 'Female', health_flags: [], health_declared: true })
            .expect(201)
    ).body.data as { oid: string; code: string };
    if (opts.sell === false) return m;
    const plans = (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
    const sale = await request(t.app)
        .post('/api/v1/subscriptions')
        .set(desk)
        .send({ member_oid: m.oid, plan_oid: plans.find(p => p.code === 'GUL-SIN-1M')?.oid, charge_admission: false })
        .expect(201);
    const total = sale.body.data.invoice.total as number;
    const amount = opts.pay === undefined || opts.pay === 'all' ? total : opts.pay;
    if (amount > 0)
        await request(t.app).post('/api/v1/payments').set(desk).send({ invoice_oid: sale.body.data.invoice.oid, method: 'cash', amount }).expect(200);
    return m;
}

describe('evaluate and check in (D-059, D-061)', () => {
    it('an active member at their branch: allowed; checked in; then "already inside" blocks a second scan anywhere', async () => {
        const m = await member();
        const ev = await request(t.app).post('/api/v1/attendance/evaluate').set(desk).send({ code: m.code }).expect(200);
        expect(ev.body.data).toMatchObject({
            allowed: true,
            failures: [],
            member: { code: m.code, status: 'Active', visitor: false, plan_name: 'Single · Monthly' }
        });
        const ci = await request(t.app).post('/api/v1/attendance/check-in').set(desk).send({ member_oid: m.oid }).expect(201);
        expect(ci.body).toMatchObject({ message: 'Visit Tester checked in', data: { member_code: m.code, visitor: false, checked_out_at: null } });
        const again = await request(t.app).post('/api/v1/attendance/evaluate').set(deskDha).send({ code: m.code }).expect(200);
        expect(again.body.data.failures).toEqual([
            { rule: 'already_in', message: 'Already checked in at Gulshan at 6:00 pm. Check out first.', overridable: false }
        ]);
        await request(t.app).post(`/api/v1/attendance/${ci.body.data.oid}/check-out`).set(deskDha).expect(404);
        await request(t.app).post(`/api/v1/attendance/${ci.body.data.oid}/check-out`).set(desk).expect(200);
        await request(t.app).post(`/api/v1/attendance/${ci.body.data.oid}/check-out`).set(desk).expect(409);
    });

    it('a visitor at another branch (D-059, D-066): allowed, sees only the outcome; the visit shows at both branches', async () => {
        const m = await member();
        const ev = await request(t.app).post('/api/v1/attendance/evaluate').set(deskDha).send({ code: m.code }).expect(200);
        expect(ev.body.data).toMatchObject({
            allowed: true,
            member: { visitor: true, home_branch_name: 'Gulshan', plan_name: null, valid_until: null, dues: 0 }
        });
        const ci = await request(t.app).post('/api/v1/attendance/check-in').set(deskDha).send({ code: m.code }).expect(201);
        expect(ci.body.data).toMatchObject({ visitor: true, home_branch_name: 'Gulshan' });
        const dhaToday = (await request(t.app).get('/api/v1/attendance/today').set(deskDha).expect(200)).body.data as { member_code: string }[];
        expect(dhaToday.map(c => c.member_code)).toContain(m.code);
        // The home branch sees the visit in the member's history, not on its own floor list.
        const gulToday = (await request(t.app).get('/api/v1/attendance/today').set(desk).expect(200)).body.data as { member_code: string }[];
        expect(gulToday.map(c => c.member_code)).not.toContain(m.code);
        const heat = (await request(t.app).get(`/api/v1/members/${m.oid}/attendance?days=7`).set(desk).expect(200)).body.data;
        expect(heat).toEqual({ from: '2026-11-13', to: '2026-11-19', days: [{ date: '2026-11-19', count: 1 }] });
        // The visited branch still cannot open the member's record.
        await request(t.app).get(`/api/v1/members/${m.oid}`).set(deskDha).expect(404);
        await request(t.app).get(`/api/v1/members/${m.oid}/attendance`).set(deskDha).expect(404);
        await request(t.app).post(`/api/v1/attendance/${ci.body.data.oid}/check-out`).set(deskDha).expect(200);
    });

    it('the home branch’s dues limit applies wherever the member trains', async () => {
        const m = await member({ pay: 0 }); // owes the whole plan, above Gulshan's ৳1,000
        const ev = await request(t.app).post('/api/v1/attendance/evaluate').set(deskDha).send({ code: m.code }).expect(200);
        expect((ev.body.data.failures as { rule: string }[]).map(f => f.rule)).toEqual(['dues']);
        expect(ev.body.data.failures[0].message).toMatch(/\(Gulshan\)\.$/);
    });

    it('blocked: a join request, outside opening hours, an unknown code', async () => {
        const pending = await member({ sell: false });
        expect((await request(t.app).post('/api/v1/attendance/evaluate').set(desk).send({ code: pending.code }).expect(200)).body.data).toMatchObject({
            allowed: false,
            can_override: false
        });
        await request(t.app)
            .post('/api/v1/attendance/check-in')
            .set(manager)
            .send({ code: pending.code, override: { reason: 'Please let in' } })
            .expect(409);
        const m = await member();
        now = new Date('2026-11-19T00:30:00Z'); // 06:30 in Dhaka
        const early = await request(t.app).post('/api/v1/attendance/evaluate').set(desk).send({ code: m.code }).expect(200);
        expect(early.body.data.failures).toEqual([{ rule: 'hours', message: 'Gulshan opens at 7:00 am today.', overridable: true }]);
        now = new Date('2026-11-19T12:00:00Z');
        await request(t.app).post('/api/v1/attendance/evaluate').set(desk).send({ code: 'MEM-GUL-999999' }).expect(404);
        await request(t.app).post('/api/v1/attendance/evaluate').set(desk).send({}).expect(400);
    });

    it('override: only a manager, only overridable blocks, with a reason; written with the reason', async () => {
        const m = await member({ pay: 0 });
        await request(t.app).post('/api/v1/attendance/check-in').set(desk).send({ code: m.code }).expect(409);
        await request(t.app)
            .post('/api/v1/attendance/check-in')
            .set(desk)
            .send({ code: m.code, override: { reason: 'Manager said so' } })
            .expect(403);
        await request(t.app)
            .post('/api/v1/attendance/check-in')
            .set(manager)
            .send({ code: m.code, override: { reason: 'ok' } })
            .expect(400);
        const ci = await request(t.app)
            .post('/api/v1/attendance/check-in')
            .set(manager)
            .send({ code: m.code, override: { reason: 'Paying tomorrow' } })
            .expect(201);
        expect(ci.body).toMatchObject({
            message: 'Visit Tester checked in with an override',
            data: { override: { reason: 'Paying tomorrow', by: 'Ashraf Siddique' } }
        });
    });

    it('a suspension blocks every branch and is not overridden (D-093); the membership keeps running', async () => {
        const m = await member();
        await suspendMember(t.app, manager, m.code, { today: '2026-11-19', now: '2026-11-19T11:00:00+06:00', reason: 'Card lent to a friend' });
        for (const [at, who] of [
            [desk, 'own'],
            [deskDha, 'visited']
        ] as const) {
            const ev = (await request(t.app).post('/api/v1/attendance/evaluate').set(at).send({ code: m.code }).expect(200)).body.data as {
                failures: { rule: string }[];
                can_override: boolean;
            };
            expect([who, ev.failures.map(f => f.rule)]).toEqual([who, ['suspended']]);
            expect(ev.can_override).toBe(false);
        }
        const refused = await request(t.app)
            .post('/api/v1/attendance/check-in')
            .set(manager)
            .send({ code: m.code, override: { reason: 'Lifting it tomorrow' } })
            .expect(409);
        expect(refused.body.message).toMatch(/cannot be overridden: Suspended until 25 Nov 2026 \(Gulshan\): Card lent to a friend/);
        const detail = (await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data;
        expect(detail).toMatchObject({ status: 'Suspended', valid_until: '2026-12-18', sanction: { level: 'suspension', until: '2026-11-25' } });
    });
});

describe('back-dated and bulk entry (D-070 b)', () => {
    it('a manager enters past visits, up to 7 days back, with a reason; the desk cannot', async () => {
        const a = await member();
        const b = await member();
        const entry = (code: string, inAt: string) => ({ code, in_at: inAt, reason: 'Scanner was down' });
        await request(t.app)
            .post('/api/v1/attendance/backdated')
            .set(desk)
            .send({ entries: [entry(a.code, '2026-11-18T18:00:00+06:00')] })
            .expect(403);
        await request(t.app)
            .post('/api/v1/attendance/backdated')
            .set(manager)
            .send({ entries: [entry(a.code, '2026-11-10T18:00:00+06:00')] })
            .expect(400);
        await request(t.app)
            .post('/api/v1/attendance/backdated')
            .set(manager)
            .send({ entries: [entry(a.code, '2026-11-20T18:00:00+06:00')] })
            .expect(400);
        const res = await request(t.app)
            .post('/api/v1/attendance/backdated')
            .set(manager)
            .send({
                entries: [entry(a.code, '2026-11-18T18:00:00+06:00'), { ...entry(b.code, '2026-11-17T07:30:00+06:00'), out_at: '2026-11-17T09:00:00+06:00' }]
            })
            .expect(201);
        expect(res.body.message).toBe('2 visits added');
        expect((res.body.data as { backdated: boolean; checked_out_at: string }[]).map(c => [c.backdated, c.checked_out_at])).toEqual([
            [true, '2026-11-18T14:00:00.000Z'],
            [true, '2026-11-17T03:00:00.000Z']
        ]);
    });
});

describe('occupancy and closing finished visits (D-070 a, D-075)', () => {
    it('inside and today counts; reading the floor after closing time closes the visits at the closing time, once', async () => {
        let now = new Date('2026-11-19T12:00:00Z');
        const fresh = await createTestApp({}, { clock: () => now });
        const d = atBranch((await signIn(fresh.app, 'desk.uttara', 'Desk@123')).access_token, UTT.oid);
        const plans = (await request(fresh.app).get('/api/v1/plans').set(d).expect(200)).body.data as { oid: string; code: string }[];
        for (const phone of ['01511111111', '01522222222']) {
            const m = (
                await request(fresh.app)
                    .post('/api/v1/members')
                    .set(d)
                    .send({ name: 'Occupant', phone, gender: 'Male', health_flags: [], health_declared: true })
                    .expect(201)
            ).body.data;
            const sale = await request(fresh.app)
                .post('/api/v1/subscriptions')
                .set(d)
                .send({ member_oid: m.oid, plan_oid: plans.find(p => p.code === 'UTT-SIN-1M')?.oid })
                .expect(201);
            await request(fresh.app)
                .post('/api/v1/payments')
                .set(d)
                .send({ invoice_oid: sale.body.data.invoice.oid, method: 'cash', amount: sale.body.data.invoice.total })
                .expect(200);
            await request(fresh.app).post('/api/v1/attendance/check-in').set(d).send({ member_oid: m.oid }).expect(201);
        }
        expect((await request(fresh.app).get('/api/v1/attendance/occupancy').set(d).expect(200)).body.data).toEqual({ inside: 2, capacity: 80, today: 2 });
        const inside = async (at: string) => {
            now = new Date(at);
            return ((await request(fresh.app).get('/api/v1/attendance/occupancy').set(d).expect(200)).body.data as { inside: number }).inside;
        };
        expect(await inside('2026-11-19T16:00:00Z')).toBe(2); // 22:00, still open
        expect(await inside('2026-11-19T17:30:00Z')).toBe(0); // 23:30: closed at 23:00
        expect(await inside('2026-11-19T18:30:00Z')).toBe(0); // nothing closed twice
        now = new Date('2026-11-19T17:30:00Z');
        const rows = (await request(fresh.app).get('/api/v1/attendance/today').set(d).expect(200)).body.data as { auto_out: boolean; checked_out_at: string }[];
        expect(rows.map(r => [r.auto_out, r.checked_out_at])).toEqual([
            [true, '2026-11-19T17:00:00.000Z'],
            [true, '2026-11-19T17:00:00.000Z']
        ]);
        await fresh.close();
    });
});

describe('attendance: RLS and audit', () => {
    it('a check-in is read by the visited branch and the home branch, not a third one (D-066)', async () => {
        const m = await member();
        await request(t.app).post('/api/v1/attendance/check-in').set(deskDha).send({ code: m.code }).expect(201);
        const seen = (oid: string) =>
            rlsScoped(t.deps.db, systemContext(oid), ['check_in', 'branch'], tx =>
                tx.query<{ oid: string }>(sql`select oid from check_in where member_oid = ${m.oid}`)
            );
        expect(await seen(DHA.oid)).toHaveLength(1);
        expect(await seen(GUL.oid)).toHaveLength(1);
        expect(await seen(UTT.oid)).toHaveLength(0);
        await expect(
            rlsScoped(t.deps.db, systemContext(UTT.oid), ['check_in', 'branch', 'member'], tx =>
                tx.query(sql`insert into check_in (branch_oid, member_oid, member_branch_oid, member_code, member_name, member_branch_name, in_at)
                    values (${GUL.oid}, ${m.oid}, ${GUL.oid}, ${m.code}, 'X', 'Gulshan', now())`)
            )
        ).rejects.toThrow(/row-level security/);
        await request(t.app)
            .post(`/api/v1/attendance/${(await request(t.app).get('/api/v1/attendance/today').set(deskDha)).body.data[0].oid}/check-out`)
            .set(managerDha)
            .expect(200);
    });

    it('check-in, override, check-out and back-dating each write an audit row', async () => {
        const actions = await withBranchTx(t.deps.db, systemContext(GUL.oid, [GUL.oid, DHA.oid]), tx =>
            tx.query<{ action: string }>(sql`select distinct action from audit_log where entity = 'check_in' order by action`)
        );
        expect(actions.map(a => a.action)).toEqual(['backdate', 'check_in', 'check_out', 'override']);
    });
});
