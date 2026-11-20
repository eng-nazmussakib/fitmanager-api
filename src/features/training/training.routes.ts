import { type Request, Router } from 'express';
import * as v from 'valibot';

import { isGuest } from '#src/auth/guest.ts';
import { authenticate, currentUser, requireAbility, requireAnyBranch, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { completeUpload, type FileDeps, startUpload } from '#src/features/files/files.service.ts';
import { memberContext } from '#src/features/portal/portal.service.ts';
import type { Caller } from '#src/features/scheduling/trainers.service.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { ok, parse } from '#src/lib/http.ts';

import { createExercise, getExercise, listExercises, type TrainingDeps, updateExercise } from './exercises.service.ts';
import { deleteMeasurement, listMeasurements, recordMeasurement } from './measurements.service.ts';
import {
    assignRoutine,
    createTemplate,
    endRoutine,
    getRoutine,
    listTemplates,
    memberRoutine,
    portalStart,
    portalTemplates,
    updateRoutine
} from './routines.service.ts';
import {
    assignSchema,
    exerciseCreate,
    exerciseQuery,
    exerciseUpdate,
    measurementCreate,
    oidParams,
    portalFileStart,
    portalStartSchema,
    routineCreate,
    routineUpdate,
    workoutCreate,
    workoutQuery,
    workoutUpdate
} from './training.schema.ts';
import { deleteWorkout, listWorkouts, logWorkout, progress, updateWorkout } from './workouts.service.ts';

const allQuery = v.object({ all: v.optional(v.picklist(['0', '1'])) });

/**
 * Training (phase 4; D-084 to D-089).
 *
 * Library, at a branch or HQ (`X-Branch-Id`): `GET /v1/exercises` (`read Exercise`), `GET /v1/exercises/:oid`,
 * `POST /v1/exercises` (`create Exercise`), `PATCH /v1/exercises/:oid` (`update Exercise`; a branch only its own);
 * `GET /v1/routines` (`read Routine`, templates), `GET /v1/routines/:oid`, `POST /v1/routines` (`create Routine`),
 * `PATCH /v1/routines/:oid` (`update Routine`: a template, or a member's running routine).
 * A member, at their home branch: `GET|POST /v1/members/:oid/routine`, `POST /v1/members/:oid/routine/end` (Routine);
 * `GET|POST /v1/members/:oid/workouts`, `PATCH|DELETE /v1/workouts/:oid`, `GET /v1/members/:oid/progress` (Workout);
 * `GET|POST /v1/members/:oid/measurements`, `DELETE /v1/measurements/:oid` (Measurement). A trainer writes only for
 * their own clients and sees only their clients' photos (D-086).
 * Portal: `GET /v1/me/exercises`, `GET|POST /v1/me/routine`, `GET /v1/me/routine/templates`, `POST /v1/me/routine/end`,
 * `GET|POST /v1/me/workouts`, `PATCH|DELETE /v1/me/workouts/:oid`, `GET /v1/me/progress`, `GET|POST /v1/me/measurements`,
 * `DELETE /v1/me/measurements/:oid`, `POST /v1/me/files` + `POST /v1/me/files/:oid/complete` (progress photos).
 */
export function trainingRouter(deps: AppDeps): Router {
    const router = Router();
    const t: TrainingDeps = { db: deps.db, files: deps.files, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const fileDeps: FileDeps = {
        db: deps.db,
        files: deps.files,
        jwtSecret: deps.config.auth.jwtSecret,
        apiPrefix: deps.config.apiPrefix,
        storageLimitBytes: deps.config.files.storageLimitBytes
    };
    const today = () => dhakaNow(deps.clock()).date;
    const staff = [authenticate(deps), requireAnyBranch()];
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const member = [authenticate(deps), requireAbility('read', 'Portal')];
    const caller = (req: Request): Caller => ({ userOid: currentUser(req).oid, selfOnly: req.auth?.assignment?.role === 'TRAINER' });
    const portal = async (req: Request) => memberContext(deps, currentUser(req));
    const oid = (req: Request) => parse(oidParams, req.params).oid;

    /* ---------- the library ---------- */

    router.get('/v1/exercises', ...staff, requireAbility('read', 'Exercise'), async (req, res) => {
        ok(res, await listExercises(t, branchContext(req), parse(exerciseQuery, req.query)));
    });
    router.get('/v1/exercises/:oid', ...staff, requireAbility('read', 'Exercise'), async (req, res) => {
        ok(res, await getExercise(t, branchContext(req), oid(req)));
    });
    router.post('/v1/exercises', ...staff, requireAbility('create', 'Exercise'), async (req, res) => {
        ok(res, await createExercise(t, branchContext(req), parse(exerciseCreate, req.body)), 'Exercise added', 201);
    });
    router.patch('/v1/exercises/:oid', ...staff, requireAbility('update', 'Exercise'), async (req, res) => {
        ok(res, await updateExercise(t, branchContext(req), oid(req), parse(exerciseUpdate, req.body)), 'Exercise saved');
    });

    router.get('/v1/routines', ...staff, requireAbility('read', 'Routine'), async (req, res) => {
        ok(res, await listTemplates(t, branchContext(req), parse(allQuery, req.query).all === '1'));
    });
    router.get('/v1/routines/:oid', ...staff, requireAbility('read', 'Routine'), async (req, res) => {
        ok(res, await getRoutine(t, branchContext(req), oid(req)));
    });
    router.post('/v1/routines', ...staff, requireAbility('create', 'Routine'), async (req, res) => {
        ok(res, await createTemplate(t, branchContext(req), caller(req), parse(routineCreate, req.body)), 'Routine saved', 201);
    });
    router.patch('/v1/routines/:oid', ...staff, requireAbility('update', 'Routine'), async (req, res) => {
        ok(res, await updateRoutine(t, branchContext(req), caller(req), oid(req), parse(routineUpdate, req.body)), 'Routine saved');
    });

    /* ---------- a member's training, at the home branch ---------- */

    router.get('/v1/members/:oid/routine', ...branch, requireAbility('read', 'Routine'), async (req, res) => {
        ok(res, await memberRoutine(t, branchContext(req), oid(req)));
    });
    router.post('/v1/members/:oid/routine', ...branch, requireAbility('create', 'Routine'), async (req, res) => {
        ok(res, await assignRoutine(t, branchContext(req), caller(req), oid(req), today(), parse(assignSchema, req.body)), 'Routine assigned', 201);
    });
    router.post('/v1/members/:oid/routine/end', ...branch, requireAbility('update', 'Routine'), async (req, res) => {
        ok(res, await endRoutine(t, branchContext(req), caller(req), oid(req), today()), 'Routine ended');
    });

    router.get('/v1/members/:oid/workouts', ...branch, requireAbility('read', 'Workout'), async (req, res) => {
        ok(res, await listWorkouts(t, branchContext(req), oid(req), today(), parse(workoutQuery, req.query).limit));
    });
    router.post('/v1/members/:oid/workouts', ...branch, requireAbility('create', 'Workout'), async (req, res) => {
        ok(res, await logWorkout(t, branchContext(req), caller(req), oid(req), today(), parse(workoutCreate, req.body)), 'Workout logged', 201);
    });
    router.patch('/v1/workouts/:oid', ...branch, requireAbility('update', 'Workout'), async (req, res) => {
        ok(res, await updateWorkout(t, branchContext(req), caller(req), oid(req), today(), parse(workoutUpdate, req.body)), 'Workout saved');
    });
    router.delete('/v1/workouts/:oid', ...branch, requireAbility('update', 'Workout'), async (req, res) => {
        await deleteWorkout(t, branchContext(req), caller(req), oid(req), today());
        ok(res, null, 'Workout deleted');
    });
    router.get('/v1/members/:oid/progress', ...branch, requireAbility('read', 'Workout'), async (req, res) => {
        ok(res, await progress(t, branchContext(req), oid(req), today()));
    });

    router.get('/v1/members/:oid/measurements', ...branch, requireAbility('read', 'Measurement'), async (req, res) => {
        ok(res, await listMeasurements(t, branchContext(req), caller(req), oid(req), today()));
    });
    router.post('/v1/members/:oid/measurements', ...branch, requireAbility('create', 'Measurement'), async (req, res) => {
        ok(res, await recordMeasurement(t, branchContext(req), caller(req), oid(req), today(), parse(measurementCreate, req.body)), 'Measurement saved', 201);
    });
    router.delete('/v1/measurements/:oid', ...branch, requireAbility('update', 'Measurement'), async (req, res) => {
        await deleteMeasurement(t, branchContext(req), caller(req), oid(req), today());
        ok(res, null, 'Measurement deleted');
    });

    /* ---------- the member portal ---------- */

    router.get('/v1/me/exercises', ...member, async (req, res) => {
        const { ctx } = await portal(req);
        ok(res, await listExercises(t, ctx, parse(exerciseQuery, req.query)));
    });
    router.get('/v1/me/routine', ...member, async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await memberRoutine(t, ctx, memberOid));
    });
    router.get('/v1/me/routine/templates', ...member, async (req, res) => {
        const { ctx } = await portal(req);
        ok(res, await portalTemplates(t, ctx));
    });
    router.post('/v1/me/routine', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await portalStart(t, ctx, memberOid, today(), parse(portalStartSchema, req.body).template_oid), 'Routine started', 201);
    });
    router.post('/v1/me/routine/end', ...member, requireAbility('update', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await endRoutine(t, ctx, null, memberOid, today()), 'Routine ended');
    });

    router.get('/v1/me/workouts', ...member, async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await listWorkouts(t, ctx, memberOid, today(), parse(workoutQuery, req.query).limit));
    });
    router.post('/v1/me/workouts', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await logWorkout(t, ctx, null, memberOid, today(), parse(workoutCreate, req.body)), 'Workout logged', 201);
    });
    router.patch('/v1/me/workouts/:oid', ...member, requireAbility('update', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await updateWorkout(t, ctx, null, oid(req), today(), parse(workoutUpdate, req.body), memberOid), 'Workout saved');
    });
    router.delete('/v1/me/workouts/:oid', ...member, requireAbility('delete', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        await deleteWorkout(t, ctx, null, oid(req), today(), memberOid);
        ok(res, null, 'Workout deleted');
    });
    router.get('/v1/me/progress', ...member, async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await progress(t, ctx, memberOid, today()));
    });

    router.get('/v1/me/measurements', ...member, async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await listMeasurements(t, ctx, null, memberOid, today()));
    });
    router.post('/v1/me/measurements', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await recordMeasurement(t, ctx, null, memberOid, today(), parse(measurementCreate, req.body)), 'Measurement saved', 201);
    });
    router.delete('/v1/me/measurements/:oid', ...member, requireAbility('delete', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        await deleteMeasurement(t, ctx, null, oid(req), today(), memberOid);
        ok(res, null, 'Measurement deleted');
    });

    // A member's own progress photos, stored at their home branch and linked to them from the start.
    router.post('/v1/me/files', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        const body = parse(portalFileStart, req.body);
        const out = await startUpload(fileDeps, ctx, { ...body, member_oid: memberOid }, isGuest(deps.config, currentUser(req).username));
        ok(res, out, 'Upload the file to the URL given', 201);
    });
    router.post('/v1/me/files/:oid/complete', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await completeUpload(fileDeps, ctx, oid(req), (kind, file) => kind === 'measurement_photo' && file.member_oid === memberOid), 'File saved');
    });

    return router;
}
