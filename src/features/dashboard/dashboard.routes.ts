import { Router } from 'express';
import * as v from 'valibot';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { addDays, daysBetween, dhakaNow } from '#src/lib/clock.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

import { dashboard } from './dashboard.service.ts';

const rangeQuery = v.object({
    from: v.optional(v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'))),
    to: v.optional(v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD')))
});

/**
 * - `GET /v1/dashboard?from&to`: the branch in `X-Branch-Id` (`read Dashboard`).
 * - `GET /v1/hq/dashboard?from&to`: every branch the HQ user reaches (`read HqDashboard`).
 * Default range: the last 30 days. At most 13 months.
 */
export function dashboardRouter(deps: AppDeps): Router {
    const router = Router();
    const range = (q: v.InferOutput<typeof rangeQuery>) => {
        const today = dhakaNow(deps.clock()).date;
        const from = q.from ?? addDays(today, -29);
        const to = q.to ?? today;
        if (from > to) throw new AppError(400, 'Choose a valid date range.');
        if (daysBetween(from, to) > 400) throw new AppError(400, 'Choose a range of at most 13 months.');
        return { from, to };
    };

    router.get('/v1/dashboard', authenticate(deps), requireBranch('BRANCH'), requireAbility('read', 'Dashboard'), async (req, res) => {
        const { from, to } = range(parse(rangeQuery, req.query));
        const ctx = branchContext(req);
        ok(res, await dashboard(deps.db, ctx, [ctx.branchOid], from, to, deps.clock()));
    });

    router.get('/v1/hq/dashboard', authenticate(deps), requireBranch('HQ'), requireAbility('read', 'HqDashboard'), async (req, res) => {
        const { from, to } = range(parse(rangeQuery, req.query));
        const ctx = branchContext(req);
        ok(res, await dashboard(deps.db, ctx, ctx.branchOids, from, to, deps.clock()));
    });

    return router;
}
