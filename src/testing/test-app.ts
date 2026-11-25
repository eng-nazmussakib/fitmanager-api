import { randomBytes } from 'node:crypto';

import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';

import { createApp } from '#src/app.ts';
import { BRANCH_HEADER } from '#src/auth/middleware.ts';
import { type EnvSource, loadConfig } from '#src/config/env.ts';
import { type AppDeps, closeDeps, createDeps } from '#src/container.ts';
import { createDb, type Db } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { createMemoryStore } from '#src/lib/file-store.ts';

// The schema and demo data come from the infra repo's runner, as in every environment.
// The repos sit side by side (clone fitmanager-infra next to this one).
import { migrate, seed, type SqlDatabase } from '../../../fitmanager-infra/db/tools/runner.ts';

export const TEST_ENV: EnvSource = {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env['LOG_LEVEL'] ?? 'silent',
    DB_DRIVER: 'pglite',
    JWT_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    LOGIN_RATE_LIMIT: '1000'
};

export interface TestApp {
    app: Express;
    deps: AppDeps;
    /** The database as its owner: for arranging fixtures the app's role may not write. Same as `deps.db` on PGlite. */
    ownerDb: Db;
    close(): Promise<void>;
}

/**
 * `TEST_DATABASE_URL` (optional): a real PostgreSQL server to test on instead of PGlite, e.g. the local one:
 * `TEST_DATABASE_URL='postgres:///postgres?host=/var/run/postgresql' npm test`. The role needs CREATEDB. Each test
 * file gets its own throwaway database (`fm_test_<random>`), created from this URL and dropped when the file ends.
 *
 * When that role may act as `fitmanager_owner` and `fitmanager_app` (locally: `grant fitmanager_owner,
 * fitmanager_app to <you>`, db/README.md), the database is set up like the real one: the schema is created as
 * `fitmanager_owner`, and the app under test connects as `fitmanager_app` (NOBYPASSRLS), as in production.
 */
const SERVER_URL = process.env['TEST_DATABASE_URL']?.trim() ?? '';

/** The role the app under test connects as: `fitmanager_app` on a server where it can, else the connecting user. */
export let testDbRole: 'fitmanager_app' | 'connecting user' | 'pglite' = 'pglite';

/** The per-database part of `fitmanager-infra/db/roles/001_roles.sql`, for a throwaway database. */
const ROLE_SETUP = `
    alter schema public owner to fitmanager_owner;
    revoke create on schema public from public;
    grant usage on schema public to fitmanager_app;
    alter default privileges for role fitmanager_owner in schema public grant select, insert, update, delete on tables to fitmanager_app;
    alter default privileges for role fitmanager_owner in schema public grant usage, select on sequences to fitmanager_app;
    alter default privileges for role fitmanager_owner in schema public grant execute on functions to fitmanager_app;
`;

async function run(url: string, statement: string): Promise<boolean> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
        // A multi-statement script (ROLE_SETUP) answers with an array of results, which has no `rows`.
        const res: unknown = await client.query(statement);
        const rows = Array.isArray(res) ? undefined : (res as { rows?: { ok?: boolean }[] }).rows;
        return rows?.[0]?.ok === true;
    } finally {
        await client.end();
    }
}

/**
 * A fresh, empty database: PGlite in memory, or a new database on the TEST_DATABASE_URL server. `owner` runs the
 * migrations, seeds and test fixtures; `app` is what the API under test uses.
 */
async function freshDb(): Promise<{ owner: Db; app: Db; drop: () => Promise<void> }> {
    if (!SERVER_URL) {
        const db = await createDb({ driver: 'pglite' });
        return { owner: db, app: db, drop: () => Promise.resolve() };
    }
    const name = `fm_test_${randomBytes(6).toString('hex')}`; // hex only: safe to put in DDL as an identifier
    await run(SERVER_URL, `create database ${name}`);
    const url = new URL(SERVER_URL);
    url.pathname = `/${name}`;
    const ownerUrl = url.toString();
    const asApp = await run(
        ownerUrl,
        `select pg_has_role(current_user, 'fitmanager_owner', 'member') and pg_has_role(current_user, 'fitmanager_app', 'member') as ok`
    );
    if (asApp) {
        await run(ownerUrl, ROLE_SETUP);
        url.searchParams.set('options', '-c role=fitmanager_app');
    }
    testDbRole = asApp ? 'fitmanager_app' : 'connecting user';
    const owner = await createDb({ driver: 'pg', url: ownerUrl, poolMax: 2 });
    const app = asApp ? await createDb({ driver: 'pg', url: url.toString(), poolMax: 5 }) : owner;
    return {
        owner,
        app,
        drop: async () => {
            if (owner !== app) await owner.close();
            await run(SERVER_URL, `drop database if exists ${name} with (force)`);
        }
    };
}

/** The API's `Db` as the infra runner's `SqlDatabase`. */
export function runnerDb(db: Db): SqlDatabase {
    return {
        transaction: fn =>
            db.transaction(tx =>
                fn({
                    exec: script => tx.exec(script),
                    rows: <T extends object>(text: string) => tx.query<T>(sql.raw(text))
                })
            )
    };
}

/**
 * The real app on a fresh database (migrated + seeded) with an in-memory cache and file store. One per test file
 * (`beforeAll`): a PGlite instance takes about a second to start, a server database a little less.
 */
export async function createTestApp(env: EnvSource = {}, overrides: Partial<AppDeps> = {}): Promise<TestApp> {
    const config = loadConfig({ ...TEST_ENV, ...env });
    const { owner, app: db, drop } = await freshDb();
    await migrate(runnerDb(owner));
    await seed(runnerDb(owner));
    const deps = await createDeps(config, { db, files: createMemoryStore(), ...overrides });
    return {
        app: createApp(deps),
        deps,
        ownerDb: owner,
        close: async () => {
            await closeDeps(deps);
            await drop();
        }
    };
}

export async function signIn(app: Express, username = 'owner', password = 'Owner@123'): Promise<{ access_token: string; refresh_token: string }> {
    const res = await request(app).post('/api/v1/auth/login').send({ username, password }).expect(200);
    return res.body.data as { access_token: string; refresh_token: string };
}

export const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];

/** Headers for a staff request at one branch: `.set(atBranch(token, DEMO_BRANCHES.GUL.oid))`. */
export const atBranch = (token: string, branchOid: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, [BRANCH_HEADER]: branchOid });

/**
 * Suspends a member the way a manager does: an incident at the manager's branch, then a suspension
 * step on it (the suggested step for a first case is a verbal warning, so the choice is explained). `days` long,
 * from today. Returns the incident.
 */
export async function suspendMember(
    app: Express,
    manager: Record<string, string>,
    code: string,
    opts: { days?: number; reason?: string; today: string; now: string }
): Promise<{ oid: string }> {
    const incident = (
        await request(app)
            .post('/api/v1/incidents')
            .set(manager)
            .send({
                subject_kind: 'member',
                member_code: code,
                occurred_at: opts.now,
                category: 'conduct',
                summary: 'Behaviour at the gym',
                description: 'Shouted at the desk.'
            })
            .expect(201)
    ).body.data as { oid: string };
    const end = new Date(`${opts.today}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + (opts.days ?? 7) - 1);
    await request(app)
        .post(`/api/v1/incidents/${incident.oid}/sanctions`)
        .set(manager)
        .send({ level: 'suspension', reason: opts.reason ?? 'Abusive behaviour', choice_reason: 'Serious first case', ends_on: end.toISOString().slice(0, 10) })
        .expect(201);
    return incident;
}

/**
 * A new member of the desk's branch with a paid monthly plan and a portal account, signed in: `{ oid, code, me }`,
 * `me` being the member's headers. `phone` must be unused (`0191…`, 11 digits).
 */
export async function portalMember(
    app: Express,
    desk: Record<string, string>,
    phone: string,
    opts: { name?: string; policies_signed?: boolean; plan?: string } = {}
): Promise<{ oid: string; code: string; me: Record<string, string> }> {
    const m = (
        await request(app)
            .post('/api/v1/members')
            .set(desk)
            .send({
                name: opts.name ?? 'Portal Member',
                phone,
                gender: 'Female',
                health_flags: [],
                health_declared: true,
                policies_signed: opts.policies_signed ?? true
            })
            .expect(201)
    ).body.data as { oid: string; code: string };
    const plans = (await request(app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
    const plan =
        plans.find(p => p.code.endsWith(opts.plan ?? '-SIN-1M') && p.code.startsWith('GUL')) ?? plans.find(p => p.code.endsWith(opts.plan ?? '-SIN-1M'));
    const sale = await request(app)
        .post('/api/v1/subscriptions')
        .set(desk)
        .send({ member_oid: m.oid, plan_oid: plan?.oid, charge_admission: false })
        .expect(201);
    await request(app)
        .post('/api/v1/payments')
        .set(desk)
        .send({ invoice_oid: sale.body.data.invoice.oid, method: 'cash', amount: sale.body.data.invoice.total })
        .expect(200);
    await request(app).post(`/api/v1/members/${m.oid}/portal-access`).set(desk).send({ password: 'Temp1234' }).expect(200);
    const temp = (await request(app).post('/api/v1/auth/login').send({ username: m.code, password: 'Temp1234' }).expect(200)).body.data.access_token as string;
    await request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${temp}`)
        .send({ current_password: 'Temp1234', new_password: 'Mine5678x' })
        .expect(200);
    const token = (await request(app).post('/api/v1/auth/login').send({ username: m.code, password: 'Mine5678x' }).expect(200)).body.data
        .access_token as string;
    return { ...m, me: { Authorization: `Bearer ${token}` } };
}

/**
 * Stocks a branch the way it happens: the manager raises a purchase order, HQ approves it, and it
 * is received in one delivery. `lines` name products by code (`PRD-000001`). Returns the order.
 */
export async function stockUp(
    app: Express,
    manager: Record<string, string>,
    hq: Record<string, string>,
    lines: { code: string; qty: number; unit_cost: number }[]
): Promise<{ oid: string; code: string }> {
    const products = (await request(app).get('/api/v1/products').set(manager).expect(200)).body.data as { oid: string; code: string }[];
    const suppliers = (await request(app).get('/api/v1/suppliers').set(manager).expect(200)).body.data as { oid: string }[];
    const po = (
        await request(app)
            .post('/api/v1/purchase-orders')
            .set(manager)
            .send({
                supplier_oid: suppliers[0]?.oid,
                lines: lines.map(l => ({ product_oid: products.find(p => p.code === l.code)?.oid, qty: l.qty, unit_cost: l.unit_cost }))
            })
            .expect(201)
    ).body.data as { oid: string; code: string; lines: { oid: string; qty: number }[] };
    await request(app).post(`/api/v1/hq/purchase-orders/${po.oid}/approve`).set(hq).send({}).expect(200);
    await request(app)
        .post(`/api/v1/purchase-orders/${po.oid}/deliveries`)
        .set(manager)
        .send({ lines: po.lines.map(l => ({ line_oid: l.oid, qty: l.qty })) })
        .expect(201);
    return po;
}
