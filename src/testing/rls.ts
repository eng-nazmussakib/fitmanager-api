import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, systemContext, withBranchTx } from '#src/db/tenancy.ts';

import { DEMO_BRANCHES } from './demo.ts';

/**
 * Run the rest of the transaction as a role that RLS applies to. On the local PostgreSQL the app connects as
 * `fitmanager_app` (or a non-superuser owner), so FORCE ROW LEVEL SECURITY already applies. PGlite connects as a
 * superuser, which bypasses RLS, so there we switch to a plain role (`set local role`: this transaction only) with
 * row rights on `tables`.
 */
export async function asRlsSubject(tx: Queryable, tables: readonly string[]): Promise<void> {
    const [me] = await tx.query<{ rolsuper: boolean }>(sql`select rolsuper from pg_roles where rolname = current_user`);
    if (!me?.rolsuper) return;
    for (const table of tables) if (!/^[a-z_]+$/.test(table)) throw new Error(`asRlsSubject: bad table name ${table}`);
    await tx.exec(`
        do $$ begin
            if not exists (select from pg_roles where rolname = 'fm_rls_probe') then create role fm_rls_probe nologin nobypassrls; end if;
        end $$;
        grant usage on schema public to fm_rls_probe;
        ${tables.map(table => `grant select, insert, update, delete on ${table} to fm_rls_probe;`).join('\n')}
        set local role fm_rls_probe;`);
}

/** `fn` inside `ctx`, as a role RLS applies to: what a branch can see with the app filter left out. */
export const rlsScoped = <T>(db: Db, ctx: BranchContext, tables: readonly string[], fn: (tx: Queryable) => Promise<T>): Promise<T> =>
    withBranchTx(db, ctx, async tx => {
        await asRlsSubject(tx, tables);
        return fn(tx);
    });

/**
 * Test fixtures and checks read as the owner with EVERY demo branch in context: on a real server the owner role is
 * bound by FORCE ROW LEVEL SECURITY too, so a bare `ownerDb.query` sees no branch rows there (PGlite, a superuser,
 * sees them all, which hid this).
 */
export const acrossBranches = <T>(db: Db, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
    withBranchTx(
        db,
        systemContext(
            DEMO_BRANCHES.HQ.oid,
            Object.values(DEMO_BRANCHES).map(b => b.oid)
        ),
        fn
    );
