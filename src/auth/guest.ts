import type { RequestHandler } from 'express';

import type { AppDeps } from '#src/container.ts';
import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { AppError } from '#src/lib/http.ts';

/**
 * Guest access on the hosted demo (D-076). `GUEST_ACCOUNTS` names seeded accounts that anyone may sign in as without
 * a password, so the demo's visitors share them. To keep them usable for the next visitor, nobody can change them:
 * not their password, profile, roles, status or sessions, and for the guest member not the portal account, a transfer
 * or anonymising. Everything else (members, sales, check-ins) stays open: the demo data is reset from the seeds.
 */
export const GUEST_LOCKED = 'This is a shared guest account of the demo, so it cannot be changed.';

export function isGuest(config: AppDeps['config'], username: string): boolean {
    return config.auth.guestAccounts.includes(username.toLowerCase());
}

/** A guest account by its user `oid` or by the member it belongs to. */
async function guestByOid(db: Queryable, config: AppDeps['config'], by: 'user' | 'member', oid: string): Promise<boolean> {
    if (!config.auth.guestAccounts.length) return false;
    const rows = await db.query<{ username: string }>(
        by === 'user' ? sql`select username from app_user where oid = ${oid}` : sql`select username from app_user where member_oid = ${oid}`
    );
    return rows.some(r => isGuest(config, r.username));
}

/** Route guard: 403 when `:oid` (a user, or a member) is a guest account. Runs after authentication. */
export function protectGuest(deps: AppDeps, by: 'user' | 'member'): RequestHandler {
    return async (req, _res, next) => {
        const oid = req.params['oid'];
        if (typeof oid === 'string' && /^[0-9a-f-]{36}$/i.test(oid) && (await guestByOid(deps.db, deps.config, by, oid))) throw new AppError(403, GUEST_LOCKED);
        next();
    };
}

export interface GuestAccount {
    username: string;
    name: string;
    kind: 'staff' | 'member';
    /** The role the picker shows: the first staff role, or MEMBER. */
    role: string;
}

/** The configured guest accounts that exist and are active, in the configured order. */
export async function guestAccounts(db: Queryable, config: AppDeps['config']): Promise<GuestAccount[]> {
    const wanted = config.auth.guestAccounts;
    if (!wanted.length) return [];
    const rows = await db.query<{ username: string; name: string; kind: 'staff' | 'member'; roles: string[] | null }>(sql`
        select u.username, u.name, u.kind,
               array(select a.role_code from staff_assignment a where a.user_oid = u.oid order by a.role_code) as roles
        from app_user u
        where lower(u.username) = any(${wanted}::text[]) and u.status = 'Active' and not u.must_change_password`);
    return rows
        .map(r => ({ username: r.username, name: r.name, kind: r.kind, role: r.kind === 'member' ? 'MEMBER' : (r.roles?.[0] ?? 'STAFF') }))
        .sort((a, b) => wanted.indexOf(a.username.toLowerCase()) - wanted.indexOf(b.username.toLowerCase()));
}
