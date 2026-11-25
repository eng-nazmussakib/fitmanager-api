import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

let t: TestApp;
let owner: Record<string, string>;
let desk: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp();
    owner = atBranch((await signIn(t.app)).access_token, DEMO_BRANCHES.HQ.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, DEMO_BRANCHES.GUL.oid);
});
afterAll(() => t.close());

interface Group {
    key: string;
    required: boolean;
    section: boolean | null;
    page: boolean | null;
    page_path: string | null;
}
const groups = async () => (await request(t.app).get('/api/v1/public/site-groups').expect(200)).body.data as Group[];

describe('site groups', () => {
    it('public list: groups in order, with their section and page; four required groups', async () => {
        const rows = await groups();
        expect(rows.map(r => r.key)).toEqual(['hero', 'services', 'plans', 'facilities', 'reviews', 'trainers', 'blog', 'branches', 'gallery', 'faq']);
        expect(rows.filter(r => r.required).map(r => r.key)).toEqual(['hero', 'services', 'plans', 'facilities']);
        expect(rows.find(r => r.key === 'blog')).toMatchObject({ section: true, page: true, page_path: '/blog' });
        expect(rows.find(r => r.key === 'hero')).toMatchObject({ section: true, page: null, page_path: null });
        expect(rows.find(r => r.key === 'faq')?.section).toBe(false);
    });

    it('section and page switch separately: blog { section: off, page: on }', async () => {
        const res = await request(t.app).patch('/api/v1/hq/site-groups/blog').set(owner).send({ section: false }).expect(200);
        expect(res.body).toMatchObject({ message: 'Blog: section hidden, page shown', data: { section: false, page: true } });
        expect((await groups()).find(r => r.key === 'blog')).toMatchObject({ section: false, page: true });
        await request(t.app).patch('/api/v1/hq/site-groups/blog').set(owner).send({ section: true, page: false }).expect(200);
        expect((await groups()).find(r => r.key === 'blog')).toMatchObject({ section: true, page: false });
        const admin = (await request(t.app).get('/api/v1/hq/site-groups').set(owner).expect(200)).body.data as {
            key: string;
            updated_by_name: string | null;
        }[];
        expect(admin.find(r => r.key === 'blog')?.updated_by_name).toBe('Kamrul Chowdhury');
        await request(t.app).patch('/api/v1/hq/site-groups/blog').set(owner).send({ page: true }).expect(200);
    });

    it('a required group keeps its section and page on, through the API or in SQL', async () => {
        const res = await request(t.app).patch('/api/v1/hq/site-groups/plans').set(owner).send({ page: false }).expect(409);
        expect(res.body.message).toBe('Membership is required and cannot be switched off');
        await request(t.app).patch('/api/v1/hq/site-groups/plans').set(owner).send({ section: false }).expect(409);
        await expect(t.deps.db.query(sql`update site_group set page_enabled = false where key = 'plans'`)).rejects.toThrow(/site_group_required_on/);
        await expect(t.deps.db.query(sql`update site_group set required = false where key = 'plans'`)).rejects.toThrow(/only its section and page/);
        await expect(t.deps.db.query(sql`delete from site_group where key = 'hero'`)).rejects.toThrow(/cannot be removed/);
    });

    it('refuses a part the group does not have, bad bodies, and staff without HQ settings rights', async () => {
        expect((await request(t.app).patch('/api/v1/hq/site-groups/reviews').set(owner).send({ page: true }).expect(400)).body.message).toBe(
            'Reviews has no page of its own'
        );
        await request(t.app).patch('/api/v1/hq/site-groups/blog').set(owner).send({}).expect(400);
        await request(t.app).patch('/api/v1/hq/site-groups/blog').set(owner).send({ section: 'no' }).expect(400);
        await request(t.app).patch('/api/v1/hq/site-groups/nope').set(owner).send({ section: false }).expect(404);
        await request(t.app).patch('/api/v1/hq/site-groups/blog').set(desk).send({ section: false }).expect(403);
    });
});

describe('site groups: audit log', () => {
    interface AuditRow {
        branch_oid: string;
        actor_name: string | null;
        action: string;
        entity_key: string;
        before: { section: boolean | null } | null;
        after: { section: boolean | null } | null;
        request_id: string | null;
    }
    const auditFor = (key: string) =>
        withBranchTx(t.deps.db, systemContext(DEMO_BRANCHES.HQ.oid), tx =>
            tx.query<AuditRow>(sql`select * from audit_log where entity = 'site_group' and entity_key = ${key} order by created_at`)
        );

    it('a change writes one audit row at HQ: who, before, after, request id', async () => {
        const before = (await auditFor('gallery')).length;
        const res = await request(t.app).patch('/api/v1/hq/site-groups/gallery').set(owner).send({ section: false }).expect(200);
        const rows = await auditFor('gallery');
        expect(rows).toHaveLength(before + 1);
        expect(rows.at(-1)).toMatchObject({
            branch_oid: DEMO_BRANCHES.HQ.oid,
            actor_name: 'Kamrul Chowdhury',
            action: 'update',
            before: { section: true },
            after: { section: false },
            request_id: res.headers['x-request-id']
        });
        await request(t.app).patch('/api/v1/hq/site-groups/gallery').set(owner).send({ section: true }).expect(200);
    });

    it('a refused change writes no audit row (same transaction)', async () => {
        const before = (await auditFor('plans')).length;
        await request(t.app).patch('/api/v1/hq/site-groups/plans').set(owner).send({ page: false }).expect(409);
        expect(await auditFor('plans')).toHaveLength(before);
    });
});
