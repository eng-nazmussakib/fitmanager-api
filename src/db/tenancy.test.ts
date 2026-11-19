import type { Request } from 'express';

import { users } from '#src/auth/auth.repo.ts';
import { abilityFor } from '#src/auth/middleware.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { asRlsSubject } from '#src/testing/rls.ts';
import { createTestApp, type TestApp, testDbRole } from '#src/testing/test-app.ts';

import type { Queryable } from './db.ts';
import { sql } from './sql.ts';
import { type BranchContext, branchContext, systemContext, withBranchTx } from './tenancy.ts';

const { HQ, GUL, DHA, UTT } = DEMO_BRANCHES;

let t: TestApp;
beforeAll(async () => {
    t = await createTestApp();
});
afterAll(() => t.close());

const entry = (key: string) => ({ action: 'update', entity: 'probe', entityKey: key, after: { key } });
const visibleKeys = async (tx: Queryable) =>
    (await tx.query<{ entity_key: string }>(sql`select entity_key from audit_log where entity = 'probe' order by entity_key`)).map(r => r.entity_key);
/** As the RLS subject, inside a context. */
const scoped = <T>(ctx: BranchContext, fn: (tx: Queryable) => Promise<T>) =>
    withBranchTx(t.deps.db, ctx, async tx => {
        await asRlsSubject(tx, ['audit_log']);
        return fn(tx);
    });

describe('branch tenancy: RLS on audit_log (migration 005)', () => {
    beforeAll(async () => {
        await scoped(systemContext(GUL.oid), tx => recordAudit(tx, systemContext(GUL.oid), entry('gul-1')));
        await scoped(systemContext(DHA.oid), tx => recordAudit(tx, systemContext(DHA.oid), entry('dha-1')));
    });

    it('a branch context sees only its own branch', async () => {
        expect(await scoped(systemContext(GUL.oid), visibleKeys)).toEqual(['gul-1']);
        expect(await scoped(systemContext(DHA.oid), visibleKeys)).toEqual(['dha-1']);
    });

    it("a branch context cannot write another branch's row, even with a raw insert", async () => {
        await expect(
            scoped(systemContext(GUL.oid), tx =>
                tx.query(sql`insert into audit_log (branch_oid, action, entity, entity_key) values (${DHA.oid}, 'update', 'probe', 'forged')`)
            )
        ).rejects.toThrow(/row-level security/);
        expect(await scoped(systemContext(DHA.oid), visibleKeys)).toEqual(['dha-1']);
    });

    it('a query that forgets the branch filter still sees only the context (the safety net)', async () => {
        const all = await scoped(systemContext(GUL.oid), tx => tx.query<{ n: number }>(sql`select count(*)::int as n from audit_log`));
        const gul = await scoped(systemContext(GUL.oid), tx =>
            tx.query<{ n: number }>(sql`select count(*)::int as n from audit_log where branch_oid = ${GUL.oid}`)
        );
        expect(all[0]?.n).toBe(gul[0]?.n);
    });

    it('an HQ context (HQ + branches) reads across them', async () => {
        expect(await scoped(systemContext(HQ.oid, [HQ.oid, GUL.oid, DHA.oid, UTT.oid]), visibleKeys)).toEqual(['dha-1', 'gul-1']);
    });

    it('no context fails closed: no rows, no inserts', async () => {
        const noContext = <T>(fn: (tx: Queryable) => Promise<T>) =>
            t.deps.db.transaction(async tx => {
                await asRlsSubject(tx, ['audit_log']);
                return fn(tx);
            });
        expect(await noContext(visibleKeys)).toEqual([]);
        await expect(
            noContext(tx => tx.query(sql`insert into audit_log (branch_oid, action, entity, entity_key) values (${GUL.oid}, 'update', 'probe', 'x')`))
        ).rejects.toThrow(/row-level security/);
    });

    it('the context is transaction-local: nothing leaks to the next transaction on the connection', async () => {
        await scoped(systemContext(GUL.oid), visibleKeys);
        const after = await t.deps.db.transaction(tx => tx.query<{ v: string | null }>(sql`select current_setting('app.branch_oids', true) as v`));
        expect(after[0]?.v ?? '').toBe('');
    });

    it('audit rows cannot be changed or removed, even inside their own branch', async () => {
        await scoped(systemContext(GUL.oid), tx => tx.query(sql`update audit_log set action = 'hacked' where entity_key = 'gul-1'`)).catch(() => undefined);
        await scoped(systemContext(GUL.oid), tx => tx.query(sql`delete from audit_log where entity_key = 'gul-1'`)).catch(() => undefined);
        const rows = await scoped(systemContext(GUL.oid), tx => tx.query<{ action: string }>(sql`select action from audit_log where entity_key = 'gul-1'`));
        expect(rows).toEqual([{ action: 'update' }]);
        // Without RLS or privileges in the way (the table owner, or a superuser), the trigger refuses outright.
        await expect(
            withBranchTx(t.ownerDb, systemContext(GUL.oid), async tx => {
                const [me] = await tx.query<{ rolsuper: boolean; owner: string }>(
                    sql`select rolsuper, pg_get_userbyid(relowner) as owner from pg_roles, pg_class where rolname = current_user and relname = 'audit_log'`
                );
                if (!me?.rolsuper) {
                    // Act as the table's owner (fitmanager_owner when the roles exist) and lift FORCE inside this tx only.
                    if (/^[a-z_][a-z0-9_]*$/.test(me?.owner ?? '')) await tx.exec(`set local role ${me?.owner}`);
                    await tx.exec(`alter table audit_log no force row level security`);
                }
                return tx.query(sql`update audit_log set action = 'hacked' where entity_key = 'gul-1'`);
            })
        ).rejects.toThrow(/append-only/);
    });

    it('the app connects as fitmanager_app, which cannot bypass RLS or change the schema', async ctx => {
        // Only on a server set up with the roles (`npm run test:pg` locally); PGlite has one superuser.
        if (testDbRole !== 'fitmanager_app') ctx.skip();
        const [me] = await t.deps.db.query<{ user: string; bypass: boolean; super: boolean }>(
            sql`select current_user as user, rolbypassrls as bypass, rolsuper as super from pg_roles where rolname = current_user`
        );
        expect(me).toEqual({ user: 'fitmanager_app', bypass: false, super: false });
        await expect(t.deps.db.query(sql`update audit_log set action = 'hacked'`)).rejects.toThrow(/permission denied|must be owner/);
        await expect(t.deps.db.exec('create table nope (id int)')).rejects.toThrow(/permission denied/);
    });
});

describe('withBranchTx and branchContext', () => {
    it('refuses an empty, inconsistent or malformed context instead of running unscoped', async () => {
        const run = (ctx: BranchContext) => withBranchTx(t.deps.db, ctx, () => Promise.resolve());
        await expect(run({ ...systemContext(GUL.oid), branchOids: [] })).rejects.toThrow(/empty or inconsistent/);
        await expect(run({ ...systemContext(GUL.oid), branchOids: [DHA.oid] })).rejects.toThrow(/empty or inconsistent/);
        await expect(run(systemContext("x'}, {y", ["x'}, {y"]))).rejects.toThrow(/UUIDs/);
    });

    const requestAs = async (username: string, branchOid: string) => {
        const user = await users.findByUsernameForAuth(t.deps.db, username);
        if (!user) throw new Error(`no demo user ${username}`);
        const assignment = user.assignments.find(a => a.branch.oid === branchOid) ?? null;
        return { auth: { user, branchOid, assignment, ability: abilityFor(user, assignment) }, id: 'req-1' } as unknown as Request;
    };

    it('a branch manager acts at their branch only', async () => {
        const ctx = branchContext(await requestAs('manager.gulshan', GUL.oid));
        expect(ctx).toMatchObject({ branchOid: GUL.oid, branchOids: [GUL.oid], actor: { name: 'Ashraf Siddique' }, requestId: 'req-1' });
    });

    it('the owner at HQ reaches HQ and every branch', async () => {
        const ctx = branchContext(await requestAs('owner', HQ.oid));
        expect(ctx.branchOid).toBe(HQ.oid);
        expect([...ctx.branchOids].sort()).toEqual([HQ.oid, GUL.oid, DHA.oid, UTT.oid].sort());
    });

    it('a branch the user does not work at gives no context', async () => {
        await expect(requestAs('manager.gulshan', DHA.oid).then(branchContext)).rejects.toThrow(/Choose a branch first/);
    });
});
