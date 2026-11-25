import { Router } from 'express';
import * as v from 'valibot';

import { authenticate, requireAbility, requireAnyBranch, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { type BranchContext, branchContext, withBranchTx } from '#src/db/tenancy.ts';
import { auditFilters, countAudit, readAudit } from '#src/features/audit/audit.routes.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { listQuery } from '#src/features/members/members.schema.ts';
import { listMembers } from '#src/features/members/members.service.ts';
import type { Column } from '#src/features/reports/reports.build.ts';
import { REPORT_KEYS } from '#src/features/reports/reports.defs.ts';
import { paymentsPage } from '#src/features/sales/sales.service.ts';
import { stockQuery } from '#src/features/stock/stock.schema.ts';
import { stockLevels } from '#src/features/stock/stock.service.ts';
import { addDays, daysBetween, dhakaNow } from '#src/lib/clock.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

/**
 * Exports. The browser makes the Excel or PDF file (exceljs, jsPDF); the API hands it the rows, a page at a
 * time, so no request loads everything (Workers' 10 ms CPU). Every export needs `export Report` (branch managers
 * and HQ: member data never leaves through the desk or a trainer) plus the right to read the data itself.
 *
 * - `POST /v1/exports/members` `{ format, filters: { q, status, plan, flag }, page }` (branch, `read Member`)
 * - `POST /v1/exports/payments` `{ format, filters: { from, to }, after }` (branch, `read Payment`)
 * - `POST /v1/exports/stock` `{ format, filters: { low, q } }` (branch, `read Stock`; costs for `update Stock`)
 * - `POST /v1/exports/audit` `{ format, filters: <the audit log's>, after }` (HQ or branch, `read AuditLog`)
 * - `POST /v1/exports/report` `{ format, report, table, from, to, rows, branch_oid? }`: a report table already on
 *   screen; only the audit row.
 *
 * Each answers `{ columns, rows, next, total }`. The first page (no `page`/`after`) counts the rows, refuses more
 * than 50 000, and writes the audit row (`export`, entity `export`, key = the kind); later pages write nothing.
 */

export const EXPORT_LIMIT = 50_000;
const PAGE = 1000;
const MEMBER_PAGE = 250;

const format = v.picklist(['xlsx', 'pdf'], 'Excel (xlsx) or PDF');
const day = v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'));

const membersBody = v.strictObject({
    format,
    filters: v.optional(v.pick(listQuery, ['q', 'status', 'plan', 'flag']), {}),
    page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)))
});
const paymentsBody = v.strictObject({
    format,
    filters: v.optional(v.strictObject({ from: v.optional(day), to: v.optional(day) }), {}),
    after: v.optional(v.pipe(v.string(), v.maxLength(200)))
});
const stockBody = v.strictObject({ format, filters: v.optional(stockQuery, {}) });
const auditBody = v.strictObject({
    format,
    filters: v.optional(v.omit(auditFilters, ['before', 'limit']), {}),
    after: v.optional(v.pipe(v.string(), v.maxLength(200)))
});
const reportBody = v.strictObject({
    format,
    report: v.picklist(REPORT_KEYS, 'Unknown report'),
    table: v.pipe(v.string(), v.regex(/^[a-z_]{1,40}$/, 'A table key')),
    from: day,
    to: day,
    rows: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(EXPORT_LIMIT)),
    branch_oid: v.optional(v.pipe(v.string(), v.uuid('A branch id')))
});

const MEMBER_COLUMNS: Column[] = [
    { key: 'code', label: 'Member', unit: 'text' },
    { key: 'name', label: 'Name', unit: 'text' },
    { key: 'phone', label: 'Phone', unit: 'text' },
    { key: 'gender', label: 'Gender', unit: 'text' },
    { key: 'status', label: 'Status', unit: 'text' },
    { key: 'plan_name', label: 'Plan', unit: 'text' },
    { key: 'valid_until', label: 'Valid until', unit: 'date' },
    { key: 'dues', label: 'Dues', unit: 'money' },
    { key: 'last_visit', label: 'Last visit', unit: 'date' },
    { key: 'joined_on', label: 'Joined', unit: 'date' }
];
const PAYMENT_COLUMNS: Column[] = [
    { key: 'received_at', label: 'When', unit: 'date' },
    { key: 'invoice_number', label: 'Invoice', unit: 'text' },
    { key: 'member_code', label: 'Member', unit: 'text' },
    { key: 'member_name', label: 'Name', unit: 'text' },
    { key: 'kind', label: 'Kind', unit: 'text' },
    { key: 'method', label: 'Method', unit: 'text' },
    { key: 'reference', label: 'Reference', unit: 'text' },
    { key: 'amount', label: 'Amount', unit: 'money' },
    { key: 'received_by', label: 'By', unit: 'text' },
    { key: 'reason', label: 'Refund reason', unit: 'text' }
];
const stockColumns = (costs: boolean): Column[] => [
    { key: 'code', label: 'Code', unit: 'text' },
    { key: 'name', label: 'Product', unit: 'text' },
    { key: 'category', label: 'Category', unit: 'text' },
    { key: 'on_hand', label: 'On hand', unit: 'count' },
    { key: 'reorder_level', label: 'Reorder at', unit: 'count' },
    { key: 'on_order', label: 'On order', unit: 'count' },
    { key: 'in_transit', label: 'In transit', unit: 'count' },
    { key: 'price', label: 'Price', unit: 'money' },
    ...(costs
        ? ([
              { key: 'avg_cost', label: 'Average cost', unit: 'money' },
              { key: 'value', label: 'Value', unit: 'money' }
          ] satisfies Column[])
        : [])
];
const AUDIT_COLUMNS: Column[] = [
    { key: 'created_at', label: 'When', unit: 'date' },
    { key: 'branch_name', label: 'Branch', unit: 'text' },
    { key: 'actor_name', label: 'Who', unit: 'text' },
    { key: 'action', label: 'Action', unit: 'text' },
    { key: 'entity', label: 'What', unit: 'text' },
    { key: 'entity_key', label: 'Which', unit: 'text' },
    { key: 'after', label: 'Details', unit: 'text' }
];

function tooMany(total: number): void {
    if (total > EXPORT_LIMIT) {
        throw new AppError(
            400,
            `This export has ${total.toLocaleString('en-IN')} rows; the most is ${EXPORT_LIMIT.toLocaleString('en-IN')}. Narrow the filters.`,
            [{ path: 'filters', message: 'Too many rows' }]
        );
    }
}

async function audited(deps: AppDeps, ctx: BranchContext, kind: string, after: Record<string, unknown>): Promise<void> {
    await withBranchTx(deps.db, ctx, tx => recordAudit(tx, ctx, { action: 'export', entity: 'export', entityKey: kind, before: null, after }));
}

const encode = (at: string, oid: string) => Buffer.from(JSON.stringify([at, oid])).toString('base64url');
function decode(cursor: string): [string, string] {
    try {
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' && !Number.isNaN(Date.parse(value[0]))) {
            return [value[0], value[1]];
        }
    } catch {
        // fall through
    }
    throw new AppError(400, 'Invalid page cursor', [{ path: 'after', message: 'Invalid page cursor' }]);
}

export function exportsRouter(deps: AppDeps): Router {
    const router = Router();
    const branch = [authenticate(deps), requireBranch('BRANCH'), requireAbility('export', 'Report')];
    const any = [authenticate(deps), requireAnyBranch(), requireAbility('export', 'Report')];
    const today = () => dhakaNow(deps.clock()).date;
    const memberDeps = { db: deps.db, files: deps.files, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };

    router.post('/v1/exports/members', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const body = parse(membersBody, req.body);
        const ctx = branchContext(req);
        const page = body.page ?? 1;
        const list = await listMembers(memberDeps, ctx, today(), { ...body.filters, page, size: MEMBER_PAGE });
        if (page === 1) {
            tooMany(list.count);
            await audited(deps, ctx, 'members', { format: body.format, filters: body.filters, rows: list.count });
        }
        ok(res, {
            columns: MEMBER_COLUMNS,
            rows: list.rows.map(({ oid: _oid, photo_url: _photo, days_left: _days, ...r }) => r),
            next: page * MEMBER_PAGE < Math.min(list.count, EXPORT_LIMIT) ? String(page + 1) : null,
            total: page === 1 ? list.count : null
        });
    });

    router.post('/v1/exports/payments', ...branch, requireAbility('read', 'Payment'), async (req, res) => {
        const body = parse(paymentsBody, req.body);
        const ctx = branchContext(req);
        const to = body.filters.to ?? today();
        const from = body.filters.from ?? addDays(to, -29);
        if (from > to || daysBetween(from, to) > 365)
            throw new AppError(400, 'Choose a range of at most 366 days.', [{ path: 'filters.from', message: 'At most 366 days' }]);
        const page = await paymentsPage(deps.db, ctx, { from, to }, body.after ? decode(body.after) : null, PAGE);
        if (page.total !== null) {
            tooMany(page.total);
            await audited(deps, ctx, 'payments', { format: body.format, filters: { from, to }, rows: page.total });
        }
        const last = page.rows.at(-1);
        ok(res, {
            columns: PAYMENT_COLUMNS,
            rows: page.rows.map(({ oid: _oid, ...r }) => r),
            next: page.rows.length === PAGE && last ? encode(last.received_at, last.oid) : null,
            total: page.total
        });
    });

    router.post('/v1/exports/stock', ...branch, requireAbility('read', 'Stock'), async (req, res) => {
        const body = parse(stockBody, req.body);
        const ctx = branchContext(req);
        const costs = req.auth?.ability.can('update', 'Stock') ?? false;
        const stock = await stockLevels({ db: deps.db, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix }, ctx, body.filters, costs);
        await audited(deps, ctx, 'stock', { format: body.format, filters: body.filters, rows: stock.rows.length });
        const keys = stockColumns(costs).map(c => c.key);
        ok(res, {
            columns: stockColumns(costs),
            rows: stock.rows.map(r => Object.fromEntries(keys.map(k => [k, (r as Record<string, unknown>)[k] ?? null]))),
            next: null,
            total: stock.rows.length
        });
    });

    router.post('/v1/exports/audit', ...any, requireAbility('read', 'AuditLog'), async (req, res) => {
        const body = parse(auditBody, req.body);
        const ctx = branchContext(req);
        const filters = body.filters;
        if (filters.branch_oid !== undefined && !ctx.branchOids.includes(filters.branch_oid)) throw new AppError(403, 'You do not reach this branch');
        const scope = filters.branch_oid !== undefined ? [filters.branch_oid] : ctx.branchOids;
        const q = { ...filters, limit: PAGE, before: body.after };
        let total: number | null = null;
        if (!body.after) {
            total = await countAudit(deps, ctx, scope, q);
            tooMany(total);
        }
        const page = await readAudit(deps, ctx, scope, q);
        // The export's own row comes after the count and the first page, so it is not in the file it describes.
        if (!body.after) await audited(deps, ctx, 'audit', { format: body.format, filters, rows: total });
        ok(res, {
            columns: AUDIT_COLUMNS,
            rows: page.rows.map(r => ({
                created_at: r.created_at,
                branch_name: r.branch_name,
                actor_name: r.actor_name,
                action: r.action,
                entity: r.entity,
                entity_key: r.entity_key,
                after: r.after === null ? null : JSON.stringify(r.after)
            })),
            next: page.next,
            total
        });
    });

    router.post('/v1/exports/report', ...any, requireAbility('read', 'Report'), async (req, res) => {
        const body = parse(reportBody, req.body);
        const ctx = branchContext(req);
        if (body.branch_oid !== undefined && !ctx.branchOids.includes(body.branch_oid)) throw new AppError(403, 'You do not have access to this branch');
        await audited(deps, ctx, `report:${body.report}/${body.table}`, {
            format: body.format,
            from: body.from,
            to: body.to,
            rows: body.rows,
            ...(body.branch_oid ? { branch_oid: body.branch_oid } : {})
        });
        ok(res, null, 'Export recorded');
    });

    return router;
}
