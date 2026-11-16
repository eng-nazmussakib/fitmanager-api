import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey, SignJWT } from 'jose';

import type { Config } from '#src/config/env.ts';

/**
 * Access tokens: short-lived JWTs, signed and verified with `jose` (jsonwebtoken 8, still in most services, has
 * known CVEs and is CommonJS-only; hapi-auth-jwt2 wrapped it). HS256 with the API's own secret, `iss` and `aud`
 * set and checked, so a token minted for another service with a shared secret is refused.
 *
 * Optionally the API also accepts tokens from an external identity provider (Keycloak for the IB portals, the
 * in-house OAuth server for IMS), verified against its published JWKS: asymmetric keys, so the API never holds a
 * secret that could mint tokens. Set OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE.
 *
 * Refresh tokens are NOT JWTs: 32 random bytes, stored as a SHA-256 hash (see auth.repo.ts). SPN stored them in
 * plain text and signed them as JWTs with a second shared secret, which bought nothing over a random string.
 */
export type Identity = { kind: 'local'; userOid: string } | { kind: 'oidc'; username: string };

export interface TokenService {
    /** Carries only the user id: roles are per branch and come from the database (cached), never from the token. */
    signAccess(user: { oid: string }): Promise<string>;
    verifyAccess(token: string): Promise<Identity>;
    readonly accessTtl: number;
}

export function createTokenService(cfg: Config['auth'], opts: { oidcKeys?: JWTVerifyGetKey } = {}): TokenService {
    const secret = new TextEncoder().encode(cfg.jwtSecret);
    const oidc = cfg.oidc;
    const oidcKeys = opts.oidcKeys ?? (oidc ? createRemoteJWKSet(new URL(oidc.jwksUrl)) : undefined);

    return {
        accessTtl: cfg.accessTtl,

        signAccess: ({ oid }) =>
            new SignJWT({})
                .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
                .setSubject(oid)
                .setIssuer(cfg.issuer)
                .setAudience(cfg.audience)
                .setIssuedAt()
                .setExpirationTime(`${cfg.accessTtl}s`)
                .setJti(randomUUID())
                .sign(secret),

        async verifyAccess(token) {
            // Unverified peek at `iss` only to pick the key; the chosen verification checks everything again.
            const { iss } = decodeJwt(token);
            if (oidc && oidcKeys && iss === oidc.issuer) {
                const { payload } = await jwtVerify(token, oidcKeys, { issuer: oidc.issuer, audience: oidc.audience, algorithms: ['RS256', 'PS256', 'ES256'] });
                const username = typeof payload['preferred_username'] === 'string' ? payload['preferred_username'] : payload.sub;
                if (!username) throw new Error('Token has no subject');
                return { kind: 'oidc', username };
            }
            const { payload } = await jwtVerify(token, secret, { issuer: cfg.issuer, audience: cfg.audience, algorithms: ['HS256'] });
            if (!payload.sub) throw new Error('Token has no subject');
            return { kind: 'local', userOid: payload.sub };
        }
    };
}

export function newRefreshToken(): string {
    return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
