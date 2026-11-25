import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { weekStart } from '#src/features/scheduling/classes.service.ts';
import type { Caller } from '#src/features/scheduling/trainers.service.ts';
import { addDays, daysBetween } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import type { TrainingDeps } from './exercises.service.ts';
import { checkSet, personalRecords, progressSeries, volumeKg } from './records.ts';
import { trainingMember } from './routines.service.ts';
import { type SetRow, trainingRepo, type WorkoutRow } from './training.repo.ts';
import type { WorkoutCreate, WorkoutUpdate } from './training.schema.ts';

/**
 * Workout logs: a session's exercises and sets, logged by the member (portal), their trainer or a
 * manager. A workout can be dated up to 7 days back and changed or deleted for 7 days after its date. Personal
 * records and the charts are computed from the sets when read (records.ts).
 */
export const EDIT_DAYS = 7;

export type Source = 'member' | 'trainer' | 'desk';

export function workoutWire(w: WorkoutRow, sets: readonly SetRow[], today: string) {
    const mine = sets.filter(s => s.workout_oid === w.oid);
    const exercises: {
        exercise_oid: string;
        name: string;
        measure: string;
        sets: { set_no: number; weight_kg: number | null; reps: number | null; seconds: number | null; distance_m: number | null }[];
    }[] = [];
    for (const s of mine) {
        let e = exercises.at(-1);
        if (e?.exercise_oid !== s.exercise_oid || exercises.length - 1 !== s.position) {
            e = { exercise_oid: s.exercise_oid, name: s.exercise_name, measure: s.measure, sets: [] };
            exercises.push(e);
        }
        e.sets.push({ set_no: s.set_no, weight_kg: s.weight_kg, reps: s.reps, seconds: s.seconds, distance_m: s.distance_m });
    }
    return {
        oid: w.oid,
        member_oid: w.member_oid,
        routine_oid: w.routine_oid,
        day_index: w.day_index,
        day_name: w.day_name,
        performed_on: w.performed_on,
        minutes: w.minutes,
        notes: w.notes,
        source: w.source,
        logged_by_name: w.logged_by_name,
        set_count: mine.length,
        volume_kg: volumeKg(mine),
        editable: daysBetween(w.performed_on, today) <= EDIT_DAYS,
        exercises
    };
}

/** The source of a staff caller's log: a trainer's, or the desk's (managers included). */
export async function staffSource(tx: Queryable, caller: Caller): Promise<Source> {
    const [row] = await tx.query<{ ok: boolean }>(sql`select exists (select from trainer where user_oid = ${caller.userOid}) as ok`);
    return row?.ok ? 'trainer' : 'desk';
}

function checkDate(performedOn: string, today: string): void {
    if (performedOn > today) throw new AppError(400, 'A workout cannot be in the future', [{ path: 'performed_on', message: 'In the future' }]);
    if (daysBetween(performedOn, today) > EDIT_DAYS)
        throw new AppError(400, `Log a workout within ${EDIT_DAYS} days`, [{ path: 'performed_on', message: `At most ${EDIT_DAYS} days back` }]);
}

async function writeSets(tx: Queryable, ctx: BranchContext, workoutOid: string, memberOid: string, exercises: WorkoutCreate['exercises']): Promise<void> {
    const oids = [...new Set(exercises.map(e => e.exercise_oid))];
    const found = new Map((await trainingRepo.exercisesByOid(tx, oids, ctx.branchOid)).map(e => [e.oid, e]));
    await tx.query(sql`delete from workout_set where workout_oid = ${workoutOid}`);
    for (const [position, x] of exercises.entries()) {
        const e = found.get(x.exercise_oid);
        if (!e) throw new AppError(400, 'Choose an exercise from the library', [{ path: `exercises.${position}.exercise_oid`, message: 'Unknown exercise' }]);
        for (const [i, s] of x.sets.entries()) {
            const problem = checkSet(e.measure, s);
            if (problem)
                throw new AppError(400, `${e.name}, set ${i + 1}: ${problem.toLowerCase()}`, [{ path: `exercises.${position}.sets.${i}`, message: problem }]);
            await tx.query(sql`
                insert into workout_set (branch_oid, workout_oid, member_oid, position, set_no, exercise_oid, exercise_name, measure, weight_kg, reps, seconds, distance_m)
                values (${ctx.branchOid}, ${workoutOid}, ${memberOid}, ${position}, ${i + 1}, ${e.oid}, ${e.name}, ${e.measure}, ${s.weight_kg ?? null},
                    ${s.reps ?? null}, ${s.seconds ?? null}, ${s.distance_m ?? null})`);
        }
    }
}

/** The running routine's day for `day_index`, or none. */
async function routineDay(tx: Queryable, memberOid: string, dayIndex: number | null | undefined) {
    if (dayIndex === null || dayIndex === undefined) return { routine_oid: null, day_index: null, day_name: null };
    const running = await trainingRepo.running(tx, memberOid);
    const day = running?.days[dayIndex];
    if (!running || !day) throw new AppError(400, 'That day is not in the running routine', [{ path: 'day_index', message: 'Not a routine day' }]);
    return { routine_oid: running.oid, day_index: dayIndex, day_name: day.name };
}

async function read(tx: Queryable, ctx: BranchContext, oid: string, today: string) {
    const w = await trainingRepo.workout(tx, oid, ctx.branchOid);
    if (!w) throw new Error('Workout missing inside its own transaction');
    return workoutWire(w, await trainingRepo.setsOf(tx, [oid]), today);
}

/** `GET /v1/members/:oid/workouts` and the portal's: the latest first. */
export async function listWorkouts(deps: TrainingDeps, ctx: BranchContext, memberOid: string, today: string, limit = 30) {
    return withBranchTx(deps.db, ctx, async tx => {
        if (!(await trainingRepo.member(tx, memberOid, ctx.branchOid))) throw new AppError(404, 'Member not found');
        const rows = await trainingRepo.workouts(tx, memberOid, limit);
        const sets = rows.length
            ? await trainingRepo.setsOf(
                  tx,
                  rows.map(w => w.oid)
              )
            : [];
        return rows.map(w => workoutWire(w, sets, today));
    });
}

/** `POST /v1/members/:oid/workouts` (caller: staff) and `POST /v1/me/workouts` (caller null: the member). */
export async function logWorkout(deps: TrainingDeps, ctx: BranchContext, caller: Caller | null, memberOid: string, today: string, input: WorkoutCreate) {
    checkDate(input.performed_on, today);
    return withBranchTx(deps.db, ctx, async tx => {
        const m = await trainingMember(tx, ctx, caller, memberOid, true);
        const source: Source = caller ? await staffSource(tx, caller) : 'member';
        const day = await routineDay(tx, memberOid, input.day_index);
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into workout (branch_oid, member_oid, routine_oid, day_index, day_name, performed_on, minutes, notes, source, logged_by, logged_by_name)
            values (${ctx.branchOid}, ${memberOid}, ${day.routine_oid}, ${day.day_index}, ${day.day_name}, ${input.performed_on}, ${input.minutes ?? null},
                ${input.notes ?? null}, ${source}, ${ctx.actor?.oid ?? null}, ${ctx.actor?.name ?? null})
            returning oid`);
        if (!row) throw new Error('Workout insert returned nothing');
        await writeSets(tx, ctx, row.oid, memberOid, input.exercises);
        const after = await read(tx, ctx, row.oid, today);
        await recordAudit(tx, ctx, { action: 'create', entity: 'workout', entityKey: row.oid, before: null, after: { member: m.code, ...after } });
        return after;
    });
}

/** A workout the caller may change: this branch, within the 7 days; a member only their own. */
async function editable(tx: Queryable, ctx: BranchContext, caller: Caller | null, oid: string, today: string, memberOid: string | null) {
    const w = await trainingRepo.workout(tx, oid, ctx.branchOid, true);
    if (!w || (memberOid && w.member_oid !== memberOid)) throw new AppError(404, 'Workout not found');
    await trainingMember(tx, ctx, caller, w.member_oid);
    if (daysBetween(w.performed_on, today) > EDIT_DAYS) throw new AppError(409, `A workout can be changed for ${EDIT_DAYS} days after its date`);
    return w;
}

/** `PATCH /v1/workouts/:oid`, `PATCH /v1/me/workouts/:oid`: the sets are replaced when sent. */
export async function updateWorkout(
    deps: TrainingDeps,
    ctx: BranchContext,
    caller: Caller | null,
    oid: string,
    today: string,
    input: WorkoutUpdate,
    memberOid: string | null = null
) {
    if (input.performed_on) checkDate(input.performed_on, today);
    return withBranchTx(deps.db, ctx, async tx => {
        const w = await editable(tx, ctx, caller, oid, today, memberOid);
        const before = await read(tx, ctx, oid, today);
        const day =
            input.day_index === undefined
                ? { routine_oid: w.routine_oid, day_index: w.day_index, day_name: w.day_name }
                : await routineDay(tx, w.member_oid, input.day_index);
        await tx.query(sql`
            update workout set performed_on = ${input.performed_on ?? w.performed_on}, minutes = ${input.minutes === undefined ? w.minutes : input.minutes},
                notes = ${input.notes === undefined ? w.notes : input.notes}, routine_oid = ${day.routine_oid}, day_index = ${day.day_index},
                day_name = ${day.day_name}, updated_at = now()
            where oid = ${oid}`);
        if (input.exercises) await writeSets(tx, ctx, oid, w.member_oid, input.exercises);
        const after = await read(tx, ctx, oid, today);
        await recordAudit(tx, ctx, { action: 'update', entity: 'workout', entityKey: oid, before, after });
        return after;
    });
}

export async function deleteWorkout(
    deps: TrainingDeps,
    ctx: BranchContext,
    caller: Caller | null,
    oid: string,
    today: string,
    memberOid: string | null = null
) {
    await withBranchTx(deps.db, ctx, async tx => {
        await editable(tx, ctx, caller, oid, today, memberOid);
        const before = await read(tx, ctx, oid, today);
        await tx.query(sql`delete from workout where oid = ${oid}`);
        await recordAudit(tx, ctx, { action: 'delete', entity: 'workout', entityKey: oid, before, after: null });
    });
}

/** Weeks shown in the "workouts a week" bars. */
const WEEKS = 12;

/**
 * `GET /v1/members/:oid/progress` and the portal's: personal records per exercise, a line per exercise for
 * the charts, workouts a week for 12 weeks, and the totals.
 */
export async function progress(deps: TrainingDeps, ctx: BranchContext, memberOid: string, today: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        if (!(await trainingRepo.member(tx, memberOid, ctx.branchOid))) throw new AppError(404, 'Member not found');
        const sets = await trainingRepo.memberSets(tx, memberOid);
        const first = addDays(weekStart(today), -7 * (WEEKS - 1));
        const days = await trainingRepo.weekly(tx, memberOid, first);
        const weekly = Array.from({ length: WEEKS }, (_, i) => {
            const week = addDays(first, 7 * i);
            const end = addDays(week, 6);
            return { week, workouts: days.filter(d => d.performed_on >= week && d.performed_on <= end).length };
        });
        const [totals] = await tx.query<{ workouts: number; this_month: number; first_on: string | null }>(sql`
            select count(*)::int as workouts, count(*) filter (where performed_on >= date_trunc('month', ${today}::date))::int as this_month,
                min(performed_on)::text as first_on
            from workout where member_oid = ${memberOid}`);
        return {
            records: personalRecords(sets),
            series: progressSeries(sets),
            weekly,
            totals: { workouts: totals?.workouts ?? 0, this_month: totals?.this_month ?? 0, first_on: totals?.first_on ?? null, volume_kg: volumeKg(sets) }
        };
    });
}
