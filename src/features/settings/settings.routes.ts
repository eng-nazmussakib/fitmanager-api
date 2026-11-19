import { Router } from 'express';
import * as v from 'valibot';

import { authenticate, currentUser, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { branchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

/**
 * HQ settings, one row (`org_settings`, migration 008):
 * - VAT (D-037, D-057): the rate, the BIN printed on invoices, and whether prices include VAT. Every quote and sale
 *   reads them at that moment and the invoice keeps a copy, so a change here never rewrites an issued invoice.
 * - Freeze rule (D-063): the shortest and longest freeze, in days. Which plans may freeze is per plan template.
 */
export interface OrgRules {
    /** A fraction: 0.15 = 15 %. 0 = not VAT-registered. */
    vat_rate: number;
    vat_bin: string | null;
    /** true: prices already include VAT ("of which VAT"); false: VAT is added on top. */
    vat_inclusive: boolean;
    freeze_min_days: number;
    freeze_max_days: number;
    /** Freezes allowed on one plan (D-067 e); 0 = none. */
    freeze_max_count: number;
}

export interface OrgSettings extends OrgRules {
    updated_at: string | null;
    updated_by: string | null;
}

/** Longest freeze HQ may allow. */
export const MAX_FREEZE_DAYS = 365;

/** Highest rate accepted: a typo guard, well above Bangladesh's 15 % standard rate (same as the web model). */
export const MAX_VAT_RATE = 0.5;

const updateSchema = v.pipe(
    v.strictObject({
        vat_rate: v.optional(
            v.pipe(
                v.number('A number, e.g. 0.15 for 15 %'),
                v.minValue(0, 'VAT cannot be negative'),
                v.maxValue(MAX_VAT_RATE, 'VAT must be at most 50 %'),
                // Basis points: 7.5 % is fine, 7.123 % is a typo.
                v.transform(r => Math.round(r * 10000) / 10000)
            )
        ),
        vat_bin: v.optional(
            v.nullable(
                v.pipe(
                    v.string(),
                    v.trim(),
                    v.transform(s => s || null),
                    v.nullable(v.pipe(v.string(), v.regex(/^[0-9-]{9,20}$/, 'A BIN is 9 to 20 digits (dashes allowed)')))
                )
            )
        ),
        vat_inclusive: v.optional(v.boolean()),
        freeze_min_days: v.optional(
            v.pipe(v.number(), v.integer('Whole days'), v.minValue(1, 'At least 1 day'), v.maxValue(MAX_FREEZE_DAYS, 'At most 365 days'))
        ),
        freeze_max_days: v.optional(
            v.pipe(v.number(), v.integer('Whole days'), v.minValue(1, 'At least 1 day'), v.maxValue(MAX_FREEZE_DAYS, 'At most 365 days'))
        ),
        freeze_max_count: v.optional(v.pipe(v.number(), v.integer('A whole number'), v.minValue(0, 'At least 0'), v.maxValue(12, 'At most 12')))
    }),
    v.check(b => Object.keys(b).length > 0, 'Nothing to change')
);

const RULES = sql.raw('s.vat_rate::float8 as vat_rate, s.vat_bin, s.vat_inclusive, s.freeze_min_days, s.freeze_max_days, s.freeze_max_count');

/** The rules in force now (always one row: migration 008 inserts it). Pricing and freezes read them per sale. */
export async function readOrgRules(db: Queryable): Promise<OrgRules> {
    const [row] = await db.query<OrgRules>(sql`select ${RULES} from org_settings s`);
    if (!row) throw new Error('org_settings has no row (migration 008)');
    return row;
}

export function settingsRouter(deps: AppDeps): Router {
    const { db } = deps;
    const router = Router();
    const hq = [authenticate(deps), requireBranch('HQ')];

    const read = async (q: Queryable) => {
        const [row] = await q.query<OrgSettings>(sql`
            select ${RULES}, s.updated_at, u.name as updated_by
            from org_settings s left join app_user u on u.oid = s.updated_by`);
        if (!row) throw new Error('org_settings has no row (migration 008)');
        return row;
    };

    // The rules every signed-in user works by (the freeze dialog, receipts): read-only, no subject needed.
    router.get('/v1/rules', authenticate(deps), async (_req, res) => {
        ok(res, await readOrgRules(db));
    });

    router.get('/v1/hq/settings', ...hq, requireAbility('read', 'Settings'), async (_req, res) => {
        ok(res, await read(db));
    });

    router.patch('/v1/hq/settings', ...hq, requireAbility('update', 'Settings'), async (req, res) => {
        const body = parse(updateSchema, req.body);
        const ctx = branchContext(req); // the HQ row: settings are HQ data (D-043)
        const row = await withBranchTx(db, ctx, async tx => {
            const before = await readOrgRules(tx);
            const min = body.freeze_min_days ?? before.freeze_min_days;
            const max = body.freeze_max_days ?? before.freeze_max_days;
            if (min > max)
                throw new AppError(400, `The shortest freeze (${min} days) is longer than the longest (${max} days)`, [
                    {
                        path: body.freeze_min_days === undefined ? 'freeze_max_days' : 'freeze_min_days',
                        message: 'The shortest freeze must not be longer than the longest'
                    }
                ]);
            await tx.query(sql`
                update org_settings set
                    vat_rate = coalesce(${body.vat_rate ?? null}::numeric, vat_rate),
                    vat_bin = case when ${body.vat_bin !== undefined} then ${body.vat_bin ?? null}::text else vat_bin end,
                    vat_inclusive = coalesce(${body.vat_inclusive ?? null}::boolean, vat_inclusive),
                    freeze_min_days = ${min}, freeze_max_days = ${max},
                    freeze_max_count = coalesce(${body.freeze_max_count ?? null}::int, freeze_max_count),
                    updated_at = now(), updated_by = ${currentUser(req).oid}`);
            const after = await read(tx);
            const { updated_at: _at, updated_by: _by, ...rules } = after;
            await recordAudit(tx, ctx, { action: 'update', entity: 'org_settings', entityKey: 'org', before, after: rules });
            return after;
        });
        await deps.cache.del('public:plans'); // it carries the VAT rate and mode
        ok(res, row, 'Settings saved');
    });

    return router;
}
