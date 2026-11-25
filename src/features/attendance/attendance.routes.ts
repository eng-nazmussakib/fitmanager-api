import { Router } from 'express';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { ok, parse } from '#src/lib/http.ts';

import { backdateSchema, checkInSchema, daysQuery, evaluateSchema, oidParams } from './attendance.schema.ts';
import { type AttendanceDeps, backdate, checkIn, checkOut, evaluate, memberAttendance, occupancy, today } from './attendance.service.ts';

/**
 * Attendance at the branch in `X-Branch-Id`.
 * - `POST /v1/attendance/evaluate` `{ code | member_oid }`: the access decision, nothing written
 * - `POST /v1/attendance/check-in` (`create Attendance`; an override needs `create AttendanceOverride`)
 * - `POST /v1/attendance/:oid/check-out` (`update Attendance`)
 * - `POST /v1/attendance/backdated` `{ entries: [...] }`: one or many visits after the fact (`manage Attendance`)
 * - `GET /v1/attendance/today` (visitors included), `GET /v1/attendance/occupancy`
 * - `GET /v1/members/:oid/attendance?days=`: an own member's visit days, at every branch
 * Live occupancy: the console polls `occupancy` (there is no push channel).
 */
export function attendanceRouter(deps: AppDeps): Router {
    const router = Router();
    const a: AttendanceDeps = { db: deps.db, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const now = () => dhakaNow(deps.clock());
    const canOverride = (req: Parameters<typeof branchContext>[0]) => req.auth?.ability.can('create', 'AttendanceOverride') ?? false;

    router.post('/v1/attendance/evaluate', ...branch, requireAbility('read', 'Attendance'), async (req, res) => {
        const key = parse(evaluateSchema, req.body);
        ok(res, await evaluate(a, branchContext(req), now(), key, canOverride(req)));
    });

    router.post('/v1/attendance/check-in', ...branch, requireAbility('create', 'Attendance'), async (req, res) => {
        const body = parse(checkInSchema, req.body);
        const { visit, message } = await checkIn(a, branchContext(req), now(), body, canOverride(req));
        ok(res, visit, message, 201);
    });

    router.post('/v1/attendance/backdated', ...branch, requireAbility('manage', 'Attendance'), async (req, res) => {
        const { entries } = parse(backdateSchema, req.body);
        const rows = await backdate(a, branchContext(req), now(), entries);
        ok(res, rows, rows.length === 1 ? 'Visit added' : `${rows.length} visits added`, 201);
    });

    router.post('/v1/attendance/:oid/check-out', ...branch, requireAbility('update', 'Attendance'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await checkOut(a, branchContext(req), now(), oid), 'Checked out');
    });

    router.get('/v1/attendance/today', ...branch, requireAbility('read', 'Attendance'), async (req, res) => {
        ok(res, await today(a, branchContext(req), now()));
    });

    router.get('/v1/attendance/occupancy', ...branch, requireAbility('read', 'Attendance'), async (req, res) => {
        ok(res, await occupancy(a, branchContext(req), now()));
    });

    router.get('/v1/members/:oid/attendance', ...branch, requireAbility('read', 'Attendance'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { days } = parse(daysQuery, req.query);
        ok(res, await memberAttendance(a, branchContext(req), now(), oid, days));
    });

    return router;
}
