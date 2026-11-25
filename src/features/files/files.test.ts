import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { createMemoryStore } from '#src/lib/file-store.ts';
import { createLocalStore } from '#src/lib/file-store-local.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, DHA } = DEMO_BRANCHES;
const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082',
    'hex'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF');

let t: TestApp;
let desk: Record<string, string>;
let deskDha: Record<string, string>;
let trainer: Record<string, string>;
const store = createMemoryStore('s3');

beforeAll(async () => {
    t = await createTestApp({}, { files: store });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    deskDha = atBranch((await signIn(t.app, 'desk.dhanmondi', 'Desk@123')).access_token, DHA.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
});
afterAll(() => t.close());

/** Start, "PUT to the bucket" (straight into the memory store), complete. */
async function upload(headers: Record<string, string>, body: Buffer, meta: { kind?: string; name?: string; content_type?: string } = {}) {
    const start = await request(t.app)
        .post('/api/v1/files')
        .set(headers)
        .send({ kind: meta.kind ?? 'member_document', name: meta.name ?? 'id.pdf', content_type: meta.content_type ?? 'application/pdf', size: body.length })
        .expect(201);
    const { file, upload: target } = start.body.data as { file: { oid: string; branch_oid: string }; upload: { url: string; headers: Record<string, string> } };
    const key = `${file.branch_oid}/${file.oid}`;
    await store.write(key, new Uint8Array(body), target.headers['Content-Type'] ?? '');
    return { oid: file.oid, key, target, complete: () => request(t.app).post(`/api/v1/files/${file.oid}/complete`).set(headers) };
}

describe('files: signed upload, checked on completion', () => {
    it('start → a pending row and a signed URL; complete → ready; then served with its checked type', async () => {
        const { oid, target, complete } = await upload(desk, PDF);
        expect(target).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf' } });
        expect(target.url).toContain('https://bucket.test/');
        const done = (await complete().expect(200)).body.data as Record<string, unknown>;
        expect(done).toMatchObject({
            oid,
            status: 'ready',
            kind: 'member_document',
            content_type: 'application/pdf',
            size_bytes: PDF.length,
            created_by_name: 'Lamia Haque'
        });
        expect(done).not.toHaveProperty('storage_key');
        const res = await request(t.app).get(`/api/v1/files/${oid}`).set(desk).expect(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-disposition']).toBe("inline; filename*=UTF-8''id.pdf");
        expect(Buffer.from(res.body as Buffer).equals(PDF)).toBe(true);
        await complete().expect(200); // completing twice is harmless
    });

    it('refuses types and sizes outside the file limits before handing out a URL', async () => {
        const start = (body: object) => request(t.app).post('/api/v1/files').set(desk).send(body);
        await start({ kind: 'member_photo', name: 'p.pdf', content_type: 'application/pdf', size: 10 }).expect(415);
        await start({ kind: 'member_document', name: 'x.webp', content_type: 'image/webp', size: 10 }).expect(415);
        await start({ kind: 'member_photo', name: 'p.png', content_type: 'image/png', size: 2 * 1024 * 1024 + 1 }).expect(413);
        await start({ kind: 'member_document', name: 'd.pdf', content_type: 'application/pdf', size: 5 * 1024 * 1024 + 1 }).expect(413);
        await start({ kind: 'other', name: 'd.pdf', content_type: 'application/pdf', size: 1 }).expect(400);
        await start({ kind: 'member_document', name: 'd.pdf', content_type: 'application/pdf', size: 0 }).expect(400);
    });

    it('judges the bytes, not the claim: an HTML page sent as a PNG is deleted and refused', async () => {
        const fake = await upload(desk, Buffer.from('<html><script>alert(1)</script></html>'), {
            kind: 'member_photo',
            name: 'me.png',
            content_type: 'image/png'
        });
        expect((await fake.complete().expect(415)).body.message).toBe('A photo is a JPEG, PNG or WebP of at most 2 MB');
        expect(store.objects.has(fake.key)).toBe(false);
        await request(t.app).get(`/api/v1/files/${fake.oid}`).set(desk).expect(404);
        await fake.complete().expect(409); // rejected stays rejected
        const photo = await upload(desk, PNG, { kind: 'member_photo', name: 'me.png', content_type: 'image/png' });
        expect((await photo.complete().expect(200)).body.data).toMatchObject({ content_type: 'image/png' });
    });

    it('a file larger than its limit once stored is deleted and refused (a signed PUT cannot cap the size)', async () => {
        const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
        const u = await upload(desk, PNG, { kind: 'member_photo', name: 'big.png', content_type: 'image/png' });
        await store.write(u.key, new Uint8Array(big), 'image/png');
        await u.complete().expect(413);
        expect(store.objects.has(u.key)).toBe(false);
    });

    it('nothing arrived yet: 409, and the row stays pending', async () => {
        const start = await request(t.app)
            .post('/api/v1/files')
            .set(desk)
            .send({ kind: 'member_document', name: 'n.pdf', content_type: 'application/pdf', size: 9 })
            .expect(201);
        const oid = (start.body.data as { file: { oid: string } }).file.oid;
        await request(t.app).post(`/api/v1/files/${oid}/complete`).set(desk).expect(409);
    });

    it('another branch cannot see, read, complete or delete the file; a trainer cannot upload', async () => {
        const { oid } = await upload(desk, PDF);
        await request(t.app).post(`/api/v1/files/${oid}/complete`).set(deskDha).expect(404);
        await request(t.app).post(`/api/v1/files/${oid}/complete`).set(desk).expect(200);
        await request(t.app).get(`/api/v1/files/${oid}`).set(deskDha).expect(404);
        await request(t.app).delete(`/api/v1/files/${oid}`).set(deskDha).expect(404);
        await request(t.app)
            .post('/api/v1/files')
            .set(trainer)
            .send({ kind: 'member_document', name: 'a.pdf', content_type: 'application/pdf', size: 9 })
            .expect(403);
        await request(t.app).get(`/api/v1/files/${oid}`).expect(401);
    });

    it('delete: the row is kept as deleted, the object goes, and reading it is a 404', async () => {
        const { oid, key, complete } = await upload(desk, PDF);
        await complete().expect(200);
        await request(t.app).delete(`/api/v1/files/${oid}`).set(desk).expect(200);
        expect(store.objects.has(key)).toBe(false);
        await request(t.app).get(`/api/v1/files/${oid}`).set(desk).expect(404);
        await request(t.app).delete(`/api/v1/files/${oid}`).set(desk).expect(404);
    });
});

describe('files: the local store (development), uploads through the API with a token', () => {
    let local: TestApp;
    let localDesk: Record<string, string>;
    beforeAll(async () => {
        local = await createTestApp({}, { files: createLocalStore(mkdtempSync(join(tmpdir(), 'fm-files-'))) });
        localDesk = atBranch((await signIn(local.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    });
    afterAll(() => local.close());

    it('PUT to the token URL, complete, read back; a wrong or reused-for-another-file token is refused', async () => {
        const start = await request(local.app)
            .post('/api/v1/files')
            .set(localDesk)
            .send({ kind: 'member_photo', name: 'me.png', content_type: 'image/png', size: PNG.length })
            .expect(201);
        const { file, upload: target } = start.body.data as { file: { oid: string }; upload: { url: string } };
        expect(target.url).toMatch(new RegExp(`^/api/v1/files/${file.oid}/content\\?token=`));
        const token = new URL(target.url, 'http://x').searchParams.get('token') ?? '';
        await request(local.app).put(`/api/v1/files/${file.oid}/content?token=${token}x`).set('Content-Type', 'image/png').send(PNG).expect(403);
        const other = '00000000-0000-4000-8000-0000000000aa';
        await request(local.app).put(`/api/v1/files/${other}/content?token=${token}`).set('Content-Type', 'image/png').send(PNG).expect(403);
        await request(local.app).put(target.url).set('Content-Type', 'image/png').send(PNG).expect(200);
        await request(local.app).post(`/api/v1/files/${file.oid}/complete`).set(localDesk).expect(200);
        const res = await request(local.app).get(`/api/v1/files/${file.oid}`).set(localDesk).expect(200);
        expect(Buffer.from(res.body as Buffer).equals(PNG)).toBe(true);
    });

    it('the token route does not exist for a bucket store', async () => {
        await request(t.app).put('/api/v1/files/00000000-0000-4000-8000-0000000000aa/content?token=abcdefghijkl').send(PNG).expect(404);
    });
});

describe('files: audit log', () => {
    it('a completed upload and a delete each write one row; a refused upload writes none', async () => {
        const rows = () =>
            withBranchTx(t.deps.db, systemContext(GUL.oid), tx =>
                tx.query<{ action: string; entity_key: string }>(sql`select action, entity_key from audit_log where entity = 'file' order by created_at`)
            );
        const n = (await rows()).length;
        const ok = await upload(desk, PDF);
        await ok.complete().expect(200);
        await request(t.app).delete(`/api/v1/files/${ok.oid}`).set(desk).expect(200);
        const bad = await upload(desk, Buffer.from('not a pdf at all'));
        await bad.complete().expect(415);
        expect((await rows()).slice(n)).toEqual([
            { action: 'create', entity_key: ok.oid },
            { action: 'delete', entity_key: ok.oid }
        ]);
    });
});

describe('files: signed view links for <img> tags', () => {
    it('a link from viewUrl() serves the file without a session; a tampered or other-file token does not', async () => {
        const { viewUrl } = await import('./files.service.ts');
        const u = await upload(desk, PNG, { kind: 'member_photo', name: 'v.png', content_type: 'image/png' });
        await u.complete().expect(200);
        const url = await viewUrl({ jwtSecret: t.deps.config.auth.jwtSecret, apiPrefix: '/api' }, { oid: u.oid, branch_oid: GUL.oid });
        const res = await request(t.app).get(url).expect(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        await request(t.app).get(`${url}x`).expect(403);
        const other = await upload(desk, PDF);
        await other.complete().expect(200);
        await request(t.app).get(url.replace(u.oid, other.oid)).expect(403);
        // A branch it does not belong to, signed: the row is not found under that branch.
        const wrong = await viewUrl({ jwtSecret: t.deps.config.auth.jwtSecret, apiPrefix: '/api' }, { oid: u.oid, branch_oid: DHA.oid });
        await request(t.app).get(wrong).expect(404);
    });
});

describe('files: one storage limit for every branch together', () => {
    let s: TestApp;
    let gul: Record<string, string>;
    let dha: Record<string, string>;
    const small = createMemoryStore('s3');
    const MB = 1024 * 1024;
    /** A PDF the sniffer accepts, padded to `bytes`. */
    const pdfOf = (bytes: number) => Buffer.concat([PDF, Buffer.alloc(Math.max(0, Math.round(bytes) - PDF.length), 0x20)]);
    const startAt = (headers: Record<string, string>, size: number) =>
        request(s.app)
            .post('/api/v1/files')
            .set(headers)
            .send({ kind: 'member_document', name: 'd.pdf', content_type: 'application/pdf', size: Math.round(size) });

    beforeAll(async () => {
        s = await createTestApp({ FILE_STORAGE_LIMIT_MB: '2' }, { files: small });
        gul = atBranch((await signIn(s.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
        dha = atBranch((await signIn(s.app, 'desk.dhanmondi', 'Desk@123')).access_token, DHA.oid);
    });
    afterAll(() => s.close());

    it('counts ready files of every branch and pending reservations; refuses with 409 past the limit', async () => {
        // Dhanmondi fills 1.5 MB: Gulshan's uploads count against the same total.
        const first = (await startAt(dha, 1.5 * MB).expect(201)).body.data as { file: { oid: string; branch_oid: string } };
        await small.write(`${first.file.branch_oid}/${first.file.oid}`, new Uint8Array(pdfOf(1.5 * MB)), 'application/pdf');
        await request(s.app).post(`/api/v1/files/${first.file.oid}/complete`).set(dha).expect(200);

        const refused = await startAt(gul, 0.6 * MB).expect(409);
        expect((refused.body as { message: string }).message).toMatch(/^File storage is full \(\d+ of 2 MB used\)/);
        // A pending upload reserves its declared size: the second start no longer fits.
        await startAt(gul, 0.3 * MB).expect(201);
        await startAt(gul, 0.3 * MB).expect(409);
    });

    it('checks the real size at completion: a file larger than declared that passes the limit is rejected and removed', async () => {
        // Deleting the Dhanmondi file frees its bytes.
        const [row] = await withBranchTx(s.deps.db, systemContext(DHA.oid), tx =>
            tx.query<{ oid: string }>(sql`select oid from file where branch_oid = ${DHA.oid} and status = 'ready' and size_bytes > 1000000`)
        );
        await request(s.app).delete(`/api/v1/files/${row?.oid}`).set(dha).expect(200);

        const start = (await startAt(gul, 1000).expect(201)).body.data as { file: { oid: string; branch_oid: string } };
        const key = `${start.file.branch_oid}/${start.file.oid}`;
        await small.write(key, new Uint8Array(pdfOf(1.9 * MB)), 'application/pdf');
        await request(s.app).post(`/api/v1/files/${start.file.oid}/complete`).set(gul).expect(409);
        expect(await small.head(key)).toBeFalsy();
        const [after] = await withBranchTx(s.deps.db, systemContext(GUL.oid), tx =>
            tx.query<{ status: string }>(sql`select status from file where oid = ${start.file.oid}`)
        );
        expect(after?.status).toBe('rejected');
    });
});

describe('files: guest uploads expire after 7 days', () => {
    let g: TestApp;
    const gStore = createMemoryStore('s3');
    beforeAll(async () => {
        g = await createTestApp({ GUEST_ACCOUNTS: 'desk.gulshan' }, { files: gStore });
    });
    afterAll(() => g.close());

    const keyOf = async (oid: string) =>
        (await acrossBranches(g.ownerDb, tx => tx.query<{ storage_key: string }>(sql`select storage_key from file where oid = ${oid}`)))[0]!.storage_key;
    async function photo(headers: Record<string, string>) {
        const start = await request(g.app)
            .post('/api/v1/files')
            .set(headers)
            .send({ kind: 'member_photo', name: 'p.png', content_type: 'image/png', size: PNG.length })
            .expect(201);
        const { oid } = start.body.data.file as { oid: string };
        await gStore.write(await keyOf(oid), new Uint8Array(PNG), 'image/png');
        await request(g.app).post(`/api/v1/files/${oid}/complete`).set(headers).expect(200);
        return oid;
    }

    it('a guest’s upload is stored under guest/ and reads as gone after 7 days; staff uploads are kept', async () => {
        const guestToken = (await request(g.app).post('/api/v1/auth/guest').send({ username: 'desk.gulshan' }).expect(200)).body.data.access_token as string;
        const guest = atBranch(guestToken, GUL.oid);
        const manager = atBranch((await signIn(g.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);

        const guestPhoto = await photo(guest);
        const staffPhoto = await photo(manager);
        expect(await keyOf(guestPhoto)).toBe(`guest/${GUL.oid}/${guestPhoto}`);
        expect(await keyOf(staffPhoto)).toBe(`${GUL.oid}/${staffPhoto}`);

        const member = (
            await request(g.app)
                .post('/api/v1/members')
                .set(guest)
                .send({ name: 'Guest Photo', phone: '01711111199', gender: 'Male', health_flags: [], health_declared: true, photo_file_oid: guestPhoto })
                .expect(201)
        ).body.data as { oid: string; photo_url: string | null };
        expect(member.photo_url).not.toBeNull();

        // Eight days on (the bucket's rule has deleted the object): the file and the photo read as gone.
        await acrossBranches(g.ownerDb, tx =>
            tx.query(sql`update file set created_at = created_at - interval '8 days' where oid in (${guestPhoto}, ${staffPhoto})`)
        );
        await request(g.app).get(`/api/v1/files/${guestPhoto}`).set(manager).expect(404);
        const later = (await request(g.app).get(`/api/v1/members/${member.oid}`).set(manager).expect(200)).body.data as { photo_url: string | null };
        expect(later.photo_url).toBeNull();
        await request(g.app).get(`/api/v1/files/${staffPhoto}`).set(manager).expect(200);
    });
});
