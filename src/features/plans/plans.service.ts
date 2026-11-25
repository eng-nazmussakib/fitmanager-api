import type { Db, Queryable } from '#src/db/db.ts';
import { pgErrorCode, sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import type { Promo as PricingPromo } from '#src/features/pricing/pricing.ts';
import { AppError } from '#src/lib/http.ts';

import { type Plan, plansRepo, type PlanTemplate, type Promo } from './plans.repo.ts';
import { type PlanUpdate, type PromoCreate, promoRules, type PromoUpdate, type TemplateCreate, type TemplateUpdate } from './plans.schema.ts';

/**
 * Plans, plan templates and promo codes. Only HQ writes any of them: the
 * routes sit behind `requireBranch('HQ')`. Every write is audited at HQ, in the same transaction.
 */

/** "GUL-SIN-3M": branch code, the tier's first three letters, months. */
export const planCode = (branchCode: string, tier: string, months: number) => `${branchCode}-${tier.slice(0, 3).toUpperCase().replace(/-/g, '')}-${months}M`;

/** A row just written or locked in this transaction: missing means a bug, not a client error. */
function found<T>(row: T | undefined): T {
    if (row === undefined) throw new Error('Row missing inside its own transaction');
    return row;
}

/** HQ writes always have a signed-in actor (the routes sit behind `authenticate`). */
function actorOf(ctx: BranchContext): string {
    if (!ctx.actor) throw new AppError(401, 'Please sign in');
    return ctx.actor.oid;
}

function conflict(err: unknown, message: string, path: string): never {
    const code = pgErrorCode(err);
    if (code === '23505') throw new AppError(409, message, [{ path, message }]);
    if (code === '23503') throw new AppError(400, 'Unknown branch or plan template');
    if (code === '23514') throw new AppError(400, (err as Error).message);
    throw err;
}

/** The plan as the desk may sell it at this branch, or 404 (step 4 uses this). */
export async function sellablePlan(tx: Queryable, branchOid: string, planOid: string): Promise<Plan> {
    const plan = await plansRepo.plan(tx, planOid, [branchOid]);
    if (!plan?.sellable) throw new AppError(404, 'Plan not found at this branch');
    return plan;
}

/** Active promo codes in the shape pricing takes (validity dates are checked there). */
export async function pricingPromos(db: Queryable): Promise<PricingPromo[]> {
    return (await plansRepo.promos(db))
        .filter(p => p.active)
        .map(p => ({
            code: p.code,
            label: p.label,
            ...(p.percent !== null && { percent: p.percent }),
            ...(p.amount !== null && { amount: p.amount }),
            ...(p.waive_admission && { waive_admission: true }),
            from: p.valid_from,
            to: p.valid_to
        }));
}

export async function createPlan(db: Db, ctx: BranchContext, input: { branch_oid: string; template_oid: string; price?: number; admission_fee: number }) {
    if (!ctx.branchOids.includes(input.branch_oid)) throw new AppError(404, 'Branch not found', [{ path: 'branch_oid', message: 'Not a branch you reach' }]);
    return withBranchTx(db, ctx, async tx => {
        const [branch] = await tx.query<{ code: string; kind: string }>(sql`select code, kind from branch where oid = ${input.branch_oid}`);
        if (branch?.kind !== 'BRANCH') throw new AppError(400, 'Only a branch sells plans', [{ path: 'branch_oid', message: 'Not a branch' }]);
        const template = await plansRepo.template(tx, input.template_oid);
        if (!template) throw new AppError(400, 'Unknown plan template', [{ path: 'template_oid', message: 'Unknown plan template' }]);
        const oid = await plansRepo
            .createPlan(
                tx,
                {
                    branch_oid: input.branch_oid,
                    template_oid: template.oid,
                    code: planCode(branch.code, template.tier, template.months),
                    price: input.price ?? template.base_price,
                    admission_fee: input.admission_fee
                },
                actorOf(ctx)
            )
            .catch((err: unknown) => conflict(err, 'This branch already sells this plan', 'template_oid'));
        const plan = found(await plansRepo.plan(tx, oid, [input.branch_oid]));
        await recordAudit(tx, ctx, { action: 'create', entity: 'plan', entityKey: plan.code, before: null, after: plan });
        return plan;
    });
}

export async function updatePlan(db: Db, ctx: BranchContext, oid: string, input: PlanUpdate): Promise<Plan> {
    return withBranchTx(db, ctx, async tx => {
        // A plan of a branch outside the context looks like one that does not exist (the filter, then RLS).
        const before = await plansRepo.plan(tx, oid, ctx.branchOids, true);
        if (!before) throw new AppError(404, 'Plan not found');
        await plansRepo.updatePlan(tx, oid, input, actorOf(ctx));
        const after = found(await plansRepo.plan(tx, oid, ctx.branchOids));
        await recordAudit(tx, ctx, { action: 'update', entity: 'plan', entityKey: after.code, before, after });
        return after;
    });
}

export async function createTemplate(db: Db, ctx: BranchContext, input: TemplateCreate): Promise<PlanTemplate> {
    return withBranchTx(db, ctx, async tx => {
        const oid = await plansRepo
            .createTemplate(tx, ctx.branchOid, input, actorOf(ctx))
            .catch((err: unknown) => conflict(err, 'A template for this tier and period exists', 'period'));
        const row = found(await plansRepo.template(tx, oid));
        await recordAudit(tx, ctx, { action: 'create', entity: 'plan_template', entityKey: `${row.tier}/${row.period}`, before: null, after: row });
        return row;
    });
}

export async function updateTemplate(db: Db, ctx: BranchContext, oid: string, input: TemplateUpdate): Promise<PlanTemplate> {
    return withBranchTx(db, ctx, async tx => {
        const before = await plansRepo.template(tx, oid, true);
        if (!before) throw new AppError(404, 'Plan template not found');
        await plansRepo.updateTemplate(tx, oid, input, actorOf(ctx));
        const after = found(await plansRepo.template(tx, oid));
        await recordAudit(tx, ctx, { action: 'update', entity: 'plan_template', entityKey: `${after.tier}/${after.period}`, before, after });
        return after;
    });
}

export async function createPromo(db: Db, ctx: BranchContext, input: PromoCreate): Promise<Promo> {
    return withBranchTx(db, ctx, async tx => {
        await plansRepo.createPromo(tx, ctx.branchOid, input, actorOf(ctx)).catch((err: unknown) => conflict(err, 'This promo code exists', 'code'));
        const row = found(await plansRepo.promo(tx, input.code));
        await recordAudit(tx, ctx, { action: 'create', entity: 'promo', entityKey: row.code, before: null, after: row });
        return row;
    });
}

export async function updatePromo(db: Db, ctx: BranchContext, code: string, input: PromoUpdate): Promise<Promo> {
    return withBranchTx(db, ctx, async tx => {
        const before = await plansRepo.promo(tx, code, true);
        if (!before) throw new AppError(404, 'Promo code not found');
        // Choosing a new effect replaces the old one: { percent: 15 } turns a ৳500-off code into 15 % off.
        const effectSent = input.percent !== undefined || input.amount !== undefined || input.waive_admission !== undefined;
        const merged: Omit<Promo, 'code'> = {
            label: input.label ?? before.label,
            percent: effectSent ? (input.percent ?? null) : before.percent,
            amount: effectSent ? (input.amount ?? null) : before.amount,
            waive_admission: effectSent ? (input.waive_admission ?? false) : before.waive_admission,
            valid_from: input.valid_from ?? before.valid_from,
            valid_to: input.valid_to ?? before.valid_to,
            active: input.active ?? before.active
        };
        if (!promoRules.promoEffect(merged)) throw new AppError(400, promoRules.EFFECT);
        if (merged.valid_from > merged.valid_to) throw new AppError(400, '`valid_from` must not be after `valid_to`');
        await plansRepo.updatePromo(tx, code, merged, actorOf(ctx));
        const after = found(await plansRepo.promo(tx, code));
        await recordAudit(tx, ctx, { action: 'update', entity: 'promo', entityKey: code, before, after });
        return after;
    });
}
