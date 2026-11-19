import request from 'supertest';

import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { rlsScoped } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import type { Queryable } from './db.ts';
import { type Sql, sql } from './sql.ts';
import { systemContext } from './tenancy.ts';

/**
 * Branch isolation through RLS alone, for every branch-scoped table (phase 1 §3): rows are made in two branches through
 * the API, then each branch reads every table with no branch filter at all, as a role RLS applies to, and must see
 * none of the other branch's rows. A new table with a `branch_oid` column fails the first test until it has RLS on
 * and forced, or is added to NO_RLS with its reason. The tables' own tests check the app filter and forged writes.
 */

/** Tables with a `branch_oid` column and no RLS, on purpose. */
const NO_RLS: Record<string, string> = {
    plan_template: 'HQ master data on the HQ row (D-023): every branch reads it, only HQ writes it (CASL)',
    promo: 'HQ master data on the HQ row (D-023): every branch reads it, only HQ writes it (CASL)',
    staff_assignment: 'identity: read at sign-in to build the branch context itself, before there is one'
};

/** The columns a table's read policy matches on, when it is more than `branch_oid`. */
const READ_BY: Record<string, string[]> = {
    // A visit is seen by the visited branch and by the member's home branch (D-062).
    check_in: ['branch_oid', 'member_branch_oid'],
    // A subscription sold elsewhere is seen by the member's home branch too (D-061).
    subscription: ['branch_oid', 'home_branch_oid'],
    // A transfer is seen by the branch it left and the one it went to.
    member_transfer: ['from_branch_oid', 'to_branch_oid']
};

const { GUL, DHA, UTT } = DEMO_BRANCHES;
const ident = (name: string) => {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`bad identifier ${name}`);
    return sql.raw(name);
};

let t: TestApp;
let rlsTables: string[];
beforeAll(async () => {
    // Midday in Dhaka on a weekday, inside opening hours, so the check-ins pass the access rules.
    t = await createTestApp({}, { clock: () => new Date('2026-11-19T06:00:00Z') });
    rlsTables = (
        await t.ownerDb.query<{ relname: string }>(sql`
            select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity order by 1`)
    ).map(r => r.relname);

    // In each of two branches: a member (and its code counter), a paid sale (subscription, invoice, payment, receipt
    // message), a check-in, a pending file, the day's cash closing, and a transfer out to Uttara. Each write is audited.
    let phone = 0;
    for (const [branch, desk, manager] of [
        [GUL, 'desk.gulshan', 'manager.gulshan'],
        [DHA, 'desk.dhanmondi', 'manager.dhanmondi']
    ] as const) {
        const d = atBranch((await signIn(t.app, desk, 'Desk@123')).access_token, branch.oid);
        const m = atBranch((await signIn(t.app, manager, 'Manager@123')).access_token, branch.oid);
        const newMember = async () =>
            (
                await request(t.app)
                    .post('/api/v1/members')
                    .set(d)
                    .send({ name: 'Isolation Probe', phone: `0191000000${++phone}`, gender: 'Female', health_flags: [], health_declared: true })
                    .expect(201)
            ).body.data as { oid: string; code: string };
        const member = await newMember();
        const plans = (await request(t.app).get('/api/v1/plans').set(d).expect(200)).body.data as { oid: string; branch_oid: string }[];
        const plan = plans.find(p => p.branch_oid === branch.oid)!;
        const quote = (
            await request(t.app)
                .post('/api/v1/subscriptions/quote')
                .set(d)
                .send({ member_oid: member.oid, plan_oid: plan.oid, charge_admission: true })
                .expect(200)
        ).body.data as { total: number };
        await request(t.app)
            .post('/api/v1/subscriptions')
            .set(d)
            .send({ member_oid: member.oid, plan_oid: plan.oid, charge_admission: true, payment: { method: 'cash', amount: quote.total } })
            .expect(201);
        await request(t.app).post('/api/v1/attendance/check-in').set(d).send({ member_oid: member.oid }).expect(201);
        await request(t.app)
            .post('/api/v1/files')
            .set(d)
            .send({ kind: 'member_document', name: 'id.pdf', content_type: 'application/pdf', size: 100 })
            .expect(201);
        await request(t.app).post('/api/v1/cash-closing').set(d).send({ counted_cash: quote.total }).expect(201);
        const leaving = await newMember();
        await request(t.app).post(`/api/v1/members/${leaving.oid}/transfer`).set(m).send({ to_branch_oid: UTT.oid, reason: 'Moved house' }).expect(200);
    }
});
afterAll(() => t.close());

describe('RLS covers every branch-scoped table', () => {
    it('every table with a branch_oid column has RLS on and forced, with a policy, or a reason it has none', async () => {
        const rows = await t.ownerDb.query<{ relname: string; on: boolean; forced: boolean; policies: number }>(sql`
            select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced,
                   (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attname = 'branch_oid' and not a.attisdropped
            where n.nspname = 'public' and c.relkind = 'r' order by 1`);
        const unprotected = rows.filter(r => !(r.on && r.forced && r.policies > 0)).map(r => r.relname);
        expect(unprotected).toEqual(Object.keys(NO_RLS).sort());
        expect(rlsTables.length).toBeGreaterThanOrEqual(12);
    });

    it.each([
        ['Gulshan', GUL, DHA],
        ['Dhanmondi', DHA, GUL]
    ])('%s, reading every table with no filter, sees its own rows and none of the other branch’s', async (_name, own, other) => {
        for (const table of rlsTables) {
            const cols = READ_BY[table] ?? ['branch_oid'];
            const mine = sql.join(
                cols.map(c => sql`${ident(c)} = ${own.oid}`),
                ' or '
            );
            const theirs = sql`not (${mine}) and ${ident(cols[0]!)} = ${other.oid}`;
            const count = async (db: Queryable, where: Sql) =>
                (await db.query<{ n: number }>(sql`select count(*)::int as n from ${ident(table)} where ${where}`))[0]!.n;
            // The rows exist (so the check means something) ...
            expect([table, await count(t.ownerDb, theirs)]).not.toEqual([table, 0]);
            // ... and RLS alone hides them, while the branch's own rows stay visible.
            const seen = await rlsScoped(t.deps.db, systemContext(own.oid), [table], async tx => ({
                theirs: await count(tx, theirs),
                any: (await tx.query<{ n: number }>(sql`select count(*)::int as n from ${ident(table)}`))[0]!.n,
                mine: await count(tx, mine)
            }));
            expect([table, seen.theirs]).toEqual([table, 0]);
            expect([table, seen.any]).toEqual([table, seen.mine]);
            expect([table, seen.mine > 0]).toEqual([table, true]);
        }
    });
});
