import request from 'supertest';

import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import { csvCell } from './items.export.ts';

let t: TestApp;
let owner: Record<string, string>;
let manager: Record<string, string>;
let ownerNoBranch: [string, string];

const valid = {
    name_en: 'Test Item',
    category_oid: 'C2',
    contact_mobile: '01712345678',
    effective_date: '2026-01-15',
    amount: 5000,
    status: 'Active',
    attachment: null,
    lines: [{ label: 'Note', value: 'Created by test' }]
};

beforeAll(async () => {
    t = await createTestApp();
    const ownerToken = (await signIn(t.app)).access_token;
    // Rules come from the assignment at X-Branch-Id (D-034): the owner's HQ assignment is `manage all`.
    owner = atBranch(ownerToken, DEMO_BRANCHES.HQ.oid);
    ownerNoBranch = bearer(ownerToken);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, DEMO_BRANCHES.GUL.oid);
});
afterAll(() => t.close());

describe('list', () => {
    it('pages, counts and returns the denormalised category', async () => {
        const res = await request(t.app).get('/api/v1/items?offset=10&limit=5').set(owner).expect(200);
        expect(res.body.data.count).toBe(42);
        expect(res.body.data.rows).toHaveLength(5);
        expect(res.body.data.rows[0]).toMatchObject({ category_en: expect.any(String), effective_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
        expect(typeof res.body.data.rows[0].amount).toBe('number');
    });

    it('searches name and code; filters; sorts by a whitelisted column', async () => {
        const byName = await request(t.app).get('/api/v1/items').query({ search_text: 'alpha' }).set(owner);
        expect(byName.body.data.count).toBe(5);
        const filtered = await request(t.app).get('/api/v1/items').query({ status: 'Inactive', category_oid: 'C1' }).set(owner);
        expect((filtered.body.data.rows as { status: string; category_oid: string }[]).every(r => r.status === 'Inactive' && r.category_oid === 'C1')).toBe(
            true
        );
        const sorted = await request(t.app).get('/api/v1/items').query({ sort_by: 'amount', sort_order: 'desc', limit: 42 }).set(owner);
        const amounts = (sorted.body.data.rows as { amount: number }[]).map(r => r.amount);
        expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    });

    it('LIKE wildcards in the search are literal, and an unknown sort column is refused', async () => {
        expect((await request(t.app).get('/api/v1/items').query({ search_text: '%' }).set(owner)).body.data.count).toBe(0);
        await request(t.app).get('/api/v1/items').query({ sort_by: 'password_hash' }).set(owner).expect(400);
        await request(t.app).get('/api/v1/items').query({ limit: 1000 }).set(owner).expect(400);
    });
});

describe('create, read, update, delete', () => {
    it('creates with a server-generated code, reads it back, updates and deletes it', async () => {
        const created = await request(t.app).post('/api/v1/items').set(owner).send(valid).expect(201);
        expect(created.body).toMatchObject({
            code: 201,
            message: 'Created successfully',
            data: { code: expect.stringMatching(/^ITM-\d+$/), category_en: 'Category B' }
        });
        const oid = created.body.data.oid as string;

        await request(t.app)
            .put(`/api/v1/items/${oid}`)
            .set(owner)
            .send({ ...valid, amount: 7500, status: 'Inactive' })
            .expect(200);
        const read = await request(t.app).get(`/api/v1/items/${oid}`).set(owner).expect(200);
        expect(read.body.data).toMatchObject({ amount: 7500, status: 'Inactive', effective_date: '2026-01-15', lines: valid.lines });

        await request(t.app).delete(`/api/v1/items/${oid}`).set(owner).expect(200);
        await request(t.app).get(`/api/v1/items/${oid}`).set(owner).expect(404);
    });

    it('400 with one error per invalid field; unknown fields are refused', async () => {
        const res = await request(t.app)
            .post('/api/v1/items')
            .set(owner)
            .send({ ...valid, name_en: 'Bad <name>', contact_mobile: '123', amount: 0, extra: true })
            .expect(400);
        const paths = (res.body.errors as { path: string }[]).map(e => e.path).sort();
        expect(paths).toEqual(['amount', 'contact_mobile', 'extra', 'name_en']); // an unknown field is named, not reported at the root
    });

    it('409 for a duplicate name (case-insensitive), 400 for an unknown category, 404 for a bad id', async () => {
        await request(t.app)
            .post('/api/v1/items')
            .set(owner)
            .send({ ...valid, name_en: 'ALPHA 1' })
            .expect(409);
        const res = await request(t.app)
            .post('/api/v1/items')
            .set(owner)
            .send({ ...valid, name_en: 'Fresh', category_oid: 'C9' })
            .expect(400);
        expect(res.body.errors).toEqual([{ path: 'category_oid', message: 'Unknown category' }]);
        await request(t.app).get('/api/v1/items/not-a-uuid').set(owner).expect(404);
    });
});

describe('permissions (the same CASL rules the frontend uses)', () => {
    it('a role without Item rules is refused; so is the owner without a branch (no assignment, no rules)', async () => {
        await request(t.app).get('/api/v1/items').set(manager).expect(403);
        await request(t.app).post('/api/v1/items').set(manager).send(valid).expect(403);
        await request(t.app).get('/api/v1/items/export').set(manager).expect(403);
        await request(t.app)
            .get('/api/v1/items')
            .set(...ownerNoBranch)
            .expect(403);
        // A branch the manager does not work at gives no rules either.
        await request(t.app)
            .get('/api/v1/items')
            .set({ ...manager, 'X-Branch-Id': DEMO_BRANCHES.UTT.oid })
            .expect(403);
    });
});

describe('export', () => {
    it('CSV: BOM, header, every matching row, UTF-8 file name', async () => {
        const res = await request(t.app)
            .get('/api/v1/items/export')
            .query({ status: 'Active' })
            .set(owner)
            .buffer(true)
            .parse((r, cb) => {
                let data = '';
                r.setEncoding('utf8');
                r.on('data', (c: string) => (data += c));
                r.on('end', () => {
                    cb(null, data);
                });
            })
            .expect(200);
        const text = res.body as string;
        expect(res.headers['content-type']).toMatch(/text\/csv/);
        expect(res.headers['content-disposition']).toMatch(/^attachment; filename="items-\d{4}-\d{2}-\d{2}\.csv"/);
        expect(text.startsWith('﻿"Code","Name"')).toBe(true);
        expect(text.trim().split('\r\n')).toHaveLength(1 + 36);
    });

    it('CSV cells: quotes doubled, formulas neutralised', () => {
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
        expect(csvCell(-5)).toBe('-5');
    });

    it('Excel: a real xlsx (zip) file', async () => {
        const res = await request(t.app)
            .get('/api/v1/items/export?format=xlsx')
            .set(owner)
            .buffer(true)
            .parse((r, cb) => {
                const chunks: Buffer[] = [];
                r.on('data', (c: Buffer) => chunks.push(c));
                r.on('end', () => {
                    cb(null, Buffer.concat(chunks));
                });
            })
            .expect(200);
        expect(res.headers['content-type']).toMatch(/spreadsheetml/);
        expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    });
});
