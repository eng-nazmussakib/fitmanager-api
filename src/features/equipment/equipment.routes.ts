import { type Request, Router } from 'express';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { ok, parse } from '#src/lib/http.ts';

import {
    equipmentCreate,
    equipmentQuery,
    equipmentUpdate,
    oidParams,
    retireSchema,
    serviceSchema,
    ticketCreate,
    ticketQuery,
    ticketUpdate
} from './equipment.schema.ts';
import {
    createEquipment,
    type EquipmentDeps,
    getEquipment,
    listEquipment,
    listTickets,
    raiseTicket,
    recordService,
    retireEquipment,
    updateEquipment,
    updateTicket
} from './equipment.service.ts';

/**
 * Equipment and maintenance, at a branch.
 * - `read Equipment`: `GET /v1/equipment[?status=&due=1&q=]`, `GET /v1/equipment/:oid` (with its tickets and services),
 *   `GET /v1/equipment-tickets[?status=open|closed|all]`.
 * - `create Equipment` (any staff): `POST /v1/equipment/:oid/tickets`.
 * - `update Equipment` (managers): `POST /v1/equipment`, `PATCH /v1/equipment/:oid`, `POST /v1/equipment/:oid/retire`,
 *   `POST /v1/equipment/:oid/service`, `PATCH /v1/equipment-tickets/:oid`.
 */
export function equipmentRouter(deps: AppDeps): Router {
    const router = Router();
    const e: EquipmentDeps = { db: deps.db, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const now = () => dhakaNow(deps.clock());
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const oid = (req: Request) => parse(oidParams, req.params).oid;

    router.get('/v1/equipment', ...branch, requireAbility('read', 'Equipment'), async (req, res) => {
        ok(res, await listEquipment(e, branchContext(req), now().date, parse(equipmentQuery, req.query)));
    });
    router.get('/v1/equipment-tickets', ...branch, requireAbility('read', 'Equipment'), async (req, res) => {
        ok(res, await listTickets(e, branchContext(req), parse(ticketQuery, req.query).status ?? 'open'));
    });
    router.get('/v1/equipment/:oid', ...branch, requireAbility('read', 'Equipment'), async (req, res) => {
        ok(res, await getEquipment(e, branchContext(req), now().date, oid(req)));
    });
    router.post('/v1/equipment', ...branch, requireAbility('update', 'Equipment'), async (req, res) => {
        ok(res, await createEquipment(e, branchContext(req), now().date, parse(equipmentCreate, req.body)), 'Equipment added', 201);
    });
    router.patch('/v1/equipment/:oid', ...branch, requireAbility('update', 'Equipment'), async (req, res) => {
        ok(res, await updateEquipment(e, branchContext(req), now().date, oid(req), parse(equipmentUpdate, req.body)), 'Equipment saved');
    });
    router.post('/v1/equipment/:oid/retire', ...branch, requireAbility('update', 'Equipment'), async (req, res) => {
        ok(res, await retireEquipment(e, branchContext(req), now(), oid(req), parse(retireSchema, req.body).reason), 'Retired');
    });
    router.post('/v1/equipment/:oid/service', ...branch, requireAbility('update', 'Equipment'), async (req, res) => {
        ok(res, await recordService(e, branchContext(req), now(), oid(req), parse(serviceSchema, req.body)), 'Service recorded', 201);
    });
    router.post('/v1/equipment/:oid/tickets', ...branch, requireAbility('create', 'Equipment'), async (req, res) => {
        ok(res, await raiseTicket(e, branchContext(req), now(), oid(req), parse(ticketCreate, req.body)), 'Ticket raised', 201);
    });
    router.patch('/v1/equipment-tickets/:oid', ...branch, requireAbility('update', 'Equipment'), async (req, res) => {
        ok(res, await updateTicket(e, branchContext(req), now(), oid(req), parse(ticketUpdate, req.body)), 'Ticket saved');
    });

    return router;
}
