import request from 'supertest';

import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import { createPdfRenderer } from './pdf.ts';

/** Needs a Chrome binary: `CHROME_PATH=/usr/bin/chromium npm test`. Skipped otherwise (CI installs one). */
const chrome = process.env['CHROME_PATH'];

describe('PDF without a browser configured', () => {
    it('answers 501 instead of crashing', async () => {
        const t = await createTestApp({ CHROME_PATH: '' });
        try {
            const auth = atBranch((await signIn(t.app)).access_token, DEMO_BRANCHES.HQ.oid);
            const { oid } = (await request(t.app).get('/api/v1/items?limit=1').set(auth)).body.data.rows[0] as { oid: string };
            await request(t.app).get(`/api/v1/items/${oid}/pdf`).set(auth).expect(501);
        } finally {
            await t.close();
        }
    });
});

describe.skipIf(!chrome)('PDF with headless Chrome', () => {
    let t: TestApp;
    beforeAll(async () => {
        t = await createTestApp({ CHROME_PATH: chrome });
    });
    afterAll(() => t.close());

    it('renders an item report, one browser for parallel requests', async () => {
        const auth = atBranch((await signIn(t.app)).access_token, DEMO_BRANCHES.HQ.oid);
        const { oid, code } = (await request(t.app).get('/api/v1/items?limit=1').set(auth)).body.data.rows[0] as { oid: string; code: string };
        const get = () =>
            request(t.app)
                .get(`/api/v1/items/${oid}/pdf`)
                .set(auth)
                .buffer(true)
                .parse((r, cb) => {
                    const chunks: Buffer[] = [];
                    r.on('data', (c: Buffer) => chunks.push(c));
                    r.on('end', () => {
                        cb(null, Buffer.concat(chunks));
                    });
                });
        const results = await Promise.all([get(), get(), get(), get()]);
        for (const res of results) {
            expect(res.status).toBe(200);
            expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
        }
        expect(results[0].headers['content-disposition']).toContain(`item-${code}.pdf`);
    });

    it('blocks network requests from the page (no SSRF through injected HTML)', async () => {
        const pdf = createPdfRenderer(chrome);
        const hits: string[] = [];
        const { createServer } = await import('node:http');
        const probe = createServer((req, res) => {
            hits.push(req.url ?? '');
            res.end('x');
        });
        await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
        const port = (probe.address() as { port: number }).port;
        try {
            const file = await pdf.render(`<p>hi</p><img src="http://127.0.0.1:${port}/leak"><link rel="stylesheet" href="http://127.0.0.1:${port}/css">`);
            expect(Buffer.from(file).subarray(0, 5).toString()).toBe('%PDF-');
            expect(hits).toEqual([]);
        } finally {
            probe.close();
            await pdf.close();
        }
    });
});
