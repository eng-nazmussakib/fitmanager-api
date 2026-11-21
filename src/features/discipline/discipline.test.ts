import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, portalMember, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, DHA, HQ } = DEMO_BRANCHES;
/** Thursday 19 Nov 2026, 12:00 in Dhaka. */
const NOON = new Date('2026-11-19T06:00:00Z');
const AT = '2026-11-19T11:30:00+06:00';
let now = NOON;
let t: TestApp;
let owner: Record<string, string>;
let manager: Record<string, string>;
let desk: Record<string, string>;
let trainer: Record<string, string>;
let managerDha: Record<string, string>;
let deskDha: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
    managerDha = atBranch((await signIn(t.app, 'manager.dhanmondi', 'Manager@123')).access_token, DHA.oid);
    deskDha = atBranch((await signIn(t.app, 'desk.dhanmondi', 'Desk@123')).access_token, DHA.oid);
});
afterAll(() => t.close());
afterEach(() => {
    now = NOON;
});

let phoneSeq = 0;
const phone = () => `0193${String(1_000_000 + ++phoneSeq).padStart(7, '0')}`;
const userOid = async (username: string) => (await t.ownerDb.query<{ oid: string }>(sql`select oid from app_user where username = ${username}`))[0]!.oid;

interface Detail {
    oid: string;
    hq_only: boolean;
    suggestion: string;
    strikes: { level: string }[];
    actions: { levels: string[]; ban_scopes: string[] };
    sanctions: {
        oid: string;
        level: string;
        state: string;
        membership_cancelled: boolean;
        can_lift: boolean;
        appeal: { oid: string; status: string; can_decide: boolean } | null;
    }[];
}

const record = (as: Record<string, string>, over: Record<string, unknown>) =>
    request(t.app)
        .post('/api/v1/incidents')
        .set(as)
        .send({ occurred_at: AT, category: 'conduct', summary: 'Shouting on the floor', description: 'Shouted at another member over a bench.', ...over });
const give = (as: Record<string, string>, oid: string, body: Record<string, unknown>) =>
    request(t.app).post(`/api/v1/incidents/${oid}/sanctions`).set(as).send(body);
const evaluate = async (as: Record<string, string>, code: string) =>
    ((await request(t.app).post('/api/v1/attendance/evaluate').set(as).send({ code }).expect(200)).body.data.failures as { rule: string }[]).map(f => f.rule);

describe('cases about members (D-092, D-093)', () => {
    it('the desk records and warns; a manager climbs the ladder; a home-branch ban cancels the membership', async () => {
        const m = await portalMember(t.app, desk, phone(), { name: 'Ladder Tester' });
        const clause = ((await request(t.app).get('/api/v1/policy-clauses').set(desk).expect(200)).body.data as { oid: string; label: string }[])[2]!;
        const first = (await record(desk, { subject_kind: 'member', member_code: m.code, clause_oid: clause.oid }).expect(201)).body.data as Detail;
        expect(first).toMatchObject({ suggestion: 'verbal', actions: { levels: ['verbal'], ban_scopes: [] }, clause_label: clause.label });
        await give(desk, first.oid, { level: 'written', reason: 'Written warning', choice_reason: 'Serious' }).expect(403);
        const warned = (await give(desk, first.oid, { level: 'verbal', reason: 'Respect other members (§3)' }).expect(201)).body.data as Detail;
        expect(warned.sanctions.map(s => [s.level, s.state])).toEqual([['verbal', 'recorded']]);

        const second = (await record(trainer, { subject_kind: 'member', member_code: m.code, category: 'safety', summary: 'Dropped dumbbells' }).expect(201))
            .body.data as Detail;
        expect(second).toMatchObject({ suggestion: 'written', actions: { levels: ['verbal'] } });
        const mine = (await request(t.app).get(`/api/v1/incidents/${second.oid}`).set(manager).expect(200)).body.data as Detail;
        expect(mine.actions).toEqual({ levels: ['verbal', 'written', 'suspension', 'ban'], ban_scopes: ['branch'], can_edit: true });
        await give(manager, second.oid, { level: 'written', reason: 'Second warning' }).expect(201);

        // Third strike: the suggestion is a suspension; a ban needs a reason for the other choice. Managers ban at their branch only.
        const third = (
            await record(manager, { subject_kind: 'member', member_code: m.code, category: 'harassment', summary: 'Threatened a trainer' }).expect(201)
        ).body.data as Detail;
        expect(third.suggestion).toBe('suspension');
        expect((await give(manager, third.oid, { level: 'ban', reason: 'Threats' }).expect(400)).body.errors[0].path).toBe('choice_reason');
        await give(manager, third.oid, { level: 'ban', scope: 'all', reason: 'Threats', choice_reason: 'Threats to staff' }).expect(403);
        const banned = (await give(manager, third.oid, { level: 'ban', reason: 'Threats to a trainer', choice_reason: 'Threats to staff' }).expect(201)).body
            .data as Detail;
        expect(banned.sanctions[0]).toMatchObject({ level: 'ban', state: 'in_force', membership_cancelled: true, can_lift: true });
        await give(manager, third.oid, { level: 'ban', reason: 'Again', choice_reason: 'Again' }).expect(409);

        const member = (await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data;
        expect(member).toMatchObject({ status: 'Banned', sanction: { level: 'ban', reason: 'Threats to a trainer' } });
        const subs = (await request(t.app).get(`/api/v1/members/${m.oid}/subscriptions`).set(desk).expect(200)).body.data as {
            status: string;
            cancel_reason: string;
        }[];
        expect(subs[0]).toMatchObject({ status: 'Cancelled', cancel_reason: 'Banned: Threats to a trainer' });
        expect(await evaluate(desk, m.code)).toContain('banned');

        // The record: the strikes, and the person's own view (reason and clause only).
        const rec = (await request(t.app).get(`/api/v1/members/${m.oid}/discipline`).set(desk).expect(200)).body.data;
        expect([rec.incidents.length, rec.strikes, rec.suggestion]).toEqual([3, 3, 'ban']);
        const own = (await request(t.app).get('/api/v1/me/record').set(m.me).expect(200)).body.data as Record<string, unknown>[];
        expect(own.map(s => s['level'])).toEqual(['ban', 'written', 'verbal']);
        expect(own[2]).toMatchObject({ clause_label: clause.label, reason: 'Respect other members (§3)', can_appeal: true });
        expect(JSON.stringify(own)).not.toMatch(/Shouted at another member|internal|witness/);

        // Lifting: the manager may lift their own branch ban; the plan stays cancelled.
        const lifted = (
            await request(t.app).post(`/api/v1/sanctions/${banned.sanctions[0]!.oid}/lift`).set(manager).send({ reason: 'Apologised in writing' }).expect(200)
        ).body.data as Detail;
        expect(lifted.sanctions[0]!.state).toBe('lifted');
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data.status).toBe('Expired');
    });

    it('a visitor banned at one branch still trains at home; the home branch sees the case; HQ bans everywhere', async () => {
        const v = await portalMember(t.app, deskDha, phone(), { name: 'Visiting Tester', plan: '-SIN-1M' });
        const c = (await record(manager, { subject_kind: 'member', member_code: v.code, category: 'payment' }).expect(201)).body.data as Detail;
        await give(manager, c.oid, { level: 'ban', reason: 'Used a friend’s card', choice_reason: 'Fraud' }).expect(201);
        expect(await evaluate(desk, v.code)).toContain('banned');
        expect(await evaluate(deskDha, v.code)).not.toContain('banned');
        const home = (await request(t.app).get(`/api/v1/members/${v.oid}`).set(deskDha).expect(200)).body.data;
        expect(home.status).toBe('Active');
        const seen = (await request(t.app).get(`/api/v1/members/${v.oid}/discipline`).set(managerDha).expect(200)).body.data;
        expect(seen.incidents).toHaveLength(1);

        // HQ: every branch; the Dhanmondi manager may not lift HQ's ban.
        const hqCase = (await record(owner, { branch_oid: DHA.oid, subject_kind: 'member', member_code: v.code, summary: 'Threats at Dhanmondi' }).expect(201))
            .body.data as Detail;
        expect(hqCase.actions.ban_scopes).toEqual(['branch', 'all']);
        const all = (await give(owner, hqCase.oid, { level: 'ban', scope: 'all', reason: 'Threats', choice_reason: 'Second ban' }).expect(201)).body
            .data as Detail;
        expect(await evaluate(deskDha, v.code)).toContain('banned');
        await request(t.app).post(`/api/v1/sanctions/${all.sanctions[0]!.oid}/lift`).set(managerDha).send({ reason: 'Asked to' }).expect(403);
    });

    it('a suspension has dates; the desk sees it as Suspended; it ends when read', async () => {
        const m = await portalMember(t.app, desk, phone());
        const c = (await record(manager, { subject_kind: 'member', member_code: m.code }).expect(201)).body.data as Detail;
        await give(manager, c.oid, { level: 'suspension', reason: 'Cool off', choice_reason: 'Serious', ends_on: '2026-11-18' }).expect(400);
        await give(manager, c.oid, { level: 'suspension', reason: 'Cool off', choice_reason: 'Serious', ends_on: '2027-03-01' }).expect(400);
        await give(manager, c.oid, { level: 'suspension', reason: 'Cool off', choice_reason: 'Serious', ends_on: '2026-11-21' }).expect(201);
        expect(await evaluate(deskDha, m.code)).toContain('suspended');
        now = new Date('2026-11-22T06:00:00Z');
        expect(await evaluate(desk, m.code)).not.toContain('suspended');
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data.status).toBe('Active');
    });
});

describe('appeals (D-094)', () => {
    it('a member appeals in the portal within 7 days; not the giver but HQ or another decides; upheld overturns', async () => {
        const m = await portalMember(t.app, desk, phone());
        const c = (await record(manager, { subject_kind: 'member', member_code: m.code }).expect(201)).body.data as Detail;
        const s = ((await give(manager, c.oid, { level: 'written', reason: 'Rude to the desk', choice_reason: 'Second time' }).expect(201)).body.data as Detail)
            .sanctions[0]!;
        await request(t.app).post(`/api/v1/me/record/${s.oid}/appeal`).set(m.me).send({ body: 'Too short' }).expect(400);
        const appealed = (
            await request(t.app).post(`/api/v1/me/record/${s.oid}/appeal`).set(m.me).send({ body: 'I was not at the gym that evening.' }).expect(201)
        ).body.data;
        expect(appealed).toMatchObject({ appeal: { status: 'open' }, can_appeal: false });
        await request(t.app).post(`/api/v1/me/record/${s.oid}/appeal`).set(m.me).send({ body: 'Again, I was not there.' }).expect(409);

        const queue = (await request(t.app).get('/api/v1/incidents?appeal=open').set(manager).expect(200)).body.data as { oid: string }[];
        expect(queue.map(q => q.oid)).toContain(c.oid);
        const viewed = (await request(t.app).get(`/api/v1/incidents/${c.oid}`).set(manager).expect(200)).body.data as Detail;
        expect(viewed.sanctions[0]!.appeal).toMatchObject({ status: 'open', can_decide: false });
        await request(t.app)
            .post(`/api/v1/appeals/${viewed.sanctions[0]!.appeal!.oid}/decide`)
            .set(manager)
            .send({ decision: 'upheld', note: 'Mine' })
            .expect(403);
        const decided = (
            await request(t.app)
                .post(`/api/v1/appeals/${viewed.sanctions[0]!.appeal!.oid}/decide`)
                .set(owner)
                .send({ decision: 'upheld', note: 'The camera shows he left at 6.' })
                .expect(200)
        ).body.data as Detail;
        expect(decided.sanctions[0]).toMatchObject({ state: 'overturned', appeal: { status: 'upheld' } });
        const next = (await record(manager, { subject_kind: 'member', member_code: m.code }).expect(201)).body.data as Detail;
        expect(next.suggestion).toBe('verbal');
    });

    it('an appeal after 7 days is refused', async () => {
        const m = await portalMember(t.app, desk, phone());
        const c = (await record(desk, { subject_kind: 'member', member_code: m.code }).expect(201)).body.data as Detail;
        const s = ((await give(desk, c.oid, { level: 'verbal', reason: 'Wipe the bench' }).expect(201)).body.data as Detail).sanctions[0]!;
        now = new Date('2026-11-27T06:00:00Z');
        expect(
            (await request(t.app).post(`/api/v1/me/record/${s.oid}/appeal`).set(m.me).send({ body: 'I always wipe the bench.' }).expect(409)).body.message
        ).toMatch(/26 Nov 2026/);
    });
});

describe('cases about staff (D-092, D-093)', () => {
    it('a case about a branch manager goes to HQ: the branch does not see it; the manager sees the step in My record', async () => {
        const mgr = await userOid('manager.gulshan');
        const staff = (await request(t.app).get('/api/v1/incidents/staff').set(desk).expect(200)).body.data as { oid: string; role: string }[];
        expect(staff.map(s => s.role).sort()).toEqual(expect.arrayContaining(['BRANCH_MANAGER', 'TRAINER']));
        expect(staff.some(s => s.oid === (staff.find(x => x.role === 'FRONT_DESK')?.oid ?? '') && s.role === 'FRONT_DESK' && s.oid === mgr)).toBe(false);
        const res = await record(desk, { subject_kind: 'staff', staff_oid: mgr, category: 'attendance', summary: 'Opened 40 minutes late' }).expect(201);
        expect(res.body).toMatchObject({ message: 'Recorded and sent to HQ', data: { sent_to_hq: true } });
        const oid = res.body.data.oid as string;
        for (const who of [desk, manager]) await request(t.app).get(`/api/v1/incidents/${oid}`).set(who).expect(404);
        expect(((await request(t.app).get('/api/v1/incidents').set(manager).expect(200)).body.data as { oid: string }[]).some(i => i.oid === oid)).toBe(false);
        const hq = (await request(t.app).get(`/api/v1/incidents/${oid}`).set(owner).expect(200)).body.data as Detail;
        expect(hq).toMatchObject({ hq_only: true, actions: { levels: ['verbal', 'written', 'suspension', 'ban'] } });
        await give(owner, oid, { level: 'verbal', reason: 'Open on time' }).expect(201);
        const mine = (await request(t.app).get('/api/v1/my-record').set(manager).expect(200)).body.data as {
            level: string;
            reason: string;
            branch_name: string;
        }[];
        expect(mine).toEqual([expect.objectContaining({ level: 'verbal', reason: 'Open on time', branch_name: 'Gulshan' })]);
    });

    it('a trainer appeals a written warning in the console; a staff suspension blocks sign-in until it ends', async () => {
        const sam = await userOid('trainer.gulshan');
        const c = (await record(manager, { subject_kind: 'staff', staff_oid: sam, category: 'attendance', summary: 'Late for three classes' }).expect(201)).body
            .data as Detail;
        await record(trainer, { subject_kind: 'staff', staff_oid: sam }).expect(400);
        const w = ((await give(manager, c.oid, { level: 'written', reason: 'Late three times', choice_reason: 'Repeated' }).expect(201)).body.data as Detail)
            .sanctions[0]!;
        const appealed = (
            await request(t.app).post(`/api/v1/my-record/${w.oid}/appeal`).set(trainer).send({ body: 'Two of those were cover classes.' }).expect(201)
        ).body.data;
        expect(appealed.appeal.status).toBe('open');
        const caseNow = (await request(t.app).get(`/api/v1/incidents/${c.oid}`).set(owner).expect(200)).body.data as Detail;
        await request(t.app)
            .post(`/api/v1/appeals/${caseNow.sanctions[0]!.appeal!.oid}/decide`)
            .set(owner)
            .send({ decision: 'rejected', note: 'All three were his.' })
            .expect(200);

        const s = (await record(manager, { subject_kind: 'staff', staff_oid: sam, category: 'conduct', summary: 'Shouted at a member' }).expect(201)).body
            .data as Detail;
        await give(manager, s.oid, { level: 'suspension', reason: 'Cool off', choice_reason: 'Serious', ends_on: '2026-11-21' }).expect(201);
        expect((await request(t.app).post('/api/v1/auth/login').send({ username: 'trainer.gulshan', password: 'Trainer@123' }).expect(403)).body.message).toBe(
            'This account is suspended until 21 Nov 2026'
        );
        await request(t.app).get('/api/v1/auth/me').set(trainer).expect(401);
        now = new Date('2026-11-22T06:00:00Z');
        await request(t.app).post('/api/v1/auth/login').send({ username: 'trainer.gulshan', password: 'Trainer@123' }).expect(200);
    });
});

describe('discipline: audit log', () => {
    it('recording, each step, lifting, appeals and decisions write audit rows', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ entity: string; action: string }>(sql`
                select distinct entity, action from audit_log where entity in ('incident', 'sanction', 'appeal', 'subscription') order by 1, 2`)
        );
        expect(rows.map(r => `${r.entity}:${r.action}`)).toEqual(
            expect.arrayContaining([
                'incident:create',
                'sanction:sanction',
                'sanction:lift',
                'appeal:appeal',
                'appeal:uphold',
                'appeal:reject',
                'subscription:cancel'
            ])
        );
    });

    it('closing a case and adding notes is a manager’s, audited; a closed case takes no step', async () => {
        const m = await portalMember(t.app, desk, phone());
        const c = (await record(desk, { subject_kind: 'member', member_code: m.code }).expect(201)).body.data as Detail;
        await request(t.app).patch(`/api/v1/incidents/${c.oid}`).set(desk).send({ closed: true }).expect(403);
        const closed = (
            await request(t.app).patch(`/api/v1/incidents/${c.oid}`).set(manager).send({ closed: true, internal_notes: 'Spoke to him' }).expect(200)
        ).body.data;
        expect(closed).toMatchObject({ closed: true, internal_notes: 'Spoke to him', actions: { levels: [] } });
        await give(manager, c.oid, { level: 'verbal', reason: 'Late' }).expect(409);
        const [row] = await acrossBranches(t.ownerDb, tx => tx.query(sql`select 1 from audit_log where entity = 'incident' and action = 'update'`));
        expect(row).toBeDefined();
    });
});
