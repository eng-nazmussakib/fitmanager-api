import { Router } from 'express';
import * as v from 'valibot';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, branchContext, withBranchTx } from '#src/db/tenancy.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';
import { isoDate, queryInt } from '#src/lib/query.ts';

/**
 * Reading the audit log (phase 1). Two routes, one query:
 * - `GET /v1/hq/audit`: at HQ, every branch the user reaches (`branchContext`), optionally one of them (`branch_oid`).
 * - `GET /v1/branch/audit`: at a branch, that branch only.
 * Both run inside `withBranchTx`, so RLS (migration 005) limits the rows even if the filter below were wrong.
 * Newest first, paged with a cursor (`next` → `?before=`): the log only grows, so offsets would drift.
 * `from` and `to` are calendar days in Dhaka, both included.
 */
export interface AuditRow {
    oid: string;
    branch_oid: string;
    branch_code: string;
    branch_name: string;
    actor_oid: string | null;
    actor_name: string | null;
    action: string;
    entity: string;
    entity_key: string;
    before: unknown;
    after: unknown;
    request_id: string | null;
    created_at: string;
}

const NAME = v.pipe(v.string(), v.regex(/^[a-z][a-z_]{1,39}$/, 'Lower snake case, e.g. site_group'));
const UUID = (message: string) => v.pipe(v.string(), v.uuid(message));

const filterEntries = {
    actor_oid: v.optional(UUID('Unknown user')),
    action: v.optional(NAME),
    entity: v.optional(NAME),
    entity_key: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
    from: v.optional(isoDate()),
    to: v.optional(isoDate()),
    before: v.optional(v.pipe(v.string(), v.maxLength(200))),
    limit: v.optional(queryInt(1, 100), 50)
};
const branchObject = v.strictObject(filterEntries);
const hqObject = v.strictObject({ ...filterEntries, branch_oid: v.optional(UUID('Unknown branch')) });
export type AuditQuery = v.InferOutput<typeof hqObject>;
type Query = AuditQuery;
const RANGE = '`from` must not be after `to`';
const inRange = (q: Query) => !q.from || !q.to || q.from <= q.to;
const branchQuery = v.pipe(branchObject, v.check(inRange, RANGE));
const hqQuery = v.pipe(hqObject, v.check(inRange, RANGE));

/** The cursor is the last row's (created_at, oid), opaque to the client. */
const encodeCursor = (at: string, oid: string) => Buffer.from(JSON.stringify([at, oid])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
    try {
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (Array.isArray(value) && value.length === 2) {
            const [at, oid] = value as unknown[];
            if (typeof at === 'string' && !Number.isNaN(Date.parse(at)) && typeof oid === 'string' && v.is(UUID(''), oid)) return [at, oid];
        }
    } catch {
        // fall through
    }
    throw new AppError(400, 'Invalid page cursor', [{ path: 'before', message: 'Invalid page cursor' }]);
}

function auditFilter(branchOids: readonly string[], q: Query) {
    const cursor = q.before ? decodeCursor(q.before) : null;
    return sql.where([
        sql`a.branch_oid = any (${`{${branchOids.join(',')}}`}::uuid[])`,
        q.actor_oid !== undefined && sql`a.actor_oid = ${q.actor_oid}`,
        q.action !== undefined && sql`a.action = ${q.action}`,
        q.entity !== undefined && sql`a.entity = ${q.entity}`,
        q.entity_key !== undefined && sql`a.entity_key = ${q.entity_key}`,
        q.from !== undefined && sql`a.created_at >= (${q.from}::date)::timestamp at time zone 'Asia/Dhaka'`,
        q.to !== undefined && sql`a.created_at < (${q.to}::date + 1)::timestamp at time zone 'Asia/Dhaka'`,
        cursor !== null && sql`(a.created_at, a.oid) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
    ]);
}

/** The audit log, newest first, a page at a time (the screens; exports page through it, D-107). */
export async function readAudit(deps: Pick<AppDeps, 'db'>, ctx: BranchContext, branchOids: readonly string[], q: Query) {
    const filter = auditFilter(branchOids, q);
    const rows = await withBranchTx(deps.db, ctx, tx =>
        tx.query<AuditRow & { cursor_at: string }>(sql`
            select a.oid, a.branch_oid, b.code as branch_code, b.name as branch_name, a.actor_oid, a.actor_name,
                   a.action, a.entity, a.entity_key, a.before, a.after, a.request_id, a.created_at,
                   a.created_at::text as cursor_at
            from audit_log a join branch b on b.oid = a.branch_oid
            where ${filter}
            order by a.created_at desc, a.oid desc
            limit ${q.limit + 1}`)
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
        rows: page.map(({ cursor_at: _cursor, ...row }) => row),
        next: rows.length > q.limit && last ? encodeCursor(last.cursor_at, last.oid) : null
    };
}

/** How many audit rows match (the export's 50 000-row cap). */
export async function countAudit(deps: Pick<AppDeps, 'db'>, ctx: BranchContext, branchOids: readonly string[], q: Query) {
    const filter = auditFilter(branchOids, { ...q, before: undefined });
    const [row] = await withBranchTx(deps.db, ctx, tx => tx.query<{ n: number }>(sql`select count(*)::int as n from audit_log a where ${filter}`));
    return row?.n ?? 0;
}

/** The filters of `GET /v1/branch/audit` (and the HQ one), for an export's body. */
export const auditFilters = v.strictObject({ ...filterEntries, branch_oid: v.optional(UUID('Unknown branch')) });

export function auditRouter(deps: AppDeps): Router {
    const router = Router();

    router.get('/v1/hq/audit', authenticate(deps), requireBranch('HQ'), requireAbility('read', 'AuditLog'), async (req, res) => {
        const q = parse(hqQuery, req.query);
        const ctx = branchContext(req);
        if (q.branch_oid !== undefined && !ctx.branchOids.includes(q.branch_oid)) throw new AppError(403, 'You do not reach this branch');
        ok(res, await readAudit(deps, ctx, q.branch_oid !== undefined ? [q.branch_oid] : ctx.branchOids, q));
    });

    router.get('/v1/branch/audit', authenticate(deps), requireBranch('BRANCH'), requireAbility('read', 'AuditLog'), async (req, res) => {
        const q = parse(branchQuery, req.query);
        const ctx = branchContext(req);
        ok(res, await readAudit(deps, ctx, ctx.branchOids, q));
    });

    return router;
}
