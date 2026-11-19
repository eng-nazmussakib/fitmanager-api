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

// The schema and demo data come from the infra repo's runner, as in every environment (D-039).
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
