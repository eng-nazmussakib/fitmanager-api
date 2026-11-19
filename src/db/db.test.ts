import { readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { runnerDb } from '#src/testing/test-app.ts';

import { migrate, MIGRATIONS_DIR, reset, seed } from '../../../fitmanager-infra/db/tools/runner.ts';
import { createDb, type Db } from './db.ts';
import { sql } from './sql.ts';

/**
 * The `pg` (node-postgres) driver, the one production uses, tested over a real PostgreSQL wire connection:
 * PGlite behind its socket server. No database server needed, and the SQL path is the production one.
 */
let pglite: PGlite;
let server: PGLiteSocketServer;
let db: Db;

beforeAll(async () => {
    pglite = await PGlite.create();
    server = new PGLiteSocketServer({ db: pglite, port: 0 });
    await server.start();
    db = await createDb({ driver: 'pg', url: `postgres://postgres@${server.getServerConn()}/postgres`, poolMax: 1 });
});
afterAll(async () => {
    await db.close();
    await server.stop();
    await pglite.close();
});

describe('pg driver', () => {
    it('migrates once, then reports nothing to apply', async () => {
        // The infra runner over this driver: the path `npm run migrate` takes on a real server.
        const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort();
        expect(files.slice(0, 2)).toEqual(['001_init.sql', '002_branches_and_staff.sql']);
        expect(await migrate(runnerDb(db))).toEqual(files);
        expect(await migrate(runnerDb(db))).toEqual([]);
    });

    it('reset reruns every migration and seed over an existing schema (D-051: files drop their tables first)', async () => {
        await seed(runnerDb(db));
        await db.query(sql`insert into app_role (code, name) values ('R1', 'gone after reset')`);
        const again = await reset(runnerDb(db), { withSeeds: true });
        expect(again.migrations).toEqual((await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort());
        expect(again.seeds.length).toBeGreaterThan(0);
        expect(await db.query(sql`select code from app_role where code = 'R1'`)).toEqual([]);
        const [users] = await db.query<{ n: number }>(sql`select count(*)::int as n from app_user`);
        expect(users?.n).toBeGreaterThan(0);
        expect(await migrate(runnerDb(db))).toEqual([]);
    });

    it('runs parameterised queries', async () => {
        await db.query(sql`insert into app_role (code, name) values (${'X1'}, ${"O'Brien; drop table item"})`);
        const [row] = await db.query<{ name: string }>(sql`select name from app_role where code = ${'X1'}`);
        expect(row!.name).toBe("O'Brien; drop table item");
    });

    it('commits a transaction, and rolls back everything when it throws', async () => {
        await db.transaction(tx => tx.query(sql`insert into app_role (code, name) values ('T1', 'kept')`));
        await expect(
            db.transaction(async tx => {
                await tx.query(sql`insert into app_role (code, name) values ('T2', 'lost')`);
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        const rows = await db.query<{ code: string }>(sql`select code from app_role where code in ('T1', 'T2')`);
        expect(rows.map(r => r.code)).toEqual(['T1']);
    });

    it('ping() succeeds', async () => {
        await expect(db.ping()).resolves.toBeUndefined();
    });
});
