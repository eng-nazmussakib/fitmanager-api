import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { runnerDb } from '#src/testing/test-app.ts';

import { migrate } from '../../../fitmanager-infra/db/tools/runner.ts';
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
        expect(await migrate(runnerDb(db))).toEqual(['001_init.sql', '002_branches_and_staff.sql', '003_site_groups.sql', '004_hq_manages_branch_plans.sql']);
        expect(await migrate(runnerDb(db))).toEqual([]);
    });

    it('runs parameterised queries', async () => {
        await db.query(sql`insert into category (oid, name_en) values (${'X1'}, ${"O'Brien; drop table item"})`);
        const [row] = await db.query<{ name_en: string }>(sql`select name_en from category where oid = ${'X1'}`);
        expect(row!.name_en).toBe("O'Brien; drop table item");
    });

    it('commits a transaction, and rolls back everything when it throws', async () => {
        await db.transaction(tx => tx.query(sql`insert into category (oid, name_en) values ('T1', 'kept')`));
        await expect(
            db.transaction(async tx => {
                await tx.query(sql`insert into category (oid, name_en) values ('T2', 'lost')`);
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        const rows = await db.query<{ oid: string }>(sql`select oid from category where oid in ('T1', 'T2')`);
        expect(rows.map(r => r.oid)).toEqual(['T1']);
    });

    it('ping() succeeds', async () => {
        await expect(db.ping()).resolves.toBeUndefined();
    });
});
