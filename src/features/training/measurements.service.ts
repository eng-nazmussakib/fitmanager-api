import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { filesRepo } from '#src/features/files/files.repo.ts';
import { claimKindFile, viewUrl } from '#src/features/files/files.service.ts';
import { schedulingRepo } from '#src/features/scheduling/scheduling.repo.ts';
import type { Caller } from '#src/features/scheduling/trainers.service.ts';
import { daysBetween } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import type { TrainingDeps } from './exercises.service.ts';
import { bmi } from './records.ts';
import { trainingMember } from './routines.service.ts';
import { type MeasurementRow, type TrainingMember, trainingRepo } from './training.repo.ts';
import type { MeasurementCreate } from './training.schema.ts';
import { staffSource } from './workouts.service.ts';

/**
 * Body measurements (phase 4, D-089): weight, body fat and tape measurements on a day, with up to 3 progress photos
 * (front, side, back; small, D-085). Recorded by the member (portal), their trainer or the desk; the source is shown.
 * The photos are private: the member, their home branch's desk and managers, and their own trainer (another trainer
 * at the branch sees the numbers, not the photos). BMI comes from the member's height, when read.
 */
const PHOTOS = ['front', 'side', 'back'] as const;
/** A member deletes their own entry for this many days; staff with `update Measurement` any time. */
export const MEMBER_DELETE_DAYS = 7;

/** May this caller see the member's photos? A trainer only their own clients' (null caller: the member). */
async function seesPhotos(tx: Queryable, caller: Caller | null, m: TrainingMember): Promise<boolean> {
    if (!caller?.selfOnly) return true;
    const mine = await schedulingRepo.trainerByUser(tx, caller.userOid);
    return m.trainer_oid !== null && mine?.oid === m.trainer_oid;
}

const FIELDS = ['weight_kg', 'body_fat_pct', 'waist_cm', 'chest_cm', 'hips_cm', 'arm_cm', 'thigh_cm'] as const;

/** What the audit log keeps of an entry. */
function summary(code: string | null, r: MeasurementRow) {
    return {
        member: code,
        measured_on: r.measured_on,
        source: r.source,
        recorded: FIELDS.filter(f => r[f] !== null),
        photos: PHOTOS.filter(p => r[`photo_${p}_oid`]).length
    };
}

async function measurementWire(deps: TrainingDeps, r: MeasurementRow, heightCm: number | null, photos: boolean, today: string, member: boolean) {
    const ids = { front: r.photo_front_oid, side: r.photo_side_oid, back: r.photo_back_oid };
    const urls: Record<(typeof PHOTOS)[number], string | null> = { front: null, side: null, back: null };
    if (photos) for (const p of PHOTOS) urls[p] = ids[p] ? await viewUrl(deps, { oid: ids[p], branch_oid: r.branch_oid }) : null;
    return {
        oid: r.oid,
        measured_on: r.measured_on,
        weight_kg: r.weight_kg,
        body_fat_pct: r.body_fat_pct,
        waist_cm: r.waist_cm,
        chest_cm: r.chest_cm,
        hips_cm: r.hips_cm,
        arm_cm: r.arm_cm,
        thigh_cm: r.thigh_cm,
        bmi: bmi(r.weight_kg, heightCm),
        photos: urls,
        photo_count: PHOTOS.filter(p => ids[p]).length,
        photos_hidden: !photos && PHOTOS.some(p => ids[p]),
        notes: r.notes,
        source: r.source,
        recorded_by_name: r.recorded_by_name,
        created_at: r.created_at,
        deletable: !member || (r.source === 'member' && daysBetween(r.measured_on, today) <= MEMBER_DELETE_DAYS)
    };
}

async function listIn(deps: TrainingDeps, tx: Queryable, ctx: BranchContext, caller: Caller | null, memberOid: string, today: string) {
    const m = await trainingRepo.member(tx, memberOid, ctx.branchOid);
    if (!m) throw new AppError(404, 'Member not found');
    const photos = await seesPhotos(tx, caller, m);
    const rows = await trainingRepo.measurements(tx, memberOid);
    return {
        height_cm: m.height_cm,
        rows: await Promise.all(rows.map(r => measurementWire(deps, r, m.height_cm, photos, today, caller === null)))
    };
}

/** `GET /v1/members/:oid/measurements` (caller: staff) and `GET /v1/me/measurements` (caller null). */
export async function listMeasurements(deps: TrainingDeps, ctx: BranchContext, caller: Caller | null, memberOid: string, today: string) {
    return withBranchTx(deps.db, ctx, tx => listIn(deps, tx, ctx, caller, memberOid, today));
}

/**
 * `POST /v1/members/:oid/measurements` and `POST /v1/me/measurements`. The photos were uploaded first (kind
 * `measurement_photo`, at the home branch); they are linked to the member, so "delete my data" removes them.
 */
export async function recordMeasurement(
    deps: TrainingDeps,
    ctx: BranchContext,
    caller: Caller | null,
    memberOid: string,
    today: string,
    input: MeasurementCreate
) {
    if (input.measured_on > today) throw new AppError(400, 'A measurement cannot be in the future', [{ path: 'measured_on', message: 'In the future' }]);
    if (daysBetween(input.measured_on, today) > 30)
        throw new AppError(400, 'Record a measurement within 30 days', [{ path: 'measured_on', message: 'At most 30 days back' }]);
    return withBranchTx(deps.db, ctx, async tx => {
        const m = await trainingMember(tx, ctx, caller, memberOid, true);
        const photoOids = [input.photo_front_oid, input.photo_side_oid, input.photo_back_oid].filter((x): x is string => Boolean(x));
        if (new Set(photoOids).size !== photoOids.length) throw new AppError(400, 'Use a different photo for each view');
        for (const oid of photoOids) await claimKindFile(tx, ctx.branchOid, oid, 'measurement_photo', memberOid);
        const source = caller ? await staffSource(tx, caller) : 'member';
        if (input.height_cm !== undefined && input.height_cm !== null) {
            await tx.query(sql`update member set height_cm = ${input.height_cm}, updated_at = now() where oid = ${memberOid}`);
        }
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into measurement (branch_oid, member_oid, measured_on, weight_kg, body_fat_pct, waist_cm, chest_cm, hips_cm, arm_cm, thigh_cm,
                photo_front_oid, photo_side_oid, photo_back_oid, notes, source, recorded_by, recorded_by_name)
            values (${ctx.branchOid}, ${memberOid}, ${input.measured_on}, ${input.weight_kg ?? null}, ${input.body_fat_pct ?? null}, ${input.waist_cm ?? null},
                ${input.chest_cm ?? null}, ${input.hips_cm ?? null}, ${input.arm_cm ?? null}, ${input.thigh_cm ?? null}, ${input.photo_front_oid ?? null},
                ${input.photo_side_oid ?? null}, ${input.photo_back_oid ?? null}, ${input.notes ?? null}, ${source}, ${ctx.actor?.oid ?? null},
                ${ctx.actor?.name ?? null})
            returning oid`);
        if (!row) throw new Error('Measurement insert returned nothing');
        const saved = await trainingRepo.measurement(tx, row.oid, ctx.branchOid);
        await recordAudit(tx, ctx, {
            action: 'create',
            entity: 'measurement',
            entityKey: row.oid,
            before: null,
            // Which fields, not the values: body data stays out of the append-only log, so "delete my data" removes it.
            after: saved && summary(m.code, saved)
        });
        return listIn(deps, tx, ctx, caller, memberOid, today);
    });
}

/** `DELETE /v1/measurements/:oid` (staff) and `/v1/me/measurements/:oid` (the member's own, for 7 days): photos too. */
export async function deleteMeasurement(
    deps: TrainingDeps,
    ctx: BranchContext,
    caller: Caller | null,
    oid: string,
    today: string,
    memberOid: string | null = null
) {
    const keys = await withBranchTx(deps.db, ctx, async tx => {
        const r = await trainingRepo.measurement(tx, oid, ctx.branchOid);
        if (!r || (memberOid && r.member_oid !== memberOid)) throw new AppError(404, 'Measurement not found');
        await trainingMember(tx, ctx, caller, r.member_oid);
        if (memberOid && (r.source !== 'member' || daysBetween(r.measured_on, today) > MEMBER_DELETE_DAYS))
            throw new AppError(409, `You can delete your own entries for ${MEMBER_DELETE_DAYS} days. Ask the desk for older ones.`);
        await tx.query(sql`delete from measurement where oid = ${oid}`);
        const dropped: string[] = [];
        for (const f of [r.photo_front_oid, r.photo_side_oid, r.photo_back_oid]) {
            if (!f) continue;
            const file = await filesRepo.get(tx, f, [ctx.branchOid], true);
            if (!file || file.status === 'deleted') continue;
            await filesRepo.setStatus(tx, f, 'deleted', { actor: ctx.actor?.oid });
            dropped.push(file.storage_key);
        }
        await recordAudit(tx, ctx, { action: 'delete', entity: 'measurement', entityKey: oid, before: summary(null, r), after: null });
        return dropped;
    });
    for (const key of keys) await deps.files.delete(key).catch(() => undefined);
}
