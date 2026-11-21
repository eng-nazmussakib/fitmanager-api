import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { createMemoryStore } from '#src/lib/file-store.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { rlsScoped } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, suspendMember, type TestApp } from '#src/testing/test-app.ts';

const { GUL, DHA } = DEMO_BRANCHES;
const NOW = new Date('2026-11-19T06:00:00Z'); // 12:00 in Dhaka
const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082',
    'hex'
);

let t: TestApp;
let desk: Record<string, string>;
let manager: Record<string, string>;
let deskDha: Record<string, string>;
let trainer: Record<string, string>;
const store = createMemoryStore('s3');

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => NOW, files: store });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    deskDha = atBranch((await signIn(t.app, 'desk.dhanmondi', 'Desk@123')).access_token, DHA.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
});
afterAll(() => t.close());

let phoneSeq = 0;
const nextPhone = () => `0171${String(10_000_000 + ++phoneSeq).slice(1)}`;
const body = (over: Record<string, unknown> = {}) => ({
    name: 'Rahim Uddin',
    phone: nextPhone(),
    gender: 'Male',
    health_flags: [],
    health_declared: true,
    ...over
});
const create = async (headers = desk, over: Record<string, unknown> = {}) => {
    const res = await request(t.app).post('/api/v1/members').set(headers).send(body(over));
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.data as Record<string, unknown> & { oid: string; code: string };
};

describe('members: add and read (D-022)', () => {
    it('the desk adds a member: a per-branch code, +880 phone, Pending until the first sale', async () => {
        const res = await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send(
                body({
                    name: 'Nadia Karim',
                    phone: '01812-345678',
                    gender: 'Female',
                    email: 'nadia@example.com',
                    health_flags: ['Asthma'],
                    emergency_contact: { name: 'Karim', phone: '01912345678', relation: 'Father' }
                })
            )
            .expect(201);
        expect(res.body.message).toMatch(/^Member MEM-GUL-\d{6} created$/);
        expect(res.body.data).toMatchObject({
            code: expect.stringMatching(/^MEM-GUL-\d{6}$/),
            name: 'Nadia Karim',
            phone: '+8801812345678',
            gender: 'Female',
            status: 'Pending',
            dues: 0,
            joined_on: '2026-11-19',
            health_flags: ['Asthma'],
            emergency_contact: { name: 'Karim', phone: '+8801912345678', relation: 'Father' },
            branch: { oid: GUL.oid, code: 'GUL', kind: 'BRANCH' },
            photo_url: null,
            plan_name: null,
            current_subscription_oid: null
        });
        const a = await create();
        const b = await create();
        expect(Number(b.code.slice(-6)) - Number(a.code.slice(-6))).toBe(1);
        expect((await create(deskDha)).code).toMatch(/^MEM-DHA-000001$/);
    });

    it('refuses a bad member, and a mobile number that any branch already has (D-068 a)', async () => {
        for (const bad of [{ name: 'Al' }, { phone: '12345' }, { health_declared: false }, { gender: 'Other' }, { email: 'x' }, { extra: 1 }]) {
            await request(t.app).post('/api/v1/members').set(desk).send(body(bad)).expect(400);
        }
        const phone = nextPhone();
        await create(desk, { phone });
        const dup = await request(t.app)
            .post('/api/v1/members')
            .set(deskDha)
            .send(body({ phone: `+88${phone}` }))
            .expect(409);
        expect(dup.body.errors).toEqual([{ path: 'phone', message: 'Already a member' }]);
    });

    it('list: search by name, code or phone digits; status counts; paging; sort whitelist', async () => {
        const m = await create(desk, { name: 'Zubair Searchable' });
        const list = async (q: string) =>
            (await request(t.app).get(`/api/v1/members?${q}`).set(desk).expect(200)).body.data as {
                rows: { oid: string }[];
                count: number;
                counts: Record<string, number>;
                page: number;
                size: number;
            };
        expect((await list('q=zubair')).rows.map(r => r.oid)).toEqual([m.oid]);
        expect((await list(`q=${m.code.toLowerCase()}`)).rows.map(r => r.oid)).toEqual([m.oid]);
        expect((await list(`q=${String(m['phone']).slice(-7)}`)).rows.map(r => r.oid)).toEqual([m.oid]);
        const all = await list('size=2&page=1');
        expect(all.rows).toHaveLength(2);
        expect(all.count).toBeGreaterThan(2);
        expect(all.counts['Pending']).toBe(all.count);
        expect((await list('status=Active')).count).toBe(0);
        expect((await list('sort_by=name&sort_order=asc&size=100')).rows.length).toBe(all.count);
        expect((await list('sort_by=drop table&size=100')).rows.length).toBe(all.count);
        await request(t.app).get('/api/v1/members?size=500').set(desk).expect(400);
    });

    it('lookup by scanned code: this branch only', async () => {
        const m = await create();
        expect((await request(t.app).get(`/api/v1/members/lookup?code=${m.code.toLowerCase()}`).set(desk).expect(200)).body.data).toMatchObject({ oid: m.oid });
        await request(t.app).get(`/api/v1/members/lookup?code=${m.code}`).set(deskDha).expect(404);
        await request(t.app).get('/api/v1/members/lookup?code=nope').set(desk).expect(400);
    });

    it('another branch sees nothing: detail, edit, timeline are 404; a trainer reads but cannot add', async () => {
        const m = await create();
        await request(t.app).get(`/api/v1/members/${m.oid}`).set(deskDha).expect(404);
        await request(t.app).patch(`/api/v1/members/${m.oid}`).set(deskDha).send({ name: 'Taken Over' }).expect(404);
        await request(t.app).get(`/api/v1/members/${m.oid}/timeline`).set(deskDha).expect(404);
        expect(
            ((await request(t.app).get('/api/v1/members?size=100').set(deskDha).expect(200)).body.data as { rows: { oid: string }[] }).rows.map(r => r.oid)
        ).not.toContain(m.oid);
        await request(t.app).get(`/api/v1/members/${m.oid}`).set(trainer).expect(200);
        await request(t.app).post('/api/v1/members').set(trainer).send(body()).expect(403);
    });
});

describe('members: edit, photo, suspend', () => {
    it('only the fields sent change; a phone change keeps the uniqueness rule', async () => {
        const m = await create(desk, { address: 'Road 1' });
        const other = await create();
        const res = await request(t.app).patch(`/api/v1/members/${m.oid}`).set(desk).send({ name: 'Rahim Uddin Khan', email: '' }).expect(200);
        expect(res.body.data).toMatchObject({ name: 'Rahim Uddin Khan', address: 'Road 1', email: null });
        await request(t.app).patch(`/api/v1/members/${m.oid}`).set(desk).send({ phone: other['phone'] }).expect(409);
        await request(t.app).patch(`/api/v1/members/${m.oid}`).set(desk).send({}).expect(400);
        await request(t.app).patch(`/api/v1/members/${m.oid}`).set(desk).send({ code: 'MEM-GUL-999999' }).expect(400);
    });

    it('a photo: upload, complete, attach; served through a signed link; another branch’s file is refused', async () => {
        const start = await request(t.app)
            .post('/api/v1/files')
            .set(desk)
            .send({ kind: 'member_photo', name: 'me.png', content_type: 'image/png', size: PNG.length })
            .expect(201);
        const file = (start.body.data as { file: { oid: string } }).file;
        await store.write(`${GUL.oid}/${file.oid}`, new Uint8Array(PNG), 'image/png');
        await request(t.app).post(`/api/v1/files/${file.oid}/complete`).set(desk).expect(200);
        const m = await create(desk, { photo_file_oid: file.oid });
        expect(m['photo_url']).toMatch(new RegExp(`^/api/v1/files/${file.oid}/view\\?token=`));
        await request(t.app).get(String(m['photo_url'])).expect(200);
        // The same photo cannot become someone else's.
        await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send(body({ photo_file_oid: file.oid }))
            .expect(400);
        await request(t.app)
            .post('/api/v1/members')
            .set(deskDha)
            .send(body({ photo_file_oid: file.oid }))
            .expect(400);
    });

    it('a suspension is a sanction (D-093): the status and the record follow; the timeline lists it', async () => {
        const m = await create();
        await request(t.app).post(`/api/v1/members/${m.oid}/suspend`).set(manager).send({ reason: 'Abusive behaviour' }).expect(404);
        await suspendMember(t.app, manager, m.code, { today: '2026-11-19', now: '2026-11-19T11:00:00+06:00', days: 3 });
        const s = await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200);
        expect(s.body.data).toMatchObject({
            status: 'Suspended',
            sanction: { level: 'suspension', reason: 'Abusive behaviour', until: '2026-11-21', branch_name: 'Gulshan' }
        });
        const tl = (await request(t.app).get(`/api/v1/members/${m.oid}/timeline`).set(desk).expect(200)).body.data as { kind: string; title: string }[];
        expect(tl.filter(e => e.kind === 'discipline').map(e => e.title)).toEqual(['Suspended (19 Nov 2026 to 21 Nov 2026)']);
    });

    it('policies signed at the desk are recorded as accepted on paper (D-090)', async () => {
        const created = await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send({ ...body(), phone: '01955000001', policies_signed: true })
            .expect(201);
        const oid = created.body.data.oid as string;
        const list = (await request(t.app).get(`/api/v1/members/${oid}/policies`).set(desk).expect(200)).body.data as { state: string; method: string }[];
        expect(list.map(p => [p.state, p.method])).toEqual(Array(5).fill(['accepted', 'paper']));
    });
});

describe('members: transfer and anonymise (D-068)', () => {
    it('a manager moves a member home; the old branch loses them, the new one has them; audited at both', async () => {
        const m = await create();
        await request(t.app).post(`/api/v1/members/${m.oid}/transfer`).set(desk).send({ to_branch_oid: DHA.oid, reason: 'Moved house' }).expect(403);
        await request(t.app).post(`/api/v1/members/${m.oid}/transfer`).set(manager).send({ to_branch_oid: GUL.oid, reason: 'Moved house' }).expect(400);
        await request(t.app)
            .post(`/api/v1/members/${m.oid}/transfer`)
            .set(manager)
            .send({ to_branch_oid: DEMO_BRANCHES.HQ.oid, reason: 'Moved house' })
            .expect(400);
        const res = await request(t.app)
            .post(`/api/v1/members/${m.oid}/transfer`)
            .set(manager)
            .send({ to_branch_oid: DHA.oid, reason: 'Moved house' })
            .expect(200);
        expect(res.body).toMatchObject({ message: `${m.code} moved to Dhanmondi`, data: { branch_oid: DHA.oid } });
        await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(404);
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(deskDha).expect(200)).body.data).toMatchObject({
            code: m.code,
            branch: { code: 'DHA' }
        });
        const audit = await withBranchTx(t.deps.db, systemContext(GUL.oid, [GUL.oid, DHA.oid]), tx =>
            tx.query<{ branch_oid: string; action: string }>(
                sql`select branch_oid, action from audit_log where entity = 'member' and entity_key = ${m.code} and action like 'transfer%' order by action`
            )
        );
        expect(audit).toEqual([
            { branch_oid: DHA.oid, action: 'transfer_in' },
            { branch_oid: GUL.oid, action: 'transfer_out' }
        ]);
    });

    it('anonymise: the code must be typed; personal data goes; the record stays under its code and cannot be edited', async () => {
        const m = await create(desk, { name: 'Private Person', email: 'p@example.com', address: 'Somewhere' });
        await request(t.app).post(`/api/v1/members/${m.oid}/anonymise`).set(desk).send({ confirm_code: m.code }).expect(403);
        await request(t.app).post(`/api/v1/members/${m.oid}/anonymise`).set(manager).send({ confirm_code: 'MEM-GUL-000000' }).expect(400);
        await request(t.app).post(`/api/v1/members/${m.oid}/anonymise`).set(manager).send({ confirm_code: m.code.toLowerCase() }).expect(200);
        const after = (await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data as Record<string, unknown>;
        expect(after).toMatchObject({ code: m.code, name: 'Anonymised member', phone: null, email: null, address: null, anonymised: true, health_flags: [] });
        await request(t.app).patch(`/api/v1/members/${m.oid}`).set(desk).send({ name: 'Back Again' }).expect(409);
        await request(t.app).post(`/api/v1/members/${m.oid}/anonymise`).set(manager).send({ confirm_code: m.code }).expect(409);
        // The phone is free again.
        await create(desk, { phone: String(m['phone']) });
        const [row] = await withBranchTx(t.deps.db, systemContext(GUL.oid), tx =>
            tx.query<{ after: unknown }>(sql`select after from audit_log where action = 'anonymise' and entity_key = ${m.code}`)
        );
        expect(row?.after).toEqual({ anonymised: true });
    });
});

describe('members: RLS and audit', () => {
    it('RLS: a Gulshan context reads no Dhanmondi member, and cannot insert one', async () => {
        const dha = await create(deskDha);
        const seen = await rlsScoped(t.deps.db, systemContext(GUL.oid), ['member', 'branch'], tx =>
            tx.query(sql`select oid from member where oid = ${dha.oid}`)
        );
        expect(seen).toEqual([]);
        await expect(
            rlsScoped(t.deps.db, systemContext(GUL.oid), ['member', 'branch'], tx =>
                tx.query(sql`insert into member (branch_oid, code, name, gender) values (${DHA.oid}, 'MEM-DHA-999999', 'X', 'Male')`)
            )
        ).rejects.toThrow(/row-level security/);
    });

    it('create and update each write one audit row at the branch, keyed by the code', async () => {
        const m = await create();
        await request(t.app).patch(`/api/v1/members/${m.oid}`).set(desk).send({ address: 'Road 9' }).expect(200);
        const rows = await withBranchTx(t.deps.db, systemContext(GUL.oid), tx =>
            tx.query<{ action: string; before: { address?: string } | null; after: { address?: string } }>(
                sql`select action, before, after from audit_log where entity = 'member' and entity_key = ${m.code} order by created_at`
            )
        );
        expect(rows.map(r => r.action)).toEqual(['create', 'update']);
        expect(rows[1]).toMatchObject({ before: { address: null }, after: { address: 'Road 9' } });
        expect(rows[0]?.after).not.toHaveProperty('status');
    });
});
