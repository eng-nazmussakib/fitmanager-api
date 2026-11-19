import { Router } from 'express';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { ok, parse } from '#src/lib/http.ts';

import { assignableRoles } from './staff.policy.ts';
import { staffRepo } from './staff.repo.ts';
import {
    branchCreateSchema,
    branchListQuery,
    branchRoleSchema,
    hqAssignmentsSchema,
    hqCreateSchema,
    hqListQuery,
    oidParams,
    profileSchema,
    resetPasswordSchema
} from './staff.schema.ts';
import { scopeOf, staffService } from './staff.service.ts';

/**
 * Staff management (phase 1, D-054, D-055).
 * - `/v1/hq/staff`: at HQ. OWNER manages everyone; HQ_ADMIN manages branch staff (BRANCH_MANAGER, FRONT_DESK,
 *   TRAINER) at any branch. Assignments are set as a whole (`PUT …/assignments`).
 * - `/v1/branch/staff`: at a branch, the people assigned there. BRANCH_MANAGER manages FRONT_DESK and TRAINER;
 *   the role is the one at this branch (`PUT …/role`), and `DELETE` removes the person from this branch only.
 * New accounts and resets take a temporary password typed by the admin; the person must change it at sign-in.
 * Each row carries `manageable`: whether the caller may change it (the web app shows or hides the actions). The list
 * also names the branches an assignment can use and the roles the caller may hand out, for the web form.
 */
export function staffRouter(deps: AppDeps): Router {
    const router = Router();
    const service = staffService(deps);
    const read = requireAbility('read', 'Staff');
    const write = requireAbility('manage', 'Staff');

    for (const level of ['hq', 'branch'] as const) {
        const base = `/v1/${level}/staff`;
        const onlyHere = level === 'branch';
        router.use(base, authenticate(deps), requireBranch(level === 'hq' ? 'HQ' : 'BRANCH'));

        /** The list, plus the roles the caller may hand out here (for the form). */
        router.get(base, read, async (req, res) => {
            const s = scopeOf(req, onlyHere);
            const filter = parse(onlyHere ? branchListQuery : hqListQuery, req.query);
            ok(res, {
                rows: await service.list(s, filter),
                // The branches an assignment can name: every active one at HQ, this one at a branch.
                branches: onlyHere
                    ? [{ oid: s.actor.branch.oid, code: req.auth?.assignment?.branch.code, name: req.auth?.assignment?.branch.name, kind: 'BRANCH' }]
                    : await staffRepo.activeBranches(deps.db),
                assignable_roles: {
                    hq: assignableRoles(s.actor, { oid: '', kind: 'HQ' }),
                    branch: assignableRoles(s.actor, { ...s.actor.branch, kind: 'BRANCH' })
                }
            });
        });

        router.get(`${base}/:oid`, read, async (req, res) => {
            const { oid } = parse(oidParams, req.params);
            ok(res, await service.get(scopeOf(req, onlyHere), oid));
        });

        router.patch(`${base}/:oid`, write, async (req, res) => {
            const { oid } = parse(oidParams, req.params);
            ok(res, await service.updateProfile(scopeOf(req, onlyHere), oid, parse(profileSchema, req.body)), 'Saved');
        });

        router.post(`${base}/:oid/deactivate`, write, async (req, res) => {
            const { oid } = parse(oidParams, req.params);
            const m = await service.setStatus(scopeOf(req, onlyHere), oid, 'Inactive');
            ok(res, m, `${m.name} is deactivated and signed out`);
        });

        router.post(`${base}/:oid/activate`, write, async (req, res) => {
            const { oid } = parse(oidParams, req.params);
            const m = await service.setStatus(scopeOf(req, onlyHere), oid, 'Active');
            ok(res, m, `${m.name} is active again`);
        });

        router.post(`${base}/:oid/reset-password`, write, async (req, res) => {
            const { oid } = parse(oidParams, req.params);
            const { password } = parse(resetPasswordSchema, req.body);
            await service.resetPassword(scopeOf(req, onlyHere), oid, password);
            ok(res, null, 'Temporary password set. They must change it when they sign in.');
        });

        router.post(`${base}/:oid/sign-out`, write, async (req, res) => {
            const { oid } = parse(oidParams, req.params);
            await service.signOutEverywhere(scopeOf(req, onlyHere), oid);
            ok(res, null, 'Signed out on every device');
        });
    }

    router.post('/v1/hq/staff', write, async (req, res) => {
        const m = await service.create(scopeOf(req, false), parse(hqCreateSchema, req.body));
        ok(res, m, `${m.name} added`, 201);
    });

    router.put('/v1/hq/staff/:oid/assignments', write, async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const body = parse(hqAssignmentsSchema, req.body);
        ok(res, await service.replaceAssignments(scopeOf(req, false), oid, body.assignments, body.all_branches), 'Assignments saved');
    });

    router.post('/v1/branch/staff', write, async (req, res) => {
        const s = scopeOf(req, true);
        const { role, ...body } = parse(branchCreateSchema, req.body);
        const m = await service.create(s, { ...body, assignments: [{ branch_oid: s.actor.branch.oid, role }], all_branches: false });
        ok(res, m, `${m.name} added`, 201);
    });

    router.put('/v1/branch/staff/:oid/role', write, async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { role } = parse(branchRoleSchema, req.body);
        ok(res, await service.setRoleHere(scopeOf(req, true), oid, role), 'Role saved');
    });

    router.delete('/v1/branch/staff/:oid', write, async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const m = await service.setRoleHere(scopeOf(req, true), oid, null);
        ok(res, m, `${m.name} no longer works at this branch`);
    });

    return router;
}
