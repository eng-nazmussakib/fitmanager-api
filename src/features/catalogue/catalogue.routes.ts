import { type Request, Router } from 'express';
import * as v from 'valibot';

import { authenticate, requireAbility, requireAnyBranch, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { ok, parse } from '#src/lib/http.ts';

import { oidParams, productCreate, productQuery, productUpdate, supplierCreate, supplierUpdate } from './catalogue.schema.ts';
import {
    type CatalogueDeps,
    createProduct,
    createSupplier,
    getProduct,
    listProducts,
    listSuppliers,
    updateProduct,
    updateSupplier
} from './catalogue.service.ts';

const allQuery = v.object({ all: v.optional(v.picklist(['0', '1'])) });

/**
 * The catalogue and suppliers.
 * - Every console (`read Product` / `read Supplier`): `GET /v1/products[?all=1&q=&category=]`, `GET /v1/products/:oid`,
 *   `GET /v1/suppliers[?all=1]`.
 * - HQ (`create`/`update Product`, `Supplier`): `POST /v1/hq/products`, `PATCH /v1/hq/products/:oid`,
 *   `POST /v1/hq/suppliers`, `PATCH /v1/hq/suppliers/:oid`.
 */
export function catalogueRouter(deps: AppDeps): Router {
    const router = Router();
    const c: CatalogueDeps = { db: deps.db, files: deps.files, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const staff = [authenticate(deps), requireAnyBranch()];
    const hq = [authenticate(deps), requireBranch('HQ')];
    const oid = (req: Request) => parse(oidParams, req.params).oid;

    router.get('/v1/products', ...staff, requireAbility('read', 'Product'), async (req, res) => {
        ok(res, await listProducts(c, branchContext(req), parse(productQuery, req.query)));
    });
    router.get('/v1/products/:oid', ...staff, requireAbility('read', 'Product'), async (req, res) => {
        ok(res, await getProduct(c, branchContext(req), oid(req)));
    });
    router.post('/v1/hq/products', ...hq, requireAbility('create', 'Product'), async (req, res) => {
        ok(res, await createProduct(c, branchContext(req), parse(productCreate, req.body)), 'Product added', 201);
    });
    router.patch('/v1/hq/products/:oid', ...hq, requireAbility('update', 'Product'), async (req, res) => {
        ok(res, await updateProduct(c, branchContext(req), oid(req), parse(productUpdate, req.body)), 'Product saved');
    });

    router.get('/v1/suppliers', ...staff, requireAbility('read', 'Supplier'), async (req, res) => {
        ok(res, await listSuppliers(c, branchContext(req), parse(allQuery, req.query).all === '1'));
    });
    router.post('/v1/hq/suppliers', ...hq, requireAbility('create', 'Supplier'), async (req, res) => {
        ok(res, await createSupplier(c, branchContext(req), parse(supplierCreate, req.body)), 'Supplier added', 201);
    });
    router.patch('/v1/hq/suppliers/:oid', ...hq, requireAbility('update', 'Supplier'), async (req, res) => {
        ok(res, await updateSupplier(c, branchContext(req), oid(req), parse(supplierUpdate, req.body)), 'Supplier saved');
    });

    return router;
}
