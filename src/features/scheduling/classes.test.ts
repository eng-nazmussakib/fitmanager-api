import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL, DHA } = DEMO_BRANCHES;
/** Thursday 19 Nov 2026, 12:00 in Dhaka. The week runs Saturday 14 to Friday 20. */
const NOON = new Date('2026-11-19T06:00:00Z');
let now = NOON;
let t: TestApp;
let desk: Record<string, string>;
let manager: Record<string, string>;
let trainer: Record<string, string>;
let deskDha: Record<string, string>;
const at = (iso: string) => {
    now = new Date(iso);
};

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
    deskDha = atBranch((await signIn(t.app, 'desk.dhanmondi', 'Desk@123')).access_token, DHA.oid);
});
afterAll(() => t.close());
afterEach(() => {
    now = NOON;
});

interface Session {
    oid: string;
    title: string;
    starts_at: string;
    trainer_name: string;
    trainer_oid: string;
    room: string;
    room_oid: string;
    capacity: number;
    booked: number;
    waitlist: number;
    ladies_only: boolean;
    cancelled: boolean;
    blocked: boolean;
}

let phoneSeq = 0;
async function member(gender: 'Male' | 'Female' = 'Female', sell = true) {
    const phone = `0181${String(10_000_000 + ++phoneSeq).slice(1)}`;
    const m = (
        await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send({ name: `Class Tester ${phoneSeq}`, phone, gender, health_flags: [], health_declared: true })
            .expect(201)
    ).body.data as { oid: string; code: string; name: string };
    if (!sell) return m;
    const plans = (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
    const sale = await request(t.app)
        .post('/api/v1/subscriptions')
        .set(desk)
        .send({ member_oid: m.oid, plan_oid: plans.find(p => p.code === 'GUL-SIN-1M')?.oid, charge_admission: false, payment: { method: 'cash', amount: 0 } })
        .expect(201);
    const invoice = sale.body.data.invoice as { oid: string; total: number };
    await request(t.app).post('/api/v1/payments').set(desk).send({ invoice_oid: invoice.oid, method: 'cash', amount: invoice.total }).expect(200);
    return m;
}

const week = async (h = desk, w = '2026-11-19') =>
    (await request(t.app).get(`/api/v1/classes/schedule?week=${w}`).set(h).expect(200)).body.data as {
        from: string;
        to: string;
        sessions: Session[];
        types: unknown[];
        rooms: { oid: string; name: string }[];
        trainers: { oid: string; name: string; gender: string }[];
        my_trainer_oid: string | null;
    };
const find = async (title: string, startsAt: string, h = desk) => {
    const s = (await week(h, startsAt.slice(0, 10))).sessions.find(x => x.title === title && x.starts_at === startsAt);
    if (!s) throw new Error(`no ${title} at ${startsAt}`);
    return s;
};
const book = (s: { oid: string }, m: { oid: string }, h = desk) =>
    request(t.app).post(`/api/v1/classes/sessions/${s.oid}/bookings`).set(h).send({ member_oid: m.oid });
const detail = async (s: { oid: string }) =>
    (await request(t.app).get(`/api/v1/classes/sessions/${s.oid}`).set(desk).expect(200)).body.data as Session & {
        roster: { oid: string; member_oid: string; status: string; late_cancel: boolean }[];
        waitlisted: { oid: string; member_oid: string }[];
    };
const messages = (memberOid: string, kind: string) =>
    acrossBranches(t.ownerDb, tx => tx.query<{ subject: string }>(sql`select subject from notification where member_oid = ${memberOid} and kind = ${kind}`));

describe('the timetable', () => {
    it('a week runs Saturday to Friday, made from the weekly rules when read, with the mock’s shape', async () => {
        const w = await week();
        expect(w).toMatchObject({ from: '2026-11-14', to: '2026-11-20', my_trainer_oid: null });
        expect(w.types).toHaveLength(8);
        expect(w.rooms.map(r => r.name)).toEqual(['PT area', 'Spin room', 'Studio A', 'Studio B']);
        expect(w.trainers).toHaveLength(5);
        const strength = w.sessions.find(s => s.starts_at === '2026-11-19T19:30:00+06:00');
        expect(strength).toMatchObject({ title: 'Strength circuit', trainer_name: 'Sam Cole', room: 'Studio B', capacity: 16, booked: 0, ladies_only: false });
        // Friday: Yoga at 5 pm and HIIT at 6:30 pm only.
        expect(w.sessions.filter(s => s.starts_at.startsWith('2026-11-20')).map(s => s.title)).toEqual(['Yoga', 'HIIT']);
        // The same read twice makes no second copy.
        expect((await week()).sessions).toHaveLength(w.sessions.length);
        // Trainers start on their own classes.
        const mine = await week(trainer);
        expect(mine.my_trainer_oid).toBe(strength?.trainer_oid);
        // A branch sees only its own timetable.
        expect((await week(deskDha)).sessions.some(s => s.oid === strength?.oid)).toBe(false);
        await request(t.app).get(`/api/v1/classes/sessions/${strength?.oid}`).set(deskDha).expect(404);
    });

    it('is filled in only 28 days ahead', async () => {
        expect((await week(desk, '2026-12-19')).sessions).toHaveLength(0);
        expect((await week(desk, '2026-12-12')).sessions.length).toBeGreaterThan(0);
    });

    it('the public timetable hides who booked', async () => {
        const m = await member();
        const s = await find('Strength circuit', '2026-11-19T19:30:00+06:00');
        await book(s, m).expect(201);
        const pub = (await request(t.app).get('/api/v1/public/classes?branch=gulshan&week=2026-11-19').expect(200)).body.data as { sessions: Session[] };
        expect(pub.sessions.find(x => x.oid === s.oid)).toMatchObject({ booked: 0, waitlist: 0 });
        await request(t.app).get('/api/v1/public/classes?branch=nowhere').expect(404);
    });
});

describe('booking rules', () => {
    it('books a member with a running plan; refuses twice, the wrong gender, no plan, and too far ahead', async () => {
        const m = await member();
        const s = await find('Spin', '2026-11-19T18:00:00+06:00');
        const ok = await book(s, m).expect(201);
        expect(ok.body).toMatchObject({ message: `${m.name} booked`, data: { status: 'Booked', source: 'desk', member_code: m.code } });
        expect((await book(s, m).expect(409)).body.message).toContain('already booked');
        const man = await member('Male');
        const ladies = (await week(desk, '2026-11-21')).sessions.find(x => x.ladies_only)!;
        expect((await book(ladies, man).expect(409)).body.message).toBe('This is a ladies-only class.');
        const none = await member('Female', false);
        expect((await book(s, none).expect(409)).body.message).toContain('has no running membership');
        const later = (await week(desk, '2026-11-27')).sessions.find(x => x.starts_at.startsWith('2026-11-27'))!;
        expect((await book(later, m).expect(409)).body.message).toBe('Classes open for booking 7 days ahead.');
        // Another branch's member is not found here; another branch cannot book on this class.
        await book(s, m, deskDha).expect(404);
    });

    it('a full class waitlists; a cancel in time frees the place for the first in line, with a message', async () => {
        const studio = (await week()).rooms.find(r => r.name === 'Studio A')!;
        const trainers = (await week()).trainers;
        const oneOff = await request(t.app)
            .post('/api/v1/classes/sessions')
            .set(manager)
            .send({
                class_type_oid: (await acrossBranches(t.ownerDb, tx => tx.query<{ oid: string }>(sql`select oid from class_type where name = 'HIIT'`)))[0]!.oid,
                trainer_oid: trainers.find(x => x.name === 'Tom Blake')!.oid,
                room_oid: studio.oid,
                date: '2026-11-20',
                start_time: '16:00',
                capacity: 1
            })
            .expect(201);
        const s = oneOff.body.data as Session;
        expect(s).toMatchObject({ title: 'HIIT', starts_at: '2026-11-20T16:00:00+06:00', capacity: 1 });
        const [a, b] = [await member(), await member()];
        await book(s, a).expect(201);
        const waiting = await book(s, b).expect(201);
        expect(waiting.body).toMatchObject({ message: `${b.name} added to the waitlist`, data: { status: 'Waitlist' } });
        const before = await detail(s);
        expect(before).toMatchObject({ booked: 1, waitlist: 1 });
        const cancel = await request(t.app).patch(`/api/v1/classes/bookings/${before.roster[0]!.oid}`).set(desk).send({ status: 'Cancelled' }).expect(200);
        expect(cancel.body.message).toBe('Booking cancelled');
        const after = await detail(s);
        expect(after.roster.map(r => [r.member_oid, r.status])).toEqual([[b.oid, 'Booked']]);
        expect(await messages(b.oid, 'waitlist_promoted')).toEqual([{ subject: 'You are in: HIIT' }]);
        // A one-off may not clash: the same room and time.
        await request(t.app)
            .post('/api/v1/classes/sessions')
            .set(manager)
            .send({
                class_type_oid: (await acrossBranches(t.ownerDb, tx => tx.query<{ oid: string }>(sql`select oid from class_type where name = 'Yoga'`)))[0]!.oid,
                trainer_oid: trainers.find(x => x.name === 'Sam Cole')!.oid,
                room_oid: studio.oid,
                date: '2026-11-20',
                start_time: '16:30',
                capacity: 5
            })
            .expect(409);
    });

    it('no-shows when read, late cancels, and the pause after three', async () => {
        const m = await member();
        await book(await find('Spin', '2026-11-19T18:00:00+06:00'), m).expect(201);
        await book(await find('Strength circuit', '2026-11-19T19:30:00+06:00'), m).expect(201);
        at('2026-11-19T17:00:00Z'); // 23:00: both classes are over
        const spin = await detail(await find('Spin', '2026-11-19T18:00:00+06:00'));
        expect(spin.roster.find(r => r.member_oid === m.oid)?.status).toBe('NoShow');
        // A late cancel (less than 2 hours before) counts too: the third strike.
        const yoga = await find('Yoga', '2026-11-20T17:00:00+06:00');
        await book(yoga, m).expect(201);
        at('2026-11-20T10:00:00Z'); // Friday 16:00
        const booking = (await detail(yoga)).roster.find(r => r.member_oid === m.oid)!;
        const late = await request(t.app).patch(`/api/v1/classes/bookings/${booking.oid}`).set(desk).send({ status: 'Cancelled' }).expect(200);
        expect(late.body.message).toContain('it counts as a missed class');
        const hiit = await find('HIIT', '2026-11-20T18:30:00+06:00');
        expect((await book(hiit, m).expect(409)).body.message).toContain('booking is paused until 27 Nov 2026');
    });

    it('a check-in before a booked class marks it attended', async () => {
        const m = await member();
        const s = await find('Strength circuit', '2026-11-19T19:30:00+06:00');
        await book(s, m).expect(201);
        at('2026-11-19T13:10:00Z'); // 19:10
        const ci = await request(t.app).post('/api/v1/attendance/check-in').set(desk).send({ member_oid: m.oid });
        expect([ci.status, ci.body.message]).toEqual([201, expect.any(String)]);
        expect(ci.body.message).toBe(`${m.name} checked in; marked present for Strength circuit`);
        expect((await detail(s)).roster.find(r => r.member_oid === m.oid)?.status).toBe('Attended');
    });

    it('a trainer marks only their own classes, on the day', async () => {
        const m = await member();
        const strength = await find('Strength circuit', '2026-11-19T19:30:00+06:00');
        const spin = await find('Spin', '2026-11-19T18:00:00+06:00');
        await book(strength, m).expect(201);
        await book(spin, m).expect(201);
        const mine = (await detail(strength)).roster.find(r => r.member_oid === m.oid)!;
        const theirs = (await detail(spin)).roster.find(r => r.member_oid === m.oid)!;
        await request(t.app).patch(`/api/v1/classes/bookings/${theirs.oid}`).set(trainer).send({ status: 'Attended' }).expect(403);
        await request(t.app).patch(`/api/v1/classes/bookings/${mine.oid}`).set(trainer).send({ status: 'Attended' }).expect(200);
        const saturday = await find('Strength circuit', '2026-11-21T19:30:00+06:00');
        await book(saturday, m).expect(201);
        const next = (await detail(saturday)).roster.find(r => r.member_oid === m.oid)!;
        expect((await request(t.app).patch(`/api/v1/classes/bookings/${next.oid}`).set(trainer).send({ status: 'NoShow' }).expect(409)).body.message).toBe(
            'Attendance is marked on the day of the class.'
        );
        // The trainer cannot cancel a class or change the timetable.
        await request(t.app).post(`/api/v1/classes/sessions/${saturday.oid}/cancel`).set(trainer).send({ reason: 'Sick' }).expect(403);
    });
});

describe('weekly rules and changes', () => {
    const typeOid = async (name: string) =>
        (await acrossBranches(t.ownerDb, tx => tx.query<{ oid: string }>(sql`select oid from class_type where name = ${name}`)))[0]!.oid;

    it('checks the trainer, the room, the hours and clashes; a new rule fills the timetable', async () => {
        const w = await week();
        const tom = w.trainers.find(x => x.name === 'Tom Blake')!.oid;
        const nabila = w.trainers.find(x => x.name === 'Nabila Islam')!.oid;
        const studioA = w.rooms.find(r => r.name === 'Studio A')!.oid;
        const pt = w.rooms.find(r => r.name === 'PT area')!.oid;
        const base = { class_type_oid: await typeOid('Pilates'), trainer_oid: nabila, room_oid: studioA, weekdays: [0], start_time: '13:00', capacity: 12 };
        const post = (body: object) => request(t.app).post('/api/v1/classes/rules').set(manager).send(body);
        expect((await post({ ...base, weekdays: [5] }).expect(400)).body.message).toBe('Gulshan is not open for the whole class on Friday');
        expect((await post({ ...base, room_oid: pt }).expect(400)).body.message).toBe('PT area holds 4');
        expect((await post({ ...base, trainer_oid: tom, ladies_only: true }).expect(400)).body.message).toBe('A ladies-only class has a female trainer');
        expect((await post({ ...base, weekdays: [1], start_time: '18:00' }).expect(409)).body.message).toBe('Studio A already has Zumba on Monday at 6:00 pm.');
        await post(base).set(desk).expect(403);
        const rule = (await post(base).expect(201)).body.data as { oid: string; end_time: string };
        expect(rule.end_time).toBe('13:55');
        const sunday = (await week(desk, '2026-11-22')).sessions.filter(s => s.title === 'Pilates' && s.starts_at === '2026-11-22T13:00:00+06:00');
        expect(sunday).toHaveLength(1);
    });

    it('a changed rule moves booked classes in place and cancels, with a message, the days it no longer runs', async () => {
        const w = await week();
        const rules = (await request(t.app).get('/api/v1/classes/rules').set(desk).expect(200)).body.data as {
            oid: string;
            type_name: string;
            weekdays: number[];
            start_time: string;
        }[];
        const boxing = rules.find(r => r.type_name === 'Boxing fit')!; // Monday and Wednesday 20:00, Studio A
        expect(boxing.weekdays).toEqual([1, 3]);
        const m = await member();
        const monday = await find('Boxing fit', '2026-11-23T20:00:00+06:00');
        const wednesday = await find('Boxing fit', '2026-11-25T20:00:00+06:00');
        await book(monday, m).expect(201);
        await book(wednesday, m).expect(201);
        const saved = await request(t.app)
            .patch(`/api/v1/classes/rules/${boxing.oid}`)
            .set(manager)
            .send({ weekdays: [1], start_time: '20:30' })
            .expect(200);
        expect(saved.body).toMatchObject({ message: 'Saved. 1 booked classes were cancelled and their members told.', data: { sessions_changed: 1 } });
        expect(await detail(monday)).toMatchObject({ starts_at: '2026-11-23T20:30:00+06:00', cancelled: false });
        expect(await detail(wednesday)).toMatchObject({ cancelled: true, cancel_reason: 'The timetable changed' });
        expect(await messages(m.oid, 'class_cancelled')).toEqual([{ subject: 'Cancelled: Boxing fit on 25 Nov 2026' }]);
        expect(w.sessions.length).toBeGreaterThan(0);
    });

    it('a single class can be moved or cancelled on its own', async () => {
        const m = await member();
        const zumba = await find('Zumba', '2026-11-22T18:00:00+06:00');
        await book(zumba, m).expect(201);
        const studioB = (await week()).rooms.find(r => r.name === 'Studio B')!.oid;
        const moved = await request(t.app).patch(`/api/v1/classes/sessions/${zumba.oid}`).set(manager).send({ room_oid: studioB, capacity: 18 }).expect(200);
        expect(moved.body.data).toMatchObject({ room: 'Studio B', capacity: 18, detached: true });
        const cancelled = await request(t.app).post(`/api/v1/classes/sessions/${zumba.oid}/cancel`).set(manager).send({ reason: 'Trainer unwell' }).expect(200);
        expect(cancelled.body.message).toBe('Class cancelled; 1 members were told');
        expect((await book(zumba, await member()).expect(409)).body.message).toContain('This class was cancelled');
    });
});

describe('the member portal', () => {
    it('lists bookable classes, books, and cancels', async () => {
        const m = await member();
        await request(t.app).post(`/api/v1/members/${m.oid}/portal-access`).set(desk).send({ password: 'Temp1234' }).expect(200);
        const temp = bearer(
            (await request(t.app).post('/api/v1/auth/login').send({ username: m.code, password: 'Temp1234' }).expect(200)).body.data.access_token as string
        );
        await request(t.app)
            .post('/api/v1/auth/change-password')
            .set(...temp)
            .send({ current_password: 'Temp1234', new_password: 'Mine5678x' })
            .expect(200);
        const me = bearer(
            (await request(t.app).post('/api/v1/auth/login').send({ username: m.code, password: 'Mine5678x' }).expect(200)).body.data.access_token as string
        );
        const list = (
            await request(t.app)
                .get('/api/v1/me/bookings')
                .set(...me)
                .expect(200)
        ).body.data as { upcoming: unknown[]; available: Session[]; rules: { cancel_hours: number } };
        expect(list.upcoming).toEqual([]);
        expect(list.rules.cancel_hours).toBe(2);
        expect(list.available.every(s => s.starts_at > '2026-11-19T12:00' && s.starts_at < '2026-11-27')).toBe(true);
        const spin = list.available.find(s => s.title === 'Spin')!;
        const b = await request(t.app)
            .post('/api/v1/me/bookings')
            .set(...me)
            .send({ session_oid: spin.oid })
            .expect(201);
        expect(b.body).toMatchObject({ message: 'Class booked', data: { source: 'portal', status: 'Booked' } });
        const again = (
            await request(t.app)
                .get('/api/v1/me/bookings')
                .set(...me)
                .expect(200)
        ).body.data as { upcoming: { oid: string; session: { title: string } }[] };
        expect(again.upcoming.map(u => u.session.title)).toEqual(['Spin']);
        // The portal home shows it as the next class.
        const home = (
            await request(t.app)
                .get('/api/v1/me/summary')
                .set(...me)
                .expect(200)
        ).body.data as { next_booking: { session: { title: string } } | null };
        expect(home.next_booking?.session.title).toBe('Spin');
        await request(t.app)
            .delete(`/api/v1/me/bookings/${again.upcoming[0]!.oid}`)
            .set(...me)
            .expect(200);
        // Staff tokens cannot use the portal routes.
        await request(t.app).get('/api/v1/me/bookings').set(desk).expect(403);
    });
});

describe('scheduling: audit log', () => {
    it('every booking and timetable change has an audit row', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ action: string; entity: string }>(sql`
            select distinct action, entity from audit_log where entity in ('booking', 'class_schedule', 'class_session') order by 2, 1`)
        );
        expect(rows).toEqual(
            expect.arrayContaining([
                { action: 'book', entity: 'booking' },
                { action: 'cancel', entity: 'booking' },
                { action: 'late_cancel', entity: 'booking' },
                { action: 'promote', entity: 'booking' },
                { action: 'mark_attended', entity: 'booking' },
                { action: 'settle', entity: 'booking' },
                { action: 'create', entity: 'class_schedule' },
                { action: 'update', entity: 'class_schedule' },
                { action: 'create', entity: 'class_session' },
                { action: 'update', entity: 'class_session' },
                { action: 'cancel', entity: 'class_session' }
            ])
        );
    });
});
