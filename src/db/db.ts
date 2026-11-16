import { mkdir } from 'node:fs/promises';

import pg from 'pg';

import { log } from '#src/lib/logger.ts';

import type { Sql } from './sql.ts';

/**
 * The database seam. Repositories only see `Queryable`, so the same SQL runs on:
 * - `pg`: node-postgres connection pool, for every real environment;
 * - `pglite`: PostgreSQL compiled to WebAssembly, in-process. `npm run dev` and the tests need no database server.
 *
 * Oracle (OMS, SIB): put an `oracledb` implementation behind the same interface. Since node-oracledb 6 the default
 * THIN mode needs no Instant Client, so the `node18-oracleclient` base image is not needed either.
 */
export interface Queryable {
    query<T extends object = Record<string, unknown>>(q: Sql): Promise<T[]>;
    /** Several statements, no parameters (migrations). */
    exec(script: string): Promise<void>;
}

export interface Db extends Queryable {
    readonly driver: 'pg' | 'pglite';
    /** BEGIN … COMMIT, or ROLLBACK when `fn` throws. Use the `tx` it gives you, not the outer db. */
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
    ping(): Promise<void>;
    close(): Promise<void>;
}

export interface DbOptions {
    driver: 'pg' | 'pglite';
    url?: string | undefined;
    pgliteDataDir?: string | undefined;
    poolMax?: number;
    statementTimeoutMs?: number;
}

export async function createDb(opts: DbOptions): Promise<Db> {
    return opts.driver === 'pg' ? createPgDb(opts) : createPgliteDb(opts.pgliteDataDir);
}

function createPgDb(opts: DbOptions): Db {
    // Pool settings the SPN service had right (max, idle and connect timeouts), plus a statement timeout: one slow
    // query can no longer hold a connection for minutes while the pool runs dry (the ACAS results-day incident).
    const pool = new pg.Pool({
        connectionString: opts.url,
        max: opts.poolMax ?? 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        statement_timeout: opts.statementTimeoutMs ?? 15_000,
        application_name: 'skeleton-api'
    });
    pool.on('error', err => {
        log().error({ err }, 'Idle PostgreSQL client error');
    });

    const on = (client: pg.Pool | pg.PoolClient): Queryable => ({
        query: async <T extends object>(q: Sql) => (await client.query<T>(q.text, q.values)).rows,
        exec: async script => {
            await client.query(script);
        }
    });

    return {
        driver: 'pg',
        ...on(pool),
        async transaction(fn) {
            const client = await pool.connect();
            let broken: Error | undefined;
            try {
                await client.query('begin');
                const result = await fn(on(client));
                await client.query('commit');
                return result;
            } catch (err) {
                try {
                    await client.query('rollback');
                } catch (rollbackErr) {
                    broken = rollbackErr as Error; // a connection that cannot roll back must not go back to the pool
                }
                throw err;
            } finally {
                client.release(broken);
            }
        },
        async ping() {
            await pool.query('select 1');
        },
        close: () => pool.end()
    };
}

async function createPgliteDb(dataDir: string | undefined): Promise<Db> {
    // Imported on demand: production (driver pg) never loads the WebAssembly build, and it is a devDependency.
    const { PGlite } = await import('@electric-sql/pglite');
    if (dataDir) await mkdir(dataDir, { recursive: true });
    const db = await PGlite.create(dataDir ?? 'memory://');

    type Tx = Pick<typeof db, 'query' | 'exec'>;
    const on = (client: Tx): Queryable => ({
        query: async <T extends object>(q: Sql) => (await client.query<T>(q.text, q.values)).rows,
        exec: async script => {
            await client.exec(script);
        }
    });

    return {
        driver: 'pglite',
        ...on(db),
        transaction: fn => db.transaction(tx => fn(on(tx))),
        async ping() {
            await db.query('select 1');
        },
        close: () => db.close()
    };
}
