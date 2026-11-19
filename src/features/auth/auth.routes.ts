import { type Request, Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import * as v from 'valibot';

import { GLOBAL_RULES } from '#src/auth/ability.ts';
import { refreshTokens, type SessionMeta, users } from '#src/auth/auth.repo.ts';
import { authenticate, currentUser, forgetUser } from '#src/auth/middleware.ts';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '#src/auth/password.ts';
import { newPasswordSchema } from '#src/auth/password-policy.ts';
import type { AppDeps } from '#src/container.ts';
import { sql } from '#src/db/sql.ts';
import { portalIdentity } from '#src/features/portal/portal.service.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';
import { log } from '#src/lib/logger.ts';
import { createLimiter } from '#src/lib/rate-limit.ts';

const token = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const loginSchema = v.object({
    username: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
    password: v.pipe(v.string(), v.minLength(1), v.maxLength(200))
});
const refreshSchema = v.object({ refresh_token: token });
const logoutSchema = v.object({ refresh_token: v.optional(token) });
const changePasswordSchema = v.pipe(
    v.strictObject({ current_password: v.pipe(v.string(), v.minLength(1), v.maxLength(200)), new_password: newPasswordSchema }),
    v.forward(
        v.check(b => b.current_password !== b.new_password, 'Choose a password different from the current one'),
        ['new_password']
    )
);
const sessionParams = v.object({ id: v.pipe(v.string(), v.uuid()) });

const meta = (req: Request): SessionMeta => ({ userAgent: req.get('user-agent') });

/**
 * Password sign-in for fitmanager-web. The response shapes are the ones its mock API returns
 * (`fitmanager-web/src/app/mock`), so `npm run start:proxy` against this API needs no frontend change.
 */
export function authRouter(deps: AppDeps): Router {
    const { db, tokens, config } = deps;
    const router = Router();
    const requireUser = authenticate(deps);
    // Routes a user with a temporary password may still call (D-054).
    const requireUserBeforeChange = authenticate(deps, { beforePasswordChange: true });

    // Per IP + username: one attacker cannot lock others out, and spraying one password over many users is
    // still limited by the per-IP refresh limiter below.
    const loginLimiter = createLimiter({
        name: 'login',
        windowMs: 15 * 60_000,
        limit: config.auth.loginRateLimit,
        stores: deps.rateLimits,
        key: req => {
            const body = req.body as { username?: unknown } | undefined;
            return `${ipKeyGenerator(req.ip ?? 'unknown')}:${typeof body?.username === 'string' ? body.username.trim().toLowerCase() : ''}`;
        }
    });
    const refreshLimiter = createLimiter({ name: 'refresh', windowMs: 60_000, limit: 60, stores: deps.rateLimits });
    // Guessing the current password through change-password: 10 tries per user per 15 minutes.
    const passwordLimiter = createLimiter({
        name: 'password',
        windowMs: 15 * 60_000,
        limit: 10,
        stores: deps.rateLimits,
        key: req => req.auth?.user.oid ?? 'anonymous'
    });

    /** New tokens for a new session, or (`rotated`) for the session a refresh just rotated. */
    const issue = async (user: { oid: string }, req: Request, rotated?: { token: string; familyId: string }) => {
        const session = rotated ?? (await refreshTokens.issue(db, user.oid, meta(req), config.auth.refreshTtl));
        return {
            access_token: await tokens.signAccess(user, session.familyId),
            refresh_token: session.token,
            token_type: 'Bearer',
            expires_in: tokens.accessTtl
        };
    };

    router.post('/v1/auth/login', loginLimiter, async (req, res) => {
        const body = parse(loginSchema, req.body);
        const user = await users.findByUsername(db, body.username);
        const valid = user ? await verifyPassword(body.password, user.password_hash) : await verifyAgainstDummy(body.password, config.auth.passwordHash);
        // One message for unknown user and wrong password, so the form does not reveal which usernames exist.
        // 400, not 401: the frontends reserve 401 for "session expired, sign in again".
        if (!user || !valid) {
            log().info({ username: body.username }, 'Sign-in failed');
            throw new AppError(400, 'Invalid username or password');
        }
        if (user.status !== 'Active') throw new AppError(403, 'This account is not active');
        if (needsRehash(user.password_hash, config.auth.passwordHash))
            await users.setPasswordHash(db, user.oid, await hashPassword(body.password, config.auth.passwordHash));

        await refreshTokens.prune(db, user.oid);
        log().info({ user: user.oid }, 'Signed in');
        ok(res, await issue(user, req), 'Signed in');
    });

    router.post('/v1/auth/refresh', refreshLimiter, async (req, res) => {
        const { refresh_token } = parse(refreshSchema, req.body);
        const result = await refreshTokens.rotate(db, refresh_token, meta(req), {
            ttlSeconds: config.auth.refreshTtl,
            graceSeconds: config.auth.refreshReuseGrace
        });
        if (result.status === 'reused') log().warn({ user: result.userOid }, 'Refresh token reuse detected: session revoked');
        if (result.status !== 'ok') throw new AppError(401, 'Session expired. Please sign in again.');
        const user = await users.findByOid(db, result.userOid);
        if (user?.status !== 'Active') throw new AppError(401, 'Session expired. Please sign in again.');
        ok(res, await issue(user, req, result), 'Token refreshed');
    });

    /** With `refresh_token`: this session only. Without: every session of the user. */
    router.post('/v1/auth/logout', requireUserBeforeChange, async (req, res) => {
        const { refresh_token } = parse(logoutSchema, req.body ?? {});
        const user = currentUser(req);
        if (refresh_token) await refreshTokens.revokeFamily(db, refresh_token, user.oid);
        else await refreshTokens.revokeAll(db, user.oid);
        ok(res, null, 'Signed out');
    });

    /**
     * The D-034 contract (the web app's `CurrentUser`): global `rules` plus one assignment per branch, each with
     * its own rules. The UI combines them for the branch in the URL; the API does the same from `X-Branch-Id`.
     * `member` stays null until the member table exists (phase 2); member sign-in comes with it.
     */
    /**
     * Sets the user's own password: replaces a temporary one (D-054) or changes a known one. Ends every session,
     * this one included, and answers with the tokens of a new one, so the caller stays signed in.
     */
    router.post('/v1/auth/change-password', requireUserBeforeChange, passwordLimiter, async (req, res) => {
        const body = parse(changePasswordSchema, req.body);
        const user = currentUser(req);
        const stored = await users.passwordHash(db, user.oid);
        if (!stored || !(await verifyPassword(body.current_password, stored)))
            throw new AppError(400, 'The current password is not correct', [{ path: 'current_password', message: 'Not correct' }]);
        const hash = await hashPassword(body.new_password, config.auth.passwordHash);
        await db.transaction(async tx => {
            await tx.query(sql`update app_user set password_hash = ${hash}, must_change_password = false, updated_at = now() where oid = ${user.oid}`);
            await refreshTokens.revokeAll(tx, user.oid);
        });
        await forgetUser(deps.cache, user);
        log().info({ user: user.oid }, 'Password changed');
        ok(res, await issue(user, req), 'Password changed');
    });

    /** The user's own live sessions (D-054). `current` marks the one making this request. */
    router.get('/v1/auth/sessions', requireUser, async (req, res) => {
        const user = currentUser(req);
        const sid = req.auth?.sid ?? null;
        ok(
            res,
            (await refreshTokens.sessions(db, user.oid)).map(s => ({ ...s, current: s.id === sid }))
        );
    });

    router.delete('/v1/auth/sessions/:id', requireUser, async (req, res) => {
        const { id } = parse(sessionParams, req.params);
        if (!(await refreshTokens.revokeSession(db, currentUser(req).oid, id))) throw new AppError(404, 'No such session');
        ok(res, null, 'Session signed out');
    });

    router.get('/v1/auth/me', requireUserBeforeChange, async (req, res) => {
        const u = currentUser(req);
        const member =
            u.kind === 'member' && !u.must_change_password
                ? await portalIdentity({ ...deps, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix }, u)
                : null;
        ok(res, {
            user_id: u.oid,
            username: u.username,
            name: u.name,
            email: u.email,
            kind: u.kind,
            photo_url: member?.photo_url ?? null,
            rules: GLOBAL_RULES[u.kind],
            assignments: u.assignments,
            all_branches: u.all_branches,
            must_change_password: u.must_change_password,
            member: member ? { oid: member.oid, code: member.code, branch: member.branch } : null
        });
    });

    return router;
}
