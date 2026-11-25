import { Router } from 'express';
import * as v from 'valibot';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { addDays, daysBetween, dhakaNow } from '#src/lib/clock.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

import { reconciliation } from './reconciliation.service.ts';

const query = v.object({
    from: v.optional(v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'))),
    to: v.optional(v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'))),
    branch_oid: v.optional(v.pipe(v.string(), v.uuid('A branch id')))
});

/**
 * `GET /v1/hq/reconciliation?from&to&branch_oid`: does the money reconcile? Read only. HQ, with `read AuditLog`
 * (owner, HQ admin). Default range: the last 14 days (the pilot's two weeks); at most 13 months.
 */
export function reconciliationRouter(deps: AppDeps): Router {
    const router = Router();
    router.get('/v1/hq/reconciliation', authenticate(deps), requireBranch('HQ'), requireAbility('read', 'AuditLog'), async (req, res) => {
        const q = parse(query, req.query);
        const today = dhakaNow(deps.clock()).date;
        const from = q.from ?? addDays(today, -13);
        const to = q.to ?? today;
        if (from > to) throw new AppError(400, 'Choose a valid date range.');
        if (daysBetween(from, to) > 400) throw new AppError(400, 'Choose a range of at most 13 months.');
        const ctx = branchContext(req);
        if (q.branch_oid && !ctx.branchOids.includes(q.branch_oid)) throw new AppError(403, 'You do not have access to this branch');
        ok(res, await reconciliation(deps.db, ctx, q.branch_oid ? [q.branch_oid] : ctx.branchOids, from, to));
    });
    return router;
}
