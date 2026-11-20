import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';

import type { Measure } from './training.schema.ts';

/** SQL of the training subsystem (phase 4). RLS limits every table to the transaction's branches (+ HQ's shared rows). */

export interface ExerciseRow {
    oid: string;
    branch_oid: string;
    hq: boolean;
    name: string;
    category: string;
    measure: Measure;
    muscles: string[];
    equipment: string;
    instructions: string | null;
    photo_file_oids: string[];
    video_file_oid: string | null;
    active: boolean;
}

/** One exercise in a routine's `days`, as stored (names copied, D-087). */
export interface DayExercise {
    exercise_oid: string;
    name: string;
    measure: Measure;
    sets: number;
    reps: number | null;
    weight_kg: number | null;
    seconds: number | null;
    distance_m: number | null;
    rest_seconds: number;
    notes: string | null;
}
export interface RoutineDay {
    name: string;
    exercises: DayExercise[];
}

export interface RoutineRow {
    oid: string;
    branch_oid: string;
    hq: boolean;
    member_oid: string | null;
    source_oid: string | null;
    source_name: string | null;
    name: string;
    goal: string;
    level: string;
    description: string | null;
    days: RoutineDay[];
    trainer_oid: string | null;
    trainer_name: string | null;
    assigned_by: 'trainer' | 'staff' | 'member' | null;
    started_on: string | null;
    ended_on: string | null;
    active: boolean;
    created_at: Date;
}

export interface WorkoutRow {
    oid: string;
    branch_oid: string;
    member_oid: string;
    routine_oid: string | null;
    day_index: number | null;
    day_name: string | null;
    performed_on: string;
    minutes: number | null;
    notes: string | null;
    source: 'member' | 'trainer' | 'desk';
    logged_by: string | null;
    logged_by_name: string | null;
    created_at: Date;
}

export interface SetRow {
    workout_oid: string;
    position: number;
    set_no: number;
    exercise_oid: string;
    exercise_name: string;
    measure: Measure;
    weight_kg: number | null;
    reps: number | null;
    seconds: number | null;
    distance_m: number | null;
    performed_on: string;
}

export interface MeasurementRow {
    oid: string;
    branch_oid: string;
    member_oid: string;
    measured_on: string;
    weight_kg: number | null;
    body_fat_pct: number | null;
    waist_cm: number | null;
    chest_cm: number | null;
    hips_cm: number | null;
    arm_cm: number | null;
    thigh_cm: number | null;
    photo_front_oid: string | null;
    photo_side_oid: string | null;
    photo_back_oid: string | null;
    notes: string | null;
    source: 'member' | 'trainer' | 'desk';
    recorded_by: string | null;
    recorded_by_name: string | null;
    created_at: Date;
}

/** The member a training write is for: at this branch (home), with their trainer. */
export interface TrainingMember {
    oid: string;
    code: string;
    name: string;
    branch_oid: string;
    trainer_oid: string | null;
    height_cm: number | null;
    anonymised: boolean;
}

const EXERCISE = sql.raw(`
    e.oid, e.branch_oid, b.kind = 'HQ' as hq, e.name, e.category, e.measure, e.muscles, e.equipment, e.instructions,
    e.photo_file_oids, e.video_file_oid, e.active
    from exercise e join branch b on b.oid = e.branch_oid`);

const ROUTINE = sql.raw(`
    r.oid, r.branch_oid, b.kind = 'HQ' as hq, r.member_oid, r.source_oid, s.name as source_name, r.name, r.goal, r.level,
    r.description, r.days, r.trainer_oid, r.trainer_name, r.assigned_by, r.started_on::text, r.ended_on::text, r.active, r.created_at
    from routine r join branch b on b.oid = r.branch_oid left join routine s on s.oid = r.source_oid`);

const WORKOUT = sql.raw(`
    w.oid, w.branch_oid, w.member_oid, w.routine_oid, w.day_index, w.day_name, w.performed_on::text, w.minutes, w.notes, w.source,
    w.logged_by, w.logged_by_name, w.created_at
    from workout w`);

const SET = sql.raw(`
    s.workout_oid, s.position, s.set_no, s.exercise_oid, s.exercise_name, s.measure, s.weight_kg::float8 as weight_kg, s.reps, s.seconds,
    s.distance_m::float8 as distance_m, w.performed_on::text
    from workout_set s join workout w on w.oid = s.workout_oid`);

const MEASUREMENT = sql.raw(`
    m.oid, m.branch_oid, m.member_oid, m.measured_on::text, m.weight_kg::float8 as weight_kg, m.body_fat_pct::float8 as body_fat_pct,
    m.waist_cm::float8 as waist_cm, m.chest_cm::float8 as chest_cm, m.hips_cm::float8 as hips_cm, m.arm_cm::float8 as arm_cm,
    m.thigh_cm::float8 as thigh_cm, m.photo_front_oid, m.photo_side_oid, m.photo_back_oid, m.notes, m.source, m.recorded_by,
    m.recorded_by_name, m.created_at
    from measurement m`);

export const trainingRepo = {
    /* ---------- exercises ---------- */

    /** This branch's exercises and HQ's (RLS: the transaction's branches + HQ). */
    exercises: (tx: Queryable, branchOid: string, opts: { all?: boolean } = {}) =>
        tx.query<ExerciseRow>(sql`
            select ${EXERCISE}
            where (e.branch_oid = ${branchOid} or b.kind = 'HQ') and (${opts.all ?? false} or e.active)
            order by lower(e.name), b.kind = 'HQ' desc`),

    exercise: async (tx: Queryable, oid: string, branchOid: string) => {
        const [row] = await tx.query<ExerciseRow>(sql`select ${EXERCISE} where e.oid = ${oid} and (e.branch_oid = ${branchOid} or b.kind = 'HQ')`);
        return row;
    },

    exercisesByOid: (tx: Queryable, oids: readonly string[], branchOid: string) =>
        tx.query<ExerciseRow>(sql`select ${EXERCISE} where e.oid = any (${oids}::uuid[]) and (e.branch_oid = ${branchOid} or b.kind = 'HQ')`),

    /* ---------- routines ---------- */

    templates: (tx: Queryable, branchOid: string, opts: { all?: boolean; hqOnly?: boolean } = {}) =>
        tx.query<RoutineRow>(sql`
            select ${ROUTINE}
            where r.member_oid is null and (b.kind = 'HQ' or (${!(opts.hqOnly ?? false)} and r.branch_oid = ${branchOid}))
                and (${opts.all ?? false} or r.active)
            order by b.kind = 'HQ' desc, lower(r.name)`),

    routine: async (tx: Queryable, oid: string, branchOid: string) => {
        const [row] = await tx.query<RoutineRow>(sql`
            select ${ROUTINE} where r.oid = ${oid} and (r.branch_oid = ${branchOid} or (b.kind = 'HQ' and r.member_oid is null))`);
        return row;
    },

    memberRoutines: (tx: Queryable, memberOid: string, branchOid: string) =>
        tx.query<RoutineRow>(
            sql`select ${ROUTINE} where r.member_oid = ${memberOid} and r.branch_oid = ${branchOid} order by r.ended_on is null desc, r.started_on desc, r.created_at desc`
        ),

    running: async (tx: Queryable, memberOid: string, forUpdate = false) => {
        const [row] = await tx.query<RoutineRow>(sql`
            select ${ROUTINE} where r.member_oid = ${memberOid} and r.ended_on is null ${forUpdate ? sql.raw('for update of r') : sql.raw('')}`);
        return row;
    },

    /** The last workout on a routine: the next day follows it (D-087). */
    lastOnRoutine: async (tx: Queryable, routineOid: string) => {
        const [row] = await tx.query<{ day_index: number | null; performed_on: string }>(sql`
            select day_index, performed_on::text from workout where routine_oid = ${routineOid} and day_index is not null
            order by performed_on desc, created_at desc limit 1`);
        return row;
    },

    /* ---------- members ---------- */

    member: async (tx: Queryable, oid: string, branchOid: string, forUpdate = false) => {
        const [row] = await tx.query<TrainingMember>(sql`
            select oid, code, name, branch_oid, trainer_oid, height_cm::float8 as height_cm, anonymised_at is not null as anonymised
            from member where oid = ${oid} and branch_oid = ${branchOid} ${forUpdate ? sql.raw('for update') : sql.raw('')}`);
        return row;
    },

    /* ---------- workouts ---------- */

    workouts: (tx: Queryable, memberOid: string, limit: number) =>
        tx.query<WorkoutRow>(sql`select ${WORKOUT} where w.member_oid = ${memberOid} order by w.performed_on desc, w.created_at desc limit ${limit}`),

    workout: async (tx: Queryable, oid: string, branchOid: string, forUpdate = false) => {
        const [row] = await tx.query<WorkoutRow>(
            sql`select ${WORKOUT} where w.oid = ${oid} and w.branch_oid = ${branchOid} ${forUpdate ? sql.raw('for update of w') : sql.raw('')}`
        );
        return row;
    },

    setsOf: (tx: Queryable, workoutOids: readonly string[]) =>
        tx.query<SetRow>(sql`select ${SET} where s.workout_oid = any (${workoutOids}::uuid[]) order by s.workout_oid, s.position, s.set_no`),

    /** Every set a member logged (personal records and charts). */
    memberSets: (tx: Queryable, memberOid: string) =>
        tx.query<SetRow>(sql`select ${SET} where s.member_oid = ${memberOid} order by w.performed_on, s.position, s.set_no`),

    /** Workouts per Saturday-to-Friday week since `from` (the weekly bars). */
    weekly: (tx: Queryable, memberOid: string, from: string) =>
        tx.query<{ performed_on: string }>(sql`select performed_on::text from workout where member_oid = ${memberOid} and performed_on >= ${from}::date`),

    /* ---------- measurements ---------- */

    measurements: (tx: Queryable, memberOid: string) =>
        tx.query<MeasurementRow>(sql`select ${MEASUREMENT} where m.member_oid = ${memberOid} order by m.measured_on desc, m.created_at desc`),

    measurement: async (tx: Queryable, oid: string, branchOid: string) => {
        const [row] = await tx.query<MeasurementRow>(sql`select ${MEASUREMENT} where m.oid = ${oid} and m.branch_oid = ${branchOid} for update of m`);
        return row;
    }
};
