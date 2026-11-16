import { Router } from 'express';
import * as v from 'valibot';

import { authenticate } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { ok, parse } from '#src/lib/http.ts';

interface LookupItem {
    oid: string;
    name_en: string;
}

/**
 * Dropdown lookups: GET /v1/ddl?ddl_key=category&ddl_key=… → `{ category: [...] }` (the `tbl_ddl_data` endpoint
 * of the projects, same shape as the frontends expect). Lookups change rarely and every form asks for them, so
 * they are served from the cache. Add a key here, never accept a table name from the query.
 */
const SOURCES: Record<string, (db: Queryable) => Promise<LookupItem[]>> = {
    category: db => db.query<LookupItem>(sql`select oid, name_en from category order by sort_order, name_en`)
};

const querySchema = v.object({
    ddl_key: v.pipe(
        v.union([v.string(), v.array(v.string())]),
        v.transform(keys => (Array.isArray(keys) ? keys : [keys])),
        v.array(v.pipe(v.string(), v.maxLength(50))),
        v.maxLength(20)
    )
});

const CACHE_SECONDS = 300;

export function ddlRouter(deps: AppDeps): Router {
    const router = Router();
    router.get('/v1/ddl', authenticate(deps), async (req, res) => {
        const { ddl_key } = parse(querySchema, req.query);
        const entries = await Promise.all(
            [...new Set(ddl_key)].map(async key => {
                const source = SOURCES[key];
                return [key, source ? await deps.cache.getOrSet(`ddl:${key}`, () => source(deps.db), CACHE_SECONDS) : []] as const;
            })
        );
        ok(res, Object.fromEntries(entries));
    });
    return router;
}
