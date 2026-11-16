import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';

import { bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082',
    'hex'
);

let t: TestApp;
let auth: [string, string];
const dir = mkdtempSync(join(tmpdir(), 'uploads-'));

beforeAll(async () => {
    t = await createTestApp({ UPLOAD_DIR: dir, UPLOAD_MAX_BYTES: '1024' });
    auth = bearer((await signIn(t.app)).access_token);
});
afterAll(() => t.close());

describe('upload', () => {
    it('stores a PDF under a random name and serves it back', async () => {
        const res = await request(t.app)
            .post('/api/v1/files/upload')
            .set(...auth)
            .attach('file', Buffer.from('%PDF-1.4 e2e'), { filename: 'note.pdf', contentType: 'application/pdf' })
            .expect(201);
        const { file_name, url } = res.body.data as { file_name: string; url: string };
        expect(file_name).toMatch(/^[0-9a-f-]{36}\.pdf$/);
        expect(url).toBe(`/api/v1/files/${file_name}`);
        expect(readdirSync(dir)).toContain(file_name); // written BEFORE the response, not "soon"

        const file = await request(t.app)
            .get(url)
            .set(...auth)
            .expect(200);
        expect(file.headers['content-type']).toBe('application/pdf');
        expect(file.headers['x-content-type-options']).toBe('nosniff');
    });

    it('decides the type by content: a PNG named .pdf is stored as .png, HTML named .png is refused', async () => {
        const png = await request(t.app)
            .post('/api/v1/files/upload')
            .set(...auth)
            .attach('file', PNG, { filename: 'looks-like.pdf', contentType: 'application/pdf' })
            .expect(201);
        expect(png.body.data.file_name).toMatch(/\.png$/);
        await request(t.app)
            .post('/api/v1/files/upload')
            .set(...auth)
            .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'evil.png', contentType: 'image/png' })
            .expect(415);
    });

    it('413 over the size limit, 400 without a file, 401 without a token', async () => {
        await request(t.app)
            .post('/api/v1/files/upload')
            .set(...auth)
            .attach('file', Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(2048)]), 'big.pdf')
            .expect(413);
        await request(t.app)
            .post('/api/v1/files/upload')
            .set(...auth)
            .field('x', '1')
            .expect(400);
        await request(t.app).post('/api/v1/files/upload').attach('file', Buffer.from('%PDF-1.4'), 'a.pdf').expect(401);
    });

    it('download cannot leave the upload folder', async () => {
        await request(t.app)
            .get('/api/v1/files/..%2F..%2Fpackage.json')
            .set(...auth)
            .expect(404);
        await request(t.app)
            .get('/api/v1/files/00000000-0000-0000-0000-000000000000.pdf')
            .set(...auth)
            .expect(404);
    });
});
