import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { rlsScoped } from '#src/testing/rls.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import { pricingPromos, sellablePlan } from './plans.service.ts';

const { HQ, GUL, DHA, UTT } = DEMO_BRANCHES;
let t: TestApp;
let owner: Record<string, string>;
let manager: Record<string, string>;
let desk: Record<string, string>;
/** An HQ admin assigned at HQ only: no branch in their context. */
let hqAdmin: Record<string, string>;

async function hqAdminAt(username: string, extra: Record<string, unknown> = {}) {
    await request(t.app)
        .post('/api/v1/hq/staff')
        .set(owner)
        .send({ username, name: `Admin ${username}`, password: 'Temp1234', assignments: [{ branch_oid: HQ.oid, role: 'HQ_ADMIN' }], ...extra })
        .expect(201);
    const first = await signIn(t.app, username, 'Temp1234');
    const changed = await request(t.app)
        .post('/api/v1/auth/change-password')
        .set(...bearer(first.access_token))
        .send({ current_password: 'Temp1234', new_password: 'Admin1234' })
        .expect(200);
    return atBranch(changed.body.data.access_token as string, HQ.oid);
}

beforeAll(async () => {
    t = await createTestApp();
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    hqAdmin = await hqAdminAt('plans.admin');
});
afterAll(() => t.close());

interface Plan {
    oid: string;
    branch_oid: string;
    template_oid: string;
    code: string;
    name: string;
    price: number;
    admission_fee: number;
    freezable: boolean;
    active: boolean;
    sellable: boolean;
}
interface Template {
    oid: string;
    tier: string;
    period: string;
    base_price: number;
    freezable: boolean;
    branches_using: number;
}
const deskPlans = async (h = desk) => (await request(t.app).get('/api/v1/plans').set(h).expect(200)).body.data as Plan[];
const templates = async () => (await request(t.app).get('/api/v1/hq/plan-templates').set(owner).expect(200)).body.data as Template[];

describe('plans at the desk (D-044)', () => {
    it('a branch sells every template at its own price, as the mock', async () => {
        const plans = await deskPlans();
        // 12 memberships and 3 PT packages (D-079).
        expect(plans).toHaveLength(15);
        expect(plans.every(p => p.branch_oid === GUL.oid && p.sellable)).toBe(true);
        expect(plans.filter(p => (p as Plan & { kind: string }).kind === 'pt').map(p => p.code)).toEqual(['GUL-PT-1', 'GUL-PT-8', 'GUL-PT-16']);
        expect(plans.find(p => p.code === 'GUL-PT-8')).toMatchObject({ kind: 'pt', sessions: 8, months: 2, price: 10000, freezable: false });
        expect(plans.find(p => p.code === 'GUL-SIN-3M')).toMatchObject({ name: 'Single · 3 Months', price: 8500, admission_fee: 2500, freezable: true });
        const dha = await deskPlans(atBranch((await signIn(t.app, 'manager.dhanmondi', 'Manager@123')).access_token, DHA.oid));
        // 90 % of 8,500 = 7,650, rounded to ৳50.
        expect(dha.find(p => p.code === 'DHA-SIN-3M')).toMatchObject({ price: 7650, admission_fee: 2000 });
        expect(dha.some(p => p.branch_oid === GUL.oid)).toBe(false);
    });

    it('branch roles read plans but never change them', async () => {
        const [plan] = await deskPlans();
        for (const h of [manager, desk]) {
            await request(t.app).patch(`/api/v1/hq/plans/${plan!.oid}`).set(h).send({ price: 1 }).expect(403);
            await request(t.app).get('/api/v1/hq/plan-templates').set(h).expect(403);
        }
        await request(t.app).get('/api/v1/plans').set(owner).expect(400); // a branch operation: HQ uses /v1/hq/plans
    });

    it('RLS: one branch never reads another branch’s plans, even without the filter', async () => {
        const all = sql`select branch_oid from plan`;
        const rows = await rlsScoped(t.deps.db, systemContext(GUL.oid), ['plan', 'plan_template', 'branch'], tx => tx.query<{ branch_oid: string }>(all));
        expect(rows.length).toBe(15);
        expect(rows.every(r => r.branch_oid === GUL.oid)).toBe(true);
        const hq = await rlsScoped(t.deps.db, systemContext(HQ.oid), ['plan', 'plan_template', 'branch'], tx => tx.query(all));
        expect(hq).toEqual([]); // HQ data only: no branch in the context
        // Writing another branch's plan is refused by the policy, not only hidden.
        await expect(
            rlsScoped(t.deps.db, systemContext(GUL.oid), ['plan', 'plan_template', 'branch'], tx =>
                tx.query(sql`insert into plan (branch_oid, template_oid, code, price) select ${DHA.oid}, oid, 'DHA-X-1M', 1 from plan_template limit 1`)
            )
        ).rejects.toThrow(/row-level security/);
    });
});

describe('plans at HQ', () => {
    it('HQ lists every branch, or one', async () => {
        expect((await request(t.app).get('/api/v1/hq/plans').set(owner).expect(200)).body.data).toHaveLength(45);
        const utt = (await request(t.app).get(`/api/v1/hq/plans?branch_oid=${UTT.oid}`).set(owner).expect(200)).body.data as Plan[];
        expect(utt).toHaveLength(15);
        expect(utt.every(p => p.branch_oid === UTT.oid)).toBe(true);
    });

    it('a price change reaches the desk; switching a plan off hides it there', async () => {
        const plan = (await deskPlans()).find(p => p.code === 'GUL-DUO-1M')!;
        const res = await request(t.app).patch(`/api/v1/hq/plans/${plan.oid}`).set(owner).send({ price: 5800.4, admission_fee: 0 }).expect(200);
        expect(res.body).toMatchObject({ message: 'GUL-DUO-1M saved', data: { price: 5800, admission_fee: 0 } });
        await request(t.app).patch(`/api/v1/hq/plans/${plan.oid}`).set(owner).send({ active: false }).expect(200);
        expect((await deskPlans()).some(p => p.oid === plan.oid)).toBe(false);
        await expect(withBranchTx(t.deps.db, systemContext(GUL.oid), tx => sellablePlan(tx, GUL.oid, plan.oid))).rejects.toThrow(
            'Plan not found at this branch'
        );
        await request(t.app).patch(`/api/v1/hq/plans/${plan.oid}`).set(owner).send({ active: true }).expect(200);
        expect((await withBranchTx(t.deps.db, systemContext(GUL.oid), tx => sellablePlan(tx, GUL.oid, plan.oid))).code).toBe('GUL-DUO-1M');
        await expect(withBranchTx(t.deps.db, systemContext(DHA.oid), tx => sellablePlan(tx, DHA.oid, plan.oid))).rejects.toThrow('Plan not found');
    });

    it('an HQ admin assigned at HQ only reaches no branch: branch plans are out of their context', async () => {
        expect((await request(t.app).get('/api/v1/hq/plans').set(hqAdmin).expect(200)).body.data).toEqual([]);
        const [plan] = await deskPlans();
        await request(t.app).patch(`/api/v1/hq/plans/${plan!.oid}`).set(hqAdmin).send({ price: 1 }).expect(404);
        const [tpl] = await templates();
        await request(t.app).post('/api/v1/hq/plans').set(hqAdmin).send({ branch_oid: GUL.oid, template_oid: tpl!.oid }).expect(404);
        // With every-branch access, the same role manages them (D-044).
        const wide = await hqAdminAt('plans.admin.all', { all_branches: true });
        expect((await request(t.app).get('/api/v1/hq/plans').set(wide).expect(200)).body.data).toHaveLength(45);
    });

    it('templates: a new one is sold nowhere until HQ adds it to a branch, at the base price by default', async () => {
        const created = await request(t.app)
            .post('/api/v1/hq/plan-templates')
            .set(owner)
            .send({ tier: 'Student', tier_name: 'Student', period: 'monthly', period_label: 'Monthly', months: 1, base_price: 2000, freezable: false })
            .expect(201);
        const tpl = created.body.data as Template;
        expect(tpl).toMatchObject({ tier: 'student', base_price: 2000, freezable: false, branches_using: 0 });
        await request(t.app)
            .post('/api/v1/hq/plan-templates')
            .set(owner)
            .send({ tier: 'student', tier_name: 'Student', period: 'monthly', period_label: 'Monthly', months: 1, base_price: 1 })
            .expect(409);

        const sold = await request(t.app).post('/api/v1/hq/plans').set(owner).send({ branch_oid: UTT.oid, template_oid: tpl.oid }).expect(201);
        expect(sold.body.data).toMatchObject({ code: 'UTT-STU-1M', name: 'Student · Monthly', price: 2000, admission_fee: 0, freezable: false });
        await request(t.app).post('/api/v1/hq/plans').set(owner).send({ branch_oid: UTT.oid, template_oid: tpl.oid, price: 1500 }).expect(409);
        await request(t.app).post('/api/v1/hq/plans').set(owner).send({ branch_oid: HQ.oid, template_oid: tpl.oid }).expect(400);
        expect((await templates()).find(x => x.oid === tpl.oid)?.branches_using).toBe(1);

        // A template change reaches every branch selling it; switching it off stops the sale everywhere.
        await request(t.app).patch(`/api/v1/hq/plan-templates/${tpl.oid}`).set(owner).send({ freezable: true, tier_name: 'Students' }).expect(200);
        const hqRows = (await request(t.app).get(`/api/v1/hq/plans?branch_oid=${UTT.oid}`).set(owner).expect(200)).body.data as Plan[];
        expect(hqRows.find(p => p.code === 'UTT-STU-1M')).toMatchObject({ name: 'Students · Monthly', freezable: true, sellable: true });
        await request(t.app).patch(`/api/v1/hq/plan-templates/${tpl.oid}`).set(owner).send({ active: false }).expect(200);
        const off = (await request(t.app).get(`/api/v1/hq/plans?branch_oid=${UTT.oid}`).set(owner).expect(200)).body.data as Plan[];
        expect(off.find(p => p.code === 'UTT-STU-1M')).toMatchObject({ active: true, sellable: false });
        await request(t.app).patch(`/api/v1/hq/plan-templates/${tpl.oid}`).set(owner).send({ tier: 'other' }).expect(400);
    });

    it('refuses bad bodies', async () => {
        const [tpl] = await templates();
        await request(t.app).post('/api/v1/hq/plans').set(owner).send({ branch_oid: GUL.oid, template_oid: tpl!.oid, price: -1 }).expect(400);
        await request(t.app)
            .post('/api/v1/hq/plans')
            .set(owner)
            .send({ branch_oid: GUL.oid, template_oid: '00000000-0000-4000-8000-0000000000ff' })
            .expect(400);
        await request(t.app).patch(`/api/v1/hq/plan-templates/${tpl!.oid}`).set(owner).send({}).expect(400);
        await request(t.app).patch(`/api/v1/hq/plan-templates/${tpl!.oid}`).set(owner).send({ months: 0 }).expect(400);
    });
});

describe('promo codes', () => {
    interface Promo {
        code: string;
        percent: number | null;
        amount: number | null;
        waive_admission: boolean;
        active: boolean;
    }
    it('the seed has the mock’s three codes; pricing gets the active ones', async () => {
        const rows = (await request(t.app).get('/api/v1/hq/promos').set(owner).expect(200)).body.data as Promo[];
        expect(rows.map(r => r.code).sort()).toEqual(['NOADMISSION', 'REFER500', 'STUDENT10']);
        expect(rows.find(r => r.code === 'REFER500')).toMatchObject({ amount: 500, percent: null, waive_admission: false });
        const forPricing = await pricingPromos(t.deps.db);
        expect(forPricing.find(p => p.code === 'NOADMISSION')).toEqual(expect.objectContaining({ waive_admission: true }));
        expect(forPricing.find(p => p.code === 'STUDENT10')).not.toHaveProperty('amount');
    });

    it('create and change: exactly one effect, dates in order; a new effect replaces the old', async () => {
        const body = { code: 'eid25', label: 'Eid offer', percent: 25, valid_from: '2026-12-01', valid_to: '2026-12-15' };
        expect((await request(t.app).post('/api/v1/hq/promos').set(owner).send(body).expect(201)).body.data).toMatchObject({ code: 'EID25', percent: 25 });
        await request(t.app).post('/api/v1/hq/promos').set(owner).send(body).expect(409);
        await request(t.app)
            .post('/api/v1/hq/promos')
            .set(owner)
            .send({ ...body, code: 'TWO', amount: 100 })
            .expect(400);
        await request(t.app)
            .post('/api/v1/hq/promos')
            .set(owner)
            .send({ ...body, code: 'NONE', percent: undefined })
            .expect(400);
        await request(t.app)
            .post('/api/v1/hq/promos')
            .set(owner)
            .send({ ...body, code: 'BACK', valid_to: '2026-11-01' })
            .expect(400);

        const changed = await request(t.app).patch('/api/v1/hq/promos/eid25').set(owner).send({ amount: 700 }).expect(200);
        expect(changed.body.data).toMatchObject({ percent: null, amount: 700, waive_admission: false });
        await request(t.app).patch('/api/v1/hq/promos/EID25').set(owner).send({ valid_to: '2026-11-30' }).expect(400);
        await request(t.app).patch('/api/v1/hq/promos/EID25').set(owner).send({ active: false }).expect(200);
        expect((await pricingPromos(t.deps.db)).some(p => p.code === 'EID25')).toBe(false);
        await request(t.app).patch('/api/v1/hq/promos/NOPE1').set(owner).send({ active: false }).expect(404);
        await request(t.app).get('/api/v1/hq/promos').set(manager).expect(403);
    });
});

describe('public price list', () => {
    it('each branch with its sellable plans and the VAT rate and mode; one branch by slug', async () => {
        const rows = (await request(t.app).get('/api/v1/public/plans').expect(200)).body.data as {
            branch: { code: string };
            plans: Plan[];
            vat_rate: number;
            vat_inclusive: boolean;
        }[];
        expect(rows.map(r => r.branch.code)).toEqual(['DHA', 'GUL', 'UTT']);
        expect(rows[0]).toMatchObject({ vat_rate: 0.15, vat_inclusive: false });
        expect(rows.every(r => r.plans.every(p => p.sellable))).toBe(true);
        const gul = (await request(t.app).get('/api/v1/public/plans?branch=gulshan').expect(200)).body.data as unknown[];
        expect(gul).toHaveLength(1);
        await request(t.app).get('/api/v1/public/plans?branch=nowhere').expect(404);
    });

    it('a VAT change shows at once (the cached list is cleared)', async () => {
        await request(t.app).get('/api/v1/public/plans').expect(200);
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ vat_inclusive: true }).expect(200);
        expect((await request(t.app).get('/api/v1/public/plans').expect(200)).body.data[0].vat_inclusive).toBe(true);
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ vat_inclusive: false }).expect(200);
    });
});

describe('plans: audit log', () => {
    const audit = (entity: string) =>
        withBranchTx(t.deps.db, systemContext(HQ.oid), tx =>
            tx.query<{ action: string; entity_key: string; before: Record<string, unknown> | null; after: Record<string, unknown> }>(
                sql`select action, entity_key, before, after from audit_log where entity = ${entity} order by created_at`
            )
        );

    it('every write is one audit row at HQ; a refused write is none', async () => {
        const plan = (await deskPlans()).find(p => p.code === 'GUL-GRO-12M')!;
        const n = (await audit('plan')).length;
        await request(t.app).patch(`/api/v1/hq/plans/${plan.oid}`).set(owner).send({ price: 99000 }).expect(200);
        await request(t.app).patch(`/api/v1/hq/plans/${plan.oid}`).set(owner).send({ price: -1 }).expect(400);
        const rows = await audit('plan');
        expect(rows).toHaveLength(n + 1);
        expect(rows.at(-1)).toMatchObject({ action: 'update', entity_key: 'GUL-GRO-12M', before: { price: 100000 }, after: { price: 99000 } });

        const tplN = (await audit('plan_template')).length;
        const tpl = (
            await request(t.app)
                .post('/api/v1/hq/plan-templates')
                .set(owner)
                .send({ tier: 'pt', tier_name: 'PT', period: 'monthly', period_label: 'Monthly', months: 1, base_price: 9000 })
                .expect(201)
        ).body.data as Template;
        await request(t.app).patch(`/api/v1/hq/plan-templates/${tpl.oid}`).set(owner).send({ base_price: 9500 }).expect(200);
        expect((await audit('plan_template')).slice(tplN).map(r => [r.action, r.entity_key])).toEqual([
            ['create', 'pt/monthly'],
            ['update', 'pt/monthly']
        ]);
        await request(t.app).post('/api/v1/hq/plans').set(owner).send({ branch_oid: GUL.oid, template_oid: tpl.oid }).expect(201);
        expect((await audit('plan')).at(-1)).toMatchObject({ action: 'create', entity_key: 'GUL-PT-1M', before: null });

        const promoN = (await audit('promo')).length;
        await request(t.app)
            .post('/api/v1/hq/promos')
            .set(owner)
            .send({ code: 'AUDIT1', label: 'A', amount: 50, valid_from: '2026-01-01', valid_to: '2026-12-31' })
            .expect(201);
        await request(t.app).patch('/api/v1/hq/promos/AUDIT1').set(owner).send({ label: 'B' }).expect(200);
        expect((await audit('promo')).slice(promoN).map(r => r.action)).toEqual(['create', 'update']);
    });
});
