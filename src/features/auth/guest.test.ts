import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

// Guest access (D-076): the accounts the hosted demo's /demo picker signs in as, without a password.
const GUESTS = 'owner,admin.hq,manager.gulshan,desk.gulshan,trainer.gulshan,MEM-GUL-000001';
const LOCKED = 'This is a shared guest account of the demo, so it cannot be changed.';

let t: TestApp;
let off: TestApp;
beforeAll(async () => {
    [t, off] = await Promise.all([createTestApp({ GUEST_ACCOUNTS: GUESTS }), createTestApp()]);
    // The tests use the demo seed only, without the showcase's members: make the guest member as the showcase does,
    // with an active portal account whose username is the member code.
    const desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, DEMO_BRANCHES.GUL.oid);
    const m = (
        await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send({ name: 'Ayesha Rahman', phone: '01711111111', gender: 'Female', health_flags: [], health_declared: true })
            .expect(201)
    ).body.data as { oid: string; code: string };
    expect(m.code).toBe('MEM-GUL-000001');
    await t.ownerDb.query(
        sql`insert into app_user (username, password_hash, name, kind, member_oid, must_change_password) values (${m.code}, 'x', 'Ayesha Rahman', 'member', ${m.oid}, false)`
    );
});
afterAll(() => Promise.all([t.close(), off.close()]));

const guestSignIn = async (username: string) =>
    (await request(t.app).post('/api/v1/auth/guest').send({ username }).expect(200)).body.data as { access_token: string; refresh_token: string };
const oidOf = async (username: string) =>
    (
        await t.deps.db.query<{ oid: string; member_oid: string | null }>(sql`select oid, member_oid from app_user where lower(username) = lower(${username})`)
    )[0]!;

describe('guest access off (GUEST_ACCOUNTS empty)', () => {
    it('lists no accounts and signs nobody in', async () => {
        expect((await request(off.app).get('/api/v1/auth/guest').expect(200)).body.data).toEqual([]);
        await request(off.app).post('/api/v1/auth/guest').send({ username: 'owner' }).expect(404);
    });
});

describe('guest sign-in', () => {
    it('lists the guest accounts in the configured order, with their role and no secrets', async () => {
        const list = (await request(t.app).get('/api/v1/auth/guest').expect(200)).body.data as Record<string, unknown>[];
        expect(list.map(a => [a['username'], a['kind'], a['role']])).toEqual([
            ['owner', 'staff', 'OWNER'],
            ['admin.hq', 'staff', 'HQ_ADMIN'],
            ['manager.gulshan', 'staff', 'BRANCH_MANAGER'],
            ['desk.gulshan', 'staff', 'FRONT_DESK'],
            ['trainer.gulshan', 'staff', 'TRAINER'],
            ['MEM-GUL-000001', 'member', 'MEMBER']
        ]);
        expect(Object.keys(list[0]!).sort()).toEqual(['kind', 'name', 'role', 'username']);
    });

    it('signs in as a guest without a password; /me says guest', async () => {
        const { access_token } = await guestSignIn('Desk.Gulshan');
        const me = (
            await request(t.app)
                .get('/api/v1/auth/me')
                .set(...bearer(access_token))
                .expect(200)
        ).body.data as { username: string; guest: boolean };
        expect(me).toMatchObject({ username: 'desk.gulshan', guest: true });
        const member = await guestSignIn('mem-gul-000001');
        const portal = await request(t.app)
            .get('/api/v1/auth/me')
            .set(...bearer(member.access_token))
            .expect(200);
        expect(portal.body.data).toMatchObject({ kind: 'member', guest: true, member: { code: 'MEM-GUL-000001' } });
    });

    it('refuses any account that is not a guest account', async () => {
        const res = await request(t.app).post('/api/v1/auth/guest').send({ username: 'manager.uttara' }).expect(404);
        expect(res.body.message).toBe('There is no such guest account');
        const pw = await signIn(t.app, 'manager.uttara', 'Manager@123');
        const me = (
            await request(t.app)
                .get('/api/v1/auth/me')
                .set(...bearer(pw.access_token))
        ).body.data as { guest: boolean };
        expect(me.guest).toBe(false);
    });
});

describe('a guest account cannot be changed', () => {
    it('not its own password, nor "sign out everywhere", nor other visitors’ sessions', async () => {
        const a = await guestSignIn('trainer.gulshan');
        const b = await guestSignIn('trainer.gulshan');
        const pw = await request(t.app)
            .post('/api/v1/auth/change-password')
            .set(...bearer(a.access_token))
            .send({ current_password: 'Trainer@123', new_password: 'Another#Pass1' })
            .expect(403);
        expect(pw.body.message).toBe(LOCKED);
        await request(t.app)
            .post('/api/v1/auth/logout')
            .set(...bearer(a.access_token))
            .send({})
            .expect(403);
        const sessions = (
            await request(t.app)
                .get('/api/v1/auth/sessions')
                .set(...bearer(a.access_token))
                .expect(200)
        ).body.data as { id: string; current: boolean }[];
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.current).toBe(true);
        await request(t.app)
            .delete(`/api/v1/auth/sessions/${sessions[0]!.id}`)
            .set(...bearer(a.access_token))
            .expect(403);
        // b is still signed in, and signing out this session alone works.
        await request(t.app)
            .get('/api/v1/auth/me')
            .set(...bearer(b.access_token))
            .expect(200);
        await request(t.app)
            .post('/api/v1/auth/logout')
            .set(...bearer(a.access_token))
            .send({ refresh_token: a.refresh_token })
            .expect(200);
    });

    it('not by HQ or a branch manager: profile, status, password, sessions, roles', async () => {
        const owner = await guestSignIn('owner');
        const manager = await guestSignIn('manager.gulshan');
        const desk = (await oidOf('desk.gulshan')).oid;
        const hq = atBranch(owner.access_token, DEMO_BRANCHES.HQ.oid);
        const gul = atBranch(manager.access_token, DEMO_BRANCHES.GUL.oid);
        const calls = [
            request(t.app).patch(`/api/v1/hq/staff/${desk}`).set(hq).send({ name: 'Renamed' }),
            request(t.app).post(`/api/v1/hq/staff/${desk}/deactivate`).set(hq),
            request(t.app).post(`/api/v1/hq/staff/${desk}/reset-password`).set(hq).send({ password: 'Temp#Pass123' }),
            request(t.app).post(`/api/v1/hq/staff/${desk}/sign-out`).set(hq),
            request(t.app).put(`/api/v1/hq/staff/${desk}/assignments`).set(hq).send({ assignments: [], all_branches: false }),
            request(t.app).put(`/api/v1/branch/staff/${desk}/role`).set(gul).send({ role: 'TRAINER' }),
            request(t.app).delete(`/api/v1/branch/staff/${desk}`).set(gul)
        ];
        for (const res of await Promise.all(calls)) expect([res.status, res.body.message]).toEqual([403, LOCKED]);
        // Other accounts can still be managed.
        const other = (await oidOf('desk.uttara')).oid;
        await request(t.app).post(`/api/v1/hq/staff/${other}/sign-out`).set(hq).expect(200);
    });

    it('the guest member: no portal reset, transfer or anonymising', async () => {
        const desk = await guestSignIn('desk.gulshan');
        const member = (await oidOf('MEM-GUL-000001')).member_oid!;
        const gul = atBranch(desk.access_token, DEMO_BRANCHES.GUL.oid);
        const manager = atBranch((await guestSignIn('manager.gulshan')).access_token, DEMO_BRANCHES.GUL.oid);
        const calls = [
            request(t.app).post(`/api/v1/members/${member}/portal-access`).set(gul).send({ password: 'Temp#Pass123' }),
            request(t.app).post(`/api/v1/members/${member}/transfer`).set(manager).send({ to_branch_oid: DEMO_BRANCHES.UTT.oid, reason: 'Moving' }),
            request(t.app).post(`/api/v1/members/${member}/anonymise`).set(manager).send({ confirm_code: 'MEM-GUL-000001' })
        ];
        for (const res of await Promise.all(calls)) expect([res.status, res.body.message]).toEqual([403, LOCKED]);
    });
});
