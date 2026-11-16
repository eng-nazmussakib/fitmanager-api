import { Router } from 'express';
import * as v from 'valibot';

import { authenticate, currentUser, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

/**
 * Public site content groups (D-040). A group (blog, trainers…) can have a landing SECTION and a PAGE of its own,
 * switched separately: `{ section: false, page: true }` keeps /blog but drops it from the home page. `null` means
 * the group has no such part. Required groups (home, programs, membership, facilities) keep every part on. The
 * groups and the `required` flags come from the migrations (`site_group`, 003); the database refuses to switch
 * off a required part even without the checks here.
 */
export interface SiteGroup {
    key: string;
    name: string;
    required: boolean;
    sort_order: number;
    section: boolean | null;
    page: boolean | null;
    page_path: string | null;
}

interface SiteGroupAdmin extends SiteGroup {
    updated_at: string;
    updated_by_name: string | null;
}

/** The public list is read on every page view (and at prerender); a change shows within this time. */
const PUBLIC_CACHE_SECONDS = 60;
const CACHE_KEY = 'site:groups';

const keyParams = v.object({ key: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,40}$/, 'Unknown group')) });
const updateSchema = v.pipe(
    v.strictObject({ section: v.optional(v.boolean()), page: v.optional(v.boolean()) }),
    v.check(b => b.section !== undefined || b.page !== undefined, 'Send section, page or both')
);

const COLUMNS = sql.raw('g.key, g.name, g.required, g.sort_order, g.section_enabled as section, g.page_enabled as page, g.page_path');
const list = (db: Queryable) => db.query<SiteGroup>(sql`select ${COLUMNS} from site_group g order by g.sort_order, g.key`);

export function siteRouter(deps: AppDeps): Router {
    const { db, cache } = deps;
    const router = Router();
    const hq = [authenticate(deps), requireBranch('HQ')];

    router.get('/v1/public/site-groups', async (_req, res) => {
        res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);
        ok(res, await cache.getOrSet(CACHE_KEY, () => list(db), PUBLIC_CACHE_SECONDS));
    });

    router.get('/v1/hq/site-groups', ...hq, requireAbility('read', 'Settings'), async (_req, res) => {
        ok(
            res,
            await db.query<SiteGroupAdmin>(sql`
                select ${COLUMNS}, g.updated_at, u.name as updated_by_name
                from site_group g left join app_user u on u.oid = g.updated_by
                order by g.sort_order, g.key`)
        );
    });

    router.patch('/v1/hq/site-groups/:key', ...hq, requireAbility('update', 'Settings'), async (req, res) => {
        const { key } = parse(keyParams, req.params);
        const body = parse(updateSchema, req.body);
        const [g] = await db.query<SiteGroup>(sql`select ${COLUMNS} from site_group g where g.key = ${key}`);
        if (!g) throw new AppError(404, 'Unknown group');
        if (body.section !== undefined && g.section === null) throw new AppError(400, `${g.name} has no section on the home page`);
        if (body.page !== undefined && g.page === null) throw new AppError(400, `${g.name} has no page of its own`);
        if (g.required && (body.section === false || body.page === false)) throw new AppError(409, `${g.name} is required and cannot be switched off`);
        const [row] = await db.query<SiteGroup>(sql`
            update site_group g set
                section_enabled = coalesce(${body.section ?? null}::boolean, g.section_enabled),
                page_enabled = coalesce(${body.page ?? null}::boolean, g.page_enabled),
                updated_at = now(), updated_by = ${currentUser(req).oid}
            where g.key = ${key}
            returning ${COLUMNS}`);
        if (!row) throw new AppError(404, 'Unknown group');
        await cache.del(CACHE_KEY);
        ok(res, row, `${g.name}: ${describe(row)}`);
    });

    return router;
}

/** "section hidden, page shown" for the toast. */
function describe(g: SiteGroup): string {
    const part = (name: string, on: boolean | null) => (on === null ? null : `${name} ${on ? 'shown' : 'hidden'}`);
    return [part('section', g.section), part('page', g.page)].filter(Boolean).join(', ');
}
