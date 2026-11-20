import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, DHA, HQ } = DEMO_BRANCHES;
/** Thursday 19 Nov 2026, 12:00 in Dhaka. */
const NOON = new Date('2026-11-19T06:00:00Z');
let now = NOON;
let t: TestApp;
let desk: Record<string, string>;
let manager: Record<string, string>;
let trainer: Record<string, string>;
let managerDha: Record<string, string>;
let owner: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
    managerDha = atBranch((await signIn(t.app, 'manager.dhanmondi', 'Manager@123')).access_token, DHA.oid);
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
});
afterAll(() => t.close());
afterEach(() => {
    now = NOON;
});

interface Trainer {
    oid: string;
    name: string;
    slug: string;
    phone: string | null;
    headline: string | null;
    clients: number;
    photo_url: string | null;
}

let phoneSeq = 0;
const plans = async () => (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
async function member(opts: { membership?: boolean; pt?: string | null } = {}) {
    const phone = `0171${String(20_000_000 + ++phoneSeq).slice(1)}`;
    const m = (
        await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send({ name: `PT Tester ${phoneSeq}`, phone, gender: 'Male', email: 'pt@example.com', health_flags: [], health_declared: true })
            .expect(201)
    ).body.data as { oid: string; code: string; name: string };
    const list = await plans();
    if (opts.membership !== false)
        await request(t.app)
            .post('/api/v1/subscriptions')
            .set(desk)
            .send({
                member_oid: m.oid,
                plan_oid: list.find(p => p.code === 'GUL-SIN-1M')?.oid,
                charge_admission: false,
                payment: { method: 'cash', amount: 0 }
            })
            .expect(201);
    if (opts.pt !== null && opts.membership !== false)
        await request(t.app)
            .post('/api/v1/subscriptions')
            .set(desk)
            .send({
                member_oid: m.oid,
                plan_oid: list.find(p => p.code === (opts.pt ?? 'GUL-PT-8'))?.oid,
                charge_admission: false,
                payment: { method: 'cash', amount: 0 }
            })
            .expect(201);
    return m;
}
const trainers = async (h = desk) => (await request(t.app).get('/api/v1/trainers').set(h).expect(200)).body.data as Trainer[];
const sam = async () => (await trainers()).find(x => x.slug === 'sam-cole')!;
const tom = async () => (await trainers()).find(x => x.slug === 'tom-blake')!;

describe('PT packages (D-079)', () => {
    it('a PT package goes with a membership, never on the public price list, and shows its sessions', async () => {
        const list = await plans();
        const none = await member({ membership: false, pt: null });
        const refused = await request(t.app)
            .post('/api/v1/subscriptions')
            .set(desk)
            .send({
                member_oid: none.oid,
                plan_oid: list.find(p => p.code === 'GUL-PT-8')?.oid,
                charge_admission: false,
                payment: { method: 'cash', amount: 0 }
            })
            .expect(409);
        expect(refused.body.message).toBe('A PT package goes with a membership. Sell the membership first.');
        const m = await member();
        const subs = (await request(t.app).get(`/api/v1/members/${m.oid}/subscriptions`).set(desk).expect(200)).body.data as Record<string, unknown>[];
        expect(subs.map(s => [s['kind'], s['sessions'], s['sessions_left']])).toEqual(
            expect.arrayContaining([
                ['membership', null, null],
                ['pt', 8, 8]
            ])
        );
        // The member's status still comes from the membership alone.
        expect((await request(t.app).get(`/api/v1/members/${m.oid}`).set(desk).expect(200)).body.data).toMatchObject({
            status: 'Active',
            plan_name: 'Single · Monthly'
        });
        const pub = (await request(t.app).get('/api/v1/public/plans?branch=gulshan').expect(200)).body.data as { plans: { kind: string }[] }[];
        expect(pub[0]!.plans.every(p => p.kind === 'membership')).toBe(true);
    });
});

describe('PT sessions (D-079)', () => {
    it('free slots follow availability, the hours, classes and other sessions', async () => {
        const s = await sam();
        const slots = (await request(t.app).get(`/api/v1/pt/slots?trainer_oid=${s.oid}&date=2026-11-19`).set(desk).expect(200)).body.data as {
            slots: string[];
        };
        // Thursday after noon: 16:00–21:00, less his Strength circuit at 19:30–20:20 (an hour from 20:30 would end after 21:00).
        expect(slots.slots).toEqual(['16:00', '16:30', '17:00', '17:30', '18:00', '18:30']);
        const friday = (await request(t.app).get(`/api/v1/pt/slots?trainer_oid=${s.oid}&date=2026-11-20`).set(desk).expect(200)).body.data as {
            slots: string[];
        };
        expect(friday.slots).toEqual([]); // no availability on Fridays
    });

    it('books a credit, refuses a taken slot, gives the credit back for a trainer’s cancel, keeps it for a late one', async () => {
        const s = await sam();
        const m = await member();
        const booked = await request(t.app)
            .post('/api/v1/pt/sessions')
            .set(desk)
            .send({ member_oid: m.oid, trainer_oid: s.oid, date: '2026-11-21', start_time: '08:00' })
            .expect(201);
        expect(booked.body.data).toMatchObject({ status: 'Booked', trainer_name: 'Sam Cole', starts_at: '2026-11-21T08:00:00+06:00', charged: true });
        const other = await member();
        expect(
            (
                await request(t.app)
                    .post('/api/v1/pt/sessions')
                    .set(desk)
                    .send({ member_oid: other.oid, trainer_oid: s.oid, date: '2026-11-21', start_time: '08:30' })
                    .expect(409)
            ).body.message
        ).toBe('Sam Cole is not free at 8:30 am on 21 Nov 2026. Pick one of the free times.');
        const pt = async () =>
            (await request(t.app).get(`/api/v1/members/${m.oid}/pt`).set(desk).expect(200)).body.data as {
                packages: { left: number }[];
                upcoming: { oid: string }[];
            };
        expect((await pt()).packages[0]!.left).toBe(7);
        const msg = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ subject: string }>(sql`select subject from notification where member_oid = ${m.oid} and kind = 'pt_booked'`)
        );
        expect(msg).toEqual([{ subject: 'PT with Sam Cole on 21 Nov 2026' }]);
        await request(t.app).post(`/api/v1/pt/sessions/${booked.body.data.oid}/cancel`).set(trainer).send({ by: 'trainer', reason: 'Called away' }).expect(200);
        expect((await pt()).packages[0]!.left).toBe(8);
        // A member's cancel inside the 2 hours uses the session.
        const second = await request(t.app)
            .post('/api/v1/pt/sessions')
            .set(desk)
            .send({ member_oid: m.oid, trainer_oid: s.oid, date: '2026-11-19', start_time: '16:00' })
            .expect(201);
        now = new Date('2026-11-19T09:00:00Z'); // 15:00
        const late = await request(t.app)
            .post(`/api/v1/pt/sessions/${second.body.data.oid}/cancel`)
            .set(desk)
            .send({ by: 'member', reason: 'Stuck in traffic' })
            .expect(200);
        expect(late.body.message).toBe('Cancelled less than 2 hours before: the session is used.');
        expect((await pt()).packages[0]!.left).toBe(7);
    });

    it('a trainer books and marks only their own sessions; sessions left Booked complete when read', async () => {
        const m = await member();
        const theirs = await request(t.app)
            .post('/api/v1/pt/sessions')
            .set(trainer)
            .send({ member_oid: m.oid, trainer_oid: (await tom()).oid, date: '2026-11-21', start_time: '09:00' })
            .expect(403);
        expect(theirs.body.message).toBe('Trainers book only their own sessions');
        const mine = await request(t.app)
            .post('/api/v1/pt/sessions')
            .set(trainer)
            .send({ member_oid: m.oid, trainer_oid: (await sam()).oid, date: '2026-11-19', start_time: '17:00' })
            .expect(201);
        await request(t.app).post(`/api/v1/pt/sessions/${mine.body.data.oid}/complete`).set(trainer).send({}).expect(409); // not started
        now = new Date('2026-11-19T11:30:00Z'); // 17:30
        const done = await request(t.app)
            .post(`/api/v1/pt/sessions/${mine.body.data.oid}/complete`)
            .set(trainer)
            .send({ notes: 'Squat 5x5 at 60 kg' })
            .expect(200);
        expect(done.body.data).toMatchObject({ status: 'Completed', notes: 'Squat 5x5 at 60 kg' });
        const later = await request(t.app)
            .post('/api/v1/pt/sessions')
            .set(desk)
            .send({ member_oid: m.oid, trainer_oid: (await sam()).oid, date: '2026-11-19', start_time: '18:00' })
            .expect(201);
        now = new Date('2026-11-19T16:00:00Z'); // 22:00
        const week = (await request(t.app).get('/api/v1/pt/sessions?week=2026-11-19').set(desk).expect(200)).body.data as {
            sessions: { oid: string; status: string }[];
        };
        expect(week.sessions.find(x => x.oid === later.body.data.oid)?.status).toBe('Completed');
    });

    it('no credits, no booking; another branch cannot see the sessions', async () => {
        const m = await member({ pt: null });
        expect(
            (
                await request(t.app)
                    .post('/api/v1/pt/sessions')
                    .set(desk)
                    .send({ member_oid: m.oid, trainer_oid: (await sam()).oid, date: '2026-11-21', start_time: '10:00' })
                    .expect(409)
            ).body.message
        ).toBe(`${m.name} has no PT sessions left for that day. Sell a PT package first.`);
        const dha = (await request(t.app).get('/api/v1/pt/sessions?week=2026-11-19').set(managerDha).expect(200)).body.data as { sessions: unknown[] };
        expect(dha.sessions).toEqual([]);
    });
});

describe('trainers (D-078)', () => {
    it('lists the branch’s trainers; public pages show the public ones without phone numbers', async () => {
        const list = await trainers();
        expect(list.map(x => x.name)).toEqual(['Nabila Islam', 'Sam Cole', 'Shakib Hasan', 'Tahmina Rahman', 'Tom Blake']);
        expect(list.find(x => x.slug === 'sam-cole')).toMatchObject({ phone: '+8801711200101', photo_url: 'assets/images/landing/trainer-sam.webp' });
        const pub = (await request(t.app).get('/api/v1/public/trainers?branch=gulshan').expect(200)).body.data as Trainer[];
        expect(pub).toHaveLength(5);
        expect(pub.every(x => x.phone === '')).toBe(true);
        const one = (await request(t.app).get('/api/v1/public/trainers/sam-cole').expect(200)).body.data as {
            classes: { title: string }[];
            branch_slug: string;
        };
        expect(one.branch_slug).toBe('gulshan');
        expect(one.classes.length).toBeGreaterThan(0);
        expect(one.classes.every(c => c.title === 'Strength circuit')).toBe(true);
        await request(t.app).get('/api/v1/public/trainers/nobody').expect(404);
        // The public branch page lists its trainers too, as the web mock does.
        const branch = (await request(t.app).get('/api/v1/public/branches/gulshan').expect(200)).body.data as { trainers: Trainer[] };
        expect(branch.trainers.map(x => x.name)).toContain('Sam Cole');
    });

    it('a trainer edits their own profile and availability, not another’s; a manager edits any', async () => {
        const s = await sam();
        const saved = await request(t.app).patch(`/api/v1/trainers/${s.oid}`).set(trainer).send({ headline: 'Strength first' }).expect(200);
        expect(saved.body.data.headline).toBe('Strength first');
        await request(t.app).patch(`/api/v1/trainers/${s.oid}`).set(trainer).send({ slug: 'sam' }).expect(403);
        await request(t.app)
            .patch(`/api/v1/trainers/${(await tom()).oid}`)
            .set(trainer)
            .send({ headline: 'x' })
            .expect(403);
        await request(t.app)
            .patch(`/api/v1/trainers/${(await tom()).oid}`)
            .set(manager)
            .send({ slug: 'sam-cole' })
            .expect(409);
        const overlap = await request(t.app)
            .put(`/api/v1/trainers/${s.oid}/availability`)
            .set(trainer)
            .send({
                slots: [
                    { weekday: 6, start_time: '07:00', end_time: '10:00' },
                    { weekday: 6, start_time: '09:00', end_time: '11:00' }
                ]
            })
            .expect(400);
        expect(overlap.body.message).toBe('Two slots overlap on Saturday');
        await request(t.app)
            .put(`/api/v1/trainers/${s.oid}/availability`)
            .set(trainer)
            .send({ slots: [{ weekday: 6, start_time: '07:00', end_time: '10:00' }] })
            .expect(200);
        const detail = (await request(t.app).get(`/api/v1/trainers/${s.oid}`).set(desk).expect(200)).body.data as { availability: unknown[] };
        expect(detail.availability).toEqual([{ weekday: 6, start_time: '07:00', end_time: '10:00' }]);
        // Another branch does not see Gulshan's trainers.
        await request(t.app).get(`/api/v1/trainers/${s.oid}`).set(managerDha).expect(404);
    });

    it('a day off removes the trainer’s free slots and says how many PT sessions fall on it', async () => {
        const t1 = await tom();
        const m = await member();
        await request(t.app)
            .post('/api/v1/pt/sessions')
            .set(desk)
            .send({ member_oid: m.oid, trainer_oid: t1.oid, date: '2026-11-22', start_time: '07:00' })
            .expect(201);
        const leave = await request(t.app)
            .post(`/api/v1/trainers/${t1.oid}/leave`)
            .set(manager)
            .send({ from_date: '2026-11-22', to_date: '2026-11-23', reason: 'Wedding' })
            .expect(201);
        expect(leave.body.message).toBe('Day off saved. 1 PT sessions fall on it: move or cancel them.');
        const slots = (await request(t.app).get(`/api/v1/pt/slots?trainer_oid=${t1.oid}&date=2026-11-23`).set(desk).expect(200)).body.data as {
            slots: string[];
        };
        expect(slots.slots).toEqual([]);
        await request(t.app).delete(`/api/v1/trainers/${t1.oid}/leave/${leave.body.data.oid}`).set(manager).expect(200);
    });

    it('a manager creates a profile for a staff member with the Trainer role, and assigns clients', async () => {
        await request(t.app)
            .post('/api/v1/branch/staff')
            .set(manager)
            .send({ username: 'new.coach', name: 'New Coach', password: 'Temp1234', role: 'TRAINER' })
            .expect(201);
        const candidates = (await request(t.app).get('/api/v1/trainers/candidates').set(manager).expect(200)).body.data as {
            user_oid: string;
            username: string;
        }[];
        expect(candidates.map(c => c.username)).toEqual(['new.coach']);
        await request(t.app).get('/api/v1/trainers/candidates').set(desk).expect(403);
        const created = await request(t.app)
            .post('/api/v1/trainers')
            .set(manager)
            .send({ user_oid: candidates[0]!.user_oid, slug: 'new-coach', gender: 'Female', phone: '01711999999', specialties: ['Mobility'] })
            .expect(201);
        expect(created.body.data).toMatchObject({ name: 'New Coach', phone: '+8801711999999', clients: 0, public: true });
        const m = await member({ pt: null });
        await request(t.app).put(`/api/v1/members/${m.oid}/trainer`).set(desk).send({ trainer_oid: created.body.data.oid }).expect(200);
        expect((await trainers()).find(x => x.slug === 'new-coach')?.clients).toBe(1);
        await request(t.app).put(`/api/v1/members/${m.oid}/trainer`).set(managerDha).send({ trainer_oid: null }).expect(404);
    });
});

describe('class types (HQ) and rooms', () => {
    it('HQ adds and edits class types; a branch manager adds rooms', async () => {
        const created = await request(t.app).post('/api/v1/hq/class-types').set(owner).send({ name: 'Kettlebells', color: 'blue', minutes: 40 }).expect(201);
        await request(t.app).post('/api/v1/hq/class-types').set(owner).send({ name: 'kettlebells', color: 'red', minutes: 40 }).expect(409);
        await request(t.app).patch(`/api/v1/hq/class-types/${created.body.data.oid}`).set(owner).send({ minutes: 45 }).expect(200);
        await request(t.app).post('/api/v1/hq/class-types').set(manager).send({ name: 'Nope', color: 'red', minutes: 40 }).expect(403);
        const types = (await request(t.app).get('/api/v1/class-types').set(desk).expect(200)).body.data as { name: string; minutes: number }[];
        expect(types.find(x => x.name === 'Kettlebells')?.minutes).toBe(45);
        const room = await request(t.app).post('/api/v1/rooms').set(manager).send({ name: 'Rooftop', capacity: 30 }).expect(201);
        await request(t.app).post('/api/v1/rooms').set(desk).send({ name: 'Nope', capacity: 3 }).expect(403);
        await request(t.app).patch(`/api/v1/rooms/${room.body.data.oid}`).set(manager).send({ capacity: 25 }).expect(200);
        const studio = ((await request(t.app).get('/api/v1/rooms').set(desk).expect(200)).body.data as { oid: string; name: string }[]).find(
            r => r.name === 'Studio A'
        )!;
        expect((await request(t.app).patch(`/api/v1/rooms/${studio.oid}`).set(manager).send({ active: false }).expect(409)).body.message).toContain(
            'weekly classes use this room'
        );
    });
});

describe('lockers and maintenance (D-082)', () => {
    interface Locker {
        oid: string;
        number: string;
        status: string;
        monthly_fee: number;
        rental: { oid: string; member_code: string; end_date: string } | null;
    }
    const lockers = async () =>
        (await request(t.app).get('/api/v1/lockers').set(desk).expect(200)).body.data as { lockers: Locker[]; totals: Record<string, number> };

    it('rents a free locker on its own invoice, once; ends the rental; a blocked locker cannot be rented', async () => {
        const before = await lockers();
        expect(before.totals).toEqual({ free: 30, rented: 0, blocked: 0, inactive: 0 });
        const l = before.lockers.find(x => x.number === 'L02')!; // medium, ৳500
        const m = await member({ pt: null });
        const rent = await request(t.app)
            .post(`/api/v1/lockers/${l.oid}/rentals`)
            .set(desk)
            .send({ member_oid: m.oid, months: 3, payment: { method: 'cash', amount: 1725 } })
            .expect(201);
        expect(rent.body.data.invoice).toMatchObject({ kind: 'locker', subtotal: 1500, vat: 225, total: 1725, status: 'Paid' });
        expect(rent.body.data.locker).toMatchObject({ status: 'Rented', rental: { member_code: m.code, end_date: '2027-02-18' } });
        const again = await request(t.app)
            .post(`/api/v1/lockers/${l.oid}/rentals`)
            .set(desk)
            .send({ member_oid: (await member({ pt: null })).oid, months: 1 })
            .expect(409);
        expect(again.body.message).toContain('is rented to');
        await request(t.app).post(`/api/v1/lockers/${before.lockers[2]!.oid}/rentals`).set(desk).send({ member_oid: m.oid, months: 1 }).expect(409);
        const ended = await request(t.app).post(`/api/v1/lockers/rentals/${rent.body.data.locker.rental.oid}/end`).set(desk);
        expect([ended.status, ended.body.data?.status, ended.body.message]).toEqual([200, 'Free', expect.any(String)]);
        expect((await lockers()).lockers.find(x => x.oid === l.oid)?.status).toBe('Free');
        // Blocking a locker is a manager's job.
        const block = { locker_oid: l.oid, starts_at: '2026-11-19T00:00:00Z', ends_at: '2026-11-25T00:00:00Z', reason: 'Broken hinge' };
        await request(t.app).post('/api/v1/maintenance').set(desk).send(block).expect(403);
        await request(t.app).post('/api/v1/maintenance').set(manager).send(block).expect(201);
        expect((await lockers()).lockers.find(x => x.oid === l.oid)?.status).toBe('Blocked');
        expect((await request(t.app).post(`/api/v1/lockers/${l.oid}/rentals`).set(desk).send({ member_oid: m.oid, months: 1 }).expect(409)).body.message).toBe(
            'Locker L02 is out of use: Broken hinge.'
        );
    });

    it('a blocked room flags its classes and refuses bookings until the block is lifted', async () => {
        const rooms = (await request(t.app).get('/api/v1/rooms').set(desk).expect(200)).body.data as { oid: string; name: string }[];
        const spinRoom = rooms.find(r => r.name === 'Spin room')!;
        const made = await request(t.app)
            .post('/api/v1/maintenance')
            .set(manager)
            .send({ room_oid: spinRoom.oid, starts_at: '2026-11-21T00:00:00+06:00', ends_at: '2026-11-22T00:00:00+06:00', reason: 'Bikes serviced' })
            .expect(201);
        expect(made.body.message).toBe('Blocked. 1 classes fall in it: move or cancel them.');
        const list = (await request(t.app).get('/api/v1/maintenance').set(desk).expect(200)).body.data as { affected_classes: { title: string }[] };
        expect(list.affected_classes.map(c => c.title)).toEqual(['Spin']);
        const week = (await request(t.app).get('/api/v1/classes/schedule?week=2026-11-21').set(desk).expect(200)).body.data as {
            sessions: { oid: string; title: string; blocked: boolean; starts_at: string }[];
        };
        const spin = week.sessions.find(s => s.title === 'Spin' && s.starts_at.startsWith('2026-11-21'))!;
        expect(spin.blocked).toBe(true);
        const m = await member({ pt: null });
        expect(
            (await request(t.app).post(`/api/v1/classes/sessions/${spin.oid}/bookings`).set(desk).send({ member_oid: m.oid }).expect(409)).body.message
        ).toBe('Spin room is closed for maintenance at that time.');
        await request(t.app).delete(`/api/v1/maintenance/${made.body.data.oid}`).set(manager).expect(200);
        await request(t.app).post(`/api/v1/classes/sessions/${spin.oid}/bookings`).set(desk).send({ member_oid: m.oid }).expect(201);
    });
});

describe('the rest of the writes', () => {
    it('a manager adds and edits lockers, and marks a PT no-show (the session is used)', async () => {
        const added = await request(t.app).post('/api/v1/lockers').set(manager).send({ number: 'l99', size: 'L', monthly_fee: 900 }).expect(201);
        expect(added.body.data).toMatchObject({ number: 'L99', status: 'Free', monthly_fee: 900 });
        await request(t.app).post('/api/v1/lockers').set(manager).send({ number: 'L99', size: 'S', monthly_fee: 300 }).expect(409);
        await request(t.app).post('/api/v1/lockers').set(desk).send({ number: 'L98', size: 'S', monthly_fee: 300 }).expect(403);
        await request(t.app).patch(`/api/v1/lockers/${added.body.data.oid}`).set(manager).send({ active: false }).expect(200);
        const m = await member();
        const pt = await request(t.app)
            .post('/api/v1/pt/sessions')
            .set(desk)
            // Sam's availability changed above; Shakib is free on Thursday afternoon.
            .send({ member_oid: m.oid, trainer_oid: (await trainers()).find(x => x.slug === 'shakib-hasan')!.oid, date: '2026-11-19', start_time: '16:00' })
            .expect(201);
        now = new Date('2026-11-19T11:00:00Z'); // 17:00
        await request(t.app).post(`/api/v1/pt/sessions/${pt.body.data.oid}/no-show`).set(trainer).expect(403); // not Sam's
        const ns = await request(t.app).post(`/api/v1/pt/sessions/${pt.body.data.oid}/no-show`).set(manager).expect(200);
        expect(ns.body.data).toMatchObject({ status: 'NoShow', charged: true });
    });
});

describe('PT, trainers and facilities: audit log', () => {
    it('every write has an audit row', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ action: string; entity: string }>(sql`
            select distinct action, entity from audit_log
            where entity in ('pt_session', 'trainer', 'locker', 'maintenance_block', 'class_type', 'room', 'invoice') or action = 'assign_trainer'
            order by 2, 1`)
        );
        expect(rows).toEqual(
            expect.arrayContaining([
                { action: 'book', entity: 'pt_session' },
                { action: 'cancel', entity: 'pt_session' },
                { action: 'complete', entity: 'pt_session' },
                { action: 'mark_noshow', entity: 'pt_session' },
                { action: 'create', entity: 'locker' },
                { action: 'update', entity: 'locker' },
                { action: 'settle', entity: 'pt_session' },
                { action: 'update', entity: 'trainer' },
                { action: 'create', entity: 'trainer' },
                { action: 'set_availability', entity: 'trainer' },
                { action: 'add_leave', entity: 'trainer' },
                { action: 'remove_leave', entity: 'trainer' },
                { action: 'assign_trainer', entity: 'member' },
                { action: 'rent', entity: 'locker' },
                { action: 'end_rental', entity: 'locker' },
                { action: 'create', entity: 'invoice' },
                { action: 'create', entity: 'maintenance_block' },
                { action: 'remove', entity: 'maintenance_block' },
                { action: 'create', entity: 'class_type' },
                { action: 'update', entity: 'class_type' },
                { action: 'create', entity: 'room' },
                { action: 'update', entity: 'room' }
            ])
        );
    });
});
