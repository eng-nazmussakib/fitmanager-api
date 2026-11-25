import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, portalMember, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, HQ } = DEMO_BRANCHES;
/** Thursday 19 Nov 2026, 12:00 in Dhaka. */
const NOON = new Date('2026-11-19T06:00:00Z');
let now = NOON;
let t: TestApp;
let owner: Record<string, string>;
let admin: Record<string, string>;
let manager: Record<string, string>;
let desk: Record<string, string>;
let trainer: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
    admin = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
});
afterAll(() => t.close());
afterEach(() => {
    now = NOON;
});

interface Policy {
    oid: string;
    slug: string;
    title: string;
    required: boolean;
    public: boolean;
    current: { oid: string; version: number; mode: string; clauses: { number: string; heading: string }[] };
    required_version: number;
    versions: { version: number; mode: string }[];
}
interface Evaluation {
    failures: { rule: string; overridable: boolean }[];
}
interface MemberPolicy {
    slug: string;
    state: string;
    accepted_version: number | null;
    current_version: number;
    current_version_oid: string;
    blocks_on: string | null;
    method: string | null;
}

const gymRules = async (): Promise<Policy> =>
    ((await request(t.app).get('/api/v1/policies').set(desk).expect(200)).body.data as Policy[]).find(p => p.slug === 'gym-rules')!;

describe('policies', () => {
    it('every console reads them; the seed has five, the refund policy with a wording-only second version', async () => {
        const list = (await request(t.app).get('/api/v1/policies').set(trainer).expect(200)).body.data as Policy[];
        expect(list.map(p => [p.slug, p.current.version, p.required_version])).toEqual([
            ['gym-rules', 1, 1],
            ['membership-terms', 1, 1],
            ['refund-policy', 2, 1],
            ['privacy-policy', 1, 1],
            ['liability-waiver', 1, 1]
        ]);
        const refund = list.find(p => p.slug === 'refund-policy')!;
        expect(refund.versions.map(v => [v.version, v.mode])).toEqual([
            [2, 'wording_only'],
            [1, 'accept_again']
        ]);
        const v1 = (await request(t.app).get(`/api/v1/policies/${refund.oid}?version=1`).set(desk).expect(200)).body.data as {
            shown: { clauses: { number: string }[] };
        };
        expect(v1.shown.clauses.map(c => c.number)).toEqual(['1', '2']);
        const clauses = (await request(t.app).get('/api/v1/policy-clauses').set(desk).expect(200)).body.data as { label: string }[];
        expect(clauses[2]!.label).toBe('Gym rules v1 §3: Respect for others');
    });

    it('only HQ writes them: create, edit, publish a version; the slug is unique', async () => {
        const body = {
            slug: 'locker-rules',
            title: 'Locker rules',
            required: false,
            public: true,
            clauses: [{ heading: 'Keys', body: 'Return the key when you leave.' }]
        };
        await request(t.app).post('/api/v1/hq/policies').set(manager).send(body).expect(403);
        const created = (await request(t.app).post('/api/v1/hq/policies').set(admin).send(body).expect(201)).body.data as Policy;
        expect(created.current).toMatchObject({ version: 1, mode: 'accept_again', clauses: [{ number: '1', heading: 'Keys' }] });
        await request(t.app).post('/api/v1/hq/policies').set(admin).send(body).expect(409);
        await request(t.app)
            .post(`/api/v1/hq/policies/${created.oid}/versions`)
            .set(admin)
            .send({
                mode: 'wording_only',
                clauses: [
                    { number: '1', heading: 'Keys', body: 'Return it.' },
                    { number: '1', heading: 'X', body: 'Dup' }
                ]
            })
            .expect(400);
        const v2 = (
            await request(t.app)
                .post(`/api/v1/hq/policies/${created.oid}/versions`)
                .set(admin)
                .send({ mode: 'wording_only', change_note: 'Shorter', clauses: [{ heading: 'Keys', body: 'Return the key at the desk.' }] })
                .expect(201)
        ).body.data as Policy;
        expect([v2.current.version, v2.required_version]).toEqual([2, 1]);
        const off = (await request(t.app).patch(`/api/v1/hq/policies/${created.oid}`).set(admin).send({ active: false, public: false }).expect(200)).body.data;
        expect(off).toMatchObject({ active: false, public: false });
        const listed = (await request(t.app).get('/api/v1/policies').set(desk).expect(200)).body.data as Policy[];
        expect(listed.some(p => p.slug === 'locker-rules')).toBe(false);
    });

    it('the public site reads the public ones, without names', async () => {
        const list = (await request(t.app).get('/api/v1/public/policies').expect(200)).body.data as { slug: string }[];
        expect(list.map(p => p.slug)).toEqual(['gym-rules', 'membership-terms', 'refund-policy', 'privacy-policy']);
        const refund = (await request(t.app).get('/api/v1/public/policies/refund-policy').expect(200)).body.data;
        expect(refund).toMatchObject({ version: 2, clauses: [{ number: '1' }, { number: '2' }, { number: '3' }] });
        expect(JSON.stringify(refund)).not.toMatch(/published_by/);
        await request(t.app).get('/api/v1/public/policies/liability-waiver').expect(404);
    });
});

describe('acceptance and enforcement', () => {
    it('a new "accept again" version is due for 14 days, then blocks check-in; a manager may override; accepting clears it', async () => {
        const m = await portalMember(t.app, desk, '01920000001', { name: 'Policy Tester' });
        let mine = (await request(t.app).get('/api/v1/me/policies').set(m.me).expect(200)).body.data as MemberPolicy[];
        expect(mine.every(p => p.state === 'accepted' && p.method === 'paper')).toBe(true);

        const rules = await gymRules();
        const clauses = rules.current.clauses.map(c => ({ number: c.number, heading: c.heading, body: `${c.heading}: the new wording.` }));
        await request(t.app)
            .post(`/api/v1/hq/policies/${rules.oid}/versions`)
            .set(owner)
            .send({ mode: 'accept_again', change_note: 'Stricter', clauses })
            .expect(201);

        mine = (await request(t.app).get('/api/v1/me/policies').set(m.me).expect(200)).body.data as MemberPolicy[];
        const due = mine.find(p => p.slug === 'gym-rules')!;
        const text = (await request(t.app).get(`/api/v1/me/policies/${rules.oid}`).set(m.me).expect(200)).body.data as { shown: { version: number } };
        expect(text.shown.version).toBe(2);
        await request(t.app).get(`/api/v1/policies/${rules.oid}`).set(m.me).expect(403);
        expect(due).toMatchObject({ state: 'due', accepted_version: 1, current_version: 2, blocks_on: '2026-12-03' });
        const ev = (await request(t.app).post('/api/v1/attendance/evaluate').set(desk).send({ code: m.code }).expect(200)).body.data;
        expect(ev).toMatchObject({ allowed: true, policies_due: [{ title: 'Gym rules', blocks_on: '2026-12-03' }] });

        now = new Date('2026-12-03T06:00:00Z');
        const blocked = (await request(t.app).post('/api/v1/attendance/evaluate').set(desk).send({ code: m.code }).expect(200)).body.data as Evaluation;
        expect(blocked.failures.map(f => f.rule)).toContain('policy');
        expect(blocked.failures.find(f => f.rule === 'policy')?.overridable).toBe(true);
        const staffView = (await request(t.app).get(`/api/v1/members/${m.oid}/policies`).set(desk).expect(200)).body.data as MemberPolicy[];
        expect(staffView.find(p => p.slug === 'gym-rules')!.state).toBe('overdue');

        // The old version is refused; the current one is accepted.
        const v1 = ((await request(t.app).get(`/api/v1/policies/${rules.oid}?version=1`).set(desk).expect(200)).body.data as { shown: { oid: string } }).shown
            .oid;
        await request(t.app).post('/api/v1/me/policies/accept').set(m.me).send({ version_oid: v1 }).expect(409);
        mine = (await request(t.app).post('/api/v1/me/policies/accept').set(m.me).send({ version_oid: due.current_version_oid }).expect(200)).body.data;
        expect(mine.find(p => p.slug === 'gym-rules')).toMatchObject({ state: 'accepted', accepted_version: 2, method: 'portal' });
        const after = (await request(t.app).post('/api/v1/attendance/evaluate').set(desk).send({ code: m.code }).expect(200)).body.data as Evaluation;
        expect(after.failures.map(f => f.rule)).not.toContain('policy');
    });

    it('a member who joined without signing has 14 days from joining; the desk records "signed on paper"', async () => {
        const m = await portalMember(t.app, desk, '01920000002', { policies_signed: false });
        const list = (await request(t.app).get(`/api/v1/members/${m.oid}/policies`).set(desk).expect(200)).body.data as MemberPolicy[];
        expect(new Set(list.map(p => p.state))).toEqual(new Set(['due']));
        expect(list[0]!.blocks_on).toBe('2026-12-03');
        await request(t.app).post(`/api/v1/members/${m.oid}/policies/accept`).set(trainer).send({}).expect(403);
        const res = await request(t.app).post(`/api/v1/members/${m.oid}/policies/accept`).set(desk).send({}).expect(200);
        expect(res.body.data.recorded).toBe(5);
        expect((res.body.data.policies as MemberPolicy[]).every(p => p.state === 'accepted' && p.method === 'paper')).toBe(true);
    });
});

describe('policies: audit log', () => {
    it('publishing, editing and each acceptance write audit rows', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ action: string; entity: string; branch_oid: string }>(sql`
                select distinct action, entity, branch_oid from audit_log where entity in ('policy', 'policy_version', 'policy_acceptance') order by entity, action`)
        );
        expect(rows.map(r => `${r.entity}:${r.action}`)).toEqual(
            expect.arrayContaining(['policy:create', 'policy:update', 'policy_version:publish', 'policy_acceptance:accept'])
        );
        expect(rows.filter(r => r.entity !== 'policy_acceptance').every(r => r.branch_oid === HQ.oid)).toBe(true);
        expect(rows.filter(r => r.entity === 'policy_acceptance').every(r => r.branch_oid === GUL.oid)).toBe(true);
    });
});
