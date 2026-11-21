import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, HQ } = DEMO_BRANCHES;
let t: TestApp;
let hq: Record<string, string>;
let manager: Record<string, string>;
let desk: Record<string, string>;
let trainer: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => new Date('2026-11-19T06:00:00Z') });
    hq = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
});
afterAll(() => t.close());

interface Product {
    oid: string;
    code: string;
    name: string;
    price: number;
    vat_rate: number | null;
    vat_rate_applied: number;
    supplier_name: string | null;
    active: boolean;
}

describe('the catalogue (D-099)', () => {
    it('the demo catalogue: 13 products on sale, HQ’s VAT unless a product has its own', async () => {
        const list = (await request(t.app).get('/api/v1/products').set(desk).expect(200)).body.data as Product[];
        expect(list).toHaveLength(13);
        expect(list.find(p => p.code === 'PRD-000007')).toMatchObject({ vat_rate: 0.05, vat_rate_applied: 0.05 });
        expect(list.find(p => p.code === 'PRD-000001')).toMatchObject({ vat_rate: null, vat_rate_applied: 0.15, supplier_name: 'Dhaka Nutrition Traders' });
        const all = (await request(t.app).get('/api/v1/products?all=1').set(hq).expect(200)).body.data as Product[];
        expect(all.find(p => p.code === 'PRD-000014')?.active).toBe(false);
        const found = (await request(t.app).get('/api/v1/products?q=prd-000011').set(desk).expect(200)).body.data as Product[];
        expect(found.map(p => p.name)).toEqual(['Lifting gloves']);
    });

    it('HQ adds and prices products (the next code); a branch reads them only; a trainer not at all', async () => {
        const suppliers = (await request(t.app).get('/api/v1/suppliers').set(hq).expect(200)).body.data as { oid: string; name: string }[];
        const created = (
            await request(t.app)
                .post('/api/v1/hq/products')
                .set(hq)
                .send({ name: 'Foam roller', category: 'accessories', unit: 'piece', price: 1200, supplier_oid: suppliers[0]!.oid })
                .expect(201)
        ).body.data as Product;
        expect(created).toMatchObject({ code: 'PRD-000015', vat_rate: null, vat_rate_applied: 0.15 });
        await request(t.app).post('/api/v1/hq/products').set(hq).send({ name: 'foam ROLLER', category: 'accessories', unit: 'piece', price: 1 }).expect(409);
        const priced = (await request(t.app).patch(`/api/v1/hq/products/${created.oid}`).set(hq).send({ price: 1350, vat_rate: 0.1 }).expect(200)).body
            .data as Product;
        expect(priced).toMatchObject({ price: 1350, vat_rate_applied: 0.1 });
        // Prices are HQ's only (D-099), and HQ's routes are HQ's.
        await request(t.app).post('/api/v1/hq/products').set(manager).send({ name: 'Mat', category: 'accessories', unit: 'piece', price: 900 }).expect(403);
        await request(t.app).patch(`/api/v1/hq/products/${created.oid}`).set(manager).send({ price: 1 }).expect(403);
        await request(t.app).get('/api/v1/products').set(trainer).expect(403);
        await request(t.app).patch(`/api/v1/hq/products/${created.oid}`).set(hq).send({ active: false }).expect(200);
        const onSale = (await request(t.app).get('/api/v1/products').set(desk).expect(200)).body.data as Product[];
        expect(onSale.map(p => p.oid)).not.toContain(created.oid);
    });

    it('a product photo must be a ready product_photo upload', async () => {
        const bad = await request(t.app)
            .post('/api/v1/hq/products')
            .set(hq)
            .send({ name: 'Yoga mat', category: 'accessories', unit: 'piece', price: 1500, photo_file_oids: ['00000000-0000-4000-8000-00000000ffff'] })
            .expect(400);
        expect(bad.body.message).toBe('Upload the file first');
    });
});

describe('suppliers (D-099)', () => {
    it('HQ adds and edits them; the branch manager reads; the desk does not', async () => {
        const s = (
            await request(t.app)
                .post('/api/v1/hq/suppliers')
                .set(hq)
                .send({ name: 'Chattogram Sports', phone: '01712 345678', email: 'Sales@Ctg.example', contact_name: null })
                .expect(201)
        ).body.data as { oid: string; phone: string; email: string; active: boolean };
        expect(s).toMatchObject({ phone: '+8801712345678', email: 'sales@ctg.example', active: true });
        await request(t.app).patch(`/api/v1/hq/suppliers/${s.oid}`).set(hq).send({ active: false }).expect(200);
        const branch = (await request(t.app).get('/api/v1/suppliers').set(manager).expect(200)).body.data as { name: string }[];
        expect(branch.map(x => x.name)).not.toContain('Chattogram Sports');
        await request(t.app).get('/api/v1/suppliers').set(desk).expect(403);
        await request(t.app).post('/api/v1/hq/suppliers').set(manager).send({ name: 'Nope' }).expect(403);
    });
});

describe('catalogue: audit log', () => {
    it('every product and supplier change writes an audit row at HQ', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ entity: string; action: string; branch_oid: string }>(sql`
                select distinct entity, action, branch_oid from audit_log where entity in ('product', 'supplier') order by 1, 2`)
        );
        expect(rows.map(r => `${r.entity}:${r.action}`)).toEqual([
            'product:create',
            'product:deactivate',
            'product:update',
            'supplier:create',
            'supplier:update'
        ]);
        expect(new Set(rows.map(r => r.branch_oid))).toEqual(new Set([HQ.oid]));
    });
});
