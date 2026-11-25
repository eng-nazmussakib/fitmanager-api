import type { Db, Queryable } from '#src/db/db.ts';
import { pgErrorCode, sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { filesRepo } from '#src/features/files/files.repo.ts';
import { claimKindFile, viewUrl } from '#src/features/files/files.service.ts';
import type { FileStore } from '#src/lib/file-store.ts';
import { AppError } from '#src/lib/http.ts';

import { type ExerciseRow, trainingRepo } from './training.repo.ts';
import type { ExerciseCreate, ExerciseQuery, ExerciseUpdate } from './training.schema.ts';

/**
 * The exercise library: HQ's exercises, read by every branch, plus each branch's own. Each has up
 * to 3 small photos and a short video, uploaded through `/v1/files` at the owning branch (HQ for HQ's).
 * A branch edits only its own; HQ's are read-only there. Exercises are never deleted, only made inactive, so the
 * routines and workouts that name them keep working.
 */
export interface TrainingDeps {
    db: Db;
    files: FileStore;
    jwtSecret: string;
    apiPrefix: string;
}

type Links = Pick<TrainingDeps, 'jwtSecret' | 'apiPrefix'>;

export async function exerciseWire(deps: Links, e: ExerciseRow, branchOid: string) {
    return {
        oid: e.oid,
        branch_oid: e.branch_oid,
        scope: e.hq ? ('hq' as const) : ('branch' as const),
        name: e.name,
        category: e.category,
        measure: e.measure,
        muscles: e.muscles,
        equipment: e.equipment,
        instructions: e.instructions,
        photos: await Promise.all(e.photo_file_oids.map(async oid => ({ file_oid: oid, url: await viewUrl(deps, { oid, branch_oid: e.branch_oid }) }))),
        video: e.video_file_oid ? { file_oid: e.video_file_oid, url: await viewUrl(deps, { oid: e.video_file_oid, branch_oid: e.branch_oid }) } : null,
        active: e.active,
        editable: e.branch_oid === branchOid
    };
}

const matches = (e: ExerciseRow, q: ExerciseQuery): boolean =>
    (!q.q || e.name.toLowerCase().includes(q.q.toLowerCase())) &&
    (!q.category || e.category === q.category) &&
    (!q.muscle || e.muscles.includes(q.muscle)) &&
    (!q.equipment || e.equipment === q.equipment);

/** `GET /v1/exercises`: at a branch, HQ's and its own; at HQ, HQ's. */
export async function listExercises(deps: TrainingDeps, ctx: BranchContext, q: ExerciseQuery) {
    const rows = await withBranchTx(deps.db, ctx, tx => trainingRepo.exercises(tx, ctx.branchOid, { all: q.all === '1' }));
    return Promise.all(rows.filter(e => matches(e, q)).map(e => exerciseWire(deps, e, ctx.branchOid)));
}

export async function getExercise(deps: TrainingDeps, ctx: BranchContext, oid: string) {
    const row = await withBranchTx(deps.db, ctx, tx => trainingRepo.exercise(tx, oid, ctx.branchOid));
    if (!row) throw new AppError(404, 'Exercise not found');
    return exerciseWire(deps, row, ctx.branchOid);
}

const duplicate = (err: unknown): never => {
    if (pgErrorCode(err) === '23505') throw new AppError(409, 'An exercise with this name exists', [{ path: 'name', message: 'Already in the library' }]);
    throw err;
};

/** Claims the photos and the video named (ready files of this branch, of the right kind). */
async function claimMedia(tx: Queryable, ctx: BranchContext, photos: readonly string[] | undefined, video: string | null | undefined): Promise<void> {
    for (const oid of photos ?? []) await claimKindFile(tx, ctx.branchOid, oid, 'exercise_photo');
    if (video) await claimKindFile(tx, ctx.branchOid, video, 'exercise_video');
}

/** Marks files no longer used deleted, and returns their storage keys (deleted from the store after the commit). */
async function dropFiles(tx: Queryable, ctx: BranchContext, oids: readonly string[]): Promise<string[]> {
    const keys: string[] = [];
    for (const oid of oids) {
        const row = await filesRepo.get(tx, oid, [ctx.branchOid], true);
        if (!row || row.status === 'deleted') continue;
        await filesRepo.setStatus(tx, oid, 'deleted', { actor: ctx.actor?.oid });
        await recordAudit(tx, ctx, { action: 'delete', entity: 'file', entityKey: oid, before: { kind: row.kind, name: row.name }, after: null });
        keys.push(row.storage_key);
    }
    return keys;
}

export async function createExercise(deps: TrainingDeps, ctx: BranchContext, input: ExerciseCreate) {
    const row = await withBranchTx(deps.db, ctx, async tx => {
        await claimMedia(tx, ctx, input.photo_file_oids, input.video_file_oid);
        const [created] = await tx
            .query<{ oid: string }>(
                sql`
                insert into exercise (branch_oid, name, category, measure, muscles, equipment, instructions, photo_file_oids, video_file_oid, updated_by)
                values (${ctx.branchOid}, ${input.name}, ${input.category}, ${input.measure}, ${input.muscles}::text[], ${input.equipment},
                    ${input.instructions ?? null}, ${input.photo_file_oids ?? []}::uuid[], ${input.video_file_oid ?? null}, ${ctx.actor?.oid ?? null})
                returning oid`
            )
            .catch(duplicate);
        const saved = created && (await trainingRepo.exercise(tx, created.oid, ctx.branchOid));
        if (!saved) throw new Error('Exercise missing inside its own transaction');
        await recordAudit(tx, ctx, { action: 'create', entity: 'exercise', entityKey: saved.oid, before: null, after: saved });
        return saved;
    });
    return exerciseWire(deps, row, ctx.branchOid);
}

export async function updateExercise(deps: TrainingDeps, ctx: BranchContext, oid: string, input: ExerciseUpdate) {
    const { row, keys } = await withBranchTx(deps.db, ctx, async tx => {
        const before = await trainingRepo.exercise(tx, oid, ctx.branchOid);
        if (!before) throw new AppError(404, 'Exercise not found');
        if (before.branch_oid !== ctx.branchOid) throw new AppError(403, 'This exercise is in the HQ library: only HQ can change it');
        const newPhotos = input.photo_file_oids?.filter(f => !before.photo_file_oids.includes(f));
        const newVideo = input.video_file_oid && input.video_file_oid !== before.video_file_oid ? input.video_file_oid : null;
        await claimMedia(tx, ctx, newPhotos, newVideo);
        const photos = input.photo_file_oids ?? before.photo_file_oids;
        const video = input.video_file_oid === undefined ? before.video_file_oid : input.video_file_oid;
        await tx
            .query(
                sql`
                update exercise set
                    name = ${input.name ?? before.name}, category = ${input.category ?? before.category}, measure = ${input.measure ?? before.measure},
                    muscles = ${input.muscles ?? before.muscles}::text[], equipment = ${input.equipment ?? before.equipment},
                    instructions = ${input.instructions === undefined ? before.instructions : input.instructions},
                    photo_file_oids = ${photos}::uuid[], video_file_oid = ${video}, active = ${input.active ?? before.active},
                    updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
                where oid = ${oid}`
            )
            .catch(duplicate);
        const gone = [
            ...before.photo_file_oids.filter(f => !photos.includes(f)),
            ...(before.video_file_oid && before.video_file_oid !== video ? [before.video_file_oid] : [])
        ];
        const dropped = await dropFiles(tx, ctx, gone);
        const after = await trainingRepo.exercise(tx, oid, ctx.branchOid);
        if (!after) throw new Error('Exercise missing inside its own transaction');
        await recordAudit(tx, ctx, { action: 'update', entity: 'exercise', entityKey: oid, before, after });
        return { row: after, keys: dropped };
    });
    for (const key of keys) await deps.files.delete(key).catch(() => undefined);
    return exerciseWire(deps, row, ctx.branchOid);
}
