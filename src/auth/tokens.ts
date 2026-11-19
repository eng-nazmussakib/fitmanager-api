import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

import type { Config } from '#src/config/env.ts';

/**
 * Access tokens: short-lived JWTs, signed and verified with `jose`. HS256 with the API's own secret, `iss` and
 * `aud` set and checked, so a token minted for another service with a shared secret is refused.
 *
 * Refresh tokens are NOT JWTs: 32 random bytes, stored as a SHA-256 hash (see auth.repo.ts).
 */
/** `sid`: the refresh-token family (one sign-in) the access token was issued for; null for tokens without one. */
export interface Identity {
    userOid: string;
    sid: string | null;
}

export interface TokenService {
    /**
     * Carries only the user id and the session (refresh-token family) id: roles are per branch and come from the
     * database (cached), never from the token.
     */
    signAccess(user: { oid: string }, sid?: string): Promise<string>;
    verifyAccess(token: string): Promise<Identity>;
    readonly accessTtl: number;
}

export function createTokenService(cfg: Config['auth']): TokenService {
    const secret = new TextEncoder().encode(cfg.jwtSecret);

    return {
        accessTtl: cfg.accessTtl,

        signAccess: ({ oid }, sid) =>
            new SignJWT(sid ? { sid } : {})
                .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
                .setSubject(oid)
                .setIssuer(cfg.issuer)
                .setAudience(cfg.audience)
                .setIssuedAt()
                .setExpirationTime(`${cfg.accessTtl}s`)
                .setJti(randomUUID())
                .sign(secret),

        async verifyAccess(token) {
            const { payload } = await jwtVerify(token, secret, { issuer: cfg.issuer, audience: cfg.audience, algorithms: ['HS256'] });
            if (!payload.sub) throw new Error('Token has no subject');
            return { userOid: payload.sub, sid: typeof payload['sid'] === 'string' ? payload['sid'] : null };
        }
    };
}

export function newRefreshToken(): string {
    return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
