import { type Request, Router } from 'express';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { ok, parse } from '#src/lib/http.ts';

import { cartSchema, oidParams, returnSchema, saleSchema, salesQuery } from './pos.schema.ts';
import { getPosSale, listPosSales, type PosDeps, posProducts, quotePos, returnPos, sellPos } from './pos.service.ts';

/**
 * The POS (phase 6, D-102), at a branch.
 * - `read Sale`: `GET /v1/pos/products`, `GET /v1/pos/sales[?day=&q=]`, `GET /v1/pos/sales/:oid`.
 * - `create Sale` (the desk): `POST /v1/pos/quote`, `POST /v1/pos/sales`, `POST /v1/pos/sales/:oid/return` (within 3 days).
 * - `manage Sale` (a manager): line discounts, and returns after the 3 days.
 * The receipt is the invoice (`GET /v1/invoices/:oid`); members see it in the portal with their other invoices.
 */
export function posRouter(deps: AppDeps): Router {
    const router = Router();
    const p: PosDeps = { db: deps.db, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const now = () => dhakaNow(deps.clock());
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const oid = (req: Request) => parse(oidParams, req.params).oid;
    const manager = (req: Request) => req.auth?.ability.can('manage', 'Sale') ?? false;

    router.get('/v1/pos/products', ...branch, requireAbility('read', 'Sale'), async (req, res) => {
        ok(res, await posProducts(p, branchContext(req)));
    });
    router.post('/v1/pos/quote', ...branch, requireAbility('create', 'Sale'), async (req, res) => {
        ok(res, await quotePos(p, branchContext(req), now(), parse(cartSchema, req.body), manager(req)));
    });
    router.post('/v1/pos/sales', ...branch, requireAbility('create', 'Sale'), async (req, res) => {
        const out = await sellPos(p, branchContext(req), now(), parse(saleSchema, req.body), manager(req));
        ok(res, out, out.charged > 0 ? `Sold: ৳${out.charged.toLocaleString('en-IN')} charged to the account` : 'Sold', 201);
    });
    router.get('/v1/pos/sales', ...branch, requireAbility('read', 'Sale'), async (req, res) => {
        ok(res, await listPosSales(p, branchContext(req), now(), parse(salesQuery, req.query)));
    });
    router.get('/v1/pos/sales/:oid', ...branch, requireAbility('read', 'Sale'), async (req, res) => {
        ok(res, await getPosSale(p, branchContext(req), now(), oid(req)));
    });
    router.post('/v1/pos/sales/:oid/return', ...branch, requireAbility('create', 'Sale'), async (req, res) => {
        ok(res, await returnPos(p, branchContext(req), now(), oid(req), parse(returnSchema, req.body), manager(req)), 'Returned and refunded');
    });

    return router;
}
