import { Router } from 'express';
import * as v from 'valibot';

import { protectGuest } from '#src/auth/guest.ts';
import { authenticate, currentUser, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import { newPasswordSchema } from '#src/auth/password-policy.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { ok, parse } from '#src/lib/http.ts';

import { attendance, grantPortalAccess, invoices, notifications, summary } from './portal.service.ts';

const oidParams = v.object({ oid: v.pipe(v.string(), v.uuid('Unknown member')) });
const accessSchema = v.strictObject({ password: newPasswordSchema });

/**
 * The member portal.
 * - `POST /v1/members/:oid/portal-access` `{ password }`: the desk gives or resets portal access (`update Member`);
 *   the username is the member code, the password is temporary (changed at the first sign-in).
 * - `GET /v1/me/summary`, `/v1/me/payments`, `/v1/me/attendance`, `/v1/me/notifications` (`read Portal`).
 * Class booking is in scheduling.routes.ts; routines, workouts and measurements in training.routes.ts.
 */
export function portalRouter(deps: AppDeps): Router {
    const router = Router();
    const p = { ...deps, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const now = () => dhakaNow(deps.clock());
    const member = [authenticate(deps), requireAbility('read', 'Portal')];

    router.post(
        '/v1/members/:oid/portal-access',
        authenticate(deps),
        requireBranch('BRANCH'),
        requireAbility('update', 'Member'),
        protectGuest(deps, 'member'),
        async (req, res) => {
            const { oid } = parse(oidParams, req.params);
            const { password } = parse(accessSchema, req.body);
            const out = await grantPortalAccess(deps, branchContext(req), oid, now().date, password);
            ok(res, out, out.reset ? 'Portal password reset: the member sets a new one at sign-in' : `Portal access given: username ${out.username}`);
        }
    );

    router.get('/v1/me/summary', ...member, async (req, res) => {
        ok(res, await summary(p, currentUser(req), now()));
    });
    router.get('/v1/me/payments', ...member, async (req, res) => {
        ok(res, await invoices(p, currentUser(req), now()));
    });
    router.get('/v1/me/attendance', ...member, async (req, res) => {
        ok(res, await attendance(p, currentUser(req), now()));
    });
    router.get('/v1/me/notifications', ...member, async (req, res) => {
        ok(res, await notifications(p, currentUser(req), now()));
    });

    return router;
}
