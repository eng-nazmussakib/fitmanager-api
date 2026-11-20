import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { createMemoryStore } from '#src/lib/file-store.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { GUL } = DEMO_BRANCHES;
/** Thursday 19 Nov 2026, 12:00 in Dhaka. */
const NOON = new Date('2026-11-19T06:00:00Z');
let now = NOON;
let t: TestApp;
let desk: Record<string, string>;
let manager: Record<string, string>;
const store = createMemoryStore('s3');
const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082',
    'hex'
);

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now, files: store });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
});
afterAll(() => t.close());
afterEach(() => {
    now = NOON;
});

let phoneSeq = 0;
/** A Gulshan member with a portal account, signed in. */
async function portalMember() {
    const m = (
        await request(t.app)
            .post('/api/v1/members')
            .set(desk)
            .send({
                name: `Portal Lifter ${++phoneSeq}`,
                phone: `0191${String(40_000_000 + phoneSeq).slice(1)}`,
                gender: 'Male',
                health_flags: [],
                health_declared: true
            })
            .expect(201)
    ).body.data as { oid: string; code: string };
    const plans = (await request(t.app).get('/api/v1/plans').set(desk).expect(200)).body.data as { oid: string; code: string }[];
    await request(t.app)
        .post('/api/v1/subscriptions')
        .set(desk)
        .send({ member_oid: m.oid, plan_oid: plans.find(p => p.code === 'GUL-SIN-1M')?.oid, charge_admission: false, payment: { method: 'cash', amount: 0 } })
        .expect(201);
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
    return { ...m, me: { [me[0]]: me[1] } };
}

interface MemberRoutine {
    current: {
        oid: string;
        name: string;
        next_day: number;
        assigned_by: string;
        days: { name: string; exercises: { exercise_oid: string; name: string }[] }[];
    } | null;
    history: { name: string }[];
}

describe('the portal: routine, workouts, progress, measurements', () => {
    it('a member starts an HQ template, logs the day it shows, and the next day follows', async () => {
        const m = await portalMember();
        const library = (await request(t.app).get('/api/v1/me/exercises').set(m.me).expect(200)).body.data as { oid: string; name: string }[];
        expect(library.length).toBe(42);
        const templates = (await request(t.app).get('/api/v1/me/routine/templates').set(m.me).expect(200)).body.data as {
            oid: string;
            name: string;
            scope: string;
        }[];
        expect(templates.every(r => r.scope === 'hq')).toBe(true);
        expect(((await request(t.app).get('/api/v1/me/routine').set(m.me).expect(200)).body.data as MemberRoutine).current).toBeNull();

        const beginner = templates.find(r => r.name === 'Beginner full body')!;
        const started = (await request(t.app).post('/api/v1/me/routine').set(m.me).send({ template_oid: beginner.oid }).expect(201)).body.data as MemberRoutine;
        expect(started.current).toMatchObject({ name: 'Beginner full body', assigned_by: 'member', next_day: 0 });

        const day = started.current!.days[0]!;
        const sets = day.exercises.map(x => {
            const measure = (library.find(e => e.oid === x.exercise_oid) as unknown as { measure: string }).measure;
            const set =
                measure === 'weight_reps'
                    ? { weight_kg: 10, reps: 10 }
                    : measure === 'reps'
                      ? { reps: 10 }
                      : measure === 'time'
                        ? { seconds: 30 }
                        : { distance_m: 1000, seconds: 300 };
            return { exercise_oid: x.exercise_oid, sets: [set, set] };
        });
        const w = (await request(t.app).post('/api/v1/me/workouts').set(m.me).send({ performed_on: '2026-11-19', day_index: 0, exercises: sets }).expect(201))
            .body.data as {
            oid: string;
            source: string;
            day_name: string;
        };
        expect(w).toMatchObject({ source: 'member', day_name: 'Day A' });
        expect(((await request(t.app).get('/api/v1/me/routine').set(m.me).expect(200)).body.data as MemberRoutine).current!.next_day).toBe(1);
        const list = (await request(t.app).get('/api/v1/me/workouts').set(m.me).expect(200)).body.data as { oid: string }[];
        expect(list.map(x => x.oid)).toEqual([w.oid]);
        await request(t.app).patch(`/api/v1/me/workouts/${w.oid}`).set(m.me).send({ notes: 'Easy' }).expect(200);
        const progress = (await request(t.app).get('/api/v1/me/progress').set(m.me).expect(200)).body.data as {
            records: { name: string }[];
            totals: { workouts: number };
        };
        expect(progress.totals.workouts).toBe(1);
        expect(progress.records.map(r => r.name)).toContain('Goblet squat');

        // A routine from the trainer or the desk is not replaced from the portal.
        const ppl = templates.find(r => r.name === 'Push, pull, legs')!;
        await request(t.app).post(`/api/v1/members/${m.oid}/routine`).set(manager).send({ template_oid: ppl.oid }).expect(201);
        const refused = await request(t.app).post('/api/v1/me/routine').set(m.me).send({ template_oid: beginner.oid }).expect(409);
        expect(refused.body.message).toMatch(/Your trainer set your routine/);
        // A branch template is not offered to members.
        const branchOwn = (
            await request(t.app)
                .post('/api/v1/routines')
                .set(manager)
                .send({
                    name: 'Staff only',
                    goal: 'general',
                    level: 'beginner',
                    days: [{ name: 'A', exercises: [{ exercise_oid: library[0]!.oid, sets: 1, reps: 5 }] }]
                })
                .expect(201)
        ).body.data as { oid: string };
        await request(t.app).post('/api/v1/me/routine/end').set(m.me).expect(200);
        await request(t.app).post('/api/v1/me/routine').set(m.me).send({ template_oid: branchOwn.oid }).expect(404);

        // Another member's workout is not theirs to change; staff tokens cannot use these routes.
        const other = await portalMember();
        await request(t.app).patch(`/api/v1/me/workouts/${w.oid}`).set(other.me).send({ notes: 'Mine' }).expect(404);
        await request(t.app).delete(`/api/v1/me/workouts/${w.oid}`).set(other.me).expect(404);
        await request(t.app).get('/api/v1/me/progress').set(desk).expect(403);
        await request(t.app).delete(`/api/v1/me/workouts/${w.oid}`).set(m.me).expect(200);
    });

    it('a member uploads their own progress photos and deletes their own entries for 7 days', async () => {
        const m = await portalMember();
        await request(t.app)
            .post('/api/v1/me/files')
            .set(m.me)
            .send({ kind: 'member_photo', name: 'x.png', content_type: 'image/png', size: PNG.length })
            .expect(400);
        const start = (
            await request(t.app)
                .post('/api/v1/me/files')
                .set(m.me)
                .send({ kind: 'measurement_photo', name: 'front.png', content_type: 'image/png', size: PNG.length })
                .expect(201)
        ).body.data as { file: { oid: string; branch_oid: string; member_oid: string } };
        expect(start.file).toMatchObject({ branch_oid: GUL.oid, member_oid: m.oid });
        await store.write(`${GUL.oid}/${start.file.oid}`, new Uint8Array(PNG), 'image/png');
        const other = await portalMember();
        await request(t.app).post(`/api/v1/me/files/${start.file.oid}/complete`).set(other.me).expect(403);
        await request(t.app).post(`/api/v1/me/files/${start.file.oid}/complete`).set(m.me).expect(200);

        const saved = (
            await request(t.app)
                .post('/api/v1/me/measurements')
                .set(m.me)
                .send({ measured_on: '2026-11-19', height_cm: 180, weight_kg: 81, photo_front_oid: start.file.oid })
                .expect(201)
        ).body.data as { rows: { oid: string; bmi: number; source: string; deletable: boolean; photos: { front: string | null } }[] };
        expect(saved.rows[0]).toMatchObject({ bmi: 25, source: 'member', deletable: true });
        expect(saved.rows[0]!.photos.front).toMatch(/\/view\?token=/);
        // The other member cannot use it.
        await request(t.app).post('/api/v1/me/measurements').set(other.me).send({ measured_on: '2026-11-19', photo_back_oid: start.file.oid }).expect(400);

        // The desk's entry is not the member's to delete.
        await request(t.app).post(`/api/v1/members/${m.oid}/measurements`).set(desk).send({ measured_on: '2026-11-18', weight_kg: 81.5 }).expect(201);
        const mine = (await request(t.app).get('/api/v1/me/measurements').set(m.me).expect(200)).body.data as typeof saved;
        const desks = mine.rows.find(r => r.source === 'desk')!;
        expect(desks.deletable).toBe(false);
        await request(t.app).delete(`/api/v1/me/measurements/${desks.oid}`).set(m.me).expect(409);
        await request(t.app).delete(`/api/v1/me/measurements/${saved.rows[0]!.oid}`).set(other.me).expect(404);
        now = new Date('2026-11-27T06:00:00Z');
        await request(t.app).delete(`/api/v1/me/measurements/${saved.rows[0]!.oid}`).set(m.me).expect(409);
        now = NOON;
        await request(t.app).delete(`/api/v1/me/measurements/${saved.rows[0]!.oid}`).set(m.me).expect(200);
    });

    it('the portal: audit log', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ e: string }>(sql`
                select distinct entity || ':' || action as e from audit_log where actor_oid in (select oid from app_user where kind = 'member')
                    and entity in ('routine', 'workout', 'measurement', 'file') order by 1`)
        );
        expect(rows.map(r => r.e)).toEqual([
            'file:create',
            'measurement:create',
            'measurement:delete',
            'routine:assign',
            'routine:end',
            'workout:create',
            'workout:delete',
            'workout:update'
        ]);
    });
});
