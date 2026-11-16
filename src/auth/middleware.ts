import type { Request, RequestHandler } from 'express';

import type { AppDeps } from '#src/container.ts';
import { AppError } from '#src/lib/http.ts';

import { type Action, type AppAbility, createAbility, GLOBAL_RULES, type Subject } from './ability.ts';
import { type AuthUser, type BranchKind, type StaffAssignment, users } from './auth.repo.ts';
import type { Identity } from './tokens.ts';

export interface AuthContext {
    user: AuthUser;
    /** `X-Branch-Id` as sent, or null. */
    branchOid: string | null;
    /** The user's assignment at that branch; null without the header or when the user does not work there. */
    assignment: StaffAssignment | null;
    /** Global rules + the active assignment's rules (D-034). */
    ability: AppAbility;
}

/** The header the web app sets from the URL (`/console/:branch`, or the HQ row for `/hq`). */
export const BRANCH_HEADER = 'X-Branch-Id';

/** The CASL ability for a user at one branch (or at none): global rules plus that assignment's rules. */
export function abilityFor(user: AuthUser, assignment: StaffAssignment | null): AppAbility {
    return createAbility([...GLOBAL_RULES[user.kind], ...(assignment?.rules ?? [])]);
}

/** Seconds a user's profile and rules stay cached. A disabled user or a changed role applies within this time. */
const USER_CACHE_SECONDS = 30;

/**
 * Bearer token → user + CASL ability on `req.auth`.
 *
 * SPN ran TWO database queries per request (the JWT validate hook re-read login history to see if the user was
 * still signed in); under a sign-in storm that alone kept the pool busy. Here the token's signature and expiry are
 * checked in memory, and the user's profile and rules come from the cache (one query per user per 30 s).
 * Revocation is handled by the short access-token lifetime plus refresh-token revocation.
 */
export function authenticate({ db, cache, tokens }: Pick<AppDeps, 'db' | 'cache' | 'tokens'>): RequestHandler {
    return async (req, _res, next) => {
        const [scheme, token] = (req.get('authorization') ?? '').split(' ');
        if (scheme?.toLowerCase() !== 'bearer' || !token) throw new AppError(401, 'Please sign in');
        let identity: Identity;
        try {
            identity = await tokens.verifyAccess(token);
        } catch {
            throw new AppError(401, 'Token expired or invalid');
        }
        const user =
            identity.kind === 'local'
                ? await cache.getOrSet(`auth:user:${identity.userOid}`, () => users.findByOid(db, identity.userOid), USER_CACHE_SECONDS)
                : await cache.getOrSet(
                      `auth:username:${identity.username.toLowerCase()}`,
                      () => users.findByUsernameForAuth(db, identity.username),
                      USER_CACHE_SECONDS
                  );
        if (user?.status !== 'Active') throw new AppError(401, 'This account is not active');
        // The branch is the caller's claim; it counts only if the user holds an assignment there. A branch the user
        // does not work at gives no branch rules here, and `requireBranch` refuses it on branch routes. Routes that
        // are not about a branch (/auth/me) still answer, so a tab left on an old branch can learn the new roles.
        const header = req.get(BRANCH_HEADER)?.trim() ?? '';
        const branchOid = header.length > 0 ? header : null; // an empty header counts as none
        const assignment = branchOid ? (user.assignments.find(a => a.branch.oid === branchOid) ?? null) : null;
        req.auth = { user, branchOid, assignment, ability: abilityFor(user, assignment) };
        next();
    };
}

/**
 * Route gate for branch-scoped routes: `X-Branch-Id` must name a branch of this kind that the user works at.
 * Put it before `requireAbility`, which then checks the rules of THAT assignment.
 */
export function requireBranch(kind: BranchKind): RequestHandler {
    return (req, _res, next) => {
        if (!req.auth) throw new AppError(401, 'Please sign in');
        const a = req.auth.assignment;
        if (req.auth.branchOid && !a) throw new AppError(403, 'You do not work at this branch');
        if (!a) throw new AppError(403, kind === 'HQ' ? 'Open the HQ console to do this' : 'Choose a branch first');
        if (a.branch.kind !== kind) throw new AppError(kind === 'HQ' ? 403 : 400, kind === 'HQ' ? 'HQ only' : 'Choose a branch: this is a branch operation');
        next();
    };
}

/** The active branch inside a handler behind `requireBranch`. */
export function currentBranch(req: Request): StaffAssignment['branch'] {
    const branch = req.auth?.assignment?.branch;
    if (!branch) throw new AppError(403, 'Choose a branch first');
    return branch;
}

/** Route gate: `requireAbility('create', 'Member')`. A typo in action or subject is a compile error. */
export function requireAbility(action: Action, subject: Subject): RequestHandler {
    return (req, _res, next) => {
        if (!req.auth) throw new AppError(401, 'Please sign in');
        if (!req.auth.ability.can(action, subject)) throw new AppError(403, 'You do not have permission to do this');
        next();
    };
}

/** The signed-in user inside a handler behind `authenticate`. */
export function currentUser(req: Request): AuthUser {
    if (!req.auth) throw new AppError(401, 'Please sign in');
    return req.auth.user;
}
