import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import { nextService, serviceState } from './equipment.service.ts';

const { GUL, DHA } = DEMO_BRANCHES;
/** Thursday 19 Nov 2026, 12:00 in Dhaka. */
const NOON = new Date('2026-11-19T06:00:00Z');
let now = NOON;
let t: TestApp;
let manager: Record<string, string>;
let desk: Record<string, string>;
let trainer: Record<string, string>;
let otherManager: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now });
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
    otherManager = atBranch((await signIn(t.app, 'manager.dhanmondi', 'Manager@123')).access_token, DHA.oid);
});
afterAll(() => t.close());
afterEach(() => {
    now = NOON;
});

interface Equipment {
    oid: string;
    status: string;
    service: string;
    next_service_on: string | null;
    last_serviced_on: string | null;
    in_warranty: boolean;
    open_tickets: number;
    spent: number;
    room: { name: string } | null;
    tickets?: { kind: string; status: string; technician: string | null }[];
}
interface Ticket {
    oid: string;
    code: string;
    status: string;
    out_of_order: boolean;
}

const add = (body: Record<string, unknown>, as = manager) =>
    request(t.app)
        .post('/api/v1/equipment')
        .set(as)
        .send({ name: 'Treadmill 1', category: 'cardio', ...body });

describe('service due, worked out when read', () => {
    it.each([
        ['no schedule', { service_every_days: null, last_serviced_on: null }, null, 'none'],
        ['from the last service', { service_every_days: 30, last_serviced_on: '2026-10-01' }, '2026-10-31', 'due'],
        ['due within a week', { service_every_days: 30, last_serviced_on: '2026-10-22' }, '2026-11-21', 'soon'],
        ['from the purchase', { service_every_days: 90, last_serviced_on: null, purchased_on: '2026-10-01' }, '2026-12-30', 'ok']
    ])('%s', (_name, e, next, state) => {
        const n = nextService({ purchased_on: null, created_on: '2026-01-01', status: 'in_use', ...e });
        expect(n).toBe(next);
        expect(serviceState(n, '2026-11-19')).toBe(state);
    });
});

describe('the equipment register', () => {
    it('a manager adds equipment with a room, a warranty and a service schedule; the desk only reads it', async () => {
        const rooms = (await request(t.app).get('/api/v1/rooms').set(manager).expect(200)).body.data as { oid: string; name: string }[];
        const e = (
            await add({
                brand: 'RunPro',
                model: 'T9',
                room_oid: rooms[0]!.oid,
                warranty_until: '2027-06-30',
                service_every_days: 30,
                last_serviced_on: '2026-10-10'
            }).expect(201)
        ).body.data as Equipment;
        expect(e).toMatchObject({ status: 'in_use', service: 'due', next_service_on: '2026-11-09', in_warranty: true, room: { name: rooms[0]!.name } });
        await add({ name: 'Rower' }, desk).expect(403);
        await request(t.app).patch(`/api/v1/equipment/${e.oid}`).set(desk).send({ notes: 'x' }).expect(403);
        const edited = (
            await request(t.app).patch(`/api/v1/equipment/${e.oid}`).set(manager).send({ serial: 'RP-0042', warranty_until: '2026-01-01' }).expect(200)
        ).body.data as Equipment;
        expect(edited.in_warranty).toBe(false);
        const list = (await request(t.app).get('/api/v1/equipment?due=1').set(desk).expect(200)).body.data as {
            rows: Equipment[];
            counts: { service_due: number };
        };
        expect(list.rows.map(x => x.oid)).toContain(e.oid);
        expect(list.counts.service_due).toBeGreaterThanOrEqual(1);
        // Another branch's register is not this one's.
        await request(t.app).get(`/api/v1/equipment/${e.oid}`).set(otherManager).expect(404);
        await request(t.app)
            .post('/api/v1/equipment')
            .set(manager)
            .send({ name: 'Bike', category: 'cardio', room_oid: '00000000-0000-4000-8000-00000000ffff' })
            .expect(400);
    });

    it('recording a service moves the next one on and adds its cost', async () => {
        const e = (await add({ name: 'Cable crossover', category: 'strength', service_every_days: 60, last_serviced_on: '2026-09-01' }).expect(201)).body
            .data as Equipment;
        expect(e.service).toBe('due');
        const after = (
            await request(t.app)
                .post(`/api/v1/equipment/${e.oid}/service`)
                .set(manager)
                .send({ technician: 'FixIt Services', cost: 1500, note: 'New cables' })
                .expect(201)
        ).body.data as Equipment;
        expect(after).toMatchObject({ last_serviced_on: '2026-11-19', next_service_on: '2027-01-18', service: 'ok', spent: 1500 });
        expect(after.tickets).toEqual([expect.objectContaining({ kind: 'service', status: 'fixed', technician: 'FixIt Services' })]);
        await request(t.app).post(`/api/v1/equipment/${e.oid}/service`).set(manager).send({ technician: 'X', on: '2026-11-20' }).expect(400);
        await request(t.app).post(`/api/v1/equipment/${e.oid}/service`).set(desk).send({ technician: 'X' }).expect(403);
    });
});

describe('maintenance tickets', () => {
    it('any staff raises one; out of order while open; the manager fixes it and it is back in use', async () => {
        const e = (await add({ name: 'Leg press' }).expect(201)).body.data as Equipment;
        const byTrainer = (await request(t.app).post(`/api/v1/equipment/${e.oid}/tickets`).set(trainer).send({ description: 'Seat squeaks' }).expect(201)).body
            .data as Ticket;
        expect(byTrainer).toMatchObject({ status: 'open', out_of_order: false });
        const urgent = (
            await request(t.app)
                .post(`/api/v1/equipment/${e.oid}/tickets`)
                .set(desk)
                .send({ description: 'Cable snapped', priority: 'urgent', out_of_order: true })
                .expect(201)
        ).body.data as Ticket;
        expect(urgent.code).toMatch(/^TKT-GUL-\d{5}$/);
        expect(((await request(t.app).get(`/api/v1/equipment/${e.oid}`).set(desk).expect(200)).body.data as Equipment).status).toBe('out_of_order');
        // The desk raises, it does not run tickets.
        await request(t.app).patch(`/api/v1/equipment-tickets/${urgent.oid}`).set(desk).send({ status: 'fixed' }).expect(403);
        await request(t.app)
            .patch(`/api/v1/equipment-tickets/${urgent.oid}`)
            .set(manager)
            .send({ status: 'in_progress', technician: 'Gym Repairs BD' })
            .expect(200);
        // Fixing the squeak does not put it back: the open urgent ticket keeps it out of order.
        await request(t.app).patch(`/api/v1/equipment-tickets/${byTrainer.oid}`).set(manager).send({ status: 'fixed' }).expect(200);
        expect(((await request(t.app).get(`/api/v1/equipment/${e.oid}`).set(desk).expect(200)).body.data as Equipment).status).toBe('out_of_order');
        await request(t.app).patch(`/api/v1/equipment-tickets/${urgent.oid}`).set(manager).send({ status: 'fixed', cost: 3200 }).expect(200);
        const fixed = (await request(t.app).get(`/api/v1/equipment/${e.oid}`).set(desk).expect(200)).body.data as Equipment;
        expect(fixed).toMatchObject({ status: 'in_use', open_tickets: 0, spent: 3200 });
        await request(t.app).patch(`/api/v1/equipment-tickets/${urgent.oid}`).set(manager).send({ status: 'open' }).expect(409);
        const open = (await request(t.app).get('/api/v1/equipment-tickets').set(desk).expect(200)).body.data as Ticket[];
        expect(open.map(x => x.oid)).not.toContain(urgent.oid);
    });

    it('cannot be fixed needs a reason and leaves it out of order; retiring waits for open tickets', async () => {
        const e = (await add({ name: 'Old bike' }).expect(201)).body.data as Equipment;
        const tk = (
            await request(t.app).post(`/api/v1/equipment/${e.oid}/tickets`).set(desk).send({ description: 'Flywheel cracked', out_of_order: true }).expect(201)
        ).body.data as Ticket;
        await request(t.app).post(`/api/v1/equipment/${e.oid}/retire`).set(manager).send({ reason: 'Beyond repair' }).expect(409);
        await request(t.app).patch(`/api/v1/equipment-tickets/${tk.oid}`).set(manager).send({ status: 'cannot_fix' }).expect(400);
        await request(t.app).patch(`/api/v1/equipment-tickets/${tk.oid}`).set(manager).send({ status: 'cannot_fix', resolution: 'No parts made' }).expect(200);
        expect(((await request(t.app).get(`/api/v1/equipment/${e.oid}`).set(desk).expect(200)).body.data as Equipment).status).toBe('out_of_order');
        const retired = (await request(t.app).post(`/api/v1/equipment/${e.oid}/retire`).set(manager).send({ reason: 'Beyond repair' }).expect(200)).body
            .data as Equipment;
        expect(retired.status).toBe('retired');
        await request(t.app).post(`/api/v1/equipment/${e.oid}/tickets`).set(desk).send({ description: 'Again' }).expect(409);
        const list = (await request(t.app).get('/api/v1/equipment').set(desk).expect(200)).body.data as { rows: Equipment[] };
        expect(list.rows.map(x => x.oid)).not.toContain(e.oid);
        const all = (await request(t.app).get('/api/v1/equipment?status=all').set(desk).expect(200)).body.data as { rows: Equipment[] };
        expect(all.rows.map(x => x.oid)).toContain(e.oid);
    });
});

describe('equipment: audit log', () => {
    it('every register change, service and ticket step writes an audit row at the branch', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ entity: string; action: string; branch_oid: string }>(sql`
                select distinct entity, action, branch_oid from audit_log where entity in ('equipment', 'maintenance_ticket') order by 1, 2`)
        );
        expect(rows.map(r => `${r.entity}:${r.action}`)).toEqual([
            'equipment:create',
            'equipment:retire',
            'equipment:service',
            'equipment:update',
            'maintenance_ticket:close',
            'maintenance_ticket:create',
            'maintenance_ticket:update'
        ]);
        expect(new Set(rows.map(r => r.branch_oid))).toEqual(new Set([GUL.oid]));
    });
});
