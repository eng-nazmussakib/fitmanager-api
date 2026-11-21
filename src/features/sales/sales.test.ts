import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, suspendMember, type TestApp } from '#src/testing/test-app.ts';

const { GUL, DHA } = DEMO_BRANCHES;
let now = new Date('2026-11-19T06:00:00Z'); // 12:00 in Dhaka
let t: TestApp;
let desk: Record<string, string>;
let manager: Record<string, string>;
let deskDha: Record<string, string>;
let plans: { oid: string; code: string; price: number; admission_fee: number; months: number; name: string }[];

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    deskDha = atBranch((await signIn(t.app, 'desk.dhanmondi', 'Desk@123')).access_token, DHA.oid);
    plans = (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data;
});
afterAll(() => t.close());

const plan = (code: string) => {
    const p = plans.find(x => x.code === code);
    if (!p) throw new Error(`no plan ${code}`);
    return p;
};

let phoneSeq = 0;
async function member(headers = desk) {
    const phone = `0181${String(10_000_000 + ++phoneSeq).slice(1)}`;
    const res = await request(t.app)
        .post('/api/v1/members')
        .set(headers)
        .send({ name: 'Sales Tester', phone, gender: 'Male', email: 's@example.com', health_flags: [], health_declared: true });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.data as { oid: string; code: string };
}

interface SaleOut {
    subscription: { oid: string; status: string; start_date: string; end_date: string; plan_name: string; due: number };
    invoice: {
        oid: string;
        number: string;
        total: number;
        paid: number;
        due: number;
        status: string;
        vat: number;
        lines: { label: string; amount: number }[];
        payments: unknown[];
    };
}
async function sale(memberOid: string, body: Record<string, unknown> = {}, headers = desk, status = 201): Promise<SaleOut & { message: string }> {
    const res = await request(t.app)
        .post('/api/v1/subscriptions')
        .set(headers)
        .send({ member_oid: memberOid, plan_oid: plan('GUL-SIN-1M').oid, charge_admission: true, payment: { method: 'cash', amount: 0 }, ...body });
    if (res.status !== status) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    return { ...(res.body.data as SaleOut), message: res.body.message as string };
}

describe('quote and sale (D-057, D-061)', () => {
    it('the quote is the server’s: plan + admission + 15 % VAT, and says whether admission is due', async () => {
        const m = await member();
        const p = plan('GUL-SIN-1M');
        const res = await request(t.app)
            .post('/api/v1/subscriptions/quote')
            .set(desk)
            .send({ member_oid: m.oid, plan_oid: p.oid, charge_admission: true })
            .expect(200);
        const subtotal = p.price + p.admission_fee;
        expect(res.body.data).toMatchObject({
            subtotal,
            vat: Math.round(subtotal * 0.15),
            total: subtotal + Math.round(subtotal * 0.15),
            admission_suggested: true,
            start_date: '2026-11-19',
            end_date: '2026-12-18'
        });
    });

    it('a sale: invoice numbered per branch and year, the member becomes Active, a partial payment leaves dues', async () => {
        const m = await member();
        const out = await sale(m.oid, { payment: { method: 'bkash', amount: 1000, reference: 'TX123' } });
        expect(out.invoice.number).toMatch(/^INV-GUL-2026-\d{5}$/);
        expect(out.invoice).toMatchObject({ paid: 1000, status: 'Partial', due: out.invoice.total - 1000 });
        expect(out.subscription).toMatchObject({ status: 'Active', start_date: '2026-11-19', end_date: '2026-12-18' });
        expect(out.message).toBe(`Membership sold. ৳${out.invoice.due.toLocaleString('en-IN')} recorded as dues.`);
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data).toMatchObject({
            status: 'Active',
            dues: out.invoice.due,
            plan_name: 'Single · Monthly'
        });
        const second = await sale((await member()).oid);
        expect(Number(second.invoice.number.slice(-5)) - Number(out.invoice.number.slice(-5))).toBe(1);
        await sale((await member(deskDha)).oid, { plan_oid: plans[0]?.oid }, deskDha, 404); // a Gulshan plan is not sold at Dhanmondi
    });

    it('refuses: a bkash payment without a reference, more than the total, an overlap, a start too far back, a suspended member', async () => {
        const m = await member();
        await sale(m.oid, { payment: { method: 'bkash', amount: 100 } }, desk, 400);
        await sale(m.oid, { payment: { method: 'cash', amount: 999_999 } }, desk, 400);
        await sale(m.oid, { start_date: '2026-11-01' }, desk, 400);
        await sale(m.oid);
        const overlap = await request(t.app)
            .post('/api/v1/subscriptions')
            .set(desk)
            .send({ member_oid: m.oid, plan_oid: plan('GUL-SIN-1M').oid, start_date: '2026-12-01' })
            .expect(409);
        expect(overlap.body.message).toMatch(/^This overlaps the Single · Monthly plan that runs until 18 Dec 2026/);
        await sale(m.oid, { start_date: '2026-12-19', charge_admission: false });
        const s = await member();
        await suspendMember(t.app, manager, (s as { code: string }).code, { today: '2026-11-19', now: '2026-11-19T11:00:00+06:00' });
        await sale(s.oid, {}, desk, 409);
    });

    it('discounts above 20 % need a manager; a promo code does not; a bad code is refused', async () => {
        const m = await member();
        await sale(m.oid, { discount: { kind: 'percent', value: 25 } }, desk, 403);
        const mine = await sale(m.oid, { discount: { kind: 'percent', value: 25 } }, manager);
        expect(mine.invoice.lines.at(-1)).toEqual({ label: 'Discount (25%)', amount: -Math.round(plan('GUL-SIN-1M').price * 0.25) });
        const n = await member();
        await sale(n.oid, { discount: { kind: 'promo', value: 0, code: 'nosuch' } }, desk, 400);
        const promo = await sale(n.oid, { discount: { kind: 'promo', value: 0, code: 'noadmission' } });
        expect(promo.invoice.lines.map(l => l.label)).toEqual(['Single · Monthly']);
    });

    it('VAT-inclusive (D-057): the total is the price, the VAT is inside it; the invoice keeps the mode', async () => {
        const owner = atBranch((await signIn(t.app)).access_token, DEMO_BRANCHES.HQ.oid);
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ vat_inclusive: true }).expect(200);
        const m = await member();
        const out = await sale(m.oid, { charge_admission: false });
        const price = plan('GUL-SIN-1M').price;
        expect(out.invoice).toMatchObject({ total: price, vat: Math.round((price * 0.15) / 1.15) });
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ vat_inclusive: false }).expect(200);
        expect((await request(t.app).get(`/api/v1/invoices/${out.invoice.oid}`).set(desk).expect(200)).body.data).toMatchObject({
            vat_inclusive: true,
            total: price
        });
    });
});

describe('dues and payments', () => {
    it('pay towards dues until paid; never more than due; another branch cannot pay it', async () => {
        const m = await member();
        const out = await sale(m.oid, { payment: { method: 'cash', amount: 500 } });
        await request(t.app)
            .post('/api/v1/payments')
            .set(desk)
            .send({ invoice_oid: out.invoice.oid, method: 'cash', amount: out.invoice.due + 1 })
            .expect(400);
        await request(t.app).post('/api/v1/payments').set(deskDha).send({ invoice_oid: out.invoice.oid, method: 'cash', amount: 100 }).expect(404);
        const paid = await request(t.app)
            .post('/api/v1/payments')
            .set(desk)
            .send({ invoice_oid: out.invoice.oid, method: 'card', amount: out.invoice.due, reference: 'POS-1' })
            .expect(200);
        expect(paid.body.data).toMatchObject({ status: 'Paid', due: 0, paid: out.invoice.total });
        await request(t.app).post('/api/v1/payments').set(desk).send({ invoice_oid: out.invoice.oid, method: 'cash', amount: 1 }).expect(409);
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data.dues).toBe(0);
    });

    it('money rows are append-only, even for the database owner', async () => {
        const m = await member();
        const out = await sale(m.oid, { payment: { method: 'cash', amount: 100 } });
        await expect(
            withBranchTx(t.deps.db, systemContext(GUL.oid), tx => tx.query(sql`update payment set amount = 1 where invoice_oid = ${out.invoice.oid}`))
        ).rejects.toThrow(/never changed/);
        await expect(withBranchTx(t.deps.db, systemContext(GUL.oid), tx => tx.query(sql`delete from invoice where oid = ${out.invoice.oid}`))).rejects.toThrow(
            /never changed/
        );
    });
});

describe('freeze, cancel, upgrade (D-063, D-067)', () => {
    it('freeze: a manager, within the HQ range, at most twice, moves the end date', async () => {
        const m = await member();
        const out = await sale(m.oid);
        const freeze = (body: object, headers = manager) => request(t.app).post(`/api/v1/subscriptions/${out.subscription.oid}/freeze`).set(headers).send(body);
        await freeze({ days: 10, reason: 'Travel' }, desk).expect(403);
        await freeze({ days: 5, reason: 'Travel' }).expect(400);
        await freeze({ days: 61, reason: 'Travel' }).expect(400);
        await freeze({ days: 10, reason: 'Travel', from: '2026-11-18' }).expect(400);
        const first = await freeze({ days: 10, reason: 'Travel', from: '2026-11-25' }).expect(200);
        expect(first.body).toMatchObject({ message: 'Frozen until 4 Dec 2026; the plan now ends 28 Dec 2026', data: { end_date: '2026-12-28' } });
        await freeze({ days: 7, reason: 'Overlap', from: '2026-11-30' }).expect(409);
        await freeze({ days: 7, reason: 'Again', from: '2026-12-10' }).expect(200);
        await freeze({ days: 7, reason: 'Third', from: '2026-12-20' }).expect(409);
    });

    it('freeze: a plan whose template is not freezable cannot be frozen', async () => {
        const owner = atBranch((await signIn(t.app)).access_token, DEMO_BRANCHES.HQ.oid);
        const templates = (await request(t.app).get('/api/v1/hq/plan-templates').set(owner).expect(200)).body.data as {
            oid: string;
            tier: string;
            months: number;
        }[];
        const tpl = templates.find(x => x.tier === 'duo' && x.months === 1);
        await request(t.app).patch(`/api/v1/hq/plan-templates/${tpl?.oid}`).set(owner).send({ freezable: false }).expect(200);
        const m = await member();
        const out = await sale(m.oid, { plan_oid: plan('GUL-DUO-1M').oid });
        await request(t.app).post(`/api/v1/subscriptions/${out.subscription.oid}/freeze`).set(manager).send({ days: 10, reason: 'Travel' }).expect(409);
        await request(t.app).patch(`/api/v1/hq/plan-templates/${tpl?.oid}`).set(owner).send({ freezable: true }).expect(200);
    });

    it('cancel: the plan ends, the member is Expired, the money stays', async () => {
        const m = await member();
        const out = await sale(m.oid, { payment: { method: 'cash', amount: 500 } });
        await request(t.app).post(`/api/v1/subscriptions/${out.subscription.oid}/cancel`).set(desk).send({ reason: 'Moving away' }).expect(403);
        const res = await request(t.app).post(`/api/v1/subscriptions/${out.subscription.oid}/cancel`).set(manager).send({ reason: 'Moving away' }).expect(200);
        expect(res.body.data).toMatchObject({ status: 'Cancelled', cancel_reason: 'Moving away' });
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data).toMatchObject({ status: 'Expired' });
        expect((await request(t.app).get(`/api/v1/invoices/${out.invoice.oid}`).set(desk).expect(200)).body.data).toMatchObject({ paid: 500 });
        await request(t.app).post(`/api/v1/subscriptions/${out.subscription.oid}/cancel`).set(manager).send({ reason: 'Again' }).expect(409);
    });

    it('upgrade: same or higher price only, starts today, credits the unused paid days pro rata', async () => {
        const m = await member();
        now = new Date('2026-11-01T06:00:00Z');
        const p = plan('GUL-SIN-1M');
        const out = await sale(m.oid, { charge_admission: false, start_date: '2026-11-01', payment: { method: 'cash', amount: 0 } });
        await request(t.app).post('/api/v1/payments').set(desk).send({ invoice_oid: out.invoice.oid, method: 'cash', amount: out.invoice.total }).expect(200);
        now = new Date('2026-11-16T06:00:00Z'); // day 16 of 30: 15 days unused
        const down = plans.find(x => x.price < p.price);
        if (down) await request(t.app).post(`/api/v1/subscriptions/${out.subscription.oid}/upgrade`).set(manager).send({ plan_oid: down.oid }).expect(409);
        const up = plan('GUL-SIN-3M');
        const res = await request(t.app).post(`/api/v1/subscriptions/${out.subscription.oid}/upgrade`).set(manager).send({ plan_oid: up.oid }).expect(201);
        const credit = Math.round((out.invoice.total * 15) / 30);
        expect(res.body.data).toMatchObject({ credit, subscription: { start_date: '2026-11-16', status: 'Active', plan_name: up.name } });
        expect(res.body.data.invoice.lines).toEqual([
            { label: up.name, amount: up.price },
            { label: `Credit: 15 unused days of ${p.name}`, amount: -credit }
        ]);
        const subs = (await request(t.app).get(`/api/v1/members/${m.oid}/subscriptions`).set(desk).expect(200)).body.data as {
            status: string;
            end_date: string;
        }[];
        expect(subs.map(s => [s.status, s.end_date])).toEqual([
            ['Active', '2027-02-15'],
            ['Upgraded', '2026-11-15']
        ]);
        now = new Date('2026-11-19T06:00:00Z');
    });
});

describe('refunds (D-067 a)', () => {
    it('the desk: a full refund within 3 days, not yet used; it ends the plan', async () => {
        const m = await member();
        const out = await sale(m.oid, { payment: { method: 'cash', amount: 3000 } });
        await request(t.app).post(`/api/v1/invoices/${out.invoice.oid}/refund`).set(desk).send({ amount: 1000, reason: 'Changed mind' }).expect(403);
        const res = await request(t.app).post(`/api/v1/invoices/${out.invoice.oid}/refund`).set(desk).send({ reason: 'Changed mind' }).expect(200);
        expect(res.body.data).toMatchObject({ status: 'Refunded', paid: 0, refunded: 3000 });
        // The plan was taken back: the unpaid rest of a part-paid invoice is not owed either.
        expect(res.body.data).toMatchObject({ due: 0 });
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data).toMatchObject({ status: 'Expired', dues: 0 });
        await request(t.app).post(`/api/v1/invoices/${out.invoice.oid}/refund`).set(desk).send({ reason: 'Again' }).expect(409);
        await request(t.app).post('/api/v1/payments').set(desk).send({ invoice_oid: out.invoice.oid, method: 'cash', amount: 100 }).expect(409);
    });

    it('a manager: a partial refund at any time, never more than was paid', async () => {
        const m = await member();
        const out = await sale(m.oid, { payment: { method: 'cash', amount: 2000 } });
        now = new Date('2026-11-29T06:00:00Z');
        await request(t.app).post(`/api/v1/invoices/${out.invoice.oid}/refund`).set(desk).send({ reason: 'Late' }).expect(403);
        await request(t.app).post(`/api/v1/invoices/${out.invoice.oid}/refund`).set(manager).send({ amount: 2001, reason: 'Too much' }).expect(400);
        const res = await request(t.app)
            .post(`/api/v1/invoices/${out.invoice.oid}/refund`)
            .set(manager)
            .send({ amount: 500, method: 'bkash', reason: 'Goodwill' })
            .expect(200);
        // The refund is not added to what is owed: only what was never paid.
        expect(res.body.data).toMatchObject({ paid: 1500, refunded: 500, status: 'Partial', due: out.invoice.total - 2000 });
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data).toMatchObject({
            status: 'Active',
            dues: out.invoice.total - 2000
        });
        now = new Date('2026-11-19T06:00:00Z');
    });

    it('a partial refund of a paid invoice leaves it paid, with no dues; the payments list shows it', async () => {
        const m = await member();
        const inv = (await sale(m.oid)).invoice as { oid: string; total: number; number: string };
        await request(t.app)
            .post('/api/v1/payments')
            .set(desk)
            .send({ invoice_oid: inv.oid, method: 'card', amount: inv.total, reference: 'POS-1' })
            .expect(200);
        const res = await request(t.app)
            .post(`/api/v1/invoices/${inv.oid}/refund`)
            .set(manager)
            .send({ amount: 700, method: 'bkash', reference: 'BKR-1', reason: 'Goodwill' })
            .expect(200);
        expect(res.body.data).toMatchObject({ status: 'Paid', due: 0, refunded: 700, paid: inv.total - 700 });
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data).toMatchObject({ dues: 0 });
        const list = (await request(t.app).get('/api/v1/payments').set(desk).expect(200)).body.data as {
            payments: { kind: string; amount: number; invoice_number: string }[];
        };
        expect(list.payments.find(x => x.kind === 'refund' && x.invoice_number === inv.number)).toMatchObject({ amount: 700 });
    });
});

describe('cash closing and the exit check', () => {
    it('today by method and staff, refunds counted against; each staff member closes once', async () => {
        const fresh = await createTestApp({}, { clock: () => new Date('2026-11-20T06:00:00Z') });
        const d = atBranch((await signIn(fresh.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
        const mres = await request(fresh.app)
            .post('/api/v1/members')
            .set(d)
            .send({ name: 'Cash Count', phone: '01911111111', gender: 'Male', health_flags: [], health_declared: true })
            .expect(201);
        const p = ((await request(fresh.app).get('/api/v1/plans').set(d).expect(200)).body.data as { oid: string; code: string }[]).find(
            x => x.code === 'GUL-SIN-1M'
        );
        const out = await request(fresh.app)
            .post('/api/v1/subscriptions')
            .set(d)
            .send({ member_oid: mres.body.data.oid, plan_oid: p?.oid, charge_admission: true, payment: { method: 'cash', amount: 2000 } })
            .expect(201);
        await request(fresh.app)
            .post('/api/v1/payments')
            .set(d)
            .send({ invoice_oid: out.body.data.invoice.oid, method: 'nagad', amount: 300, reference: 'N1' })
            .expect(200);
        await request(fresh.app)
            .post(`/api/v1/invoices/${out.body.data.invoice.oid}/refund`)
            .set(d)
            .send({ amount: 2300, method: 'cash', reason: 'Refund all' })
            .expect(200);
        const day = (await request(fresh.app).get('/api/v1/cash-closing/today').set(d).expect(200)).body.data;
        expect(day).toMatchObject({
            date: '2026-11-20',
            total: 0,
            invoices: 1,
            new_members: 1,
            renewals: 0,
            by_staff: [{ name: 'Lamia Haque', cash: -300, total: 0, closed: null }]
        });
        expect((day.by_method as { method: string }[]).find(x => x.method === 'nagad')).toEqual({ method: 'nagad', count: 1, amount: 300 });
        const closed = await request(fresh.app)
            .post('/api/v1/cash-closing')
            .set(d)
            .send({ counted_cash: 0, note: 'Gave back 300 more than taken' })
            .expect(201);
        expect(closed.body.data).toMatchObject({ expected_cash: -300, counted_cash: 0, difference: 300 });
        await request(fresh.app).post('/api/v1/cash-closing').set(d).send({ counted_cash: 0 }).expect(409);
        await fresh.close();
    });

    it('reconciles: every invoice’s paid amount is its payments minus refunds', async () => {
        const rows = await withBranchTx(t.deps.db, systemContext(GUL.oid, [GUL.oid, DHA.oid]), tx =>
            tx.query<{ bad: number }>(sql`
                select count(*)::int as bad from invoice i
                where i.total < 0 or coalesce((select sum(case when p.kind = 'payment' then p.amount else -p.amount end) from payment p where p.invoice_oid = i.oid), 0) not between 0 and i.total`)
        );
        expect(rows[0]?.bad).toBe(0);
    });
});

describe('sales: audit log', () => {
    it('sale, payment, freeze, cancel, upgrade and refund each write a row', async () => {
        const actions = async () =>
            (
                await withBranchTx(t.deps.db, systemContext(GUL.oid), tx =>
                    tx.query<{ action: string; entity: string }>(
                        sql`select action, entity from audit_log where entity in ('subscription', 'invoice', 'cash_closing')`
                    )
                )
            ).map(r => `${r.entity}:${r.action}`);
        expect(new Set(await actions())).toEqual(
            new Set(['subscription:create', 'invoice:pay', 'subscription:freeze', 'subscription:cancel', 'subscription:upgrade', 'invoice:refund'])
        );
    });
});
