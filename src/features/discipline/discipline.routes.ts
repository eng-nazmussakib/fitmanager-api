import { type Request, Router } from 'express';

import { authenticate, currentUser, requireAbility, requireAnyBranch, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { memberContext } from '#src/features/portal/portal.service.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

import {
    appealCreate,
    appealDecide,
    incidentCreate,
    incidentQuery,
    incidentUpdate,
    liftSchema,
    oidParams,
    sanctionCreate,
    staffQuery
} from './discipline.schema.ts';
import {
    type Caller,
    createIncident,
    decideAppeal,
    type DisciplineDeps,
    fileAppeal,
    getIncident,
    giveSanction,
    liftBan,
    listIncidents,
    memberRecord,
    ownRecord,
    staffSubjects,
    updateIncident
} from './discipline.service.ts';
import { giverRole } from './ladder.ts';

/**
 * Discipline (phase 5; D-092 to D-094), at a branch or HQ (`X-Branch-Id`):
 * - `GET /v1/incidents` (`read Incident`; `?status=open|closed&kind=member|staff&appeal=open&q=`), `GET /v1/incidents/:oid`,
 *   `GET /v1/incidents/staff[?branch_oid=]` (who a staff case may be about), `POST /v1/incidents` (`create Incident`),
 *   `PATCH /v1/incidents/:oid` (`manage Incident`).
 * - `POST /v1/incidents/:oid/sanctions` (`create Incident`: the desk and trainers a verbal warning, managers and HQ any
 *   step), `POST /v1/sanctions/:oid/lift` and `POST /v1/appeals/:oid/decide` (`manage Incident`).
 * - `GET /v1/members/:oid/discipline` (`read Incident`, the home branch).
 * - Their own record: staff `GET /v1/my-record`, `POST /v1/my-record/:oid/appeal`; members `GET /v1/me/record`,
 *   `POST /v1/me/record/:oid/appeal`.
 */
export function disciplineRouter(deps: AppDeps): Router {
    const router = Router();
    const d: DisciplineDeps = { db: deps.db, cache: deps.cache, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const today = () => dhakaNow(deps.clock()).date;
    const staff = [authenticate(deps), requireAnyBranch()];
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const member = [authenticate(deps), requireAbility('read', 'Portal')];
    const oid = (req: Request) => parse(oidParams, req.params).oid;
    const caller = (req: Request): Caller => {
        const a = req.auth?.assignment;
        if (!a) throw new AppError(403, 'Choose a branch first');
        return { userOid: currentUser(req).oid, role: a.role, giver: giverRole(a.role, a.branch.kind === 'HQ') };
    };

    router.get('/v1/incidents', ...staff, requireAbility('read', 'Incident'), async (req, res) => {
        ok(res, await listIncidents(d, branchContext(req), caller(req), parse(incidentQuery, req.query), today()));
    });
    router.get('/v1/incidents/staff', ...staff, requireAbility('create', 'Incident'), async (req, res) => {
        const ctx = branchContext(req);
        const at = parse(staffQuery, req.query).branch_oid ?? ctx.branchOid;
        if (!ctx.branchOids.includes(at)) throw new AppError(403, 'You do not work at this branch');
        ok(res, await staffSubjects(d, ctx, caller(req), at));
    });
    router.get('/v1/incidents/:oid', ...staff, requireAbility('read', 'Incident'), async (req, res) => {
        ok(res, await getIncident(d, branchContext(req), caller(req), oid(req), today()));
    });
    router.post('/v1/incidents', ...staff, requireAbility('create', 'Incident'), async (req, res) => {
        const out = await createIncident(d, branchContext(req), caller(req), parse(incidentCreate, req.body), deps.clock());
        ok(res, out, 'sent_to_hq' in out ? 'Recorded and sent to HQ' : 'Incident recorded', 201);
    });
    router.patch('/v1/incidents/:oid', ...staff, requireAbility('manage', 'Incident'), async (req, res) => {
        ok(res, await updateIncident(d, branchContext(req), caller(req), oid(req), parse(incidentUpdate, req.body), today()), 'Case saved');
    });
    router.post('/v1/incidents/:oid/sanctions', ...staff, requireAbility('create', 'Incident'), async (req, res) => {
        ok(res, await giveSanction(d, branchContext(req), caller(req), oid(req), parse(sanctionCreate, req.body), today()), 'Step recorded', 201);
    });
    router.post('/v1/sanctions/:oid/lift', ...staff, requireAbility('manage', 'Incident'), async (req, res) => {
        ok(res, await liftBan(d, branchContext(req), caller(req), oid(req), parse(liftSchema, req.body).reason, today()), 'Ban lifted');
    });
    router.post('/v1/appeals/:oid/decide', ...staff, requireAbility('manage', 'Incident'), async (req, res) => {
        const body = parse(appealDecide, req.body);
        ok(
            res,
            await decideAppeal(d, branchContext(req), caller(req), oid(req), body, today()),
            body.decision === 'upheld' ? 'Appeal upheld' : 'Appeal rejected'
        );
    });

    router.get('/v1/members/:oid/discipline', ...branch, requireAbility('read', 'Incident'), async (req, res) => {
        ok(res, await memberRecord(d, branchContext(req), caller(req), oid(req), today()));
    });

    // Staff: their own sanctions, wherever they were given ("My record").
    const self = authenticate(deps);
    const staffOnly = (req: Request) => {
        const u = currentUser(req);
        if (u.kind !== 'staff') throw new AppError(403, 'Staff only');
        return u;
    };
    router.get('/v1/my-record', self, async (req, res) => {
        const u = staffOnly(req);
        ok(res, await ownRecord(d, { member_oid: null, staff_oid: u.oid }, { oid: u.oid, name: u.name }, today()));
    });
    router.post('/v1/my-record/:oid/appeal', self, async (req, res) => {
        const u = staffOnly(req);
        const { body } = parse(appealCreate, req.body);
        ok(res, await fileAppeal(d, { member_oid: null, staff_oid: u.oid }, { oid: u.oid, name: u.name }, oid(req), body, today()), 'Appeal sent', 201);
    });

    router.get('/v1/me/record', ...member, async (req, res) => {
        const u = currentUser(req);
        const { memberOid } = await memberContext(deps, u);
        ok(res, await ownRecord(d, { member_oid: memberOid, staff_oid: null }, { oid: u.oid, name: u.name }, today()));
    });
    router.post('/v1/me/record/:oid/appeal', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const u = currentUser(req);
        const { memberOid } = await memberContext(deps, u);
        const { body } = parse(appealCreate, req.body);
        ok(res, await fileAppeal(d, { member_oid: memberOid, staff_oid: null }, { oid: u.oid, name: u.name }, oid(req), body, today()), 'Appeal sent', 201);
    });

    return router;
}
