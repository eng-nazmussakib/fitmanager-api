import { Router } from 'express';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext, withBranchTx } from '#src/db/tenancy.ts';
import { memberDocuments } from '#src/features/files/files.service.ts';
import { notificationsRepo } from '#src/features/notifications/notifications.service.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { ok, parse } from '#src/lib/http.ts';

import { anonymiseSchema, createSchema, listQuery, lookupQuery, oidParams, reasonSchema, transferSchema, updateSchema } from './members.schema.ts';
import {
    anonymiseMember,
    createMember,
    listMembers,
    lookupMember,
    memberAt,
    type MemberDeps,
    memberDetail,
    setSuspension,
    transferMember,
    updateMember
} from './members.service.ts';
import { memberTimeline } from './members.timeline.ts';

/**
 * Members of the branch in `X-Branch-Id` (phase 2 step 3; D-022, D-068). The desk adds and edits (`create`,
 * `update Member`); suspending, transfers and anonymising need a manager (`manage Member`).
 * - `GET /v1/members` (search, status, plan, flag, paging, sort) → `{ rows, count, page, size, counts }`
 * - `GET /v1/members/lookup?code=` (scanner, this branch only), `GET /v1/members/:oid`
 * - `POST /v1/members`, `PATCH /v1/members/:oid`
 * - `POST /v1/members/:oid/suspend` `{ reason }`, `/unsuspend`, `/transfer` `{ to_branch_oid, reason }`,
 *   `/anonymise` `{ confirm_code }`
 * - `GET /v1/members/:oid/timeline`, `/documents`, `/notifications`, `/measurements` (none yet: a later phase)
 * Subscriptions, invoices and attendance of a member are served by their own features.
 */
export function membersRouter(deps: AppDeps): Router {
    const router = Router();
    const memberDeps: MemberDeps = { db: deps.db, files: deps.files, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const today = () => dhakaNow(deps.clock()).date;

    router.get('/v1/members', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const q = parse(listQuery, req.query);
        ok(res, await listMembers(memberDeps, branchContext(req), today(), q));
    });

    router.get('/v1/members/lookup', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const { code } = parse(lookupQuery, req.query);
        ok(res, await lookupMember(memberDeps, branchContext(req), today(), code));
    });

    router.post('/v1/members', ...branch, requireAbility('create', 'Member'), async (req, res) => {
        const body = parse(createSchema, req.body);
        const m = await createMember(memberDeps, branchContext(req), today(), body);
        ok(res, m, `Member ${m.code} created`, 201);
    });

    router.get('/v1/members/:oid', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await memberDetail(memberDeps, branchContext(req), oid, today()));
    });

    router.patch('/v1/members/:oid', ...branch, requireAbility('update', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const body = parse(updateSchema, req.body);
        ok(res, await updateMember(memberDeps, branchContext(req), oid, today(), body), 'Member updated');
    });

    router.post('/v1/members/:oid/suspend', ...branch, requireAbility('manage', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { reason } = parse(reasonSchema, req.body);
        ok(res, await setSuspension(memberDeps, branchContext(req), oid, today(), reason), 'Member suspended');
    });

    router.post('/v1/members/:oid/unsuspend', ...branch, requireAbility('manage', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await setSuspension(memberDeps, branchContext(req), oid, today(), null), 'Suspension lifted');
    });

    router.post('/v1/members/:oid/transfer', ...branch, requireAbility('manage', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const body = parse(transferSchema, req.body);
        const moved = await transferMember(memberDeps, branchContext(req), oid, today(), body.to_branch_oid, body.reason);
        ok(res, moved, `${moved.code} moved to ${moved.branch_name}`);
    });

    router.post('/v1/members/:oid/anonymise', ...branch, requireAbility('manage', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { confirm_code } = parse(anonymiseSchema, req.body);
        ok(res, await anonymiseMember(memberDeps, branchContext(req), oid, today(), confirm_code), 'Personal data removed');
    });

    router.get('/v1/members/:oid/timeline', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const ctx = branchContext(req);
        ok(
            res,
            await withBranchTx(deps.db, ctx, async tx => {
                const m = await memberAt(tx, ctx, oid, today());
                return memberTimeline(tx, m);
            })
        );
    });

    router.get('/v1/members/:oid/documents', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const ctx = branchContext(req);
        ok(
            res,
            await withBranchTx(deps.db, ctx, async tx => {
                await memberAt(tx, ctx, oid, today());
                return memberDocuments(memberDeps, tx, oid, [ctx.branchOid]);
            })
        );
    });

    router.get('/v1/members/:oid/notifications', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const ctx = branchContext(req);
        ok(
            res,
            await withBranchTx(deps.db, ctx, async tx => {
                await memberAt(tx, ctx, oid, today());
                return (await notificationsRepo.forMember(tx, oid, deps.clock())).map(n => ({ ...n, created_at: n.created_at.toISOString() }));
            })
        );
    });

    router.get('/v1/members/:oid/measurements', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const ctx = branchContext(req);
        await withBranchTx(deps.db, ctx, tx => memberAt(tx, ctx, oid, today()));
        ok(res, []);
    });

    return router;
}
