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
let manager: Record<string, string>;
let desk: Record<string, string>;
let trainer: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
});
afterAll(() => t.close());
afterEach(() => {
    now = NOON;
});

let phoneSeq = 0;
const phone = () => `0194${String(1_000_000 + ++phoneSeq).padStart(7, '0')}`;
const userOid = async (username: string) => (await t.ownerDb.query<{ oid: string }>(sql`select oid from app_user where username = ${username}`))[0]!.oid;

interface Complaint {
    oid: string;
    code: string;
    status: string;
    overdue: boolean;
    hq_only: boolean;
    can_respond: boolean;
    escalated: { by: string } | null;
    updates: { author: string; body: string }[];
}
const file = (as: Record<string, string>, body: Record<string, unknown>, path = '/api/v1/me/complaints') =>
    request(t.app)
        .post(path)
        .set(as)
        .send({ category: 'facilities', subject: 'Cold showers', body: 'The men’s showers have been cold all week.', ...body });

describe('complaints (D-095)', () => {
    it('a member files in the portal; overdue after 48 hours with no reply; resolved, then accepted (closed)', async () => {
        const m = await portalMember(t.app, desk, phone());
        const c = (await file(m.me, {}).expect(201)).body.data as Complaint;
        expect(c).toMatchObject({ code: 'CMP-GUL-00001', status: 'open', overdue: false });
        now = new Date('2026-11-21T07:00:00Z');
        const overdue = (await request(t.app).get('/api/v1/complaints?overdue=1').set(owner).expect(200)).body.data as Complaint[];
        expect(overdue.map(x => x.oid)).toContain(c.oid);
        await request(t.app).post(`/api/v1/me/complaints/${c.oid}/accept`).set(m.me).expect(409);
        await request(t.app).post(`/api/v1/complaints/${c.oid}/updates`).set(desk).send({ body: 'Looking at the boiler today.' }).expect(200);
        const fixed = (
            await request(t.app).post(`/api/v1/complaints/${c.oid}/updates`).set(desk).send({ body: 'The boiler is fixed.', status: 'resolved' }).expect(200)
        ).body.data as Complaint;
        expect(fixed).toMatchObject({ status: 'resolved', overdue: false });
        const mine = ((await request(t.app).get('/api/v1/me/complaints').set(m.me).expect(200)).body.data as Complaint[])[0]!;
        expect(mine).toMatchObject({ status: 'resolved', can_respond: true });
        expect(mine.updates.map(u => u.author)).toEqual(['staff', 'staff']);
        const closed = (await request(t.app).post(`/api/v1/me/complaints/${c.oid}/accept`).set(m.me).expect(200)).body.data as Complaint;
        expect(closed.status).toBe('closed');
        await request(t.app).post(`/api/v1/complaints/${c.oid}/updates`).set(desk).send({ body: 'More?' }).expect(409);
    });

    it('a resolution closes by itself after 7 days; within them the member may escalate to HQ', async () => {
        const m = await portalMember(t.app, desk, phone());
        const a = (await file(m.me, { category: 'equipment', subject: 'Treadmill 3' }).expect(201)).body.data as Complaint;
        const b = (await file(m.me, { category: 'cleanliness', subject: 'Changing room floor' }).expect(201)).body.data as Complaint;
        for (const c of [a, b])
            await request(t.app).post(`/api/v1/complaints/${c.oid}/updates`).set(desk).send({ body: 'Sorted.', status: 'resolved' }).expect(200);
        const esc = (await request(t.app).post(`/api/v1/me/complaints/${b.oid}/escalate`).set(m.me).send({ reason: 'Still dirty' }).expect(200)).body
            .data as Complaint;
        expect(esc).toMatchObject({ status: 'in_progress', escalated: { by: 'member' } });
        now = new Date('2026-11-27T07:00:00Z');
        const later = (await request(t.app).get('/api/v1/me/complaints').set(m.me).expect(200)).body.data as Complaint[];
        expect(later.find(x => x.oid === a.oid)).toMatchObject({ status: 'closed', can_respond: false });
        const escalated = (await request(t.app).get('/api/v1/complaints?escalated=1').set(owner).expect(200)).body.data as Complaint[];
        expect(escalated.map(x => x.oid)).toContain(b.oid);
    });

    it('a complaint naming staff is hidden from them; naming the manager goes to HQ only; managers escalate', async () => {
        const m = await portalMember(t.app, desk, phone());
        const staff = (await request(t.app).get('/api/v1/me/complaints/staff').set(m.me).expect(200)).body.data as {
            oid: string;
            name: string;
            role: string;
        }[];
        const sam = staff.find(s => s.name === 'Sam Cole')!;
        const aboutSam = (await file(m.me, { category: 'staff', subject: 'Trainer was rude', named_staff_oid: sam.oid }).expect(201)).body.data as Complaint;
        expect(((await request(t.app).get('/api/v1/complaints').set(desk).expect(200)).body.data as Complaint[]).some(c => c.oid === aboutSam.oid)).toBe(true);
        await request(t.app).get(`/api/v1/complaints/${aboutSam.oid}`).set(trainer).expect(403);
        const aboutMgr = (await file(m.me, { category: 'staff', subject: 'Manager ignored me', named_staff_oid: await userOid('manager.gulshan') }).expect(201))
            .body.data as Complaint;
        for (const who of [desk, manager]) await request(t.app).get(`/api/v1/complaints/${aboutMgr.oid}`).set(who).expect(404);
        expect((await request(t.app).get(`/api/v1/complaints/${aboutMgr.oid}`).set(owner).expect(200)).body.data.hq_only).toBe(true);

        await request(t.app).post(`/api/v1/complaints/${aboutSam.oid}/escalate`).set(desk).send({ reason: 'Needs HQ' }).expect(403);
        const esc = (
            await request(t.app).post(`/api/v1/complaints/${aboutSam.oid}/escalate`).set(manager).send({ reason: 'Second complaint about him' }).expect(200)
        ).body.data;
        expect(esc.escalated.by).toBe('manager');
    });

    it('the desk files on someone’s behalf: a member of the branch or a visitor by name', async () => {
        const m = await portalMember(t.app, desk, phone());
        const own = (await file(desk, { member_oid: m.oid }, '/api/v1/complaints').expect(201)).body.data as Complaint & {
            filed_via: string;
            member_name: string;
        };
        expect(own).toMatchObject({ filed_via: 'desk', member_name: 'Portal Member' });
        await file(desk, {}, '/api/v1/complaints').expect(400);
        const visitor = (await file(desk, { member_name: 'A visitor' }, '/api/v1/complaints').expect(201)).body.data;
        expect(visitor.member_oid).toBeNull();
    });
});

describe('NPS and ratings (D-096)', () => {
    it('the NPS card shows after 30 days, at most every 90 days; a dismissal counts', async () => {
        const m = await portalMember(t.app, desk, phone());
        expect((await request(t.app).get('/api/v1/me/feedback').set(m.me).expect(200)).body.data.nps_due).toBe(false);
        // The member joined on the database's day; read 30 days after it.
        const [j] = await acrossBranches(t.ownerDb, tx => tx.query<{ joined: string }>(sql`select joined_on::text as joined from member where oid = ${m.oid}`));
        now = new Date(`${j!.joined}T06:00:00Z`);
        now = new Date(now.getTime() + 31 * 86_400_000);
        expect((await request(t.app).get('/api/v1/me/feedback').set(m.me).expect(200)).body.data.nps_due).toBe(true);
        await request(t.app).post('/api/v1/me/nps').set(m.me).send({ score: null, comment: 'x' }).expect(400);
        await request(t.app).post('/api/v1/me/nps').set(m.me).send({ score: null }).expect(201);
        expect((await request(t.app).get('/api/v1/me/feedback').set(m.me).expect(200)).body.data.nps_due).toBe(false);
        await request(t.app).post('/api/v1/me/nps').set(m.me).send({ score: 9 }).expect(409);
        now = new Date(now.getTime() + 90 * 86_400_000);
        await request(t.app).post('/api/v1/me/nps').set(m.me).send({ score: 9, comment: 'Great trainers' }).expect(201);
        const report = (await request(t.app).get('/api/v1/feedback?days=365').set(manager).expect(200)).body.data;
        expect(report.nps).toMatchObject({ responses: 1, promoters: 1, dismissed: 1, score: 100 });
        expect(report.answers[0]).toMatchObject({ member_name: 'Portal Member', comment: 'Great trainers' });
    });

    it('an attended class and a completed PT session are rated within 7 days, once; a trainer sees averages only', async () => {
        const m = await portalMember(t.app, desk, phone());
        const [sam] = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ oid: string }>(sql`select t.oid from trainer t join app_user u on u.oid = t.user_oid where u.username = 'trainer.gulshan'`)
        );
        const ids = await acrossBranches(t.ownerDb, async tx => {
            const [s] = await tx.query<{ oid: string }>(sql`
                insert into class_session (branch_oid, session_date, class_type_oid, title, color, trainer_oid, trainer_name, room_oid, room_name, starts_at, ends_at, capacity)
                select ${GUL.oid}, '2026-11-18', ct.oid, 'HIIT', 'red', ${sam!.oid}, 'Sam Cole', r.oid, r.name, '2026-11-18T12:00:00Z', '2026-11-18T12:45:00Z', 20
                from class_type ct, room r where ct.name = 'HIIT' and r.branch_oid = ${GUL.oid} limit 1 returning oid`);
            const [b] = await tx.query<{ oid: string }>(sql`
                insert into booking (branch_oid, session_oid, member_oid, member_code, member_name, status, source)
                values (${GUL.oid}, ${s!.oid}, ${m.oid}, ${m.code}, 'Portal Member', 'Attended', 'desk') returning oid`);
            return { booking: b!.oid };
        });
        const fb = (await request(t.app).get('/api/v1/me/feedback').set(m.me).expect(200)).body.data;
        expect(fb.rateable).toEqual([
            expect.objectContaining({ kind: 'class', booking_oid: ids.booking, label: 'HIIT', trainer_name: 'Sam Cole', until: '2026-11-25' })
        ]);
        await request(t.app).post('/api/v1/me/ratings').set(m.me).send({ booking_oid: ids.booking, score: 6 }).expect(400);
        await request(t.app).post('/api/v1/me/ratings').set(m.me).send({ booking_oid: ids.booking, score: 4, comment: 'Loud music' }).expect(201);
        await request(t.app).post('/api/v1/me/ratings').set(m.me).send({ booking_oid: ids.booking, score: 5 }).expect(409);

        const mine = (await request(t.app).get('/api/v1/feedback').set(trainer).expect(200)).body.data;
        expect(mine).toEqual({ days: 90, trainer: expect.objectContaining({ class_avg: 4, class_count: 1, pt_count: 0 }) });
        expect(JSON.stringify(mine)).not.toMatch(/Loud music|Portal Member/);
        const all = (await request(t.app).get('/api/v1/feedback').set(manager).expect(200)).body.data;
        expect(all.ratings[0]).toMatchObject({ member_name: 'Portal Member', score: 4, comment: 'Loud music' });
        await request(t.app).get('/api/v1/feedback').set(desk).expect(403);
    });
});

describe('feedback: audit log', () => {
    it('each complaint step, answer and rating writes an audit row', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ entity: string; action: string }>(sql`
                select distinct entity, action from audit_log where entity in ('complaint', 'nps_response', 'rating') order by 1, 2`)
        );
        expect(rows.map(r => `${r.entity}:${r.action}`)).toEqual(
            expect.arrayContaining([
                'complaint:create',
                'complaint:reply',
                'complaint:resolve',
                'complaint:accept',
                'complaint:escalate',
                'nps_response:answer',
                'nps_response:dismiss',
                'rating:rate'
            ])
        );
    });
});
