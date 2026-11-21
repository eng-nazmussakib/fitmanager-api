import { type Request, Router } from 'express';
import * as v from 'valibot';

import { authenticate, currentUser, requireAbility, requireAnyBranch, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext, withBranchTx } from '#src/db/tenancy.ts';
import { memberContext } from '#src/features/portal/portal.service.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { ok, parse } from '#src/lib/http.ts';

import { oidParams, paperAccept, policyCreate, policyUpdate, portalAccept, slugParams, versionCreate } from './policies.schema.ts';
import {
    acceptPolicies,
    createPolicy,
    currentClauses,
    getPolicy,
    listPolicies,
    memberFor,
    memberPolicies,
    type PolicyDeps,
    publicPolicies,
    publicPolicy,
    publishVersion,
    updatePolicy
} from './policies.service.ts';

const listQuery = v.object({ all: v.optional(v.picklist(['0', '1'])) });
const versionQuery = v.object({ version: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number))) });

/**
 * Policies (phase 5; D-090, D-091).
 * - Every staff console (`read Policy`): `GET /v1/policies`, `GET /v1/policies/:oid[?version=]`, `GET /v1/policy-clauses`.
 * - HQ (`create`/`update Policy`): `POST /v1/hq/policies`, `PATCH /v1/hq/policies/:oid`, `POST /v1/hq/policies/:oid/versions`.
 * - A member at the home branch: `GET /v1/members/:oid/policies` (`read Member`), `POST /v1/members/:oid/policies/accept`
 *   (`update Member`: "signed on paper", recorded by the desk).
 * - Portal: `GET /v1/me/policies`, `GET /v1/me/policies/:oid` (the wording), `POST /v1/me/policies/accept` `{ version_oid }`.
 * - Public: `GET /v1/public/policies`, `GET /v1/public/policies/:slug`.
 */
export function policiesRouter(deps: AppDeps): Router {
    const router = Router();
    const p: PolicyDeps = { db: deps.db };
    const today = () => dhakaNow(deps.clock()).date;
    const staff = [authenticate(deps), requireAnyBranch()];
    const hq = [authenticate(deps), requireBranch('HQ')];
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const member = [authenticate(deps), requireAbility('read', 'Portal')];
    const oid = (req: Request) => parse(oidParams, req.params).oid;

    router.get('/v1/policies', ...staff, requireAbility('read', 'Policy'), async (req, res) => {
        ok(res, await listPolicies(p, branchContext(req), parse(listQuery, req.query).all === '1'));
    });
    router.get('/v1/policy-clauses', ...staff, requireAbility('read', 'Policy'), async (req, res) => {
        ok(res, await currentClauses(p, branchContext(req)));
    });
    router.get('/v1/policies/:oid', ...staff, requireAbility('read', 'Policy'), async (req, res) => {
        ok(res, await getPolicy(p, branchContext(req), oid(req), parse(versionQuery, req.query).version ?? null));
    });

    router.post('/v1/hq/policies', ...hq, requireAbility('create', 'Policy'), async (req, res) => {
        ok(res, await createPolicy(p, branchContext(req), parse(policyCreate, req.body), today()), 'Policy published', 201);
    });
    router.patch('/v1/hq/policies/:oid', ...hq, requireAbility('update', 'Policy'), async (req, res) => {
        ok(res, await updatePolicy(p, branchContext(req), oid(req), parse(policyUpdate, req.body)), 'Policy saved');
    });
    router.post('/v1/hq/policies/:oid/versions', ...hq, requireAbility('create', 'Policy'), async (req, res) => {
        ok(res, await publishVersion(p, branchContext(req), oid(req), parse(versionCreate, req.body), today()), 'New version published', 201);
    });

    router.get('/v1/members/:oid/policies', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const ctx = branchContext(req);
        ok(res, await withBranchTx(deps.db, ctx, async tx => memberPolicies(tx, await memberFor(tx, ctx, oid(req)), today())));
    });
    router.post('/v1/members/:oid/policies/accept', ...branch, requireAbility('update', 'Member'), async (req, res) => {
        const ctx = branchContext(req);
        const body = parse(paperAccept, req.body ?? {});
        const out = await withBranchTx(deps.db, ctx, async tx => {
            const m = await memberFor(tx, ctx, oid(req));
            const n = await acceptPolicies(tx, ctx, m, 'paper', today(), { policyOids: body.policy_oids });
            return { recorded: n, policies: await memberPolicies(tx, m, today()) };
        });
        ok(res, out, out.recorded ? `Signed on paper: ${out.recorded} recorded` : 'Nothing to record');
    });

    router.get('/v1/me/policies', ...member, async (req, res) => {
        const { ctx, memberOid } = await memberContext(deps, currentUser(req));
        ok(res, await withBranchTx(deps.db, ctx, async tx => memberPolicies(tx, await memberFor(tx, ctx, memberOid), today())));
    });
    // The wording a member reads before accepting (every active policy, public or not).
    router.get('/v1/me/policies/:oid', ...member, async (req, res) => {
        const { ctx } = await memberContext(deps, currentUser(req));
        ok(res, await getPolicy(p, ctx, oid(req), null));
    });
    router.post('/v1/me/policies/accept', ...member, requireAbility('update', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await memberContext(deps, currentUser(req));
        const body = parse(portalAccept, req.body);
        const out = await withBranchTx(deps.db, ctx, async tx => {
            const m = await memberFor(tx, ctx, memberOid);
            await acceptPolicies(tx, ctx, m, 'portal', today(), { versionOid: body.version_oid });
            return memberPolicies(tx, m, today());
        });
        ok(res, out, 'Accepted');
    });

    router.get('/v1/public/policies', async (_req, res) => {
        ok(res, await publicPolicies(deps.db));
    });
    router.get('/v1/public/policies/:slug', async (req, res) => {
        ok(res, await publicPolicy(deps.db, parse(slugParams, req.params).slug));
    });

    return router;
}
