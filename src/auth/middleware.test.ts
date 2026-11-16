import express from 'express';
import request from 'supertest';

import { errorHandler } from '#src/lib/errors.ts';
import { log } from '#src/lib/logger.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import { authenticate, currentBranch, requireAbility, requireBranch } from './middleware.ts';

/**
 * Branch scoping (D-034), on a small app with the gates the phase 2 routes will use: `requireBranch` then
 * `requireAbility`, which checks the rules of the assignment at `X-Branch-Id`. The same cases as the web mock's
 * `mock-api.spec.ts`.
 */
let t: TestApp;
let app: express.Express;
const token: Record<string, string> = {};

beforeAll(async () => {
    t = await createTestApp();
    app = express();
    app.use((req, _res, next) => {
        req.log = log(); // pino-http sets it in the real app; the error handler logs through it
        next();
    });
    app.get('/branch-op', authenticate(t.deps), requireBranch('BRANCH'), requireAbility('create', 'AttendanceOverride'), (req, res) => {
        res.json({ branch: currentBranch(req).code });
    });
    app.get('/hq-op', authenticate(t.deps), requireBranch('HQ'), requireAbility('read', 'HqDashboard'), (req, res) => {
        res.json({ branch: currentBranch(req).code });
    });
    app.use(errorHandler);
    for (const [u, p] of [
        ['owner', 'Owner@123'],
        ['manager.gulshan', 'Manager@123'],
        ['desk.gulshan', 'Desk@123'],
        ['desk.uttara', 'Desk@123']
    ] as const)
        token[u] = (await signIn(t.app, u, p)).access_token;
});
afterAll(() => t.close());

const { HQ, GUL, DHA, UTT } = DEMO_BRANCHES;

describe('requireBranch + requireAbility', () => {
    it('applies the role at the branch in X-Branch-Id', async () => {
        expect((await request(app).get('/branch-op').set(atBranch(token['manager.gulshan']!, GUL.oid)).expect(200)).body).toEqual({ branch: 'GUL' });
        // Front desk at the same branch: no AttendanceOverride rule.
        await request(app).get('/branch-op').set(atBranch(token['desk.gulshan']!, GUL.oid)).expect(403);
    });

    it('refuses a branch the user does not work at, and a missing header', async () => {
        const res = await request(app).get('/branch-op').set(atBranch(token['manager.gulshan']!, DHA.oid)).expect(403);
        expect(res.body.message).toBe('You do not work at this branch');
        await request(app)
            .get('/branch-op')
            .set(...bearer(token['manager.gulshan']!))
            .expect(403);
    });

    it('one person at two branches gets each branch, and only those', async () => {
        await request(app).get('/branch-op').set(atBranch(token['desk.uttara']!, UTT.oid)).expect(403); // front desk: no override
        await request(app).get('/hq-op').set(atBranch(token['desk.uttara']!, DHA.oid)).expect(403);
        await request(app).get('/branch-op').set(atBranch(token['desk.uttara']!, GUL.oid)).expect(403);
    });

    it('HQ routes need the HQ row; branch routes refuse it', async () => {
        expect((await request(app).get('/hq-op').set(atBranch(token['owner']!, HQ.oid)).expect(200)).body).toEqual({ branch: 'HQ' });
        await request(app).get('/hq-op').set(atBranch(token['owner']!, GUL.oid)).expect(403);
        await request(app).get('/branch-op').set(atBranch(token['owner']!, HQ.oid)).expect(400);
        // all_branches: the owner works at every branch with the HQ role.
        expect((await request(app).get('/branch-op').set(atBranch(token['owner']!, UTT.oid)).expect(200)).body).toEqual({ branch: 'UTT' });
    });
});
