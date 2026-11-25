import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { createMemoryStore } from '#src/lib/file-store.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { HQ, GUL, DHA } = DEMO_BRANCHES;
const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082',
    'hex'
);
let now = new Date('2026-11-19T06:00:00Z');
const store = createMemoryStore('s3');
let t: TestApp;
let hq: Record<string, string>;
let manager: Record<string, string>;
let managerDha: Record<string, string>;
let desk: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now, files: store });
    hq = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    managerDha = atBranch((await signIn(t.app, 'manager.dhanmondi', 'Manager@123')).access_token, DHA.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
});
afterAll(() => t.close());

/** A ready `site_image` uploaded at the caller's branch. */
async function image(who: Record<string, string>, branchOid: string): Promise<string> {
    const start = await request(t.app)
        .post('/api/v1/files')
        .set(who)
        .send({ kind: 'site_image', name: 'photo.png', content_type: 'image/png', size: PNG.length });
    expect(start.status).toBe(201);
    const oid = (start.body.data as { file: { oid: string } }).file.oid;
    await store.write(`${branchOid}/${oid}`, new Uint8Array(PNG), 'image/png');
    await request(t.app).post(`/api/v1/files/${oid}/complete`).set(who).expect(200);
    return oid;
}

interface Post {
    oid: string;
    slug: string;
    status: string;
    body?: string;
    cover: { src: string } | null;
    category: { slug: string } | null;
}

describe('the blog', () => {
    it('HQ writes posts; the public sees published ones only, a scheduled one from its date; branches and the desk cannot write', async () => {
        const cat = (await request(t.app).post('/api/v1/website/categories').set(hq).send({ name: 'Strength', slug: 'strength' }).expect(201)).body.data as {
            oid: string;
        };
        await request(t.app).post('/api/v1/website/categories').set(hq).send({ name: 'Strength', slug: 'strength' }).expect(409);
        const cover = await image(hq, HQ.oid);
        const base = { excerpt: 'A short excerpt for the list.', body: '## Hello\n\nSome **bold** text.', category_oid: cat.oid };
        const live = (
            await request(t.app)
                .post('/api/v1/website/posts')
                .set(hq)
                .send({ ...base, title: 'Squat well', slug: 'squat-well', cover_file_oid: cover, cover_alt: 'A squat', published_at: '2026-11-18T04:00:00Z' })
                .expect(201)
        ).body.data as Post;
        expect(live).toMatchObject({ status: 'published', cover: { src: `/api/v1/public/images/${cover}` }, category: { slug: 'strength' } });
        await request(t.app)
            .post('/api/v1/website/posts')
            .set(hq)
            .send({ ...base, title: 'Draft', slug: 'draft-post', published_at: null })
            .expect(201);
        const later = (
            await request(t.app)
                .post('/api/v1/website/posts')
                .set(hq)
                .send({ ...base, title: 'Later', slug: 'later-post', published_at: '2026-11-25T04:00:00Z' })
                .expect(201)
        ).body.data as Post;
        expect(later.status).toBe('scheduled');
        await request(t.app)
            .post('/api/v1/website/posts')
            .set(hq)
            .send({ ...base, title: 'Taken', slug: 'squat-well', published_at: null })
            .expect(409);
        await request(t.app)
            .post('/api/v1/website/posts')
            .set(hq)
            .send({ ...base, title: 'Bad', slug: 'Bad Slug!', published_at: null })
            .expect(400);
        await request(t.app)
            .post('/api/v1/website/posts')
            .set(manager)
            .send({ ...base, title: 'Nope', slug: 'nope', published_at: null })
            .expect(403);
        await request(t.app).get('/api/v1/website/posts').set(desk).expect(403);

        const list = (await request(t.app).get('/api/v1/public/posts').expect(200)).body.data as Post[];
        expect(list.map(p => p.slug)).toEqual(['squat-well']);
        expect(list[0]?.body).toBeUndefined();
        expect((await request(t.app).get('/api/v1/public/posts?category=strength').expect(200)).body.data).toHaveLength(1);
        expect((await request(t.app).get('/api/v1/public/posts?category=other').expect(200)).body.data).toHaveLength(0);
        expect(((await request(t.app).get('/api/v1/public/posts/squat-well').expect(200)).body.data as Post).body).toContain('**bold**');
        await request(t.app).get('/api/v1/public/posts/draft-post').expect(404);
        await request(t.app).get('/api/v1/public/posts/later-post').expect(404);
        // The cover is public; a member's photo never is.
        const img = await request(t.app).get(`/api/v1/public/images/${cover}`).expect(200);
        expect(img.headers['cache-control']).toBe('public, max-age=31536000, immutable');

        now = new Date('2026-11-26T06:00:00Z');
        expect(((await request(t.app).get('/api/v1/public/posts').expect(200)).body.data as Post[]).map(p => p.slug)).toEqual(['later-post', 'squat-well']);
        now = new Date('2026-11-19T06:00:00Z');

        // Edit, unpublish, delete (the slug is freed).
        await request(t.app).patch(`/api/v1/website/posts/${live.oid}`).set(hq).send({ published_at: null }).expect(200);
        await request(t.app).get('/api/v1/public/posts/squat-well').expect(404);
        await request(t.app).delete(`/api/v1/website/posts/${live.oid}`).set(hq).expect(200);
        const all = (await request(t.app).get('/api/v1/website/posts').set(hq).expect(200)).body.data as Post[];
        expect(all.map(p => p.slug).sort()).toEqual(['draft-post', 'later-post']);
        await request(t.app)
            .post('/api/v1/website/posts')
            .set(hq)
            .send({ ...base, title: 'Again', slug: 'squat-well', published_at: null })
            .expect(201);
        const audit = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ action: string }>(sql`select action from audit_log where entity = 'blog_post' order by created_at`)
        );
        expect(audit.map(a => a.action)).toEqual(['create', 'create', 'create', 'update', 'delete', 'create']);
    });
});

describe('offers', () => {
    it('the public sees the offers running today, in order; an unknown promo code is refused', async () => {
        const offer = (body: Record<string, unknown>) => request(t.app).post('/api/v1/website/offers').set(hq).send(body);
        await offer({ title: 'Students', slug: 'students', summary: 'Ten percent off for students.', starts_on: '2026-11-01', sort_order: 2 }).expect(201);
        await offer({
            title: 'Early',
            slug: 'early',
            summary: 'An offer for early birds.',
            starts_on: '2026-11-01',
            sort_order: 1,
            conditions: ['Before 8 am']
        }).expect(201);
        await offer({ title: 'Ended', slug: 'ended', summary: 'An offer that ended.', starts_on: '2026-10-01', ends_on: '2026-10-31' }).expect(201);
        const hidden = (await offer({ title: 'Hidden', slug: 'hidden', summary: 'Not published yet.', starts_on: '2026-11-01', published: false }).expect(201))
            .body.data as { oid: string };
        await offer({ title: 'Bad', slug: 'bad', summary: 'An unknown promo code.', starts_on: '2026-11-01', promo_code: 'NOPE123' }).expect(400);
        await offer({ title: 'Bad', slug: 'bad', summary: 'Ends before it starts.', starts_on: '2026-11-10', ends_on: '2026-11-01' }).expect(400);
        expect(((await request(t.app).get('/api/v1/public/offers').expect(200)).body.data as { slug: string }[]).map(o => o.slug)).toEqual([
            'early',
            'students'
        ]);
        await request(t.app).patch(`/api/v1/website/offers/${hidden.oid}`).set(hq).send({ published: true }).expect(200);
        expect((await request(t.app).get('/api/v1/public/offers').expect(200)).body.data).toHaveLength(3);
        await request(t.app).patch(`/api/v1/website/offers/${hidden.oid}`).set(manager).send({ published: false }).expect(403);
    });
});

describe('the gallery and branch pages', () => {
    it('a branch manager adds and edits their own branch’s photos and text; HQ any branch’s; the public page shows them', async () => {
        const mine = await image(manager, GUL.oid);
        const photo = (await request(t.app).post('/api/v1/website/gallery').set(manager).send({ file_oid: mine, alt: 'The new rowing machines' }).expect(201))
            .body.data as { oid: string; branch: { slug: string }; src: string };
        expect(photo).toMatchObject({ branch: { slug: 'gulshan' }, src: `/api/v1/public/images/${mine}` });
        // HQ needs a branch; a branch manager cannot touch another branch's photo.
        const hqImage = await image(hq, HQ.oid);
        await request(t.app).post('/api/v1/website/gallery').set(hq).send({ file_oid: hqImage, alt: 'No branch given' }).expect(400);
        await request(t.app).post('/api/v1/website/gallery').set(hq).send({ file_oid: hqImage, alt: 'Dhanmondi ring', branch_oid: DHA.oid }).expect(201);
        await request(t.app).patch(`/api/v1/website/gallery/${photo.oid}`).set(managerDha).send({ alt: 'Mine now' }).expect(404);
        await request(t.app).patch(`/api/v1/website/gallery/${photo.oid}`).set(manager).send({ alt: 'Rowing machines by the window' }).expect(200);
        await request(t.app).post('/api/v1/website/gallery').set(desk).send({ file_oid: mine, alt: 'Desk' }).expect(403);

        await request(t.app).put('/api/v1/website/branch').set(manager).send({ description: 'Two floors in Gulshan 2.' }).expect(200);
        const page = (await request(t.app).get('/api/v1/public/branches/gulshan').expect(200)).body.data as {
            description: string;
            photos: { alt: string }[];
        };
        expect(page.description).toBe('Two floors in Gulshan 2.');
        expect(page.photos.map(p => p.alt)).toEqual(['Rowing machines by the window']);
        expect(((await request(t.app).get('/api/v1/public/gallery?branch=dhanmondi').expect(200)).body.data as unknown[]).length).toBe(1);

        await request(t.app).delete(`/api/v1/website/gallery/${photo.oid}`).set(manager).expect(200);
        expect(((await request(t.app).get('/api/v1/public/gallery?branch=gulshan').expect(200)).body.data as unknown[]).length).toBe(0);
    });
});
