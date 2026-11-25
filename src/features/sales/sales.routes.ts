import { Router } from 'express';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { ok, parse } from '#src/lib/http.ts';

import { cancelSchema, closeSchema, freezeSchema, oidParams, paySchema, refundSchema, saleSchema, upgradeSchema } from './sales.schema.ts';
import {
    cancelSubscription,
    cashClosing,
    closeDay,
    freezeSubscription,
    getInvoice,
    memberInvoices,
    memberSubscriptions,
    payInvoice,
    quoteSale,
    recentPayments,
    refundInvoice,
    sell,
    upgradeSubscription
} from './sales.service.ts';

/**
 * Sales and money at the branch in `X-Branch-Id`.
 * - `POST /v1/subscriptions/quote`, `POST /v1/subscriptions` (`create Subscription`; > 20 % off needs `manage`)
 * - `POST /v1/subscriptions/:oid/freeze` `{ from?, days, reason }`, `/cancel` `{ reason }`, `/upgrade`
 *   `{ plan_oid, payment }` (`update Subscription`: a manager)
 * - `POST /v1/payments` (dues), `GET /v1/payments` (recent + top dues), `GET /v1/invoices/:oid`,
 *   `POST /v1/invoices/:oid/refund` (the desk for a policy refund, a manager for any other)
 * - `GET /v1/cash-closing/today`, `POST /v1/cash-closing` `{ counted_cash, note? }`
 * - `GET /v1/members/:oid/subscriptions`, `/invoices`
 */
export function salesRouter(deps: AppDeps): Router {
    const { db } = deps;
    const router = Router();
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const now = () => dhakaNow(deps.clock());

    router.post('/v1/subscriptions/quote', ...branch, requireAbility('create', 'Subscription'), async (req, res) => {
        const { payment: _p, ...sale } = parse(saleSchema, req.body);
        ok(res, await quoteSale(db, branchContext(req), now(), sale, req.auth?.ability.can('manage', 'Subscription') ?? false));
    });

    router.post('/v1/subscriptions', ...branch, requireAbility('create', 'Subscription'), async (req, res) => {
        const { payment, ...sale } = parse(saleSchema, req.body);
        const out = await sell(db, branchContext(req), now(), sale, payment, req.auth?.ability.can('manage', 'Subscription') ?? false);
        ok(res, out, out.invoice.due ? `Membership sold. ৳${out.invoice.due.toLocaleString('en-IN')} recorded as dues.` : 'Membership sold and paid', 201);
    });

    router.post('/v1/subscriptions/:oid/freeze', ...branch, requireAbility('update', 'Subscription'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const body = parse(freezeSchema, req.body);
        const { subscription, message } = await freezeSubscription(db, branchContext(req), now(), oid, body);
        ok(res, subscription, message);
    });

    router.post('/v1/subscriptions/:oid/cancel', ...branch, requireAbility('update', 'Subscription'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { reason } = parse(cancelSchema, req.body);
        ok(res, await cancelSubscription(db, branchContext(req), now(), oid, reason), 'Plan ended');
    });

    router.post('/v1/subscriptions/:oid/upgrade', ...branch, requireAbility('update', 'Subscription'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const body = parse(upgradeSchema, req.body);
        const out = await upgradeSubscription(db, branchContext(req), now(), oid, body.plan_oid, body.payment);
        ok(res, out, `Upgraded to ${out.subscription.plan_name}`, 201);
    });

    router.post('/v1/payments', ...branch, requireAbility('create', 'Payment'), async (req, res) => {
        const { invoice_oid, ...payment } = parse(paySchema, req.body);
        ok(res, await payInvoice(db, branchContext(req), now(), invoice_oid, payment), `Payment of ৳${payment.amount.toLocaleString('en-IN')} recorded`);
    });

    router.get('/v1/payments', ...branch, requireAbility('read', 'Payment'), async (req, res) => {
        ok(res, await recentPayments(db, branchContext(req)));
    });

    router.get('/v1/invoices/:oid', ...branch, requireAbility('read', 'Invoice'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await getInvoice(db, branchContext(req), oid));
    });

    router.post('/v1/invoices/:oid/refund', ...branch, requireAbility('create', 'Payment'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const body = parse(refundSchema, req.body);
        ok(res, await refundInvoice(db, branchContext(req), now(), oid, body, req.auth?.ability.can('manage', 'Payment') ?? false), 'Refund recorded');
    });

    router.get('/v1/cash-closing/today', ...branch, requireAbility('read', 'CashClosing'), async (req, res) => {
        ok(res, await cashClosing(db, branchContext(req), now()));
    });

    router.post('/v1/cash-closing', ...branch, requireAbility('read', 'CashClosing'), requireAbility('create', 'Payment'), async (req, res) => {
        const body = parse(closeSchema, req.body);
        ok(res, await closeDay(db, branchContext(req), now(), body), 'Day closed', 201);
    });

    router.get('/v1/members/:oid/subscriptions', ...branch, requireAbility('read', 'Subscription'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await memberSubscriptions(db, branchContext(req), now(), oid));
    });

    router.get('/v1/members/:oid/invoices', ...branch, requireAbility('read', 'Invoice'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await memberInvoices(db, branchContext(req), now(), oid));
    });

    return router;
}
