import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { activateMember, memberAt } from '#src/features/members/members.service.ts';
import { notify } from '#src/features/notifications/notifications.service.ts';
import { pricingPromos, sellablePlan } from '#src/features/plans/plans.service.ts';
import { type DiscountKind, endDate, invoiceDue, invoiceStatus, type Quote, quote } from '#src/features/pricing/pricing.ts';
import { readOrgRules } from '#src/features/settings/settings.routes.ts';
import { addDays, daysBetween, dhakaInstant, type DhakaNow, shortDate, taka } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import { type Freeze, type InvoiceRow, METHODS, NEEDS_REFERENCE, type PaymentMethod, type PaymentRow, salesRepo, type SubscriptionRow } from './sales.repo.ts';

/**
 * Selling and money (phase 2 steps 4 and 5; D-009, D-037, D-057, D-061, D-063, D-067). Prices are computed here
 * only (pricing.ts), never trusted from the browser. Money rows are append-only; an invoice's paid amount is its
 * payments minus its refunds. Every action is audited at the branch, in the same transaction.
 */

export interface SaleInput {
    member_oid: string;
    plan_oid: string;
    start_date?: string | undefined;
    discount: { kind: DiscountKind; value: number; code?: string | undefined };
    charge_admission: boolean;
}

export interface PaymentInput {
    method: PaymentMethod;
    amount: number;
    reference?: string | null | undefined;
}

/** Discounts above 20 % of the plan price need a branch manager (D-061). */
export const MANAGER_DISCOUNT_PERCENT = 20;
/** A plan may start at most this many days in the past (the mock's rule). */
export const MAX_BACKDATE_DAYS = 7;
/** A full refund is allowed within this many days of the sale, if the member has not trained since (D-067 a). */
export const REFUND_WINDOW_DAYS = 3;
/** Admission is charged again when the last plan ended more than this many days before the new one starts. */
export const ADMISSION_GAP_DAYS = 30;

function actorOf(ctx: BranchContext): { oid: string; name: string } {
    if (!ctx.actor) throw new AppError(401, 'Please sign in');
    return ctx.actor;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/* ---------- wire shapes (the web app's Subscription, Invoice and PaymentRecord) ---------- */

export function subscriptionStatus(s: Pick<SubscriptionRow, 'start_date' | 'end_date' | 'freezes' | 'cancelled_at' | 'upgraded_to'>, today: string) {
    if (s.cancelled_at) return s.upgraded_to ? ('Upgraded' as const) : ('Cancelled' as const);
    if (s.start_date > today) return 'Upcoming' as const;
    if (s.end_date < today) return 'Expired' as const;
    return s.freezes.some(f => f.from <= today && today <= f.to) ? ('Frozen' as const) : ('Active' as const);
}

export function subscriptionWire(s: SubscriptionRow, today: string) {
    return {
        oid: s.oid,
        branch_oid: s.branch_oid,
        member_oid: s.member_oid,
        plan_oid: s.plan_oid,
        plan_name: s.plan_name,
        start_date: s.start_date,
        end_date: s.end_date,
        status: subscriptionStatus(s, today),
        freezable: s.freezable,
        kind: s.kind,
        sessions: s.sessions,
        sessions_used: s.sessions_used,
        sessions_left: s.sessions === null ? null : Math.max(0, s.sessions - s.sessions_used),
        total: s.total,
        paid: s.paid,
        due: s.due,
        invoice_oid: s.invoice_oid,
        freezes: s.freezes.map(f => ({ from: f.from, to: f.to, reason: f.reason })),
        cancelled_at: iso(s.cancelled_at),
        cancel_reason: s.cancel_reason,
        upgraded_to: s.upgraded_to,
        created_at: s.created_at.toISOString()
    };
}

function paymentWire(p: PaymentRow) {
    return {
        oid: p.oid,
        invoice_oid: p.invoice_oid,
        kind: p.kind,
        amount: p.amount,
        method: p.method,
        reference: p.reference,
        reason: p.reason,
        approved_by: p.approved_by,
        received_at: p.received_at.toISOString(),
        received_by: p.received_by
    };
}

export function invoiceWire(i: InvoiceRow, payments: PaymentRow[]) {
    const paid = i.paid - i.refunded;
    const status = invoiceStatus(i.total, i.paid, i.refunded);
    return {
        oid: i.oid,
        number: i.number,
        kind: i.kind,
        branch: { oid: i.branch_oid, code: i.branch_code, slug: i.branch_slug, name: i.branch_name, kind: 'BRANCH' as const },
        member_oid: i.member_oid,
        member_name: i.member_name,
        member_code: i.member_code,
        member_phone: i.member_phone,
        subscription_oid: i.subscription_oid,
        issued_at: i.issued_at.toISOString(),
        lines: i.lines,
        subtotal: i.subtotal,
        discount: i.discount,
        vat_rate: i.vat_rate,
        vat_inclusive: i.vat_inclusive,
        vat_bin: i.vat_bin,
        vat: i.vat,
        total: i.total,
        paid,
        refunded: i.refunded,
        due: invoiceDue(i.total, i.paid, i.refunded),
        status,
        payments: payments.filter(p => p.invoice_oid === i.oid).map(paymentWire)
    };
}

export async function invoiceOut(tx: Queryable, oid: string, branchOids: readonly string[]) {
    const inv = await salesRepo.invoice(tx, oid, branchOids);
    if (!inv) throw new AppError(404, 'Invoice not found');
    return invoiceWire(inv, await salesRepo.payments(tx, [inv.oid]));
}

/* ---------- quote and sale ---------- */

export function checkPayment(pay: PaymentInput, max: number, min = 0): void {
    if (!METHODS.includes(pay.method)) throw new AppError(400, 'Choose a payment method', [{ path: 'payment.method', message: 'Unknown method' }]);
    if (pay.amount < min || pay.amount > max)
        throw new AppError(400, `The payment must be between ${taka(min)} and ${taka(max)}.`, [{ path: 'payment.amount', message: 'Out of range' }]);
    if (pay.amount > 0 && NEEDS_REFERENCE.includes(pay.method) && !pay.reference?.trim()) {
        throw new AppError(400, 'Enter the transaction reference for this payment method.', [{ path: 'payment.reference', message: 'Required' }]);
    }
}

/** Admission is due for a new member, and for one whose last plan ended more than 30 days before this start. */
function admissionDue(subs: SubscriptionRow[], start: string): boolean {
    const last = subs.filter(s => s.kind === 'membership' && s.start_date <= s.end_date).at(-1);
    return !last || daysBetween(last.end_date, start) > ADMISSION_GAP_DAYS;
}

interface Priced {
    quote: Quote & { admission_suggested: boolean };
    plan: Awaited<ReturnType<typeof sellablePlan>>;
    member: Awaited<ReturnType<typeof memberAt>>;
    subs: SubscriptionRow[];
    start: string;
}

async function price(tx: Queryable, ctx: BranchContext, now: DhakaNow, input: SaleInput, canDiscount: boolean): Promise<Priced> {
    const member = await memberAt(tx, ctx, input.member_oid, now.date);
    const plan = await sellablePlan(tx, ctx.branchOid, input.plan_oid);
    const start = input.start_date ?? now.date;
    if (start < addDays(now.date, -MAX_BACKDATE_DAYS))
        throw new AppError(400, `A membership cannot start more than ${MAX_BACKDATE_DAYS} days in the past.`, [
            { path: 'start_date', message: 'Too far back' }
        ]);
    const rules = await readOrgRules(tx);
    const q = quote({
        plan_name: plan.name,
        price: plan.price,
        months: plan.months,
        admission_fee: plan.admission_fee,
        charge_admission: input.charge_admission,
        discount: { kind: input.discount.kind, value: input.discount.value, ...(input.discount.code !== undefined && { code: input.discount.code }) },
        start_date: start,
        today: now.date,
        vat_rate: rules.vat_rate,
        vat_inclusive: rules.vat_inclusive,
        promos: await pricingPromos(tx)
    });
    // A manual discount above 20 % of the plan price needs a manager; HQ's promo codes do not (D-061).
    if (input.discount.kind !== 'promo' && q.discount_percent > MANAGER_DISCOUNT_PERCENT && !canDiscount) {
        throw new AppError(403, `Discounts above ${MANAGER_DISCOUNT_PERCENT}% need a branch manager.`);
    }
    const subs = await salesRepo.subscriptions(tx, member.oid);
    return { quote: { ...q, admission_suggested: admissionDue(subs, start) }, plan, member, subs, start };
}

export async function quoteSale(db: Db, ctx: BranchContext, now: DhakaNow, input: SaleInput, canDiscount: boolean) {
    return withBranchTx(db, ctx, async tx => (await price(tx, ctx, now, input, canDiscount)).quote);
}

/** What an invoice is made from: a plan's quote, or a POS sale's (pos-pricing.ts). */
export type InvoiceDraft = Pick<Quote, 'subtotal' | 'discount' | 'discount_label' | 'vat_rate' | 'vat_inclusive' | 'vat' | 'total'> & {
    lines: ({ label: string; amount: number } & Record<string, unknown>)[];
};

/**
 * Numbers and writes an invoice at the context's branch (INV-GUL-2026-00001). `member.oid` is null for a walk-in POS
 * sale (D-102). For other features in the same transaction (POS); the caller audits it.
 */
export async function newInvoice(
    tx: Queryable,
    ctx: BranchContext,
    now: DhakaNow,
    member: { oid: string | null; code: string; name: string; phone: string | null },
    q: InvoiceDraft,
    vatBin: string | null,
    subscriptionOid: string | null,
    kind: 'sale' | 'upgrade' | 'locker' | 'pos'
) {
    const [branch] = await tx.query<{ code: string }>(sql`select code from branch where oid = ${ctx.branchOid}`);
    const year = now.date.slice(0, 4);
    const seq = await tx.query<{ value: number }>(sql`
        insert into branch_counter (branch_oid, name, value) values (${ctx.branchOid}, ${`invoice:${year}`}, 1)
        on conflict (branch_oid, name) do update set value = branch_counter.value + 1 returning value`);
    const number = `INV-${branch?.code ?? 'XXX'}-${year}-${String(seq[0]?.value ?? 0).padStart(5, '0')}`;
    return salesRepo.insertInvoice(
        tx,
        {
            branch_oid: ctx.branchOid,
            member_oid: member.oid,
            subscription_oid: subscriptionOid,
            number,
            kind,
            member_code: member.code,
            member_name: member.name,
            member_phone: member.phone,
            lines: q.discount ? [...q.lines, { label: q.discount_label ?? 'Discount', amount: -q.discount }] : q.lines,
            subtotal: q.subtotal,
            discount: q.discount,
            discount_label: q.discount_label,
            vat_rate: q.vat_rate,
            vat_inclusive: q.vat_inclusive,
            vat_bin: vatBin,
            vat: q.vat,
            total: q.total,
            issued_at: now.at
        },
        actorOf(ctx).oid
    );
}

export async function receipt(
    tx: Queryable,
    ctx: BranchContext,
    member: { oid: string; code: string; name: string; email: string | null; phone: string | null },
    invoiceOid: string,
    paymentOid: string,
    amount: number,
    number: string
) {
    await notify(tx, {
        branch_oid: ctx.branchOid,
        member,
        kind: 'receipt',
        subject: `Receipt for ${number}`,
        body: `Dear ${member.name}, we received ${taka(amount)} towards ${number}. Thank you.`,
        related_oid: invoiceOid,
        dedupe_key: `receipt:${paymentOid}`
    });
}

export async function sell(db: Db, ctx: BranchContext, now: DhakaNow, input: SaleInput, payment: PaymentInput, canDiscount: boolean) {
    const actor = actorOf(ctx);
    return withBranchTx(db, ctx, async tx => {
        const { quote: q, plan, member, subs, start } = await price(tx, ctx, now, input, canDiscount);
        if (member.status === 'Suspended') throw new AppError(409, 'This member is suspended. Sell after the suspension ends.');
        if (member.status === 'Banned') throw new AppError(409, 'This member is banned from their home branch.');
        if (member.anonymised) throw new AppError(409, 'This member was anonymised');
        if (q.promo_error) throw new AppError(400, q.promo_error, [{ path: 'discount.code', message: q.promo_error }]);
        checkPayment(payment, q.total);
        const end = endDate(start, plan.months);
        // Memberships may not overlap; PT packages run next to them (D-079), and only with a membership.
        const memberships = subs.filter(s => s.kind === 'membership' && !s.cancelled_at);
        if (plan.kind === 'pt' && !memberships.some(s => s.start_date <= s.end_date && s.end_date >= start))
            throw new AppError(409, 'A PT package goes with a membership. Sell the membership first.');
        const overlapping =
            plan.kind === 'membership' ? memberships.find(s => s.start_date <= s.end_date && s.end_date >= start && s.start_date <= end) : undefined;
        if (overlapping)
            throw new AppError(409, `This overlaps the ${overlapping.plan_name} plan that runs until ${shortDate(overlapping.end_date)}. Start the day after.`);
        const [rules] = await tx.query<{ vat_bin: string | null }>(sql`select vat_bin from org_settings`);
        const subOid = await salesRepo.insertSubscription(
            tx,
            {
                branch_oid: ctx.branchOid,
                home_branch_oid: member.branch_oid,
                member_oid: member.oid,
                plan_oid: plan.oid,
                plan_name: plan.name,
                months: plan.months,
                freezable: plan.kind === 'membership' && plan.freezable,
                kind: plan.kind,
                sessions: plan.sessions,
                start_date: start,
                end_date: end,
                invoice_oid: null,
                created_at: now.at
            },
            actor.oid
        );
        const invoiceOid = await newInvoice(tx, ctx, now, member, q, rules?.vat_bin ?? null, subOid, 'sale');
        await salesRepo.setInvoice(tx, subOid, invoiceOid);
        await activateMember(tx, member.oid, actor.oid);
        let paymentOid: string | null = null;
        if (payment.amount > 0) {
            paymentOid = await salesRepo.insertPayment(
                tx,
                {
                    branch_oid: ctx.branchOid,
                    invoice_oid: invoiceOid,
                    member_oid: member.oid,
                    kind: 'payment',
                    amount: payment.amount,
                    method: payment.method,
                    reference: payment.reference?.trim() ? payment.reference.trim() : null,
                    reason: null,
                    approved_by: null,
                    received_at: now.at
                },
                actor.oid
            );
        }
        const invoice = await invoiceOut(tx, invoiceOid, [ctx.branchOid]);
        const sub = await salesRepo.subscription(tx, subOid, [ctx.branchOid]);
        if (!sub) throw new Error('Subscription missing inside its own transaction');
        await recordAudit(tx, ctx, {
            action: 'create',
            entity: 'subscription',
            entityKey: `${member.code}/${invoice.number}`,
            before: null,
            after: { subscription: subscriptionWire(sub, now.date), invoice }
        });
        if (paymentOid) await receipt(tx, ctx, member, invoiceOid, paymentOid, payment.amount, invoice.number);
        return { subscription: subscriptionWire(sub, now.date), invoice };
    });
}

/**
 * For other features (locker rentals, D-082): charge a home-branch member for one item on its own invoice of `kind`,
 * VAT applied as for plans, and take a first payment (0 = all of it left as dues). Runs in the caller's transaction.
 */
export async function chargeItem(
    tx: Queryable,
    ctx: BranchContext,
    now: DhakaNow,
    memberOid: string,
    item: { label: string; amount: number; months: number; kind: 'locker' },
    payment: PaymentInput
) {
    const actor = actorOf(ctx);
    const member = await memberAt(tx, ctx, memberOid, now.date);
    if (member.anonymised) throw new AppError(409, 'This member was anonymised');
    const rules = await readOrgRules(tx);
    const q = quote({
        plan_name: item.label,
        price: item.amount,
        months: item.months,
        admission_fee: 0,
        charge_admission: false,
        discount: { kind: 'none', value: 0 },
        start_date: now.date,
        today: now.date,
        vat_rate: rules.vat_rate,
        vat_inclusive: rules.vat_inclusive,
        promos: []
    });
    checkPayment(payment, q.total);
    const invoiceOid = await newInvoice(tx, ctx, now, member, { ...q, lines: [{ label: item.label, amount: item.amount }] }, rules.vat_bin, null, item.kind);
    if (payment.amount > 0) {
        const paymentOid = await salesRepo.insertPayment(
            tx,
            {
                branch_oid: ctx.branchOid,
                invoice_oid: invoiceOid,
                member_oid: member.oid,
                kind: 'payment',
                amount: payment.amount,
                method: payment.method,
                reference: payment.reference?.trim() ? payment.reference.trim() : null,
                reason: null,
                approved_by: null,
                received_at: now.at
            },
            actor.oid
        );
        const inv = await invoiceOut(tx, invoiceOid, [ctx.branchOid]);
        await receipt(tx, ctx, member, invoiceOid, paymentOid, payment.amount, inv.number);
    }
    const invoice = await invoiceOut(tx, invoiceOid, [ctx.branchOid]);
    await recordAudit(tx, ctx, { action: 'create', entity: 'invoice', entityKey: `${member.code}/${invoice.number}`, before: null, after: invoice });
    return { invoice, member };
}

/* ---------- freeze, upgrade, cancel (at the member's home branch) ---------- */

async function homeSubscription(tx: Queryable, ctx: BranchContext, oid: string, today: string) {
    const sub = await salesRepo.subscription(tx, oid, [ctx.branchOid], true);
    if (!sub) throw new AppError(404, 'Subscription not found');
    const member = await memberAt(tx, ctx, sub.member_oid, today);
    return { sub, member };
}

export async function freezeSubscription(
    db: Db,
    ctx: BranchContext,
    now: DhakaNow,
    oid: string,
    input: { from?: string | undefined; days: number; reason: string }
) {
    const actor = actorOf(ctx);
    return withBranchTx(db, ctx, async tx => {
        const { sub, member } = await homeSubscription(tx, ctx, oid, now.date);
        const rules = await readOrgRules(tx);
        const from = input.from ?? now.date;
        const status = subscriptionStatus(sub, now.date);
        if (status === 'Cancelled' || status === 'Upgraded' || status === 'Expired')
            throw new AppError(409, `This plan has ${status === 'Expired' ? 'ended' : 'been closed'}.`);
        if (!sub.freezable) throw new AppError(409, 'This plan cannot be frozen.');
        if (rules.freeze_max_count === 0) throw new AppError(409, 'Freezes are switched off.');
        if (input.days < rules.freeze_min_days || input.days > rules.freeze_max_days)
            throw new AppError(400, `A freeze lasts ${rules.freeze_min_days} to ${rules.freeze_max_days} days.`, [{ path: 'days', message: 'Out of range' }]);
        if (from < now.date || from > sub.end_date)
            throw new AppError(400, 'The freeze must start today or later, before the plan ends.', [{ path: 'from', message: 'Out of range' }]);
        if (sub.freezes.length >= rules.freeze_max_count) {
            throw new AppError(
                409,
                rules.freeze_max_count === 1 ? 'This plan has already been frozen once.' : `This plan has already been frozen ${rules.freeze_max_count} times.`
            );
        }
        const to = addDays(from, input.days - 1);
        if (sub.freezes.some(f => f.from <= to && from <= f.to)) throw new AppError(409, 'This overlaps a freeze already on the plan.');
        const freeze: Freeze = { from, to, days: input.days, reason: input.reason, by: actor.oid, by_name: actor.name, at: now.at.toISOString() };
        const newEnd = addDays(sub.end_date, input.days);
        // The plan moves later: a plan sold after it must not overlap it.
        const later = (await salesRepo.subscriptions(tx, sub.member_oid)).find(
            s => s.oid !== sub.oid && s.start_date > sub.end_date && s.start_date <= newEnd && s.start_date <= s.end_date
        );
        if (later) throw new AppError(409, `The frozen days would run into the next plan (${later.plan_name}, from ${shortDate(later.start_date)}).`);
        await salesRepo.freeze(tx, oid, freeze, newEnd);
        const after = await salesRepo.subscription(tx, oid, [ctx.branchOid]);
        if (!after) throw new Error('Subscription missing inside its own transaction');
        await recordAudit(tx, ctx, {
            action: 'freeze',
            entity: 'subscription',
            entityKey: member.code,
            before: subscriptionWire(sub, now.date),
            after: subscriptionWire(after, now.date)
        });
        return { subscription: subscriptionWire(after, now.date), message: `Frozen until ${shortDate(to)}; the plan now ends ${shortDate(newEnd)}` };
    });
}

/** Ends a plan early (D-067 c): from today on it gives no access; no money moves (a refund is separate). */
export async function cancelSubscription(db: Db, ctx: BranchContext, now: DhakaNow, oid: string, reason: string) {
    const actor = actorOf(ctx);
    return withBranchTx(db, ctx, async tx => {
        const { sub, member } = await homeSubscription(tx, ctx, oid, now.date);
        const status = subscriptionStatus(sub, now.date);
        if (status === 'Cancelled' || status === 'Upgraded' || status === 'Expired') throw new AppError(409, 'This plan is not running.');
        const end = sub.start_date > now.date ? addDays(sub.start_date, -1) : addDays(now.date, -1);
        await salesRepo.end(tx, oid, end, reason, actor.oid, now.at);
        const after = await salesRepo.subscription(tx, oid, [ctx.branchOid]);
        if (!after) throw new Error('Subscription missing inside its own transaction');
        await recordAudit(tx, ctx, {
            action: 'cancel',
            entity: 'subscription',
            entityKey: member.code,
            before: subscriptionWire(sub, now.date),
            after: subscriptionWire(after, now.date)
        });
        return subscriptionWire(after, now.date);
    });
}

/**
 * Upgrade (D-067 b): to a plan of the same or a higher price at this branch. The new plan starts today, the old
 * one ends yesterday, and the unused days are credited pro rata on what was actually paid for the old plan, as
 * a line on the new invoice. No downgrades.
 */
export async function upgradeSubscription(db: Db, ctx: BranchContext, now: DhakaNow, oid: string, planOid: string, payment: PaymentInput) {
    const actor = actorOf(ctx);
    return withBranchTx(db, ctx, async tx => {
        const { sub, member } = await homeSubscription(tx, ctx, oid, now.date);
        if (sub.branch_oid !== ctx.branchOid) throw new AppError(409, 'Upgrade at the branch that sold the plan.');
        if (subscriptionStatus(sub, now.date) !== 'Active') throw new AppError(409, 'Only a running plan can be upgraded.');
        if (member.status === 'Suspended') throw new AppError(409, 'This member is suspended. Sell after the suspension ends.');
        if (member.status === 'Banned') throw new AppError(409, 'This member is banned from their home branch.');
        const plan = await sellablePlan(tx, ctx.branchOid, planOid);
        if (sub.kind !== 'membership' || plan.kind !== 'membership') throw new AppError(409, 'Only a membership is upgraded, to another membership.');
        if (plan.oid === sub.plan_oid) throw new AppError(400, 'That is the plan the member already has.', [{ path: 'plan_oid', message: 'Same plan' }]);
        const old = await salesRepo.invoice(tx, sub.invoice_oid ?? '', [ctx.branchOid]);
        const oldPrice = old?.lines[0]?.amount ?? 0;
        if (plan.price < oldPrice)
            throw new AppError(409, 'Plans can only be upgraded to the same or a higher price. To move down, end this plan and sell a new one.');
        const totalDays = daysBetween(sub.start_date, sub.end_date) + 1;
        const unused = Math.max(0, daysBetween(now.date, sub.end_date) + 1);
        const paid = old ? old.paid - old.refunded : 0;
        const rules = await readOrgRules(tx);
        const credit = Math.round((paid * unused) / totalDays);
        const base = quote({
            plan_name: plan.name,
            price: plan.price,
            months: plan.months,
            admission_fee: 0,
            charge_admission: false,
            discount: { kind: 'amount', value: credit },
            start_date: now.date,
            today: now.date,
            vat_rate: rules.vat_rate,
            vat_inclusive: rules.vat_inclusive,
            promos: []
        });
        const q: Quote = { ...base, discount_label: credit ? `Credit: ${unused} unused days of ${sub.plan_name}` : null };
        checkPayment(payment, q.total);
        const end = endDate(now.date, plan.months);
        const later = (await salesRepo.subscriptions(tx, sub.member_oid)).find(
            s => s.oid !== sub.oid && s.kind === 'membership' && s.start_date > now.date && s.start_date <= end && s.start_date <= s.end_date
        );
        if (later) throw new AppError(409, `The new plan would overlap the next one (${later.plan_name}, from ${shortDate(later.start_date)}).`);
        const subOid = await salesRepo.insertSubscription(
            tx,
            {
                branch_oid: ctx.branchOid,
                home_branch_oid: member.branch_oid,
                member_oid: member.oid,
                plan_oid: plan.oid,
                plan_name: plan.name,
                months: plan.months,
                freezable: plan.freezable,
                kind: 'membership',
                sessions: null,
                start_date: now.date,
                end_date: end,
                invoice_oid: null,
                created_at: now.at
            },
            actor.oid
        );
        await salesRepo.end(tx, sub.oid, addDays(now.date, -1), `Upgraded to ${plan.name}`, actor.oid, now.at, subOid);
        const invoiceOid = await newInvoice(tx, ctx, now, member, q, rules.vat_bin, subOid, 'upgrade');
        await salesRepo.setInvoice(tx, subOid, invoiceOid);
        let paymentOid: string | null = null;
        if (payment.amount > 0) {
            paymentOid = await salesRepo.insertPayment(
                tx,
                {
                    branch_oid: ctx.branchOid,
                    invoice_oid: invoiceOid,
                    member_oid: member.oid,
                    kind: 'payment',
                    amount: payment.amount,
                    method: payment.method,
                    reference: payment.reference?.trim() ? payment.reference.trim() : null,
                    reason: null,
                    approved_by: null,
                    received_at: now.at
                },
                actor.oid
            );
        }
        const invoice = await invoiceOut(tx, invoiceOid, [ctx.branchOid]);
        const next = await salesRepo.subscription(tx, subOid, [ctx.branchOid]);
        if (!next) throw new Error('Subscription missing inside its own transaction');
        await recordAudit(tx, ctx, {
            action: 'upgrade',
            entity: 'subscription',
            entityKey: `${member.code}/${invoice.number}`,
            before: subscriptionWire(sub, now.date),
            after: { subscription: subscriptionWire(next, now.date), invoice, credit }
        });
        if (paymentOid) await receipt(tx, ctx, member, invoiceOid, paymentOid, payment.amount, invoice.number);
        return { subscription: subscriptionWire(next, now.date), invoice, credit };
    });
}

/* ---------- payments, refunds ---------- */

export async function payInvoice(db: Db, ctx: BranchContext, now: DhakaNow, invoiceOid: string, payment: PaymentInput) {
    const actor = actorOf(ctx);
    return withBranchTx(db, ctx, async tx => {
        const inv = await salesRepo.invoice(tx, invoiceOid, [ctx.branchOid], true);
        if (!inv) throw new AppError(404, 'Invoice not found');
        const due = invoiceDue(inv.total, inv.paid, inv.refunded);
        if (due <= 0) throw new AppError(409, inv.refunded > 0 && inv.paid - inv.refunded <= 0 ? 'This invoice was refunded.' : 'This invoice is paid.');
        checkPayment(payment, due, 1);
        const paymentOid = await salesRepo.insertPayment(
            tx,
            {
                branch_oid: ctx.branchOid,
                invoice_oid: inv.oid,
                member_oid: inv.member_oid,
                kind: 'payment',
                amount: payment.amount,
                method: payment.method,
                reference: payment.reference?.trim() ? payment.reference.trim() : null,
                reason: null,
                approved_by: null,
                received_at: now.at
            },
            actor.oid
        );
        const after = await invoiceOut(tx, inv.oid, [ctx.branchOid]);
        await recordAudit(tx, ctx, {
            action: 'pay',
            entity: 'invoice',
            entityKey: inv.number,
            before: { paid: inv.paid - inv.refunded, due },
            after: { paid: after.paid, due: after.due, payment: paymentOid }
        });
        const member = inv.member_oid ? await memberAt(tx, ctx, inv.member_oid, now.date).catch(() => null) : null;
        if (member) await receipt(tx, ctx, member, inv.oid, paymentOid, payment.amount, inv.number);
        return after;
    });
}

/**
 * Refund (D-067 a). A FULL refund (everything paid on the invoice) within 3 days of the sale, with no check-in
 * since, is the published policy: the desk may do it, and it ends the plan. Any other refund needs a manager
 * (`manage Payment`) and never exceeds what was paid less earlier refunds.
 */
export async function refundInvoice(
    db: Db,
    ctx: BranchContext,
    now: DhakaNow,
    invoiceOid: string,
    input: { amount?: number | undefined; method: PaymentMethod; reference?: string | null | undefined; reason: string },
    isManager: boolean
) {
    const actor = actorOf(ctx);
    return withBranchTx(db, ctx, async tx => {
        const inv = await salesRepo.invoice(tx, invoiceOid, [ctx.branchOid], true);
        if (!inv) throw new AppError(404, 'Invoice not found');
        // A POS sale's money goes back with its items (POST /v1/pos/sales/:oid/return), so the stock moves too.
        if (inv.kind === 'pos') throw new AppError(409, 'Return the items on this sale from the POS sales list.');
        const net = inv.paid - inv.refunded;
        if (net <= 0) throw new AppError(409, 'Nothing has been paid on this invoice.');
        const amount = input.amount ?? net;
        if (amount < 1 || amount > net) throw new AppError(400, `A refund is between ৳1 and ${taka(net)}.`, [{ path: 'amount', message: 'Out of range' }]);
        if (!METHODS.includes(input.method)) throw new AppError(400, 'Choose how the money goes back', [{ path: 'method', message: 'Unknown method' }]);
        const full = amount === net;
        const withinWindow = daysBetween(new Date(inv.issued_at.getTime() + 6 * 3600_000).toISOString().slice(0, 10), now.date) <= REFUND_WINDOW_DAYS;
        const unused = inv.member_oid === null || !(await salesRepo.visitedSince(tx, inv.member_oid, inv.issued_at));
        const policy = full && withinWindow && unused;
        if (!policy && !isManager) {
            throw new AppError(
                403,
                `Only a full refund within ${REFUND_WINDOW_DAYS} days of the sale, before the member has trained, can be done at the desk. Ask a branch manager.`
            );
        }
        const refundOid = await salesRepo.insertPayment(
            tx,
            {
                branch_oid: ctx.branchOid,
                invoice_oid: inv.oid,
                member_oid: inv.member_oid,
                kind: 'refund',
                amount,
                method: input.method,
                reference: input.reference?.trim() ? input.reference.trim() : null,
                reason: input.reason,
                approved_by: actor.oid,
                received_at: now.at
            },
            actor.oid
        );
        // A full refund takes the plan back too.
        if (full && inv.subscription_oid) {
            const sub = await salesRepo.subscription(tx, inv.subscription_oid, [ctx.branchOid], true);
            if (sub && !sub.cancelled_at) {
                const end = sub.start_date > now.date ? addDays(sub.start_date, -1) : addDays(now.date, -1);
                await salesRepo.end(tx, sub.oid, end, `Refunded: ${input.reason}`, actor.oid, now.at);
            }
        }
        const after = await invoiceOut(tx, inv.oid, [ctx.branchOid]);
        await recordAudit(tx, ctx, {
            action: 'refund',
            entity: 'invoice',
            entityKey: inv.number,
            before: { paid: net },
            after: { paid: after.paid, refund: refundOid, amount, reason: input.reason, policy }
        });
        return after;
    });
}

/* ---------- reads ---------- */

export async function memberSubscriptions(db: Db, ctx: BranchContext, now: DhakaNow, memberOid: string) {
    return withBranchTx(db, ctx, async tx => {
        await memberAt(tx, ctx, memberOid, now.date);
        return (await salesRepo.subscriptions(tx, memberOid)).reverse().map(s => subscriptionWire(s, now.date));
    });
}

export async function memberInvoices(db: Db, ctx: BranchContext, now: DhakaNow, memberOid: string) {
    return withBranchTx(db, ctx, async tx => {
        await memberAt(tx, ctx, memberOid, now.date);
        const list = await salesRepo.memberInvoices(tx, memberOid, [ctx.branchOid]);
        const pays = await salesRepo.payments(
            tx,
            list.map(i => i.oid)
        );
        return list.map(i => invoiceWire(i, pays));
    });
}

export const getInvoice = (db: Db, ctx: BranchContext, oid: string) => withBranchTx(db, ctx, tx => invoiceOut(tx, oid, [ctx.branchOid]));

export async function recentPayments(db: Db, ctx: BranchContext) {
    return withBranchTx(db, ctx, async tx => {
        const rows = await salesRepo.recentPayments(tx, ctx.branchOid, 50);
        const dues = await salesRepo.topDues(tx, ctx.branchOid, 10);
        return {
            payments: rows.map(p => ({
                ...paymentWire(p),
                invoice_number: p.invoice_number,
                member_name: p.member_name,
                member_oid: p.member_oid,
                member_code: p.member_code
            })),
            top_dues: dues
        };
    });
}

/**
 * Payments and refunds at the branch in a range of Dhaka days, oldest first, a page at a time (exports, D-107).
 * `after` is the last row's `[received_at, oid]`; the first page also counts the rows.
 */
export async function paymentsPage(db: Db, ctx: BranchContext, range: { from: string; to: string }, after: [string, string] | null, limit: number) {
    const from = dhakaInstant(range.from);
    const to = dhakaInstant(addDays(range.to, 1));
    return withBranchTx(db, ctx, async tx => {
        const rows = await tx.query<{
            oid: string;
            received_at: string;
            invoice_number: string;
            member_code: string;
            member_name: string;
            kind: string;
            method: string;
            reference: string | null;
            reason: string | null;
            amount: number;
            received_by: string | null;
        }>(sql`
            select p.oid::text, p.received_at::text as received_at, i.number as invoice_number, i.member_code, i.member_name, p.kind, p.method,
                   p.reference, p.reason, p.amount::float8 as amount, u.name as received_by
            from payment p join invoice i on i.oid = p.invoice_oid left join app_user u on u.oid = p.received_by
            where p.branch_oid = ${ctx.branchOid} and p.received_at >= ${from} and p.received_at < ${to}
              ${after ? sql`and (p.received_at, p.oid) > (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql.raw('')}
            order by p.received_at, p.oid
            limit ${limit}`);
        const [total] = after
            ? [null]
            : await tx.query<{ n: number }>(sql`
                  select count(*)::int as n from payment where branch_oid = ${ctx.branchOid} and received_at >= ${from} and received_at < ${to}`);
        return { rows, total: total?.n ?? null };
    });
}

/* ---------- cash closing ---------- */

export async function cashClosing(db: Db, ctx: BranchContext, now: DhakaNow) {
    const from = dhakaInstant(now.date);
    const to = dhakaInstant(addDays(now.date, 1));
    return withBranchTx(db, ctx, async tx => {
        const takings = await salesRepo.dayTakings(tx, ctx.branchOid, from, to);
        const counts = await salesRepo.dayInvoices(tx, ctx.branchOid, from, to);
        const closings = await salesRepo.closings(tx, ctx.branchOid, now.date);
        const byMethod = METHODS.map(method => {
            const rows = takings.filter(r => r.method === method);
            return { method, count: rows.reduce((s, r) => s + r.count, 0), amount: rows.reduce((s, r) => s + r.amount, 0) };
        });
        const staff = new Map<string, { staff_oid: string; name: string; cash: number; total: number }>();
        for (const r of takings) {
            if (!r.staff_oid) continue;
            const e = staff.get(r.staff_oid) ?? { staff_oid: r.staff_oid, name: r.staff_name ?? '', cash: 0, total: 0 };
            e.total += r.amount;
            if (r.method === 'cash') e.cash += r.amount;
            staff.set(r.staff_oid, e);
        }
        for (const c of closings) if (!staff.has(c.staff_oid)) staff.set(c.staff_oid, { staff_oid: c.staff_oid, name: c.staff_name, cash: 0, total: 0 });
        return {
            date: now.date,
            by_method: byMethod,
            total: byMethod.reduce((s, m) => s + m.amount, 0),
            invoices: counts.invoices,
            new_members: counts.new_members,
            renewals: counts.renewals,
            pos_sales: counts.pos_sales,
            by_staff: [...staff.values()].map(s => {
                const closed = closings.find(c => c.staff_oid === s.staff_oid);
                return {
                    ...s,
                    closed: closed
                        ? {
                              counted_cash: closed.counted_cash,
                              expected_cash: closed.expected_cash,
                              difference: closed.counted_cash - closed.expected_cash,
                              note: closed.note,
                              at: closed.created_at.toISOString()
                          }
                        : null
                };
            })
        };
    });
}

/** A staff member closes their day: what they counted against the cash the system says they took. Once a day. */
export async function closeDay(db: Db, ctx: BranchContext, now: DhakaNow, input: { counted_cash: number; note?: string | null | undefined }) {
    const actor = actorOf(ctx);
    const summary = await cashClosing(db, ctx, now);
    const expected = summary.by_staff.find(s => s.staff_oid === actor.oid)?.cash ?? 0;
    return withBranchTx(db, ctx, async tx => {
        const rows = await tx.query<{ oid: string }>(sql`
            insert into cash_closing (branch_oid, day, staff_oid, expected_cash, counted_cash, note)
            values (${ctx.branchOid}, ${now.date}, ${actor.oid}, ${expected}, ${input.counted_cash}, ${input.note ?? null})
            on conflict (branch_oid, day, staff_oid) do nothing returning oid`);
        if (!rows.length) throw new AppError(409, 'You have already closed today.');
        const result = {
            day: now.date,
            expected_cash: expected,
            counted_cash: input.counted_cash,
            difference: input.counted_cash - expected,
            note: input.note ?? null
        };
        await recordAudit(tx, ctx, { action: 'close', entity: 'cash_closing', entityKey: `${now.date}/${actor.name}`, before: null, after: result });
        return result;
    });
}
