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
import { createMemoryMailer } from '#src/lib/mailer.ts';

// The schema and demo data come from the infra repo's runner, as in every environment (D-039).
// The repos sit side by side (CI and the Docker test stage clone fitmanager-infra next to this one).
import { migrate, seed, type SqlDatabase } from '../../../fitmanager-infra/db/tools/runner.ts';

export const TEST_ENV: EnvSource = {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env['LOG_LEVEL'] ?? 'silent',
    DB_DRIVER: 'pglite',
    JWT_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    SCHEDULER_ENABLED: 'false',
    LOGIN_RATE_LIMIT: '1000'
};

export interface TestApp {
    app: Express;
    deps: AppDeps;
    mailer: ReturnType<typeof createMemoryMailer>;
    close(): Promise<void>;
}

/**
 * `TEST_DATABASE_URL` (optional): a real PostgreSQL server to test on instead of PGlite, e.g. the local one:
 * `TEST_DATABASE_URL='postgres:///postgres?host=/var/run/postgresql' npm test`. The role needs CREATEDB. Each test
 * file gets its own throwaway database (`fm_test_<random>`), created from this URL and dropped when the file ends.
 */
const SERVER_URL = process.env['TEST_DATABASE_URL']?.trim() ?? '';

/** A fresh, empty database: PGlite in memory, or a new database on the TEST_DATABASE_URL server. */
async function freshDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
    if (!SERVER_URL) return { db: await createDb({ driver: 'pglite' }), drop: () => Promise.resolve() };
    const name = `fm_test_${randomBytes(6).toString('hex')}`; // hex only: safe to put in DDL as an identifier
    const admin = async (statement: string) => {
        const client = new pg.Client({ connectionString: SERVER_URL });
        await client.connect();
        try {
            await client.query(statement);
        } finally {
            await client.end();
        }
    };
    await admin(`create database ${name}`);
    const url = new URL(SERVER_URL);
    url.pathname = `/${name}`;
    return { db: await createDb({ driver: 'pg', url: url.toString(), poolMax: 5 }), drop: () => admin(`drop database if exists ${name} with (force)`) };
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
 * The real app on a fresh database (migrated + seeded) with an in-memory mailer and cache. One per test file
 * (`beforeAll`): a PGlite instance takes about a second to start, a server database a little less.
 */
export async function createTestApp(env: EnvSource = {}, overrides: Partial<AppDeps> = {}): Promise<TestApp> {
    const config = loadConfig({ ...TEST_ENV, ...env });
    const { db, drop } = await freshDb();
    await migrate(runnerDb(db));
    await seed(runnerDb(db));
    const mailer = createMemoryMailer();
    const deps = await createDeps(config, { db, mailer, redis: undefined, ...overrides });
    return {
        app: createApp(deps),
        deps,
        mailer,
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
