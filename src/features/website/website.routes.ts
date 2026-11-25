import { type Request, Router } from 'express';

import { authenticate, requireAbility, requireAnyBranch, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

import {
    categoryCreate,
    descriptionSchema,
    galleryCreate,
    galleryQuery,
    galleryUpdate,
    offerCreate,
    offerUpdate,
    oidParams,
    postCreate,
    postUpdate,
    publicGalleryQuery,
    publicPostsQuery,
    slugParams
} from './website.schema.ts';
import {
    addPhoto,
    allOffers,
    allPosts,
    categories,
    createCategory,
    createOffer,
    createPost,
    deleteOffer,
    deletePost,
    gallery,
    publicOffers,
    publicPost,
    publicPosts,
    removePhoto,
    setDescription,
    updateOffer,
    updatePhoto,
    updatePost,
    type WebsiteDeps
} from './website.service.ts';

const PUBLIC_CACHE_SECONDS = 60;

/**
 * The public website's content.
 *
 * Public (no sign-in, cached a minute):
 * - `GET /v1/public/posts[?category=]`, `/v1/public/posts/:slug`, `/v1/public/blog-categories`;
 * - `GET /v1/public/gallery[?branch=<slug>]`, `GET /v1/public/offers` (running today). Branch descriptions and photos
 *   come with `GET /v1/public/branches/:slug`; images at `/v1/public/images/:oid` (files.routes.ts).
 *
 * HQ (`Website` at HQ): `GET/POST /v1/website/posts`, `PATCH/DELETE /v1/website/posts/:oid`, `GET/POST
 * /v1/website/categories`, `GET/POST /v1/website/offers`, `PATCH/DELETE /v1/website/offers/:oid`.
 *
 * HQ or a branch (`read`/`update Website`): `GET/POST /v1/website/gallery`, `PATCH/DELETE /v1/website/gallery/:oid`
 * (a branch manager their own branch's photos), `PUT /v1/website/branch` `{ description }` (the branch's page; at HQ
 * with `?branch_oid=`).
 */
export function websiteRouter(deps: AppDeps): Router {
    const router = Router();
    const w: WebsiteDeps = { db: deps.db, apiPrefix: deps.config.apiPrefix };
    const hq = [authenticate(deps), requireBranch('HQ')];
    const any = [authenticate(deps), requireAnyBranch()];
    const now = () => deps.clock();
    const atHq = (req: Request) => req.auth?.assignment?.branch.kind === 'HQ';
    const cached = (res: Parameters<typeof ok>[0]) => res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);

    /* ---------- public ---------- */

    router.get('/v1/public/posts', async (req, res) => {
        const { category } = parse(publicPostsQuery, req.query);
        cached(res);
        ok(res, await publicPosts(w, now(), category));
    });
    router.get('/v1/public/posts/:slug', async (req, res) => {
        const { slug } = parse(slugParams, req.params);
        cached(res);
        ok(res, await publicPost(w, now(), slug));
    });
    router.get('/v1/public/blog-categories', async (_req, res) => {
        cached(res);
        ok(res, await categories(deps.db));
    });
    router.get('/v1/public/gallery', async (req, res) => {
        const { branch } = parse(publicGalleryQuery, req.query);
        cached(res);
        ok(res, await gallery(w, { slug: branch }));
    });
    router.get('/v1/public/offers', async (_req, res) => {
        cached(res);
        ok(res, await publicOffers(deps.db, dhakaNow(now()).date));
    });

    /* ---------- HQ: the blog and the offers ---------- */

    router.get('/v1/website/posts', ...hq, requireAbility('read', 'Website'), async (_req, res) => {
        ok(res, await allPosts(w, now()));
    });
    router.post('/v1/website/posts', ...hq, requireAbility('create', 'Website'), async (req, res) => {
        ok(res, await createPost(w, branchContext(req), now(), parse(postCreate, req.body)), 'Post saved', 201);
    });
    router.patch('/v1/website/posts/:oid', ...hq, requireAbility('update', 'Website'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await updatePost(w, branchContext(req), now(), oid, parse(postUpdate, req.body)), 'Post saved');
    });
    router.delete('/v1/website/posts/:oid', ...hq, requireAbility('delete', 'Website'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        await deletePost(w, branchContext(req), now(), oid);
        ok(res, null, 'Post deleted');
    });
    router.get('/v1/website/categories', ...any, requireAbility('read', 'Website'), async (_req, res) => {
        ok(res, await categories(deps.db));
    });
    router.post('/v1/website/categories', ...hq, requireAbility('create', 'Website'), async (req, res) => {
        ok(res, await createCategory(w, branchContext(req), parse(categoryCreate, req.body)), 'Category added', 201);
    });
    router.get('/v1/website/offers', ...hq, requireAbility('read', 'Website'), async (_req, res) => {
        ok(res, await allOffers(deps.db));
    });
    router.post('/v1/website/offers', ...hq, requireAbility('create', 'Website'), async (req, res) => {
        ok(res, await createOffer(w, branchContext(req), parse(offerCreate, req.body)), 'Offer saved', 201);
    });
    router.patch('/v1/website/offers/:oid', ...hq, requireAbility('update', 'Website'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await updateOffer(w, branchContext(req), now(), oid, parse(offerUpdate, req.body)), 'Offer saved');
    });
    router.delete('/v1/website/offers/:oid', ...hq, requireAbility('delete', 'Website'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        await deleteOffer(w, branchContext(req), now(), oid);
        ok(res, null, 'Offer deleted');
    });

    /* ---------- the gallery and branch pages (HQ, or a branch manager for their own) ---------- */

    router.get('/v1/website/gallery', ...any, requireAbility('read', 'Website'), async (req, res) => {
        const { branch_oid } = parse(galleryQuery, req.query);
        ok(res, await gallery(w, { oid: atHq(req) ? branch_oid : branchContext(req).branchOid }));
    });
    router.post('/v1/website/gallery', ...any, requireAbility('update', 'Website'), async (req, res) => {
        ok(res, await addPhoto(w, branchContext(req), atHq(req), parse(galleryCreate, req.body)), 'Photo added', 201);
    });
    router.patch('/v1/website/gallery/:oid', ...any, requireAbility('update', 'Website'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await updatePhoto(w, branchContext(req), atHq(req), oid, parse(galleryUpdate, req.body)), 'Photo saved');
    });
    router.delete('/v1/website/gallery/:oid', ...any, requireAbility('update', 'Website'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        await removePhoto(w, branchContext(req), atHq(req), now(), oid);
        ok(res, null, 'Photo removed');
    });
    router.put('/v1/website/branch', ...any, requireAbility('update', 'Website'), async (req, res) => {
        const { description } = parse(descriptionSchema, req.body);
        const ctx = branchContext(req);
        const { branch_oid } = parse(galleryQuery, req.query);
        const target = atHq(req) ? branch_oid : ctx.branchOid;
        if (!target) throw new AppError(400, 'Choose a branch', [{ path: 'branch_oid', message: 'Required' }]);
        ok(res, await setDescription(w, ctx, target, description), 'Branch page saved');
    });

    return router;
}
