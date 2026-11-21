import { randomUUID } from 'node:crypto';

import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';

import type { AppRule } from './ability.ts';
import { hashToken, newRefreshToken } from './tokens.ts';

export type BranchKind = 'HQ' | 'BRANCH';
export type StaffRole = 'OWNER' | 'HQ_ADMIN' | 'BRANCH_MANAGER' | 'FRONT_DESK' | 'TRAINER';

/** What every screen needs to name and address a branch (the web app's `BranchRef`). */
export interface BranchRef {
    oid: string;
    code: string;
    slug: string;
    name: string;
    kind: BranchKind;
}

/** The role a staff member holds at one branch, with the rules it gives there (D-034). */
export interface StaffAssignment {
    branch: BranchRef;
    role: StaffRole;
    rules: AppRule[];
}

export interface AuthUser {
    oid: string;
    username: string;
    name: string;
    email: string | null;
    kind: 'staff' | 'member';
    status: 'Active' | 'Inactive';
    /** HQ staff: every active branch, with the role of the HQ assignment. */
    all_branches: boolean;
    /** A temporary password is set (D-054): only /auth/me, change-password and sign-out work until it is replaced. */
    must_change_password: boolean;
    /** A member's portal account (D-064): whose data `/v1/me/*` serves. Null for staff. */
    member_oid: string | null;
    /** Explicit rows, plus (with `all_branches`) the branches the user reaches through HQ. Active branches only. */
    assignments: StaffAssignment[];
    /** A staff member's suspensions not overturned (D-093): sign-in is refused on their days (`suspendedUntil`). */
    suspensions: { starts_on: string; ends_on: string }[];
}

/** The last day of a suspension in force on `today` (Dhaka), or null. */
export function suspendedUntil(user: Pick<AuthUser, 'suspensions'>, today: string): string | null {
    const now = user.suspensions.filter(s => s.starts_on <= today && today <= s.ends_on).map(s => s.ends_on);
    return now.sort().at(-1) ?? null;
}

type UserRow = Omit<AuthUser, 'assignments'>;
type UserRowWithHash = UserRow & { password_hash: string };

const USER = sql.raw(
    `u.oid, u.username, u.name, u.email, u.kind, u.status, u.all_branches, u.must_change_password, u.member_oid,
     case when u.kind = 'staff' then staff_suspensions(u.oid) else '[]'::jsonb end as suspensions from app_user u`
);

/**
 * A user's assignments at active branches, HQ first, then by branch name. With `all_branches`, every other active
 * branch is added with the HQ assignment's role, so a branch opened later is reachable without a new row.
 */
async function assignmentsOf(db: Queryable, user: UserRow): Promise<StaffAssignment[]> {
    const rows = await db.query<{ oid: string; code: string; slug: string; name: string; kind: BranchKind; role: StaffRole; rules: AppRule[] }>(sql`
        select b.oid, b.code, b.slug, b.name, b.kind, a.role_code as role, r.rules
        from staff_assignment a
        join branch b on b.oid = a.branch_oid and b.status = 'Active'
        join app_role r on r.code = a.role_code
        where a.user_oid = ${user.oid}
        order by b.kind = 'HQ' desc, b.name`);
    const list: StaffAssignment[] = rows.map(({ role, rules, ...branch }) => ({ branch, role, rules }));
    const hq = list.find(a => a.branch.kind === 'HQ');
    if (user.all_branches && hq) {
        const others = await db.query<BranchRef>(sql`
            select oid, code, slug, name, kind from branch
            where kind = 'BRANCH' and status = 'Active'
              and oid not in (select branch_oid from staff_assignment where user_oid = ${user.oid})
            order by name`);
        list.push(...others.map(branch => ({ branch, role: hq.role, rules: hq.rules })));
        list.sort((a, b) => (a.branch.kind === b.branch.kind ? a.branch.name.localeCompare(b.branch.name) : a.branch.kind === 'HQ' ? -1 : 1));
    }
    return list;
}

async function withAssignments<T extends UserRow>(db: Queryable, row: T | undefined): Promise<(T & { assignments: StaffAssignment[] }) | undefined> {
    return row && { ...row, assignments: await assignmentsOf(db, row) };
}

export const users = {
    async findByUsername(db: Queryable, username: string): Promise<(AuthUser & { password_hash: string }) | undefined> {
        const [row] = await db.query<UserRowWithHash>(sql`select u.password_hash, ${USER} where lower(u.username) = lower(${username})`);
        return withAssignments(db, row);
    },
    /** Never returns the password hash: this is what gets cached. */
    async findByOid(db: Queryable, oid: string): Promise<AuthUser | undefined> {
        const [row] = await db.query<UserRow>(sql`select ${USER} where u.oid = ${oid}`);
        return withAssignments(db, row);
    },
    async findByUsernameForAuth(db: Queryable, username: string): Promise<AuthUser | undefined> {
        const [row] = await db.query<UserRow>(sql`select ${USER} where lower(u.username) = lower(${username})`);
        return withAssignments(db, row);
    },
    async setPasswordHash(db: Queryable, oid: string, hash: string): Promise<void> {
        await db.query(sql`update app_user set password_hash = ${hash}, updated_at = now() where oid = ${oid}`);
    },
    async passwordHash(db: Queryable, oid: string): Promise<string | undefined> {
        const [row] = await db.query<{ password_hash: string }>(sql`select password_hash from app_user where oid = ${oid}`);
        return row?.password_hash;
    }
};

export interface SessionMeta {
    userAgent: string | undefined;
}

export interface Session {
    id: string;
    signed_in_at: string;
    last_used_at: string;
    user_agent: string | null;
}

export type RotateResult = { status: 'ok'; userOid: string; token: string; familyId: string } | { status: 'invalid' } | { status: 'reused'; userOid: string };

/**
 * Refresh-token rotation with reuse detection (OAuth 2.0 Security BCP): every refresh returns a NEW refresh token
 * and retires the old one. Presenting a retired token again means it was copied: the whole family (that sign-in)
 * is revoked, so the thief and the victim both have to sign in again.
 *
 * One exception, `REFRESH_REUSE_GRACE` seconds: two tabs (or two requests) refreshing with the same token at the
 * same moment is normal, not theft; within the grace window the late one gets a fresh token of the same family.
 */
export const refreshTokens = {
    /**
     * Deletes the user's refresh tokens that expired or were revoked over a day ago (kept a day for looking into an
     * incident). Run at each sign-in instead of a nightly job (D-075), so the table only holds live sessions.
     */
    async prune(db: Queryable, userOid: string): Promise<void> {
        await db.query(sql`
            delete from refresh_token
            where user_oid = ${userOid} and (expires_at < now() - interval '1 day' or revoked_at < now() - interval '1 day')`);
    },
    async issue(
        db: Queryable,
        userOid: string,
        meta: SessionMeta,
        ttlSeconds: number,
        familyId: string = randomUUID()
    ): Promise<{ id: string; token: string; familyId: string }> {
        const token = newRefreshToken();
        const [row] = await db.query<{ id: string }>(sql`
            insert into refresh_token (user_oid, family_id, token_hash, expires_at, user_agent)
            values (${userOid}, ${familyId}, ${hashToken(token)}, now() + make_interval(secs => ${ttlSeconds}), ${meta.userAgent?.slice(0, 300) ?? null})
            returning id`);
        if (!row) throw new Error('insert returned no row');
        return { id: row.id, token, familyId };
    },

    async rotate(db: Db, token: string, meta: SessionMeta, opts: { ttlSeconds: number; graceSeconds: number }): Promise<RotateResult> {
        // The revocation of a reused family must COMMIT, so this returns a result instead of throwing inside the
        // transaction (a throw would roll the revocation back).
        return db.transaction(async tx => {
            const [row] = await tx.query<{ id: string; user_oid: string; family_id: string; expired: boolean; revoked: boolean; in_grace: boolean }>(sql`
                select id, user_oid, family_id, expires_at <= now() as expired, revoked_at is not null as revoked,
                       coalesce(replaced_by is not null and revoked_at > now() - make_interval(secs => ${opts.graceSeconds}), false) as in_grace
                from refresh_token where token_hash = ${hashToken(token)} for update`);
            if (!row || row.expired) return { status: 'invalid' };
            if (row.revoked && !row.in_grace) {
                await tx.query(sql`update refresh_token set revoked_at = now() where family_id = ${row.family_id} and revoked_at is null`);
                return { status: 'reused', userOid: row.user_oid };
            }
            const next = await refreshTokens.issue(tx, row.user_oid, meta, opts.ttlSeconds, row.family_id);
            if (!row.revoked) await tx.query(sql`update refresh_token set revoked_at = now(), replaced_by = ${next.id} where id = ${row.id}`);
            return { status: 'ok', userOid: row.user_oid, token: next.token, familyId: row.family_id };
        });
    },

    /** Sign out of one session: the family of this token, if it belongs to the user. */
    async revokeFamily(db: Queryable, token: string, userOid: string): Promise<void> {
        await db.query(sql`
            update refresh_token set revoked_at = now()
            where revoked_at is null and family_id = (select family_id from refresh_token where token_hash = ${hashToken(token)} and user_oid = ${userOid})`);
    },

    /** Sign out everywhere. */
    async revokeAll(db: Queryable, userOid: string): Promise<void> {
        await db.query(sql`update refresh_token set revoked_at = now() where user_oid = ${userOid} and revoked_at is null`);
    },

    /**
     * A user's live sessions, newest activity first. One session is one sign-in (a family); its latest token's
     * time is when it was last refreshed. Only families with an unexpired, unrevoked token are live.
     */
    async sessions(db: Queryable, userOid: string): Promise<Session[]> {
        return db.query<Session>(sql`
            select family_id as id, min(created_at) as signed_in_at, max(created_at) as last_used_at,
                   (array_agg(user_agent order by created_at desc))[1] as user_agent
            from refresh_token
            where user_oid = ${userOid}
            group by family_id
            having bool_or(revoked_at is null and expires_at > now())
            order by last_used_at desc`);
    },

    /** Ends one session of the user, by id. False when there is no such live session. */
    async revokeSession(db: Queryable, userOid: string, familyId: string): Promise<boolean> {
        const rows = await db.query<{ id: string }>(sql`
            update refresh_token set revoked_at = now()
            where user_oid = ${userOid} and family_id = ${familyId} and revoked_at is null
            returning id`);
        return rows.length > 0;
    }
};
