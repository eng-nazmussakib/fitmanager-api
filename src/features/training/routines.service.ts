import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { schedulingRepo } from '#src/features/scheduling/scheduling.repo.ts';
import type { Caller } from '#src/features/scheduling/trainers.service.ts';
import { AppError } from '#src/lib/http.ts';

import type { TrainingDeps } from './exercises.service.ts';
import { type DayExercise, type RoutineDay, type RoutineRow, type TrainingMember, trainingRepo } from './training.repo.ts';
import type { AssignInput, RoutineCreate, RoutineUpdate } from './training.schema.ts';

/**
 * Routines (phase 4, D-087). A template is HQ's (read by every branch) or a branch's own, built by its trainers or
 * manager. A member's routine is a SNAPSHOT copy: made from a template (or built for them) when assigned, then
 * edited on its own. One runs at a time; assigning another ends it. Days rotate: the next day is the one after the
 * last workout logged on the routine, whatever the date. A member may start an HQ template themselves (portal).
 */

export function routineWire(r: RoutineRow, branchOid: string, next: { day: number; last_on: string | null } | null = null) {
    return {
        oid: r.oid,
        scope: r.member_oid ? ('member' as const) : r.hq ? ('hq' as const) : ('branch' as const),
        name: r.name,
        goal: r.goal,
        level: r.level,
        description: r.description,
        days: r.days,
        exercise_count: r.days.reduce((n, d) => n + d.exercises.length, 0),
        trainer_oid: r.trainer_oid,
        trainer_name: r.trainer_name,
        active: r.active,
        editable: r.branch_oid === branchOid,
        member_oid: r.member_oid,
        source_oid: r.source_oid,
        source_name: r.source_name,
        assigned_by: r.assigned_by,
        started_on: r.started_on,
        ended_on: r.ended_on,
        next_day: next?.day ?? null,
        last_workout_on: next?.last_on ?? null
    };
}

/** The day after the last one logged on this routine (D-087). */
export async function nextDay(tx: Queryable, r: RoutineRow): Promise<{ day: number; last_on: string | null }> {
    const last = await trainingRepo.lastOnRoutine(tx, r.oid);
    if (last?.day_index === null || last?.day_index === undefined) return { day: 0, last_on: last?.performed_on ?? null };
    return { day: (last.day_index + 1) % r.days.length, last_on: last.performed_on };
}

/** The caller's trainer profile, when they have one (a trainer building or assigning). */
async function callerTrainer(tx: Queryable, caller: Caller): Promise<{ oid: string; name: string } | null> {
    const t = await schedulingRepo.trainerByUser(tx, caller.userOid);
    return t ? { oid: t.oid, name: t.name } : null;
}

/**
 * A member at this branch whose training the caller may change: a trainer only their own clients (D-086).
 * Exported for workouts and measurements.
 */
export async function trainingMember(tx: Queryable, ctx: BranchContext, caller: Caller | null, memberOid: string, forUpdate = false): Promise<TrainingMember> {
    const m = await trainingRepo.member(tx, memberOid, ctx.branchOid, forUpdate);
    if (!m) throw new AppError(404, 'Member not found');
    if (m.anonymised) throw new AppError(409, 'This member was anonymised');
    if (caller?.selfOnly) {
        const mine = await callerTrainer(tx, caller);
        if (m.trainer_oid === null || m.trainer_oid !== mine?.oid) throw new AppError(403, "Only the member's own trainer, the desk or a manager can do this");
    }
    return m;
}

/** Fills each exercise's name and measure from the library, and checks its targets (D-087). */
async function resolveDays(tx: Queryable, ctx: BranchContext, days: RoutineCreate['days'], keep: readonly string[] = []): Promise<RoutineDay[]> {
    const oids = [...new Set(days.flatMap(d => d.exercises.map(e => e.exercise_oid)))];
    const found = new Map((await trainingRepo.exercisesByOid(tx, oids, ctx.branchOid)).map(e => [e.oid, e]));
    return days.map((d, di) => ({
        name: d.name,
        exercises: d.exercises.map((x, xi): DayExercise => {
            const e = found.get(x.exercise_oid);
            const path = `days.${di}.exercises.${xi}`;
            if (!e || (!e.active && !keep.includes(e.oid)))
                throw new AppError(400, 'Choose an exercise from the library', [{ path, message: 'Unknown exercise' }]);
            const problem =
                (e.measure === 'weight_reps' || e.measure === 'reps') && !x.reps
                    ? 'Enter the reps'
                    : e.measure === 'time' && !x.seconds
                      ? 'Enter the time'
                      : e.measure === 'distance_time' && !x.seconds && !x.distance_m
                        ? 'Enter a distance or a time'
                        : null;
            if (problem) throw new AppError(400, `${e.name}: ${problem.toLowerCase()}`, [{ path, message: problem }]);
            const has = (m: typeof e.measure, ...ok: (typeof e.measure)[]) => ok.includes(m);
            return {
                exercise_oid: e.oid,
                name: e.name,
                measure: e.measure,
                sets: x.sets,
                reps: has(e.measure, 'weight_reps', 'reps') ? (x.reps ?? null) : null,
                weight_kg: e.measure === 'weight_reps' ? (x.weight_kg ?? null) : null,
                seconds: has(e.measure, 'time', 'distance_time') ? (x.seconds ?? null) : null,
                distance_m: e.measure === 'distance_time' ? (x.distance_m ?? null) : null,
                rest_seconds: x.rest_seconds,
                notes: x.notes ?? null
            };
        })
    }));
}

const exerciseOids = (r: RoutineRow) => r.days.flatMap(d => d.exercises.map(e => e.exercise_oid));

/* ---------- templates ---------- */

/** `GET /v1/routines`: HQ's templates and this branch's (at HQ: HQ's). */
export async function listTemplates(deps: TrainingDeps, ctx: BranchContext, all = false) {
    const rows = await withBranchTx(deps.db, ctx, tx => trainingRepo.templates(tx, ctx.branchOid, { all }));
    return rows.map(r => routineWire(r, ctx.branchOid));
}

export async function getRoutine(deps: TrainingDeps, ctx: BranchContext, oid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const r = await trainingRepo.routine(tx, oid, ctx.branchOid);
        if (!r) throw new AppError(404, 'Routine not found');
        return routineWire(r, ctx.branchOid, r.member_oid && !r.ended_on ? await nextDay(tx, r) : null);
    });
}

async function insertRoutine(
    tx: Queryable,
    ctx: BranchContext,
    input: RoutineCreate,
    days: RoutineDay[],
    extra: { member_oid?: string; source_oid?: string | null; trainer?: { oid: string; name: string } | null; assigned_by?: string; started_on?: string }
): Promise<RoutineRow> {
    const [row] = await tx.query<{ oid: string }>(sql`
        insert into routine (branch_oid, member_oid, source_oid, name, goal, level, description, days, trainer_oid, trainer_name, assigned_by,
            started_on, created_by, updated_by)
        values (${ctx.branchOid}, ${extra.member_oid ?? null}, ${extra.source_oid ?? null}, ${input.name}, ${input.goal}, ${input.level},
            ${input.description ?? null}, ${JSON.stringify(days)}::jsonb, ${extra.trainer?.oid ?? null}, ${extra.trainer?.name ?? null},
            ${extra.assigned_by ?? null}, ${extra.started_on ?? null}, ${ctx.actor?.oid ?? null}, ${ctx.actor?.oid ?? null})
        returning oid`);
    const saved = row && (await trainingRepo.routine(tx, row.oid, ctx.branchOid));
    if (!saved) throw new Error('Routine missing inside its own transaction');
    return saved;
}

/** `POST /v1/routines`: a template of this branch (HQ's at HQ). A trainer's carries their name. */
export async function createTemplate(deps: TrainingDeps, ctx: BranchContext, caller: Caller, input: RoutineCreate) {
    const row = await withBranchTx(deps.db, ctx, async tx => {
        const days = await resolveDays(tx, ctx, input.days);
        const saved = await insertRoutine(tx, ctx, input, days, { trainer: await callerTrainer(tx, caller) });
        await recordAudit(tx, ctx, { action: 'create', entity: 'routine', entityKey: saved.oid, before: null, after: saved });
        return saved;
    });
    return routineWire(row, ctx.branchOid);
}

/**
 * `PATCH /v1/routines/:oid`: a template of this branch, or a member's running routine. A trainer changes only the
 * templates they built and their own clients' routines.
 */
export async function updateRoutine(deps: TrainingDeps, ctx: BranchContext, caller: Caller, oid: string, input: RoutineUpdate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await trainingRepo.routine(tx, oid, ctx.branchOid);
        if (!before) throw new AppError(404, 'Routine not found');
        if (before.branch_oid !== ctx.branchOid) throw new AppError(403, 'This routine is an HQ template: only HQ can change it');
        if (before.ended_on) throw new AppError(409, 'This routine has ended: assign a new one instead');
        if (before.member_oid) await trainingMember(tx, ctx, caller, before.member_oid);
        else if (caller.selfOnly) {
            const mine = await callerTrainer(tx, caller);
            if (before.trainer_oid === null || before.trainer_oid !== mine?.oid)
                throw new AppError(403, 'Only the trainer who built this template, or a manager, can change it');
        }
        if (before.member_oid && input.active !== undefined)
            throw new AppError(400, 'End the routine instead', [{ path: 'active', message: 'Templates only' }]);
        const days = input.days ? await resolveDays(tx, ctx, input.days, exerciseOids(before)) : before.days;
        if (before.member_oid && input.days && input.days.length !== before.days.length) {
            // The rotation follows the day index: keep it in range.
            await tx.query(sql`update workout set day_index = null where routine_oid = ${oid} and day_index >= ${input.days.length}`);
        }
        await tx.query(sql`
            update routine set name = ${input.name ?? before.name}, goal = ${input.goal ?? before.goal}, level = ${input.level ?? before.level},
                description = ${input.description === undefined ? before.description : input.description}, days = ${JSON.stringify(days)}::jsonb,
                active = ${input.active ?? before.active}, updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
            where oid = ${oid}`);
        const after = await trainingRepo.routine(tx, oid, ctx.branchOid);
        if (!after) throw new Error('Routine missing inside its own transaction');
        await recordAudit(tx, ctx, { action: 'update', entity: 'routine', entityKey: oid, before, after });
        return routineWire(after, ctx.branchOid, after.member_oid ? await nextDay(tx, after) : null);
    });
}

/* ---------- a member's routine ---------- */

/** `GET /v1/members/:oid/routine` and the portal: the running routine with its next day, and the ended ones. */
export async function memberRoutine(deps: TrainingDeps, ctx: BranchContext, memberOid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        if (!(await trainingRepo.member(tx, memberOid, ctx.branchOid))) throw new AppError(404, 'Member not found');
        return memberRoutineIn(tx, ctx, memberOid);
    });
}

export async function memberRoutineIn(tx: Queryable, ctx: BranchContext, memberOid: string) {
    const rows = await trainingRepo.memberRoutines(tx, memberOid, ctx.branchOid);
    const running = rows.find(r => !r.ended_on);
    return {
        current: running ? routineWire(running, ctx.branchOid, await nextDay(tx, running)) : null,
        history: rows.filter(r => r.ended_on).map(r => routineWire(r, ctx.branchOid))
    };
}

async function startRoutine(
    tx: Queryable,
    ctx: BranchContext,
    m: TrainingMember,
    today: string,
    from: { template: RoutineRow } | { routine: RoutineCreate },
    by: { trainer: { oid: string; name: string } | null; assigned_by: 'trainer' | 'staff' | 'member' }
): Promise<RoutineRow> {
    const running = await trainingRepo.running(tx, m.oid, true);
    if (running) {
        await tx.query(
            sql`update routine set ended_on = greatest(${today}::date, started_on), updated_at = now(), updated_by = ${ctx.actor?.oid ?? null} where oid = ${running.oid}`
        );
        await recordAudit(tx, ctx, {
            action: 'end',
            entity: 'routine',
            entityKey: running.oid,
            before: { ended_on: null },
            after: { ended_on: today, replaced: true }
        });
    }
    const input: RoutineCreate =
        'template' in from
            ? {
                  name: from.template.name,
                  goal: from.template.goal as RoutineCreate['goal'],
                  level: from.template.level as RoutineCreate['level'],
                  description: from.template.description,
                  days: []
              }
            : from.routine;
    const days = 'template' in from ? from.template.days : await resolveDays(tx, ctx, from.routine.days);
    const saved = await insertRoutine(tx, ctx, input, days, {
        member_oid: m.oid,
        source_oid: 'template' in from ? from.template.oid : null,
        trainer: by.trainer,
        assigned_by: by.assigned_by,
        started_on: today
    });
    await recordAudit(tx, ctx, {
        action: 'assign',
        entity: 'routine',
        entityKey: saved.oid,
        before: running ? { routine_oid: running.oid } : null,
        after: { member: m.code, ...saved }
    });
    return saved;
}

async function template(tx: Queryable, ctx: BranchContext, oid: string, hqOnly = false): Promise<RoutineRow> {
    const t = await trainingRepo.routine(tx, oid, ctx.branchOid);
    if (!t || t.member_oid || !t.active || (hqOnly && !t.hq)) throw new AppError(404, 'Routine not found');
    return t;
}

/**
 * `POST /v1/members/:oid/routine`: a copy of a template, or a routine built for this member, which replaces the
 * running one. The trainer on it: the caller if they are a trainer, or else the member's trainer.
 */
export async function assignRoutine(deps: TrainingDeps, ctx: BranchContext, caller: Caller, memberOid: string, today: string, input: AssignInput) {
    return withBranchTx(deps.db, ctx, async tx => {
        const m = await trainingMember(tx, ctx, caller, memberOid, true);
        const mine = await callerTrainer(tx, caller);
        const memberTrainer = !mine && m.trainer_oid ? await schedulingRepo.trainer(tx, m.trainer_oid, ctx.branchOids) : undefined;
        const trainer = mine ?? (memberTrainer ? { oid: memberTrainer.oid, name: memberTrainer.name } : null);
        const from = 'template_oid' in input ? { template: await template(tx, ctx, input.template_oid) } : { routine: input.routine };
        await startRoutine(tx, ctx, m, today, from, { trainer, assigned_by: mine ? 'trainer' : 'staff' });
        return memberRoutineIn(tx, ctx, memberOid);
    });
}

/** `POST /v1/members/:oid/routine/end` (and the portal's): ends the running routine today. */
export async function endRoutine(deps: TrainingDeps, ctx: BranchContext, caller: Caller | null, memberOid: string, today: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        await trainingMember(tx, ctx, caller, memberOid, true);
        const running = await trainingRepo.running(tx, memberOid, true);
        if (!running) throw new AppError(409, 'No routine is running');
        await tx.query(
            sql`update routine set ended_on = greatest(${today}::date, started_on), updated_at = now(), updated_by = ${ctx.actor?.oid ?? null} where oid = ${running.oid}`
        );
        await recordAudit(tx, ctx, { action: 'end', entity: 'routine', entityKey: running.oid, before: { ended_on: null }, after: { ended_on: today } });
        return memberRoutineIn(tx, ctx, memberOid);
    });
}

/* ---------- the member portal ---------- */

/** `GET /v1/me/routine/templates`: the HQ templates a member may start on their own. */
export async function portalTemplates(deps: TrainingDeps, ctx: BranchContext) {
    const rows = await withBranchTx(deps.db, ctx, tx => trainingRepo.templates(tx, ctx.branchOid, { hqOnly: true }));
    return rows.map(r => routineWire(r, ctx.branchOid));
}

/** `POST /v1/me/routine`: the member starts an HQ template; it replaces a routine they started themselves only. */
export async function portalStart(deps: TrainingDeps, ctx: BranchContext, memberOid: string, today: string, templateOid: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const m = await trainingMember(tx, ctx, null, memberOid, true);
        const running = await trainingRepo.running(tx, memberOid);
        if (running && running.assigned_by !== 'member')
            throw new AppError(409, `Your trainer set your routine (${running.name}). Ask them to change it, or end it first.`);
        const t = await template(tx, ctx, templateOid, true);
        await startRoutine(tx, ctx, m, today, { template: t }, { trainer: null, assigned_by: 'member' });
        return memberRoutineIn(tx, ctx, memberOid);
    });
}
