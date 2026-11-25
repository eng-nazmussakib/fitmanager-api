import { Router } from 'express';

import { authenticate, currentUser, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { publicTrainers } from '#src/features/scheduling/trainers.service.ts';
import { gallery } from '#src/features/website/website.service.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

import { branchesRepo } from './branches.repo.ts';
import { oidParams, profileSchema, slugParams } from './branches.schema.ts';

/**
 * Branch profiles (migration 008): contact details, capacity, dues limit, facilities and hours.
 * - `GET /v1/branches`, `/v1/branches/:oid`: the branches the signed-in user is assigned to (any staff).
 * - `GET /v1/public/branches`, `/:slug`: active selling branches for the public site, without the dues limit.
 * - `PATCH /v1/hq/branches/:oid`: HQ changes a profile (`update Branch`), audited at HQ.
 * Hours are weekday numbers (0 = Sunday) with HH:mm ranges in Dhaka time, the shape the access rules read; the
 * web app formats them for people.
 */
const PUBLIC_CACHE_SECONDS = 60;

export function branchesRouter(deps: AppDeps): Router {
    const { db, cache } = deps;
    const router = Router();
    const signedIn = authenticate(deps);

    router.get('/v1/public/branches', async (_req, res) => {
        res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);
        ok(res, await cache.getOrSet('public:branches', () => branchesRepo.publicList(db), PUBLIC_CACHE_SECONDS));
    });

    router.get('/v1/public/branches/:slug', async (req, res) => {
        const { slug } = parse(slugParams, req.params);
        const branch = await branchesRepo.publicBySlug(db, slug);
        if (!branch) throw new AppError(404, 'Branch not found');
        // Its public trainers, as the web mock answers.
        const trainers = await publicTrainers({ db, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix }, slug);
        // Its photos: the branch's gallery.
        const photos = await gallery({ db, apiPrefix: deps.config.apiPrefix }, { slug });
        res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);
        ok(res, { ...branch, trainers, photos });
    });

    router.get('/v1/branches', signedIn, async (req, res) => {
        ok(
            res,
            await branchesRepo.profiles(
                db,
                currentUser(req).assignments.map(a => a.branch.oid)
            )
        );
    });

    router.get('/v1/branches/:oid', signedIn, async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        // Not assigned there: the same answer as a branch that does not exist.
        if (!currentUser(req).assignments.some(a => a.branch.oid === oid)) throw new AppError(404, 'Branch not found');
        const branch = await branchesRepo.profile(db, oid);
        if (!branch) throw new AppError(404, 'Branch not found');
        ok(res, branch);
    });

    router.patch('/v1/hq/branches/:oid', signedIn, requireBranch('HQ'), requireAbility('update', 'Branch'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const body = parse(profileSchema, req.body);
        const ctx = branchContext(req);
        if (!ctx.branchOids.includes(oid)) throw new AppError(404, 'Branch not found');
        const row = await withBranchTx(db, ctx, async tx => {
            const before = await branchesRepo.profile(tx, oid, true);
            if (!before) throw new AppError(404, 'Branch not found');
            const after = await branchesRepo.updateProfile(tx, oid, body, currentUser(req).oid);
            if (!after) throw new AppError(404, 'Branch not found');
            await recordAudit(tx, ctx, { action: 'update', entity: 'branch', entityKey: before.code, before, after });
            return after;
        });
        await cache.del('public:branches');
        ok(res, row, `${row.name}: profile saved`);
    });

    return router;
}
