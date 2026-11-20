import { Router } from 'express';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext, systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { branchesRepo } from '#src/features/branches/branches.repo.ts';
import { readOrgRules } from '#src/features/settings/settings.routes.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

import { plansRepo } from './plans.repo.ts';
import {
    hqPlansQuery,
    oidParams,
    planCreate,
    planUpdate,
    promoCreate,
    promoParams,
    promoUpdate,
    publicPlansQuery,
    templateCreate,
    templateParams,
    templateUpdate
} from './plans.schema.ts';
import * as plans from './plans.service.ts';

/**
 * Plans (phase 2 step 1; D-043, D-044, D-063).
 * - `GET /v1/plans`: what the desk sells at its branch (read Plan).
 * - `GET /v1/hq/plans`, `POST`, `PATCH /:oid`: every branch's plans; only HQ creates or changes them (manage Plan).
 * - `GET /v1/hq/plan-templates`, `POST`, `PATCH /:oid`: HQ templates (PlanTemplate).
 * - `GET /v1/hq/promos`, `POST`, `PATCH /:code`: HQ promo codes, under PlanTemplate (HQ pricing data).
 * - `GET /v1/public/plans?branch=<slug>`: the public price list per branch, with the VAT rate and mode.
 */
const PUBLIC_CACHE_SECONDS = 60;

export function plansRouter(deps: AppDeps): Router {
    const { db, cache } = deps;
    const router = Router();
    const signedIn = authenticate(deps);
    const hq = [signedIn, requireBranch('HQ')];

    router.get('/v1/public/plans', async (req, res) => {
        const q = parse(publicPlansQuery, req.query);
        const load = async () => {
            const branches = await branchesRepo.publicList(db);
            const oids = branches.map(b => b.oid);
            const [first] = oids;
            const rules = await readOrgRules(db);
            const all = first ? await withBranchTx(db, systemContext(first, oids), tx => plansRepo.plans(tx, oids, true)) : [];
            return branches.map(b => ({
                branch: { oid: b.oid, code: b.code, slug: b.slug, name: b.name, kind: b.kind },
                // The public price list shows memberships; PT packages are sold at the desk (D-079).
                plans: all.filter(p => p.branch_oid === b.oid && p.kind === 'membership'),
                vat_rate: rules.vat_rate,
                vat_inclusive: rules.vat_inclusive
            }));
        };
        const list = await cache.getOrSet('public:plans', load, PUBLIC_CACHE_SECONDS);
        const rows = q.branch ? list.filter(r => r.branch.slug === q.branch) : list;
        if (q.branch && !rows.length) throw new AppError(404, 'Branch not found');
        res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);
        ok(res, rows);
    });

    router.get('/v1/plans', signedIn, requireBranch('BRANCH'), requireAbility('read', 'Plan'), async (req, res) => {
        const ctx = branchContext(req);
        ok(res, await withBranchTx(db, ctx, tx => plansRepo.plans(tx, [ctx.branchOid], true)));
    });

    router.get('/v1/hq/plans', ...hq, requireAbility('read', 'Plan'), async (req, res) => {
        const q = parse(hqPlansQuery, req.query);
        const ctx = branchContext(req);
        const oids = q.branch_oid ? ctx.branchOids.filter(o => o === q.branch_oid) : ctx.branchOids;
        ok(res, oids.length ? await withBranchTx(db, ctx, tx => plansRepo.plans(tx, oids, false)) : []);
    });

    /** The public price list changes with plans and templates (and VAT: settings.routes.ts clears it too). */
    const forget = () => cache.del('public:plans');

    router.post('/v1/hq/plans', ...hq, requireAbility('create', 'Plan'), async (req, res) => {
        const plan = await plans.createPlan(db, branchContext(req), parse(planCreate, req.body));
        await forget();
        ok(res, plan, `${plan.name} added`, 201);
    });

    router.patch('/v1/hq/plans/:oid', ...hq, requireAbility('update', 'Plan'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const plan = await plans.updatePlan(db, branchContext(req), oid, parse(planUpdate, req.body));
        await forget();
        ok(res, plan, `${plan.code} saved`);
    });

    router.get('/v1/hq/plan-templates', ...hq, requireAbility('read', 'PlanTemplate'), async (req, res) => {
        // In the HQ context: `branches_using` counts plans, which are branch rows under RLS.
        ok(res, await withBranchTx(db, branchContext(req), tx => plansRepo.templates(tx)));
    });

    router.post('/v1/hq/plan-templates', ...hq, requireAbility('create', 'PlanTemplate'), async (req, res) => {
        const row = await plans.createTemplate(db, branchContext(req), parse(templateCreate, req.body));
        ok(res, row, `${row.tier_name} · ${row.period_label} added`, 201);
    });

    router.patch('/v1/hq/plan-templates/:oid', ...hq, requireAbility('update', 'PlanTemplate'), async (req, res) => {
        const { oid } = parse(templateParams, req.params);
        const row = await plans.updateTemplate(db, branchContext(req), oid, parse(templateUpdate, req.body));
        await forget();
        ok(res, row, `${row.tier_name} · ${row.period_label} saved`);
    });

    router.get('/v1/hq/promos', ...hq, requireAbility('read', 'PlanTemplate'), async (_req, res) => {
        ok(res, await plansRepo.promos(db));
    });

    router.post('/v1/hq/promos', ...hq, requireAbility('create', 'PlanTemplate'), async (req, res) => {
        const row = await plans.createPromo(db, branchContext(req), parse(promoCreate, req.body));
        ok(res, row, `${row.code} added`, 201);
    });

    router.patch('/v1/hq/promos/:code', ...hq, requireAbility('update', 'PlanTemplate'), async (req, res) => {
        const { code } = parse(promoParams, req.params);
        const row = await plans.updatePromo(db, branchContext(req), code, parse(promoUpdate, req.body));
        ok(res, row, `${row.code} saved`);
    });

    return router;
}
