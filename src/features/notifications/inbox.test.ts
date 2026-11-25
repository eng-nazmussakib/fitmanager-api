import request from 'supertest';

import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, portalMember, signIn, stockUp, type TestApp } from '#src/testing/test-app.ts';

const { HQ, GUL, DHA } = DEMO_BRANCHES;
let now = new Date('2026-11-19T06:00:00Z');
let t: TestApp;
let desk: Record<string, string>;
let manager: Record<string, string>;
let managerDha: Record<string, string>;
let hq: Record<string, string>;
let owner: Record<string, string>;
let phone = 0;
const nextPhone = () => `0191300${String(++phone).padStart(4, '0')}`;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    managerDha = atBranch((await signIn(t.app, 'manager.dhanmondi', 'Manager@123')).access_token, DHA.oid);
    hq = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
});
afterAll(() => t.close());

interface Message {
    oid: string;
    kind: string;
    subject: string;
    body: string;
    read_at: string | null;
}
interface Inbox {
    items: (Message & { link: string; from_branch_name: string })[];
    unread: number;
}
const messages = async (me: Record<string, string>) => (await request(t.app).get('/api/v1/me/notifications').set(me).expect(200)).body.data as Message[];
const unread = async (me: Record<string, string>) =>
    (await request(t.app).get('/api/v1/me/notifications/count').set(me).expect(200)).body.data.unread as number;
const inbox = async (who: Record<string, string>) => (await request(t.app).get('/api/v1/inbox').set(who).expect(200)).body.data as Inbox;

describe('members’ messages (d)', () => {
    it('a reply to a complaint, a sanction and the appeal’s decision, each a message; read state and the count', async () => {
        const m = await portalMember(t.app, desk, nextPhone());
        const before = await unread(m.me);

        const c = (
            await request(t.app)
                .post('/api/v1/complaints')
                .set(desk)
                .send({ member_oid: m.oid, category: 'facilities', subject: 'Cold showers', body: 'The showers were cold all week.' })
                .expect(201)
        ).body.data as { oid: string };
        await request(t.app).post(`/api/v1/complaints/${c.oid}/updates`).set(manager).send({ body: 'The boiler is fixed.', status: 'resolved' }).expect(200);

        const incident = (
            await request(t.app)
                .post('/api/v1/incidents')
                .set(manager)
                .send({
                    subject_kind: 'member',
                    member_code: m.code,
                    occurred_at: '2026-11-19T10:00:00+06:00',
                    category: 'conduct',
                    summary: 'Shouting',
                    description: 'Shouted at the desk'
                })
                .expect(201)
        ).body.data as { oid: string };
        const step = (
            await request(t.app).post(`/api/v1/incidents/${incident.oid}/sanctions`).set(manager).send({ level: 'verbal', reason: 'Shouting' }).expect(201)
        ).body.data as { sanctions: { oid: string }[] };

        const list = await messages(m.me);
        const reply = list.find(x => x.kind === 'complaint_reply');
        expect(reply).toMatchObject({ subject: 'Resolved: Cold showers', read_at: null });
        expect(reply?.body).toContain('The boiler is fixed.');
        const sanction = list.find(x => x.kind === 'sanction');
        expect(sanction?.subject).toBe('Verbal warning at Gulshan');
        expect(sanction?.body).toContain('You can appeal under My record in the portal by 26 Nov 2026');
        expect(await unread(m.me)).toBe(before + 2);

        // The appeal goes to whoever decides it (the manager gave it: HQ); the decision is a message to the member.
        await request(t.app)
            .post(`/api/v1/me/record/${step.sanctions[0]!.oid}/appeal`)
            .set(m.me)
            .send({ body: 'I only asked loudly about my locker.' })
            .expect(201);
        expect((await inbox(manager)).items.some(x => x.kind === 'appeal_filed')).toBe(false);
        const appeal = (await inbox(hq)).items.find(x => x.kind === 'appeal_filed' && x.link === `incidents/${incident.oid}`);
        expect(appeal).toMatchObject({ from_branch_name: 'Gulshan', read_at: null });
        const viewed = (await request(t.app).get(`/api/v1/incidents/${incident.oid}`).set(owner).expect(200)).body.data as {
            sanctions: { appeal: { oid: string } }[];
        };
        await request(t.app)
            .post(`/api/v1/appeals/${viewed.sanctions[0]!.appeal.oid}/decide`)
            .set(owner)
            .send({ decision: 'rejected', note: 'The desk log shows it.' })
            .expect(200);
        expect((await messages(m.me)).find(x => x.kind === 'appeal_decided')).toMatchObject({ subject: 'Your appeal was not upheld' });

        // Read one, then the rest; another member's message cannot be marked.
        const other = await portalMember(t.app, desk, nextPhone());
        const theirs = (await messages(other.me))[0]!;
        const left = (
            await request(t.app)
                .post('/api/v1/me/notifications/read')
                .set(m.me)
                .send({ oids: [reply!.oid, theirs.oid] })
                .expect(200)
        ).body.data.unread;
        expect(left).toBe(await unread(m.me));
        expect((await messages(m.me)).find(x => x.oid === reply!.oid)?.read_at).toBe(now.toISOString());
        expect((await messages(other.me)).find(x => x.oid === theirs.oid)?.read_at).toBeNull();
        expect((await request(t.app).post('/api/v1/me/notifications/read').set(m.me).send({}).expect(200)).body.data.unread).toBe(0);
        await request(t.app)
            .post('/api/v1/me/notifications/read')
            .set(m.me)
            .send({ oids: ['nope'] })
            .expect(400);

        // Kept 180 days once read; unread ones stay listed.
        const all = (await messages(m.me)).length;
        now = new Date('2027-05-20T06:00:00Z');
        const later = await messages(m.me);
        expect(later.filter(x => x.kind === 'complaint_reply' || x.kind === 'sanction')).toEqual([]);
        expect(later.length).toBeLessThan(all);
        now = new Date('2026-11-19T06:00:00Z');
    });

    it('a shop sale to a member is a receipt with what they bought; staff cannot read the member count', async () => {
        await stockUp(t.app, manager, hq, [{ code: 'PRD-000005', qty: 5, unit_cost: 110 }]);
        const bar = ((await request(t.app).get('/api/v1/pos/products').set(desk).expect(200)).body.data as { oid: string; code: string }[]).find(
            p => p.code === 'PRD-000005'
        )!.oid;
        const m = await portalMember(t.app, desk, nextPhone());
        const sale = (
            await request(t.app)
                .post('/api/v1/pos/sales')
                .set(desk)
                .send({ member_oid: m.oid, lines: [{ product_oid: bar, qty: 1 }], payment: { method: 'cash', amount: 207 } })
                .expect(201)
        ).body.data as { invoice: { number: string } };
        const shop = (await messages(m.me)).find(x => x.kind === 'shop_receipt');
        expect(shop?.subject).toBe(`Shop receipt ${sale.invoice.number}`);
        expect(shop?.body).toMatch(/Total ৳207, paid ৳207\.$/);
        await request(t.app).get('/api/v1/me/notifications/count').set(desk).expect(403);
    });
});

describe('the staff inbox', () => {
    it('an order goes to HQ, its decision to the branch; a transfer to the branch asked; each sees only its own', async () => {
        const products = (await request(t.app).get('/api/v1/products').set(manager).expect(200)).body.data as { oid: string; code: string }[];
        const suppliers = (await request(t.app).get('/api/v1/suppliers').set(manager).expect(200)).body.data as { oid: string }[];
        const hqBefore = (await inbox(hq)).unread;
        const po = (
            await request(t.app)
                .post('/api/v1/purchase-orders')
                .set(manager)
                .send({ supplier_oid: suppliers[0]?.oid, lines: [{ product_oid: products[0]?.oid, qty: 3, unit_cost: 100 }] })
                .expect(201)
        ).body.data as { oid: string; code: string };
        const atHq = await inbox(hq);
        expect(atHq.unread).toBe(hqBefore + 1);
        expect(atHq.items.find(x => x.subject.includes(po.code))).toMatchObject({
            kind: 'po_submitted',
            link: 'purchase-orders',
            subject: `Gulshan: ${po.code} waits for approval`,
            read_at: null
        });
        expect((await request(t.app).get('/api/v1/inbox/count').set(hq).expect(200)).body.data.unread).toBe(atHq.unread);
        // The branch's inbox is the branch's: not HQ's messages; the desk has no order permission.
        expect((await inbox(manager)).items.some(x => x.kind === 'po_submitted')).toBe(false);

        await request(t.app).post(`/api/v1/hq/purchase-orders/${po.oid}/reject`).set(hq).send({ note: 'Too many bars already' }).expect(200);
        const gul = await inbox(manager);
        expect(gul.items.find(x => x.kind === 'po_rejected')).toMatchObject({
            subject: `${po.code} rejected`,
            link: 'stock?tab=orders',
            from_branch_name: 'Head office'
        });
        expect((await inbox(desk)).items.some(x => x.kind === 'po_rejected')).toBe(false);
        expect((await inbox(managerDha)).items.some(x => x.kind === 'po_rejected')).toBe(false);

        const trf = (
            await request(t.app)
                .post('/api/v1/transfers')
                .set(manager)
                .send({ from_branch_oid: DHA.oid, lines: [{ product_oid: products[0]?.oid, qty: 1 }] })
                .expect(201)
        ).body.data as { oid: string; code: string };
        expect((await inbox(managerDha)).items.find(x => x.kind === 'transfer_requested')).toMatchObject({
            kind: 'transfer_requested',
            subject: `Gulshan asks for stock: ${trf.code}`
        });
        await request(t.app).post(`/api/v1/transfers/${trf.oid}/reject`).set(managerDha).send({ note: 'None to spare' }).expect(200);
        expect((await inbox(manager)).items.find(x => x.kind === 'transfer_rejected')).toMatchObject({
            kind: 'transfer_rejected',
            body: `Dhanmondi cannot send ${trf.code}: None to spare`
        });

        // Read: one, then all; per person (the owner at HQ still has HQ's unread).
        const first = atHq.items.find(x => x.subject.includes(po.code))!;
        const left = (
            await request(t.app)
                .post('/api/v1/inbox/read')
                .set(hq)
                .send({ oids: [first.oid] })
                .expect(200)
        ).body.data.unread as number;
        expect(left).toBe(atHq.unread - 1);
        expect((await inbox(hq)).items.find(x => x.oid === first.oid)?.read_at).toBe(now.toISOString());
        expect((await inbox(owner)).items.find(x => x.oid === first.oid)?.read_at).toBeNull();
        expect((await request(t.app).post('/api/v1/inbox/read').set(hq).send({}).expect(200)).body.data.unread).toBe(0);
    });

    it('an urgent ticket, raised or made urgent later, is in the branch’s inbox once; a member escalation goes to the branch and HQ', async () => {
        const kit = (await request(t.app).post('/api/v1/equipment').set(manager).send({ name: 'Inbox rower', category: 'cardio' }).expect(201)).body.data as {
            oid: string;
        };
        await request(t.app)
            .post(`/api/v1/equipment/${kit.oid}/tickets`)
            .set(desk)
            .send({ description: 'Seat cracked', priority: 'urgent', out_of_order: true })
            .expect(201);
        const ticket = (await request(t.app).post(`/api/v1/equipment/${kit.oid}/tickets`).set(desk).send({ description: 'Belt slips' }).expect(201)).body
            .data as { oid: string };
        let urgent = (await inbox(manager)).items.filter(x => x.kind === 'ticket_urgent' && x.subject.startsWith('Urgent: Inbox rower'));
        expect(urgent).toHaveLength(1);
        expect(urgent[0]?.body).toContain('and took it out of use: Seat cracked');
        await request(t.app).patch(`/api/v1/equipment-tickets/${ticket.oid}`).set(manager).send({ priority: 'urgent' }).expect(200);
        await request(t.app).patch(`/api/v1/equipment-tickets/${ticket.oid}`).set(manager).send({ technician: 'Rahim' }).expect(200);
        urgent = (await inbox(manager)).items.filter(x => x.kind === 'ticket_urgent' && x.subject.startsWith('Urgent: Inbox rower'));
        expect(urgent).toHaveLength(2);

        const m = await portalMember(t.app, desk, nextPhone());
        const c = (
            await request(t.app)
                .post('/api/v1/me/complaints')
                .set(m.me)
                .send({ category: 'cleanliness', subject: 'Dusty mats', body: 'The yoga mats are dusty every morning.' })
                .expect(201)
        ).body.data as { oid: string; code: string };
        await request(t.app).post(`/api/v1/complaints/${c.oid}/updates`).set(manager).send({ body: 'Cleaned.', status: 'resolved' }).expect(200);
        await request(t.app).post(`/api/v1/me/complaints/${c.oid}/escalate`).set(m.me).send({ reason: 'Still dusty the next day.' }).expect(200);
        for (const who of [manager, hq])
            expect((await inbox(who)).items.find(x => x.kind === 'complaint_escalated' && x.link === `complaints?open=${c.oid}`)?.body).toBe(
                `Portal Member escalated complaint ${c.code} at Gulshan: Still dusty the next day.`
            );
    });
});
