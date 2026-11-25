import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { createMemoryStore } from '#src/lib/file-store.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { acrossBranches } from '#src/testing/rls.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import { epley, personalRecords, progressSeries } from './records.ts';

const { GUL, DHA, HQ } = DEMO_BRANCHES;
/** Thursday 19 Nov 2026, 12:00 in Dhaka. */
const NOON = new Date('2026-11-19T06:00:00Z');
let now = NOON;
let t: TestApp;
let desk: Record<string, string>;
let manager: Record<string, string>;
let trainer: Record<string, string>;
let managerDha: Record<string, string>;
let admin: Record<string, string>;
const store = createMemoryStore('s3');
const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082',
    'hex'
);

beforeAll(async () => {
    t = await createTestApp({}, { clock: () => now, files: store });
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    trainer = atBranch((await signIn(t.app, 'trainer.gulshan', 'Trainer@123')).access_token, GUL.oid);
    managerDha = atBranch((await signIn(t.app, 'manager.dhanmondi', 'Manager@123')).access_token, DHA.oid);
    admin = atBranch((await signIn(t.app, 'admin.hq', 'Admin@123')).access_token, HQ.oid);
});
afterAll(() => t.close());
afterEach(() => {
    now = NOON;
});

interface Exercise {
    oid: string;
    name: string;
    scope: string;
    measure: string;
    editable: boolean;
    active: boolean;
    photos: { file_oid: string; url: string }[];
    video: { file_oid: string; url: string } | null;
}
interface Routine {
    oid: string;
    name: string;
    scope: string;
    days: { name: string; exercises: { exercise_oid: string; name: string; sets: number; reps: number | null; weight_kg: number | null }[] }[];
    next_day: number | null;
    trainer_name: string | null;
    assigned_by: string | null;
    source_oid: string | null;
    ended_on: string | null;
}
interface MemberRoutine {
    current: Routine | null;
    history: Routine[];
}

let phoneSeq = 0;
async function member(h = desk) {
    const phone = `0181${String(30_000_000 + ++phoneSeq).slice(1)}`;
    return (
        await request(t.app)
            .post('/api/v1/members')
            .set(h)
            .send({ name: `Lifter ${phoneSeq}`, phone, gender: 'Female', health_flags: [], health_declared: true })
            .expect(201)
    ).body.data as { oid: string; code: string };
}
const exercises = async (h = desk, query = '') => (await request(t.app).get(`/api/v1/exercises${query}`).set(h).expect(200)).body.data as Exercise[];
const byName = async (name: string, h = desk) => (await exercises(h)).find(e => e.name === name)!;
const templates = async (h = desk) => (await request(t.app).get('/api/v1/routines').set(h).expect(200)).body.data as Routine[];
const routineOf = async (oid: string, h = manager) =>
    (await request(t.app).get(`/api/v1/members/${oid}/routine`).set(h).expect(200)).body.data as MemberRoutine;
async function upload(h: Record<string, string>, kind: string, bytes = PNG, size = bytes.length) {
    const start = await request(t.app).post('/api/v1/files').set(h).send({ kind, name: 'p.png', content_type: 'image/png', size });
    if (start.status !== 201) return { status: start.status, oid: '' };
    const file = start.body.data.file as { oid: string; branch_oid: string };
    await store.write(`${file.branch_oid}/${file.oid}`, new Uint8Array(bytes), 'image/png');
    await request(t.app).post(`/api/v1/files/${file.oid}/complete`).set(h).expect(200);
    return { status: 201, oid: file.oid };
}

describe('records (pure)', () => {
    it('Epley, records and series', () => {
        expect(epley(100, 1)).toBe(100);
        expect(epley(100, 5)).toBe(116.7);
        expect(epley(100, 13)).toBeNull();
        const base = { exercise_oid: 'a', exercise_name: 'Squat', measure: 'weight_reps' as const, seconds: null, distance_m: null };
        const sets = [
            { ...base, performed_on: '2026-11-01', weight_kg: 80, reps: 8 },
            { ...base, performed_on: '2026-11-08', weight_kg: 90, reps: 3 },
            { ...base, performed_on: '2026-11-15', weight_kg: 85, reps: 8 }
        ];
        const [r] = personalRecords(sets);
        expect(r).toMatchObject({
            heaviest_kg: 90,
            heaviest_reps: 3,
            best_e1rm_kg: 107.7,
            most_reps: 8,
            best_on: '2026-11-15',
            days: 3,
            last_on: '2026-11-15'
        });
        expect(progressSeries(sets)[0]?.points).toEqual([
            { date: '2026-11-01', value: 101.3 },
            { date: '2026-11-08', value: 99 },
            { date: '2026-11-15', value: 107.7 }
        ]);
    });
});

describe('the exercise library', () => {
    it('a branch reads HQ’s library and its own; edits only its own; HQ adds to every branch', async () => {
        const list = await exercises();
        expect(list.length).toBe(42);
        expect(list.every(e => e.scope === 'hq' && !e.editable)).toBe(true);
        expect((await exercises(desk, '?muscle=hamstrings&equipment=machine')).map(e => e.name)).toEqual(['Leg curl']);

        await request(t.app)
            .post('/api/v1/exercises')
            .set(desk)
            .send({ name: 'Nope', category: 'core', measure: 'reps', muscles: ['core'], equipment: 'other' })
            .expect(403);
        const mine = (
            await request(t.app)
                .post('/api/v1/exercises')
                .set(manager)
                .send({
                    name: 'Battle ropes',
                    category: 'cardio',
                    measure: 'time',
                    muscles: ['shoulders', 'core'],
                    equipment: 'other',
                    instructions: 'Make waves.'
                })
                .expect(201)
        ).body.data as Exercise;
        expect(mine).toMatchObject({ scope: 'branch', editable: true, photos: [], video: null });
        await request(t.app)
            .post('/api/v1/exercises')
            .set(manager)
            .send({ name: 'battle ropes', category: 'cardio', measure: 'time', muscles: ['core'], equipment: 'other' })
            .expect(409);
        // Another branch does not see it; HQ's exercises are read-only at a branch.
        expect((await exercises(managerDha)).some(e => e.oid === mine.oid)).toBe(false);
        const squat = await byName('Barbell back squat');
        await request(t.app).patch(`/api/v1/exercises/${squat.oid}`).set(manager).send({ instructions: 'Mine now' }).expect(403);
        // Inactive: hidden from pickers, listed with all=1.
        await request(t.app).patch(`/api/v1/exercises/${mine.oid}`).set(manager).send({ active: false }).expect(200);
        expect((await exercises(manager)).some(e => e.oid === mine.oid)).toBe(false);
        expect((await exercises(manager, '?all=1')).some(e => e.oid === mine.oid)).toBe(true);

        const hq = (
            await request(t.app)
                .post('/api/v1/exercises')
                .set(admin)
                .send({ name: 'Farmer carry', category: 'strength', measure: 'distance_time', muscles: ['forearms', 'core'], equipment: 'dumbbell' })
                .expect(201)
        ).body.data as Exercise;
        expect(hq.scope).toBe('hq');
        expect((await exercises(managerDha)).find(e => e.oid === hq.oid)).toMatchObject({ scope: 'hq', editable: false });
    });

    it('photos and a video: small files only, uploaded at the owning branch, replaced files deleted', async () => {
        expect((await upload(manager, 'exercise_photo', PNG, 400 * 1024)).status).toBe(413);
        expect((await upload(desk, 'exercise_photo')).status).toBe(403);
        const a = await upload(manager, 'exercise_photo');
        const b = await upload(manager, 'exercise_photo');
        const created = (
            await request(t.app)
                .post('/api/v1/exercises')
                .set(manager)
                .send({
                    name: 'Sandbag clean',
                    category: 'strength',
                    measure: 'weight_reps',
                    muscles: ['full_body'],
                    equipment: 'other',
                    photo_file_oids: [a.oid, b.oid]
                })
                .expect(201)
        ).body.data as Exercise;
        expect(created.photos.map(p => p.file_oid)).toEqual([a.oid, b.oid]);
        const img = await request(t.app).get(created.photos[0]!.url).expect(200);
        expect(img.headers['content-type']).toBe('image/png');
        // A file of another kind, or another branch's, is refused.
        const doc = await upload(manager, 'trainer_photo');
        await request(t.app)
            .patch(`/api/v1/exercises/${created.oid}`)
            .set(manager)
            .send({ photo_file_oids: [doc.oid] })
            .expect(400);
        // Dropping a photo deletes its file.
        await request(t.app)
            .patch(`/api/v1/exercises/${created.oid}`)
            .set(manager)
            .send({ photo_file_oids: [b.oid] })
            .expect(200);
        const statuses = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ oid: string; status: string }>(sql`select oid, status from file where oid = any (${[a.oid, b.oid]}::uuid[])`)
        );
        expect(Object.fromEntries(statuses.map(s => [s.oid, s.status]))).toEqual({ [a.oid]: 'deleted', [b.oid]: 'ready' });
        // At HQ, for the HQ library.
        expect((await upload(admin, 'exercise_photo')).status).toBe(201);
    });
});

describe('routines', () => {
    it('templates: HQ’s and the branch’s; targets checked against the measure; a trainer’s carry their name', async () => {
        const list = await templates();
        expect(list.map(r => r.name)).toEqual(['5 km runner', 'Beginner full body', 'Fat loss circuit', 'Push, pull, legs', 'Upper and lower strength']);
        const squat = await byName('Barbell back squat');
        const plank = await byName('Plank');
        const body = (exs: object[]) => ({ name: 'Leg day', goal: 'strength', level: 'beginner', days: [{ name: 'Legs', exercises: exs }] });
        await request(t.app)
            .post('/api/v1/routines')
            .set(desk)
            .send(body([{ exercise_oid: squat.oid, sets: 3, reps: 5 }]))
            .expect(403);
        const noReps = await request(t.app)
            .post('/api/v1/routines')
            .set(trainer)
            .send(body([{ exercise_oid: squat.oid, sets: 3 }]))
            .expect(400);
        expect(noReps.body.message).toBe('Barbell back squat: enter the reps');
        await request(t.app)
            .post('/api/v1/routines')
            .set(trainer)
            .send(body([{ exercise_oid: plank.oid, sets: 3, reps: 5 }]))
            .expect(400);
        const made = (
            await request(t.app)
                .post('/api/v1/routines')
                .set(trainer)
                .send(body([{ exercise_oid: squat.oid, sets: 3, reps: 5, weight_kg: 60, seconds: 30 }]))
                .expect(201)
        ).body.data as Routine;
        // Fields the measure does not use are dropped; the name is copied.
        expect(made).toMatchObject({
            scope: 'branch',
            trainer_name: 'Sam Cole',
            days: [{ exercises: [{ name: 'Barbell back squat', weight_kg: 60, reps: 5 }] }]
        });
        expect(made.days[0]!.exercises[0]).toMatchObject({ seconds: null });
        // An HQ template is read-only at a branch.
        await request(t.app).patch(`/api/v1/routines/${list[0]!.oid}`).set(manager).send({ name: 'Mine' }).expect(403);
        await request(t.app).patch(`/api/v1/routines/${made.oid}`).set(manager).send({ name: 'Leg day (heavy)' }).expect(200);
    });

    it('assigning copies a snapshot; one runs at a time; days rotate after the last workout', async () => {
        const m = await member();
        const ppl = (await templates()).find(r => r.name === 'Push, pull, legs')!;
        const copy = (await request(t.app).post(`/api/v1/members/${m.oid}/routine`).set(manager).send({ template_oid: ppl.oid }).expect(201)).body
            .data as MemberRoutine;
        expect(copy.current).toMatchObject({ scope: 'member', source_oid: ppl.oid, assigned_by: 'staff', next_day: 0, started_on: '2026-11-19' });

        // Editing the member's copy does not touch the template.
        const days = copy.current!.days.map(d => ({
            ...d,
            exercises: d.exercises.map(x => ({ exercise_oid: x.exercise_oid, sets: x.sets, reps: x.reps, weight_kg: x.weight_kg }))
        }));
        days[0]!.exercises[0]!.weight_kg = 70;
        await request(t.app).patch(`/api/v1/routines/${copy.current!.oid}`).set(manager).send({ days }).expect(200);
        expect((await templates()).find(r => r.oid === ppl.oid)!.days[0]!.exercises[0]!.weight_kg).toBe(60);

        // Log day 0 (Push), then day 1: the next is day 2, then back to 0.
        const bench = await byName('Bench press');
        const log = (day: number, on: string) =>
            request(t.app)
                .post(`/api/v1/members/${m.oid}/workouts`)
                .set(manager)
                .send({ performed_on: on, day_index: day, exercises: [{ exercise_oid: bench.oid, sets: [{ weight_kg: 60, reps: 8 }] }] })
                .expect(201);
        await log(0, '2026-11-17');
        expect((await routineOf(m.oid)).current!.next_day).toBe(1);
        await log(1, '2026-11-18');
        await log(2, '2026-11-19');
        expect((await routineOf(m.oid)).current).toMatchObject({ next_day: 0, last_workout_on: '2026-11-19' });
        await request(t.app)
            .post(`/api/v1/members/${m.oid}/workouts`)
            .set(manager)
            .send({ performed_on: '2026-11-19', day_index: 5, exercises: [{ exercise_oid: bench.oid, sets: [{ weight_kg: 60, reps: 8 }] }] })
            .expect(400);

        // A new routine ends the running one.
        const beginner = (await templates()).find(r => r.name === 'Beginner full body')!;
        const after = (await request(t.app).post(`/api/v1/members/${m.oid}/routine`).set(manager).send({ template_oid: beginner.oid }).expect(201)).body
            .data as MemberRoutine;
        expect(after.current).toMatchObject({ name: 'Beginner full body', next_day: 0 });
        expect(after.history).toMatchObject([{ name: 'Push, pull, legs', ended_on: '2026-11-19' }]);
        const ended = (await request(t.app).post(`/api/v1/members/${m.oid}/routine/end`).set(manager).expect(200)).body.data as MemberRoutine;
        expect(ended.current).toBeNull();
        await request(t.app).post(`/api/v1/members/${m.oid}/routine/end`).set(manager).expect(409);
        await request(t.app).get(`/api/v1/members/${m.oid}/routine`).set(managerDha).expect(404);
    });

    it('a trainer assigns and logs for their own clients only; a routine can be built for one member', async () => {
        const m = await member();
        const squat = await byName('Goblet squat');
        const built = {
            routine: {
                name: 'Knee friendly',
                goal: 'general',
                level: 'beginner',
                days: [{ name: 'A', exercises: [{ exercise_oid: squat.oid, sets: 3, reps: 12 }] }]
            }
        };
        await request(t.app).post(`/api/v1/members/${m.oid}/routine`).set(trainer).send(built).expect(403);
        const sam = ((await request(t.app).get('/api/v1/trainers').set(desk).expect(200)).body.data as { oid: string; slug: string }[]).find(
            x => x.slug === 'sam-cole'
        )!;
        await request(t.app).put(`/api/v1/members/${m.oid}/trainer`).set(desk).send({ trainer_oid: sam.oid }).expect(200);
        const r = (await request(t.app).post(`/api/v1/members/${m.oid}/routine`).set(trainer).send(built).expect(201)).body.data as MemberRoutine;
        expect(r.current).toMatchObject({ name: 'Knee friendly', source_oid: null, assigned_by: 'trainer', trainer_name: 'Sam Cole' });
        const w = await request(t.app)
            .post(`/api/v1/members/${m.oid}/workouts`)
            .set(trainer)
            .send({ performed_on: '2026-11-19', day_index: 0, exercises: [{ exercise_oid: squat.oid, sets: [{ weight_kg: 16, reps: 12 }] }] })
            .expect(201);
        expect(w.body.data).toMatchObject({ source: 'trainer', logged_by_name: 'Sam Cole', day_name: 'A' });
        // The desk reads but does not log workouts.
        await request(t.app).get(`/api/v1/members/${m.oid}/workouts`).set(desk).expect(200);
        await request(t.app)
            .post(`/api/v1/members/${m.oid}/workouts`)
            .set(desk)
            .send({ performed_on: '2026-11-19', exercises: [{ exercise_oid: squat.oid, sets: [{ weight_kg: 16, reps: 12 }] }] })
            .expect(403);
    });
});

describe('workouts and progress', () => {
    it('logs sets by measure, within 7 days; edits and deletes for 7 days after; records on read', async () => {
        const m = await member();
        const bench = await byName('Bench press');
        const plank = await byName('Plank');
        const run = await byName('Treadmill run');
        const send = (body: object) => request(t.app).post(`/api/v1/members/${m.oid}/workouts`).set(manager).send(body);
        const bad = await send({ performed_on: '2026-11-19', exercises: [{ exercise_oid: bench.oid, sets: [{ reps: 8 }] }] }).expect(400);
        expect(bad.body.message).toBe('Bench press, set 1: enter the weight');
        await send({ performed_on: '2026-11-19', exercises: [{ exercise_oid: plank.oid, sets: [{ seconds: 60, reps: 1 }] }] }).expect(400);
        await send({ performed_on: '2026-11-20', exercises: [{ exercise_oid: plank.oid, sets: [{ seconds: 60 }] }] }).expect(400);
        await send({ performed_on: '2026-11-11', exercises: [{ exercise_oid: plank.oid, sets: [{ seconds: 60 }] }] }).expect(400);

        await send({ performed_on: '2026-11-12', exercises: [{ exercise_oid: bench.oid, sets: [{ weight_kg: 60, reps: 10 }] }] }).expect(201);
        const w = (
            await send({
                performed_on: '2026-11-19',
                minutes: 55,
                notes: 'Felt strong',
                exercises: [
                    {
                        exercise_oid: bench.oid,
                        sets: [
                            { weight_kg: 70, reps: 5 },
                            { weight_kg: 75, reps: 3 }
                        ]
                    },
                    { exercise_oid: plank.oid, sets: [{ seconds: 90 }] },
                    { exercise_oid: run.oid, sets: [{ distance_m: 3000, seconds: 1200 }] }
                ]
            }).expect(201)
        ).body.data as { oid: string; volume_kg: number; set_count: number; exercises: { name: string; sets: unknown[] }[]; editable: boolean; source: string };
        expect(w).toMatchObject({ volume_kg: 575, set_count: 4, editable: true, source: 'desk' });
        expect(w.exercises.map(e => [e.name, e.sets.length])).toEqual([
            ['Bench press', 2],
            ['Plank', 1],
            ['Treadmill run', 1]
        ]);

        const p = (await request(t.app).get(`/api/v1/members/${m.oid}/progress`).set(desk).expect(200)).body.data as {
            records: {
                name: string;
                heaviest_kg: number | null;
                best_e1rm_kg: number | null;
                longest_seconds: number | null;
                longest_distance_m: number | null;
            }[];
            series: { name: string; points: { date: string; value: number }[] }[];
            weekly: { week: string; workouts: number }[];
            totals: { workouts: number; this_month: number };
        };
        expect(p.records.find(r => r.name === 'Bench press')).toMatchObject({ heaviest_kg: 75, best_e1rm_kg: 82.5 });
        expect(p.records.find(r => r.name === 'Treadmill run')).toMatchObject({ longest_distance_m: 3000, longest_seconds: 1200 });
        expect(p.series.map(s => s.name)).toEqual(['Bench press']);
        expect(p.weekly).toHaveLength(12);
        expect(p.weekly.at(-1)).toEqual({ week: '2026-11-14', workouts: 1 });
        expect(p.totals).toEqual(expect.objectContaining({ workouts: 2, this_month: 2 }));

        // Edit: the sets are replaced; the record follows.
        await request(t.app)
            .patch(`/api/v1/workouts/${w.oid}`)
            .set(manager)
            .send({ exercises: [{ exercise_oid: bench.oid, sets: [{ weight_kg: 80, reps: 2 }] }] })
            .expect(200);
        const p2 = (await request(t.app).get(`/api/v1/members/${m.oid}/progress`).set(desk).expect(200)).body.data as typeof p;
        expect(p2.records.find(r => r.name === 'Bench press')).toMatchObject({ heaviest_kg: 80 });
        expect(p2.records.some(r => r.name === 'Plank')).toBe(false);
        // Another branch cannot touch it.
        await request(t.app).patch(`/api/v1/workouts/${w.oid}`).set(managerDha).send({ notes: 'x' }).expect(404);
        // After 7 days it is closed.
        now = new Date('2026-11-27T06:00:00Z');
        await request(t.app).delete(`/api/v1/workouts/${w.oid}`).set(manager).expect(409);
        now = new Date('2026-11-26T06:00:00Z');
        await request(t.app).delete(`/api/v1/workouts/${w.oid}`).set(manager).expect(200);
    });
});

describe('measurements', () => {
    it('BMI from the height; photos linked to the member, hidden from other trainers; delete removes the photos', async () => {
        const m = await member();
        await request(t.app).post(`/api/v1/members/${m.oid}/measurements`).set(desk).send({ measured_on: '2026-11-19' }).expect(400);
        const front = await upload(desk, 'measurement_photo');
        const list = (
            await request(t.app)
                .post(`/api/v1/members/${m.oid}/measurements`)
                .set(desk)
                .send({ measured_on: '2026-11-19', height_cm: 165, weight_kg: 68.5, waist_cm: 80, photo_front_oid: front.oid })
                .expect(201)
        ).body.data as {
            height_cm: number;
            rows: { oid: string; bmi: number; source: string; photos: { front: string | null }; photo_count: number; photos_hidden: boolean }[];
        };
        expect(list.height_cm).toBe(165);
        expect(list.rows[0]).toMatchObject({ bmi: 25.2, source: 'desk', photo_count: 1, photos_hidden: false });
        expect(list.rows[0]!.photos.front).toMatch(/\/view\?token=/);
        // A photo can be used once; the same photo for another member is refused.
        const other = await member();
        await request(t.app)
            .post(`/api/v1/members/${other.oid}/measurements`)
            .set(desk)
            .send({ measured_on: '2026-11-19', photo_front_oid: front.oid })
            .expect(400);

        // Sam is not this member's trainer: numbers yes, photos no.
        const seen = (await request(t.app).get(`/api/v1/members/${m.oid}/measurements`).set(trainer).expect(200)).body.data as typeof list;
        expect(seen.rows[0]).toMatchObject({ weight_kg: 68.5, photos: { front: null }, photos_hidden: true });
        await request(t.app).post(`/api/v1/members/${m.oid}/measurements`).set(trainer).send({ measured_on: '2026-11-19', weight_kg: 68 }).expect(403);
        const sam = ((await request(t.app).get('/api/v1/trainers').set(desk).expect(200)).body.data as { oid: string; slug: string }[]).find(
            x => x.slug === 'sam-cole'
        )!;
        await request(t.app).put(`/api/v1/members/${m.oid}/trainer`).set(desk).send({ trainer_oid: sam.oid }).expect(200);
        expect(((await request(t.app).get(`/api/v1/members/${m.oid}/measurements`).set(trainer).expect(200)).body.data as typeof list).rows[0]).toMatchObject({
            photos_hidden: false
        });
        const byTrainer = (
            await request(t.app).post(`/api/v1/members/${m.oid}/measurements`).set(trainer).send({ measured_on: '2026-11-18', weight_kg: 69 }).expect(201)
        ).body.data as typeof list;
        expect(byTrainer.rows.map(r => r.source)).toEqual(['desk', 'trainer']);

        await request(t.app).delete(`/api/v1/measurements/${list.rows[0]!.oid}`).set(managerDha).expect(404);
        await request(t.app).delete(`/api/v1/measurements/${list.rows[0]!.oid}`).set(desk).expect(200);
        const [file] = await acrossBranches(t.ownerDb, tx => tx.query<{ status: string }>(sql`select status from file where oid = ${front.oid}`));
        expect(file?.status).toBe('deleted');
        expect(store.objects.has(`${GUL.oid}/${front.oid}`)).toBe(false);
    });

    it('a transfer takes the history along; "delete my data" deletes it with the photos', async () => {
        const m = await member();
        const bench = await byName('Bench press');
        const beginner = (await templates()).find(r => r.name === 'Beginner full body')!;
        await request(t.app).post(`/api/v1/members/${m.oid}/routine`).set(manager).send({ template_oid: beginner.oid }).expect(201);
        await request(t.app)
            .post(`/api/v1/members/${m.oid}/workouts`)
            .set(manager)
            .send({ performed_on: '2026-11-19', exercises: [{ exercise_oid: bench.oid, sets: [{ weight_kg: 50, reps: 10 }] }] })
            .expect(201);
        const photo = await upload(desk, 'measurement_photo');
        await request(t.app)
            .post(`/api/v1/members/${m.oid}/measurements`)
            .set(desk)
            .send({ measured_on: '2026-11-19', weight_kg: 60, photo_side_oid: photo.oid })
            .expect(201);

        await request(t.app).post(`/api/v1/members/${m.oid}/transfer`).set(manager).send({ to_branch_oid: DHA.oid, reason: 'Moved' }).expect(200);
        const there = await routineOf(m.oid, managerDha);
        expect(there.current).toBeNull();
        expect(there.history).toMatchObject([{ name: 'Beginner full body', ended_on: '2026-11-19' }]);
        expect(((await request(t.app).get(`/api/v1/members/${m.oid}/workouts`).set(managerDha).expect(200)).body.data as unknown[]).length).toBe(1);
        await request(t.app).get(`/api/v1/members/${m.oid}/workouts`).set(manager).expect(404);

        await request(t.app).post(`/api/v1/members/${m.oid}/anonymise`).set(managerDha).send({ confirm_code: m.code }).expect(200);
        const left = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ n: number }>(sql`
                select (select count(*) from routine where member_oid = ${m.oid}) + (select count(*) from workout where member_oid = ${m.oid})
                    + (select count(*) from workout_set where member_oid = ${m.oid}) + (select count(*) from measurement where member_oid = ${m.oid}) as n`)
        );
        expect(Number(left[0]?.n)).toBe(0);
        const [file] = await acrossBranches(t.ownerDb, tx => tx.query<{ status: string }>(sql`select status from file where oid = ${photo.oid}`));
        expect(file?.status).toBe('deleted');
    });
});

describe('training: audit log', () => {
    it('every training write is audited, body numbers left out', async () => {
        const rows = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ entity: string; action: string }>(sql`
                select distinct entity, action from audit_log where entity in ('exercise', 'routine', 'workout', 'measurement') order by 1, 2`)
        );
        expect(rows.map(r => `${r.entity}:${r.action}`)).toEqual([
            'exercise:create',
            'exercise:update',
            'measurement:create',
            'measurement:delete',
            'routine:assign',
            'routine:create',
            'routine:end',
            'routine:update',
            'workout:create',
            'workout:delete',
            'workout:update'
        ]);
        const [m] = await acrossBranches(t.ownerDb, tx =>
            tx.query<{ after: Record<string, unknown> }>(sql`select after from audit_log where entity = 'measurement' and action = 'create' limit 1`)
        );
        expect(m?.after).not.toHaveProperty('weight_kg');
        expect(m?.after).toHaveProperty('recorded');
    });
});
