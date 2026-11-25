import { Router } from 'express';
import * as v from 'valibot';

import { authenticate, currentUser, requireAbility, requireAnyBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext, withBranchTx } from '#src/db/tenancy.ts';
import { memberEverywhere } from '#src/features/portal/portal.service.ts';
import { ok, parse } from '#src/lib/http.ts';

import { inbox, inboxCount, kindsFor, markInboxRead } from './inbox.service.ts';
import { notificationsRepo } from './notifications.service.ts';

const readSchema = v.strictObject({
    /** The messages to mark read; omitted: all of them. */
    oids: v.optional(v.pipe(v.array(v.pipe(v.string(), v.uuid('Unknown message'))), v.maxLength(200, 'At most 200 at a time')))
});

/**
 * The bell. The count is read when a page opens or the user moves to another one, so there is no
 * live channel (live updates deferred).
 *
 * Staff (any console, `requireAnyBranch`): the inbox at the active branch or at HQ. There is no single permission:
 * each kind is shown to whoever holds its permission there (`INBOX_RULES`), so someone with none of them sees an
 * empty inbox, never someone else's.
 * - `GET /v1/inbox` → `{ items, unread }`; `GET /v1/inbox/count` → `{ unread }`; `POST /v1/inbox/read` `{ oids? }`.
 *
 * Members (`read Portal`): their own messages (the list is `GET /v1/me/notifications`, portal.routes.ts).
 * - `GET /v1/me/notifications/count` → `{ unread }`; `POST /v1/me/notifications/read` `{ oids? }`.
 */
export function notificationsRouter(deps: AppDeps): Router {
    const router = Router();
    const staff = [authenticate(deps), requireAnyBranch()];
    const member = [authenticate(deps), requireAbility('read', 'Portal')];
    const kinds = (req: Parameters<typeof branchContext>[0]) => (req.auth ? kindsFor(req.auth.ability) : []);

    router.get('/v1/inbox', ...staff, async (req, res) => {
        ok(res, await inbox(deps.db, branchContext(req), currentUser(req).oid, kinds(req), deps.clock()));
    });
    router.get('/v1/inbox/count', ...staff, async (req, res) => {
        ok(res, { unread: await inboxCount(deps.db, branchContext(req), currentUser(req).oid, kinds(req)) });
    });
    router.post('/v1/inbox/read', ...staff, async (req, res) => {
        const { oids } = parse(readSchema, req.body);
        ok(res, { unread: await markInboxRead(deps.db, branchContext(req), currentUser(req).oid, kinds(req), oids, deps.clock()) });
    });

    router.get('/v1/me/notifications/count', ...member, async (req, res) => {
        const { ctx, memberOid } = await memberEverywhere(deps, currentUser(req));
        ok(res, { unread: await withBranchTx(deps.db, ctx, tx => notificationsRepo.unread(tx, memberOid, deps.clock())) });
    });
    router.post('/v1/me/notifications/read', ...member, requireAbility('update', 'Portal'), async (req, res) => {
        const { oids } = parse(readSchema, req.body);
        const { ctx, memberOid } = await memberEverywhere(deps, currentUser(req));
        ok(res, { unread: await withBranchTx(deps.db, ctx, tx => notificationsRepo.markRead(tx, memberOid, oids, deps.clock())) });
    });

    return router;
}
