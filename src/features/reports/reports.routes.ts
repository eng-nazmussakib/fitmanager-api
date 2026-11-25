import { Router } from 'express';

import { authenticate, currentUser, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { sql } from '#src/db/sql.ts';
import { branchContext, withBranchTx } from '#src/db/tenancy.ts';
import { addDays, daysBetween, dhakaNow } from '#src/lib/clock.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

import type { Range } from './reports.build.ts';
import { reportParams, reportQuery, trainerParams } from './reports.schema.ts';
import { buildReport, trainerReport } from './reports.service.ts';

/**
 * Reports, read only, computed when read:
 * - `GET /v1/reports/:key?from&to&compare` at a branch (`read Report`: branch managers, HQ);
 * - `GET /v1/hq/reports/:key?from&to&compare&branch_oid` at HQ, across the user's branches (a column per branch);
 * - `GET /v1/trainers/:oid/numbers?from&to` (`read Trainer`): one trainer's PT and class counts at this branch.
 *   A trainer sees only their own; `read Report` sees any.
 * Keys: revenue, dues, members, attendance, classes, trainers, shop, operations. Default range: the last 30 days.
 */
export function reportsRouter(deps: AppDeps): Router {
    const router = Router();
    const range = (q: { from?: string | undefined; to?: string | undefined }): Range => {
        const today = dhakaNow(deps.clock()).date;
        const to = q.to ?? today;
        const from = q.from ?? addDays(to, -29);
        if (from > to) throw new AppError(400, 'Choose a valid date range.', [{ path: 'from', message: 'The start is after the end' }]);
        if (daysBetween(from, to) > 365) throw new AppError(400, 'Choose a range of at most 366 days.', [{ path: 'from', message: 'At most 366 days' }]);
        return { from, to };
    };
    const compare = (v: string | undefined) => v === '1' || v === 'true';

    router.get('/v1/reports/:key', authenticate(deps), requireBranch('BRANCH'), requireAbility('read', 'Report'), async (req, res) => {
        const { key } = parse(reportParams, req.params);
        const q = parse(reportQuery, req.query);
        const ctx = branchContext(req);
        ok(res, await buildReport(deps.db, ctx, key, [ctx.branchOid], range(q), compare(q.compare)));
    });

    router.get('/v1/hq/reports/:key', authenticate(deps), requireBranch('HQ'), requireAbility('read', 'Report'), async (req, res) => {
        const { key } = parse(reportParams, req.params);
        const q = parse(reportQuery, req.query);
        const ctx = branchContext(req);
        if (q.branch_oid && !ctx.branchOids.includes(q.branch_oid)) throw new AppError(403, 'You do not have access to this branch');
        ok(res, await buildReport(deps.db, ctx, key, q.branch_oid ? [q.branch_oid] : ctx.branchOids, range(q), compare(q.compare)));
    });

    router.get('/v1/trainers/:oid/numbers', authenticate(deps), requireBranch('BRANCH'), requireAbility('read', 'Trainer'), async (req, res) => {
        const { oid } = parse(trainerParams, req.params);
        const q = parse(reportQuery, req.query);
        const ctx = branchContext(req);
        const [trainer] = await withBranchTx(deps.db, ctx, tx => tx.query<{ user_oid: string }>(sql`select user_oid::text from trainer where oid = ${oid}`));
        if (!trainer) throw new AppError(404, 'Trainer not found');
        const own = trainer.user_oid === currentUser(req).oid;
        if (!own && !req.auth?.ability.can('read', 'Report')) throw new AppError(403, 'You can see only your own numbers');
        ok(res, await trainerReport(deps.db, ctx, oid, range(q)));
    });

    return router;
}
