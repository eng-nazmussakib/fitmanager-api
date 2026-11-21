import { type Request, Router } from 'express';

import { authenticate, requireAbility, requireAnyBranch, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { ok, parse } from '#src/lib/http.ts';

import {
    cancelPurchaseOrder,
    decidePurchaseOrder,
    getPurchaseOrder,
    listPurchaseOrders,
    markSent,
    raisePurchaseOrder,
    receiveDelivery
} from './purchase-orders.service.ts';
import {
    adjustSchema,
    decideSchema,
    deliverySchema,
    elsewhereQuery,
    oidParams,
    poCreate,
    poQuery,
    productParams,
    reasonSchema,
    reorderSchema,
    stockQuery,
    transferClose,
    transferCreate,
    transferQuery,
    transferReceive,
    transferSend
} from './stock.schema.ts';
import { adjust, hqStock, movements, setReorderLevel, type StockDeps, stockElsewhere, stockLevels } from './stock.service.ts';
import { closeTransfer, getTransfer, listTransfers, receiveTransfer, requestTransfer, sendTransfer } from './transfers.service.ts';

/**
 * Stock, purchase orders and transfers (phase 6, D-100, D-101).
 * - A branch (`read Stock`): `GET /v1/stock[?low=1&q=]`, `GET /v1/stock/:product_oid/movements`; managers (`update
 *   Stock`): `POST /v1/stock/:product_oid/adjust`, `PUT /v1/stock/:product_oid/reorder-level`; costs show to them only.
 *   `GET /v1/stock/elsewhere?product_oid=` (`read Transfer`): the other branches' counts.
 * - HQ (`read Stock`): `GET /v1/hq/stock`.
 * - Purchase orders: `GET /v1/purchase-orders[?status=&branch_oid=]`, `GET /v1/purchase-orders/:oid` (`read PurchaseOrder`,
 *   a branch's own, every branch's at HQ); a branch (`create`/`update PurchaseOrder`): `POST /v1/purchase-orders`,
 *   `POST /v1/purchase-orders/:oid/sent`, `/deliveries`, `/cancel`; HQ (`update PurchaseOrder`):
 *   `POST /v1/hq/purchase-orders/:oid/approve`, `/reject`.
 * - Transfers (`read`/`create`/`update Transfer`): `GET /v1/transfers[?direction=in|out]`, `GET /v1/transfers/:oid`,
 *   `POST /v1/transfers`, `POST /v1/transfers/:oid/send`, `/receive`, `/reject`, `/cancel`.
 */
export function stockRouter(deps: AppDeps): Router {
    const router = Router();
    const s: StockDeps = { db: deps.db, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const now = () => dhakaNow(deps.clock());
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const staff = [authenticate(deps), requireAnyBranch()];
    const hq = [authenticate(deps), requireBranch('HQ')];
    const oid = (req: Request) => parse(oidParams, req.params).oid;
    const product = (req: Request) => parse(productParams, req.params).product_oid;
    const costs = (req: Request) => req.auth?.ability.can('update', 'Stock') ?? false;

    router.get('/v1/stock', ...branch, requireAbility('read', 'Stock'), async (req, res) => {
        ok(res, await stockLevels(s, branchContext(req), parse(stockQuery, req.query), costs(req)));
    });
    router.get('/v1/stock/elsewhere', ...branch, requireAbility('read', 'Transfer'), async (req, res) => {
        const q = parse(elsewhereQuery, req.query).product_oid;
        ok(res, await stockElsewhere(s, branchContext(req), Array.isArray(q) ? q : [q]));
    });
    router.get('/v1/stock/:product_oid/movements', ...branch, requireAbility('read', 'Stock'), async (req, res) => {
        ok(res, await movements(s, branchContext(req), product(req), costs(req)));
    });
    router.post('/v1/stock/:product_oid/adjust', ...branch, requireAbility('update', 'Stock'), async (req, res) => {
        ok(res, await adjust(s, branchContext(req), deps.clock(), product(req), parse(adjustSchema, req.body)), 'Stock adjusted');
    });
    router.put('/v1/stock/:product_oid/reorder-level', ...branch, requireAbility('update', 'Stock'), async (req, res) => {
        ok(res, await setReorderLevel(s, branchContext(req), product(req), parse(reorderSchema, req.body).reorder_level), 'Reorder level saved');
    });
    router.get('/v1/hq/stock', ...hq, requireAbility('read', 'Stock'), async (req, res) => {
        ok(res, await hqStock(s, branchContext(req)));
    });

    router.get('/v1/purchase-orders', ...staff, requireAbility('read', 'PurchaseOrder'), async (req, res) => {
        ok(res, await listPurchaseOrders(s, branchContext(req), parse(poQuery, req.query)));
    });
    router.get('/v1/purchase-orders/:oid', ...staff, requireAbility('read', 'PurchaseOrder'), async (req, res) => {
        ok(res, await getPurchaseOrder(s, branchContext(req), oid(req)));
    });
    router.post('/v1/purchase-orders', ...branch, requireAbility('create', 'PurchaseOrder'), async (req, res) => {
        ok(res, await raisePurchaseOrder(s, branchContext(req), now(), parse(poCreate, req.body)), 'Sent to HQ for approval', 201);
    });
    router.post('/v1/purchase-orders/:oid/sent', ...branch, requireAbility('update', 'PurchaseOrder'), async (req, res) => {
        ok(res, await markSent(s, branchContext(req), now(), oid(req)), 'Marked as sent');
    });
    router.post('/v1/purchase-orders/:oid/deliveries', ...branch, requireAbility('update', 'PurchaseOrder'), async (req, res) => {
        const out = await receiveDelivery(s, branchContext(req), now(), oid(req), parse(deliverySchema, req.body));
        ok(res, out, out.status === 'received' ? 'Received in full' : 'Delivery received', 201);
    });
    router.post('/v1/purchase-orders/:oid/cancel', ...branch, requireAbility('update', 'PurchaseOrder'), async (req, res) => {
        ok(res, await cancelPurchaseOrder(s, branchContext(req), now(), oid(req), parse(reasonSchema, req.body).reason), 'Order cancelled');
    });
    router.post('/v1/hq/purchase-orders/:oid/approve', ...hq, requireAbility('update', 'PurchaseOrder'), async (req, res) => {
        ok(res, await decidePurchaseOrder(s, branchContext(req), now(), oid(req), true, parse(decideSchema, req.body ?? {}).note ?? null), 'Approved');
    });
    router.post('/v1/hq/purchase-orders/:oid/reject', ...hq, requireAbility('update', 'PurchaseOrder'), async (req, res) => {
        ok(res, await decidePurchaseOrder(s, branchContext(req), now(), oid(req), false, parse(decideSchema, req.body ?? {}).note ?? null), 'Rejected');
    });

    router.get('/v1/transfers', ...branch, requireAbility('read', 'Transfer'), async (req, res) => {
        ok(res, await listTransfers(s, branchContext(req), parse(transferQuery, req.query).direction ?? 'all'));
    });
    router.get('/v1/transfers/:oid', ...branch, requireAbility('read', 'Transfer'), async (req, res) => {
        ok(res, await getTransfer(s, branchContext(req), oid(req)));
    });
    router.post('/v1/transfers', ...branch, requireAbility('create', 'Transfer'), async (req, res) => {
        ok(res, await requestTransfer(s, branchContext(req), now(), parse(transferCreate, req.body)), 'Request sent', 201);
    });
    router.post('/v1/transfers/:oid/send', ...branch, requireAbility('update', 'Transfer'), async (req, res) => {
        ok(res, await sendTransfer(s, branchContext(req), now(), oid(req), parse(transferSend, req.body)), 'Sent: in transit');
    });
    router.post('/v1/transfers/:oid/receive', ...branch, requireAbility('update', 'Transfer'), async (req, res) => {
        ok(res, await receiveTransfer(s, branchContext(req), now(), oid(req), parse(transferReceive, req.body)), 'Received');
    });
    router.post('/v1/transfers/:oid/reject', ...branch, requireAbility('update', 'Transfer'), async (req, res) => {
        ok(res, await closeTransfer(s, branchContext(req), now(), oid(req), 'reject', parse(transferClose, req.body).note), 'Request rejected');
    });
    router.post('/v1/transfers/:oid/cancel', ...branch, requireAbility('update', 'Transfer'), async (req, res) => {
        ok(res, await closeTransfer(s, branchContext(req), now(), oid(req), 'cancel', parse(transferClose, req.body).note), 'Request cancelled');
    });

    return router;
}
