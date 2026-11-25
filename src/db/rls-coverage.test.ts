import request from 'supertest';

import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches, rlsScoped } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, stockUp, type TestApp } from '#src/testing/test-app.ts';

import type { Queryable } from './db.ts';
import { type Sql, sql } from './sql.ts';
import { systemContext } from './tenancy.ts';

/**
 * Branch isolation through RLS alone, for every branch-scoped table: rows are made in two branches through
 * the API, then each branch reads every table with no branch filter at all, as a role RLS applies to, and must see
 * none of the other branch's rows. A new table with a `branch_oid` column fails the first test until it has RLS on
 * and forced, or is added to NO_RLS with its reason. The tables' own tests check the app filter and forged writes.
 */

/** Tables with a `branch_oid` column and no RLS, on purpose. */
const NO_RLS: Record<string, string> = {
    plan_template: 'HQ master data on the HQ row: every branch reads it, only HQ writes it (CASL)',
    promo: 'HQ master data on the HQ row: every branch reads it, only HQ writes it (CASL)',
    class_type: 'HQ master data on the HQ row: every branch reads it, only HQ writes it (CASL)',
    policy: 'HQ master data on the HQ row: every branch and the public site read it, only HQ writes it (CASL)',
    product: 'HQ master data on the HQ row: every branch reads the catalogue, only HQ writes it (CASL)',
    supplier: 'HQ master data on the HQ row: branch managers read it for orders, only HQ writes it (CASL)',
    blog_category: 'public website content on the HQ row: the public site reads it without a context, only HQ writes it (CASL)',
    blog_post: 'public website content on the HQ row: the public site reads it without a context, only HQ writes it (CASL)',
    offer: 'public website content on the HQ row: the public site reads it without a context, only HQ writes it (CASL)',
    gallery_item: 'public website photos: read by the public site; HQ writes any, a branch manager their own (CASL + the branch check)',
    staff_assignment: 'identity: read at sign-in to build the branch context itself, before there is one'
};

/** The columns a table's read policy matches on, when it is more than `branch_oid`. */
const READ_BY: Record<string, string[]> = {
    // A visit is seen by the visited branch and by the member's home branch.
    check_in: ['branch_oid', 'member_branch_oid'],
    // A subscription sold elsewhere is seen by the member's home branch too.
    subscription: ['branch_oid', 'home_branch_oid'],
    // A transfer is seen by the branch it left and the one it went to.
    member_transfer: ['from_branch_oid', 'to_branch_oid'],
    // A case, its steps and appeals are seen where it happened and by the member's home branch.
    incident: ['branch_oid', 'member_branch_oid'],
    sanction: ['branch_oid', 'member_branch_oid'],
    appeal: ['branch_oid', 'member_branch_oid'],
    // A stock transfer and its lines are seen by the branch that asked and the one that sends.
    stock_transfer: ['to_branch_oid', 'from_branch_oid'],
    stock_transfer_line: ['to_branch_oid', 'from_branch_oid'],
    // An inbox message is seen by the branch it is addressed to and the one that sent it.
    staff_message: ['branch_oid', 'from_branch_oid']
};

/** Tables a policy reads (the probe role needs rights on them too): a trainer is seen where they are assigned. */
const POLICY_READS: Record<string, string[]> = {
    trainer: ['staff_assignment'],
    trainer_leave: ['trainer', 'staff_assignment'],
    exercise: ['branch'],
    routine: ['branch']
};

/** Tables whose policy also shows HQ's shared rows (the HQ library and templates). */
const ALSO_HQ = new Set(['exercise', 'routine']);

const { GUL, DHA, UTT, HQ } = DEMO_BRANCHES;
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

        // The seeded trainers, rooms, lockers, rules and availability are there; add a class
        // session (made when the timetable is read) with a booking, a PT package and session, a locker rental, a
        // maintenance block and a trainer's day off.
        const week = (await request(t.app).get('/api/v1/classes/schedule?week=2026-11-21').set(d).expect(200)).body.data as {
            sessions: { oid: string; ladies_only: boolean }[];
        };
        const session = week.sessions.find(x => !x.ladies_only)!;
        await request(t.app).post(`/api/v1/classes/sessions/${session.oid}/bookings`).set(d).send({ member_oid: member.oid }).expect(201);
        const pt = plans.find(p => p.branch_oid === branch.oid && (p as { code?: string }).code?.endsWith('-PT-8'))!;
        await request(t.app)
            .post('/api/v1/subscriptions')
            .set(d)
            .send({ member_oid: member.oid, plan_oid: pt.oid, charge_admission: false, payment: { method: 'cash', amount: 0 } })
            .expect(201);
        const trainers = (await request(t.app).get('/api/v1/trainers').set(d).expect(200)).body.data as { oid: string }[];
        const slots = (await request(t.app).get(`/api/v1/pt/slots?trainer_oid=${trainers[0]!.oid}&date=2026-11-21`).set(d).expect(200)).body.data as {
            slots: string[];
        };
        await request(t.app)
            .post('/api/v1/pt/sessions')
            .set(d)
            .send({ member_oid: member.oid, trainer_oid: trainers[0]!.oid, date: '2026-11-21', start_time: slots.slots[0] })
            .expect(201);
        const lockers = (await request(t.app).get('/api/v1/lockers').set(d).expect(200)).body.data as { lockers: { oid: string }[] };
        await request(t.app).post(`/api/v1/lockers/${lockers.lockers[0]!.oid}/rentals`).set(d).send({ member_oid: member.oid, months: 1 }).expect(201);
        const rooms = (await request(t.app).get('/api/v1/rooms').set(d).expect(200)).body.data as { oid: string }[];
        await request(t.app)
            .post('/api/v1/maintenance')
            .set(m)
            .send({ room_oid: rooms[0]!.oid, starts_at: '2026-12-01T00:00:00Z', ends_at: '2026-12-02T00:00:00Z', reason: 'New flooring' })
            .expect(201);
        await request(t.app).post(`/api/v1/trainers/${trainers[0]!.oid}/leave`).set(m).send({ from_date: '2026-12-10', to_date: '2026-12-11' }).expect(201);

        // A branch exercise and template, the member's copy, a workout with a set and a measurement.
        const exercise = (
            await request(t.app)
                .post('/api/v1/exercises')
                .set(m)
                .send({ name: 'Sled push', category: 'strength', measure: 'reps', muscles: ['quads'], equipment: 'other' })
                .expect(201)
        ).body.data as { oid: string };
        const template = (
            await request(t.app)
                .post('/api/v1/routines')
                .set(m)
                .send({
                    name: 'Branch finisher',
                    goal: 'general',
                    level: 'beginner',
                    days: [{ name: 'Day A', exercises: [{ exercise_oid: exercise.oid, sets: 3, reps: 10 }] }]
                })
                .expect(201)
        ).body.data as { oid: string };
        await request(t.app).post(`/api/v1/members/${member.oid}/routine`).set(m).send({ template_oid: template.oid }).expect(201);
        await request(t.app)
            .post(`/api/v1/members/${member.oid}/workouts`)
            .set(m)
            .send({ performed_on: '2026-11-19', day_index: 0, exercises: [{ exercise_oid: exercise.oid, sets: [{ reps: 10 }] }] })
            .expect(201);
        await request(t.app).post(`/api/v1/members/${member.oid}/measurements`).set(d).send({ measured_on: '2026-11-19', weight_kg: 70 }).expect(201);

        // A paper acceptance, a case about the member with a step, a case about the desk with
        // a step and the desk's appeal, a complaint with a reply; an NPS answer and a rating (fixtures: they need a
        // portal sign-in and a class in the past).
        await request(t.app).post(`/api/v1/members/${member.oid}/policies/accept`).set(d).send({}).expect(200);
        const at = '2026-11-19T11:00:00+06:00';
        const c = (
            await request(t.app)
                .post('/api/v1/incidents')
                .set(m)
                .send({ subject_kind: 'member', member_code: member.code, occurred_at: at, category: 'conduct', summary: 'Probe', description: 'Probe case' })
                .expect(201)
        ).body.data as { oid: string };
        await request(t.app).post(`/api/v1/incidents/${c.oid}/sanctions`).set(m).send({ level: 'verbal', reason: 'Probe warning' }).expect(201);
        const deskOid = (await t.ownerDb.query<{ oid: string }>(sql`select oid from app_user where username = ${desk}`))[0]!.oid;
        const sc = (
            await request(t.app)
                .post('/api/v1/incidents')
                .set(m)
                .send({ subject_kind: 'staff', staff_oid: deskOid, occurred_at: at, category: 'attendance', summary: 'Late', description: 'Late for a shift' })
                .expect(201)
        ).body.data as { oid: string };
        const step = (await request(t.app).post(`/api/v1/incidents/${sc.oid}/sanctions`).set(m).send({ level: 'verbal', reason: 'Be on time' }).expect(201))
            .body.data as { sanctions: { oid: string }[] };
        await request(t.app).post(`/api/v1/my-record/${step.sanctions[0]!.oid}/appeal`).set(d).send({ body: 'The bus broke down that day.' }).expect(201);
        const cmp = (
            await request(t.app)
                .post('/api/v1/complaints')
                .set(d)
                .send({ member_oid: member.oid, category: 'facilities', subject: 'Probe', body: 'A probe complaint text.' })
                .expect(201)
        ).body.data as { oid: string };
        await request(t.app).post(`/api/v1/complaints/${cmp.oid}/updates`).set(d).send({ body: 'On it' }).expect(200);
        // Stock in on a received order, an adjustment, equipment with a service and a
        // ticket, a stock transfer asked of Uttara, and a POS sale with a return.
        const hq = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
        await stockUp(t.app, m, hq, [{ code: 'PRD-000005', qty: 10, unit_cost: 110 }]);
        const bar = ((await request(t.app).get('/api/v1/pos/products').set(d).expect(200)).body.data as { oid: string; code: string }[]).find(
            p => p.code === 'PRD-000005'
        )!.oid;
        await request(t.app).post(`/api/v1/stock/${bar}/adjust`).set(m).send({ qty: -1, reason: 'damaged' }).expect(200);
        const kit = (await request(t.app).post('/api/v1/equipment').set(m).send({ name: 'Probe bike', category: 'cardio' }).expect(201)).body.data as {
            oid: string;
        };
        await request(t.app).post(`/api/v1/equipment/${kit.oid}/service`).set(m).send({ technician: 'Probe Tech' }).expect(201);
        // An urgent ticket is a message in the branch's inbox, which the manager reads.
        await request(t.app).post(`/api/v1/equipment/${kit.oid}/tickets`).set(d).send({ description: 'Probe squeak', priority: 'urgent' }).expect(201);
        await request(t.app).post('/api/v1/inbox/read').set(m).send({}).expect(200);
        await request(t.app)
            .post('/api/v1/transfers')
            .set(m)
            .send({ from_branch_oid: UTT.oid, lines: [{ product_oid: bar, qty: 2 }] })
            .expect(201);
        const sale = (
            await request(t.app)
                .post('/api/v1/pos/sales')
                .set(d)
                .send({ lines: [{ product_oid: bar, qty: 2 }], payment: { method: 'bkash', amount: 414, reference: 'PROBE' } })
                .expect(201)
        ).body.data as { invoice: { oid: string } };
        await request(t.app)
            .post(`/api/v1/pos/sales/${sale.invoice.oid}/return`)
            .set(d)
            .send({ lines: [{ index: 0, qty: 1 }], method: 'bkash', reason: 'Probe return' })
            .expect(200);

        await acrossBranches(t.ownerDb, async tx => {
            await tx.query(sql`insert into nps_response (branch_oid, member_oid, score) values (${branch.oid}, ${member.oid}, 9)`);
            await tx.query(sql`
                insert into rating (branch_oid, member_oid, member_name, kind, booking_oid, label, session_at, score)
                select ${branch.oid}, ${member.oid}, 'Isolation Probe', 'class', k.oid, 'Probe', now(), 5 from booking k where k.member_oid = ${member.oid} limit 1`);
        });
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
            // Null-safe: a staff case has no member home branch.
            const mine = sql.join(
                [...cols.map(c => sql`${ident(c)} is not distinct from ${own.oid}::uuid`), ...(ALSO_HQ.has(table) ? [sql`branch_oid = ${HQ.oid}`] : [])],
                ' or '
            );
            const theirs = sql`not (${mine}) and ${ident(cols[0]!)} = ${other.oid}`;
            const count = async (db: Queryable, where: Sql) =>
                (await db.query<{ n: number }>(sql`select count(*)::int as n from ${ident(table)} where ${where}`))[0]!.n;
            // The rows exist (so the check means something) ...
            expect([table, await acrossBranches(t.ownerDb, tx => count(tx, theirs))]).not.toEqual([table, 0]);
            // ... and RLS alone hides them, while the branch's own rows stay visible.
            const seen = await rlsScoped(t.deps.db, systemContext(own.oid), [table, ...(POLICY_READS[table] ?? [])], async tx => ({
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
