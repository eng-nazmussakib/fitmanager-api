import request from 'supertest';

import { runExclusive } from '#src/lib/scheduler.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import { sql } from './db/sql.ts';
import { cleanupJob } from './jobs/cleanup.job.ts';

let t: TestApp;
beforeAll(async () => {
    t = await createTestApp({ CORS_ORIGINS: 'https://app.example.com' });
});
afterAll(() => t.close());

describe('platform', () => {
    it('health: live, and ready while the database answers; 503 once shutting down', async () => {
        await request(t.app).get('/health/live').expect(200);
        expect((await request(t.app).get('/health/ready').expect(200)).body.checks).toEqual({ database: 'ok' });
        t.deps.lifecycle.shuttingDown = true;
        await request(t.app).get('/health/ready').expect(503);
        t.deps.lifecycle.shuttingDown = false;
    });

    it('metrics: Prometheus text with per-route-template latency', async () => {
        await request(t.app).get('/api/v1/items/00000000-0000-0000-0000-000000000000').expect(401);
        const res = await request(t.app).get('/metrics').expect(200);
        expect(res.text).toContain('http_request_duration_seconds_bucket');
        expect(res.text).toContain('nodejs_eventloop_lag_seconds');
    });

    it('security headers, request id, and CORS only for allowed origins', async () => {
        const res = await request(t.app).get('/health/live').set('Origin', 'https://app.example.com').set('X-Request-Id', 'from-nginx-123');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-powered-by']).toBeUndefined();
        const api = await request(t.app).get('/api/v1/auth/me');
        expect(api.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-request-id']).toBe('from-nginx-123');
        expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
        const other = await request(t.app).get('/health/live').set('Origin', 'https://evil.example.com');
        expect(other.headers['access-control-allow-origin']).toBeUndefined();
        const injected = await request(t.app).get('/health/live').set('X-Request-Id', 'bad id <script>');
        expect(injected.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('errors use the envelope: unknown route, malformed JSON, oversized body', async () => {
        expect((await request(t.app).get('/api/v1/nope').expect(404)).body).toMatchObject({ code: 404, data: null });
        const bad = await request(t.app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{bad').expect(400);
        expect(bad.body.message).toBe('The request body is not valid JSON');
        await request(t.app)
            .post('/api/v1/auth/login')
            .send({ username: 'x'.repeat(1_100_000), password: 'x' })
            .expect(413);
    });

    it('lookups: known keys from the database, unknown keys empty', async () => {
        const { access_token } = await signIn(t.app);
        const res = await request(t.app)
            .get('/api/v1/ddl?ddl_key=category&ddl_key=unknown')
            .set(...bearer(access_token))
            .expect(200);
        expect(res.body.data.category).toHaveLength(3);
        expect(res.body.data.unknown).toEqual([]);
    });

    it('mail: the editor HTML is sanitised before it is sent', async () => {
        const { access_token } = await signIn(t.app);
        await request(t.app)
            .post('/api/v1/mail/send')
            .set(atBranch(access_token, DEMO_BRANCHES.HQ.oid))
            .send({ to: ['a@example.com'], subject: 'Hello', body: '<p style="text-align:center">Hi<img src=x onerror=alert(1)></p><script>steal()</script>' })
            .expect(200);
        const html = t.mailer.sent.at(-1)!.html;
        expect(html).toContain('<p style="text-align:center">Hi</p>');
        expect(html).not.toMatch(/script|onerror|<img/);
    });

    it('jobs: the cleanup job runs under its advisory lock and removes expired credentials', async () => {
        await signIn(t.app);
        await t.deps.db.query(sql`update refresh_token set expires_at = now() - interval '2 days'`);
        expect(await runExclusive(t.deps.db, cleanupJob)).toBe(true);
        const [row] = await t.deps.db.query<{ count: number }>(sql`select count(*)::int as count from refresh_token`);
        expect(row!.count).toBe(0);
    });
});
