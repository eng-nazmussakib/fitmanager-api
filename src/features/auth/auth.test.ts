import request from 'supertest';

import { createTokenService } from '#src/auth/tokens.ts';
import { sql } from '#src/db/sql.ts';
import { bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

let t: TestApp;
beforeAll(async () => {
    t = await createTestApp({ REFRESH_REUSE_GRACE: '0' });
});
afterAll(() => t.close());

describe('sign-in', () => {
    it('returns tokens in the envelope the frontends parse', async () => {
        const res = await request(t.app).post('/api/v1/auth/login').send({ username: 'Owner', password: 'Owner@123' }).expect(200);
        expect(res.body).toMatchObject({ code: 200, message: 'Signed in', data: { token_type: 'Bearer', expires_in: 900 } });
        expect(res.body.data.access_token).toMatch(/^ey/);
        expect(res.body.data.refresh_token).toHaveLength(43);
    });

    it('answers the same for an unknown user and a wrong password', async () => {
        const wrong = await request(t.app).post('/api/v1/auth/login').send({ username: 'owner', password: 'nope' }).expect(400);
        const unknown = await request(t.app).post('/api/v1/auth/login').send({ username: 'ghost', password: 'nope' }).expect(400);
        expect(wrong.body).toEqual(unknown.body);
        expect(wrong.body).toEqual({ code: 400, message: 'Invalid username or password', data: null });
    });

    it('validates the body field by field', async () => {
        const res = await request(t.app).post('/api/v1/auth/login').send({ username: '' }).expect(400);
        expect((res.body.errors as { path: string }[]).map(e => e.path)).toEqual(['username', 'password']);
    });

    it('stores refresh tokens hashed, never in plain text', async () => {
        const { refresh_token } = await signIn(t.app);
        const rows = await t.deps.db.query<{ token_hash: string }>(sql`select token_hash from refresh_token`);
        expect(rows.some(r => r.token_hash === refresh_token)).toBe(false);
        expect(rows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
    });
});

describe('session', () => {
    it('/me returns the D-034 shape: global rules plus one assignment per branch, each with its rules', async () => {
        const { access_token } = await signIn(t.app, 'desk.uttara', 'Desk@123');
        const res = await request(t.app)
            .get('/api/v1/auth/me')
            .set(...bearer(access_token))
            .expect(200);
        expect(res.body.data).toMatchObject({ username: 'desk.uttara', name: 'Tanjila Biswas', kind: 'staff', rules: [], all_branches: false, member: null });
        expect(res.body.data).not.toHaveProperty('name_en');
        expect(res.body.data).not.toHaveProperty('role');
        const assignments = res.body.data.assignments as { branch: { code: string; slug: string; kind: string }; role: string; rules: unknown[] }[];
        expect(assignments.map(a => [a.branch.code, a.branch.slug, a.role])).toEqual([
            ['DHA', 'dhanmondi', 'FRONT_DESK'],
            ['UTT', 'uttara', 'FRONT_DESK']
        ]);
        expect(assignments[0]!.rules).toContainEqual({
            action: ['read', 'create', 'update'],
            subject: ['Member', 'Attendance', 'Booking', 'Locker', 'PtSession', 'Measurement']
        });
    });

    it('the owner reaches every branch through the HQ assignment, including one opened later', async () => {
        await t.deps.db.query(sql`insert into branch (code, slug, name, kind) values ('MIR', 'mirpur', 'Mirpur', 'BRANCH')`);
        // The profile is cached for 30 s (middleware.ts); drop the owner's entry, as a role change waits for it.
        const [owner] = await t.deps.db.query<{ oid: string }>(sql`select oid from app_user where username = 'owner'`);
        await t.deps.cache.del(`auth:user:${owner!.oid}`);
        const { access_token } = await signIn(t.app);
        const me = (
            await request(t.app)
                .get('/api/v1/auth/me')
                .set(...bearer(access_token))
                .expect(200)
        ).body.data as { all_branches: boolean; assignments: { branch: { code: string; kind: string }; role: string }[] };
        expect(me.all_branches).toBe(true);
        expect(me.assignments.map(a => a.branch.code)).toEqual(['HQ', 'DHA', 'GUL', 'MIR', 'UTT']);
        expect(me.assignments.every(a => a.role === 'OWNER')).toBe(true);
    });

    it('/me still answers with an X-Branch-Id the user does not work at (a stale tab learns its new roles)', async () => {
        const { access_token } = await signIn(t.app, 'desk.gulshan', 'Desk@123');
        await request(t.app)
            .get('/api/v1/auth/me')
            .set({ Authorization: `Bearer ${access_token}`, 'X-Branch-Id': '00000000-0000-4000-8000-000000000004' })
            .expect(200);
    });

    it('401 without a token, with a tampered one, or with a token for another audience', async () => {
        await request(t.app).get('/api/v1/auth/me').expect(401);
        const { access_token } = await signIn(t.app);
        await request(t.app)
            .get('/api/v1/auth/me')
            .set(...bearer(`${access_token.slice(0, -2)}xx`))
            .expect(401);
        const foreign = await createTokenService({ ...t.deps.config.auth, audience: 'another-app' }).signAccess({ oid: 'x' });
        await request(t.app)
            .get('/api/v1/auth/me')
            .set(...bearer(foreign))
            .expect(401);
    });

    it('rotates the refresh token on every use', async () => {
        const first = await signIn(t.app);
        const res = await request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: first.refresh_token }).expect(200);
        expect(res.body.data.refresh_token).not.toBe(first.refresh_token);
        await request(t.app)
            .get('/api/v1/auth/me')
            .set(...bearer(res.body.data.access_token as string))
            .expect(200);
    });

    it('reuse of a rotated refresh token revokes the whole session', async () => {
        const first = await signIn(t.app);
        const second = (await request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: first.refresh_token }).expect(200)).body.data;
        // An attacker replays the old token: refused, and the legitimate newer token dies with it.
        await request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: first.refresh_token }).expect(401);
        await request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: second.refresh_token }).expect(401);
    });

    it('logout with a refresh token ends that session only', async () => {
        const a = await signIn(t.app);
        const b = await signIn(t.app);
        await request(t.app)
            .post('/api/v1/auth/logout')
            .set(...bearer(a.access_token))
            .send({ refresh_token: a.refresh_token })
            .expect(200);
        await request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: a.refresh_token }).expect(401);
        await request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: b.refresh_token }).expect(200);
    });

    it('upgrades a legacy bcrypt hash at the next sign-in', async () => {
        const { default: bcrypt } = await import('bcryptjs');
        await t.deps.db.query(sql`update app_user set password_hash = ${await bcrypt.hash('Desk@123', 4)} where username = 'desk.gulshan'`);
        await signIn(t.app, 'desk.gulshan', 'Desk@123');
        const [row] = await t.deps.db.query<{ password_hash: string }>(sql`select password_hash from app_user where username = 'desk.gulshan'`);
        expect(row!.password_hash).toMatch(/^scrypt\$/);
    });
});

describe('rotation grace window', () => {
    it('two tabs refreshing with the same token at once both succeed', async () => {
        const g = await createTestApp({ REFRESH_REUSE_GRACE: '30' });
        try {
            const { refresh_token } = await signIn(g.app);
            const [a, b] = await Promise.all([
                request(g.app).post('/api/v1/auth/refresh').send({ refresh_token }),
                request(g.app).post('/api/v1/auth/refresh').send({ refresh_token })
            ]);
            expect([a.status, b.status]).toEqual([200, 200]);
        } finally {
            await g.close();
        }
    });
});

describe('rate limit', () => {
    it('answers 429 after LOGIN_RATE_LIMIT attempts for one username from one IP', async () => {
        const limited = await createTestApp({ LOGIN_RATE_LIMIT: '2' });
        try {
            const attempt = () => request(limited.app).post('/api/v1/auth/login').send({ username: 'owner', password: 'wrong' });
            expect((await attempt()).status).toBe(400);
            expect((await attempt()).status).toBe(400);
            const blocked = await attempt();
            expect(blocked.status).toBe(429);
            expect(blocked.body.code).toBe(429);
            // Another username is counted separately.
            expect((await request(limited.app).post('/api/v1/auth/login').send({ username: 'desk.gulshan', password: 'Desk@123' })).status).toBe(200);
        } finally {
            await limited.close();
        }
    });
});
