import { type Request, Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import * as v from 'valibot';

import { GLOBAL_RULES } from '#src/auth/ability.ts';
import { refreshTokens, type SessionMeta, users } from '#src/auth/auth.repo.ts';
import { authenticate, currentUser } from '#src/auth/middleware.ts';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '#src/auth/password.ts';
import type { AppDeps } from '#src/container.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';
import { log } from '#src/lib/logger.ts';
import { createLimiter } from '#src/lib/rate-limit.ts';

const token = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const loginSchema = v.object({
    username: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
    password: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    recaptcha_token: v.optional(v.pipe(v.string(), v.maxLength(4000)))
});
const refreshSchema = v.object({ refresh_token: token });
const logoutSchema = v.object({ refresh_token: v.optional(token) });

const meta = (req: Request): SessionMeta => ({ userAgent: req.get('user-agent'), ip: req.ip });

/**
 * Password sign-in for fitmanager-web. The response shapes are the ones its mock API returns
 * (`fitmanager-web/src/app/mock`), so `npm run start:proxy` against this API needs no frontend change.
 */
export function authRouter(deps: AppDeps): Router {
    const { db, tokens, config, recaptcha } = deps;
    const router = Router();
    const requireUser = authenticate(deps);

    // Per IP + username: one attacker cannot lock others out, and spraying one password over many users is
    // still limited by the per-IP refresh limiter below and by nginx.
    const loginLimiter = createLimiter({
        name: 'login',
        windowMs: 15 * 60_000,
        limit: config.auth.loginRateLimit,
        redis: deps.redis,
        key: req => {
            const body = req.body as { username?: unknown } | undefined;
            return `${ipKeyGenerator(req.ip ?? 'unknown')}:${typeof body?.username === 'string' ? body.username.trim().toLowerCase() : ''}`;
        }
    });
    const refreshLimiter = createLimiter({ name: 'refresh', windowMs: 60_000, limit: 60, redis: deps.redis });

    const issue = async (user: { oid: string }, req: Request, familyToken?: string) => ({
        access_token: await tokens.signAccess(user),
        refresh_token: familyToken ?? (await refreshTokens.issue(db, user.oid, meta(req), config.auth.refreshTtl)).token,
        token_type: 'Bearer',
        expires_in: tokens.accessTtl
    });

    router.post('/v1/auth/login', loginLimiter, async (req, res) => {
        const body = parse(loginSchema, req.body);
        if (!(await recaptcha(body.recaptcha_token, 'sign_in', req.ip))) throw new AppError(400, 'reCAPTCHA check failed. Please try again.');

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
        ok(res, await issue(user, req, result.token), 'Token refreshed');
    });

    /** With `refresh_token`: this session only. Without: every session of the user. */
    router.post('/v1/auth/logout', requireUser, async (req, res) => {
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
    router.get('/v1/auth/me', requireUser, (req, res) => {
        const u = currentUser(req);
        ok(res, {
            user_id: u.oid,
            username: u.username,
            name: u.name,
            email: u.email,
            kind: u.kind,
            photo_url: null,
            rules: GLOBAL_RULES[u.kind],
            assignments: u.assignments,
            all_branches: u.all_branches,
            member: null
        });
    });

    return router;
}
