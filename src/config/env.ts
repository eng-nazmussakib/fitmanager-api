import { readFileSync } from 'node:fs';

import * as v from 'valibot';

/**
 * All configuration, read ONCE at startup and validated with Valibot: a missing or malformed variable stops the
 * process with a list of every problem, instead of an `undefined` deep inside a request hours later.
 *
 * Replaces, from the hapi services:
 * - `require('dotenv').config({ path: './src/env/.env.' + NODE_ENV })` in several modules → Node's own
 *   `--env-file` flag (see package.json scripts); no dotenv dependency, loaded before any module runs.
 * - `Secret.get_secret('spn_db_password', 'DB_PASSWORD')`, which read /run/secrets only when NODE_ENV !== 'loc'
 *   → the `<NAME>_FILE` convention (the one the official postgres/redis images use): `JWT_SECRET_FILE=/run/secrets/jwt`.
 *   Works the same in Swarm, Compose and Kubernetes, and locally you just set `JWT_SECRET`.
 */
const SECRET_KEYS = ['DATABASE_URL', 'JWT_SECRET', 'REDIS_URL', 'SMTP_URL', 'RECAPTCHA_SECRET', 'OTP_SECRET'] as const;

const bool = v.pipe(
    v.picklist(['true', 'false']),
    v.transform(s => s === 'true')
);
const csv = v.pipe(
    v.string(),
    v.transform(s =>
        s
            .split(',')
            .map(x => x.trim())
            .filter(Boolean)
    )
);
/** Unset and empty both mean "not configured". */
const optional = v.optional(
    v.pipe(
        v.string(),
        v.transform(s => (s === '' ? undefined : s))
    )
);
/** Env values are strings: coerce, then check. NaN ('abc') fails `number()`. */
const toNumber = v.pipe(v.string(), v.transform(Number), v.number('must be a number'));
const num = (min: number, max: number) => v.pipe(toNumber, v.minValue(min), v.maxValue(max));
const int = (min: number, max = Number.MAX_SAFE_INTEGER) => v.pipe(toNumber, v.integer('must be a whole number'), v.minValue(min), v.maxValue(max));
const str = v.string();

const fields = v.object({
    NODE_ENV: v.optional(v.picklist(['development', 'test', 'production']), 'production'),
    /** Deployment label for logs and Sentry: local, dev, iat, uat, prod. */
    APP_ENV: v.optional(str, 'local'),
    APP_VERSION: v.optional(str, 'dev'),
    PORT: v.optional(int(1, 65535), '3000'),
    HOST: v.optional(str, '0.0.0.0'),
    API_PREFIX: v.optional(v.pipe(v.string(), v.regex(/^\/[\w/-]*[^/]$/, 'must start with / and not end with /')), '/api'),
    /** Comma-separated origins allowed to call the API cross-origin. Empty: no CORS headers (same-origin via nginx). */
    CORS_ORIGINS: v.optional(csv, ''),
    /** Reverse proxies in front of the app (nginx = 1). Needed for the real client IP in logs and rate limits. */
    TRUST_PROXY: v.optional(int(0), '0'),
    LOG_LEVEL: v.optional(v.picklist(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']), 'info'),
    LOG_PRETTY: v.optional(bool, 'false'),

    DB_DRIVER: v.optional(v.picklist(['pg', 'pglite']), 'pg'),
    DATABASE_URL: optional,
    /** pglite only: a directory to keep the data in; empty = in memory (lost on restart). */
    PGLITE_DATA_DIR: optional,
    DB_POOL_MAX: v.optional(int(1), '10'),
    DB_STATEMENT_TIMEOUT_MS: v.optional(int(1), '15000'),

    JWT_SECRET: v.pipe(v.string('required'), v.minLength(32, 'must be at least 32 characters')),
    JWT_ISSUER: v.optional(str, 'skeleton-api'),
    JWT_AUDIENCE: v.optional(str, 'skeleton-web'),
    ACCESS_TOKEN_TTL: v.optional(int(1), '900'),
    REFRESH_TOKEN_TTL: v.optional(int(1), String(7 * 24 * 3600)),
    /** Seconds a just-rotated refresh token is still accepted (two tabs refreshing at once). */
    REFRESH_REUSE_GRACE: v.optional(int(0), '30'),
    /** Optional external identity provider (Keycloak, the in-house OAuth server): its tokens are accepted too. */
    OIDC_ISSUER: optional,
    OIDC_JWKS_URL: optional,
    OIDC_AUDIENCE: optional,
    LOGIN_RATE_LIMIT: v.optional(int(1), '10'),
    /** scrypt cost for NEW password hashes (src/auth/password.ts). Cheap by default for the Workers Free plan. */
    PASSWORD_SCRYPT_N: v.optional(
        v.pipe(
            int(2 ** 10, 2 ** 20),
            v.check(n => (n & (n - 1)) === 0, 'must be a power of two')
        ),
        String(2 ** 10)
    ),
    PASSWORD_SCRYPT_R: v.optional(int(1, 32), '8'),
    PASSWORD_SCRYPT_P: v.optional(int(1, 16), '1'),

    REDIS_URL: optional,
    SMTP_URL: optional,
    MAIL_FROM: v.optional(str, 'Skeleton <no-reply@example.com>'),
    OTP_SECRET: optional,
    UPLOAD_DIR: v.optional(str, 'storage/uploads'),
    UPLOAD_MAX_BYTES: v.optional(int(1), String(5 * 1024 * 1024)),
    RECAPTCHA_SECRET: optional,
    RECAPTCHA_MIN_SCORE: v.optional(num(0, 1), '0.5'),
    /** Chrome/Chromium binary for server-side PDF reports. Unset: the PDF endpoint answers 501. */
    CHROME_PATH: optional,
    SCHEDULER_ENABLED: v.optional(bool, 'true')
});
type Fields = v.InferOutput<typeof fields>;

/** Rules across fields. They run once every field is valid on its own; each returns `[variable, message]`. */
function crossFieldProblems(f: Fields): [string, string][] {
    const problems: [string, string][] = [];
    if (f.DB_DRIVER === 'pg' && !f.DATABASE_URL) problems.push(['DATABASE_URL', 'required when DB_DRIVER=pg']);
    const oidc = [f.OIDC_ISSUER, f.OIDC_JWKS_URL, f.OIDC_AUDIENCE];
    if (oidc.some(Boolean) && !oidc.every(Boolean)) problems.push(['OIDC_ISSUER', 'set OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE together']);
    // scrypt needs 128 * N * r bytes; derive() allows at most 256 MiB.
    if (128 * f.PASSWORD_SCRYPT_N * f.PASSWORD_SCRYPT_R > 256 * 1024 * 1024) problems.push(['PASSWORD_SCRYPT_N', 'N * r needs more than 256 MiB of memory']);
    if (f.NODE_ENV === 'production') {
        if (f.DB_DRIVER === 'pglite') problems.push(['DB_DRIVER', 'pglite is for development and tests']);
        if (f.JWT_SECRET.startsWith('dev-')) problems.push(['JWT_SECRET', 'the development secret must not be used in production']);
    }
    return problems;
}

function toConfig(v: Fields) {
    return {
        env: v.NODE_ENV,
        appEnv: v.APP_ENV,
        version: v.APP_VERSION,
        isProduction: v.NODE_ENV === 'production',
        port: v.PORT,
        host: v.HOST,
        apiPrefix: v.API_PREFIX,
        corsOrigins: v.CORS_ORIGINS,
        trustProxy: v.TRUST_PROXY,
        log: { level: v.LOG_LEVEL, pretty: v.LOG_PRETTY },
        db: {
            driver: v.DB_DRIVER,
            url: v.DATABASE_URL,
            pgliteDataDir: v.PGLITE_DATA_DIR,
            poolMax: v.DB_POOL_MAX,
            statementTimeoutMs: v.DB_STATEMENT_TIMEOUT_MS
        },
        auth: {
            jwtSecret: v.JWT_SECRET,
            issuer: v.JWT_ISSUER,
            audience: v.JWT_AUDIENCE,
            accessTtl: v.ACCESS_TOKEN_TTL,
            refreshTtl: v.REFRESH_TOKEN_TTL,
            refreshReuseGrace: v.REFRESH_REUSE_GRACE,
            loginRateLimit: v.LOGIN_RATE_LIMIT,
            passwordHash: { N: v.PASSWORD_SCRYPT_N, r: v.PASSWORD_SCRYPT_R, p: v.PASSWORD_SCRYPT_P },
            oidc:
                v.OIDC_ISSUER && v.OIDC_JWKS_URL && v.OIDC_AUDIENCE ? { issuer: v.OIDC_ISSUER, jwksUrl: v.OIDC_JWKS_URL, audience: v.OIDC_AUDIENCE } : undefined
        },
        redisUrl: v.REDIS_URL,
        mail: { smtpUrl: v.SMTP_URL, from: v.MAIL_FROM },
        // OTP codes are HMAC'd with their own key; falls back to one derived from the JWT secret.
        otpSecret: v.OTP_SECRET ?? `otp:${v.JWT_SECRET}`,
        upload: { dir: v.UPLOAD_DIR, maxBytes: v.UPLOAD_MAX_BYTES },
        recaptcha: { secret: v.RECAPTCHA_SECRET, minScore: v.RECAPTCHA_MIN_SCORE },
        chromePath: v.CHROME_PATH,
        schedulerEnabled: v.SCHEDULER_ENABLED
    };
}

export type Config = ReturnType<typeof toConfig>;
export type EnvSource = Record<string, string | undefined>;

/** Copies `<NAME>_FILE` contents into `<NAME>`. The file wins over a plain variable of the same name. */
function resolveSecretFiles(source: EnvSource): EnvSource {
    const out = { ...source };
    for (const key of SECRET_KEYS) {
        const file = source[`${key}_FILE`];
        if (!file) continue;
        try {
            out[key] = readFileSync(file, 'utf8').trim();
        } catch (err) {
            throw new Error(`Cannot read ${key}_FILE (${file}): ${(err as Error).message}`, { cause: err });
        }
    }
    return out;
}

/** Pure: pass a plain object in tests. Throws one error listing every invalid variable. */
export function loadConfig(source: EnvSource = process.env): Config {
    const result = v.safeParse(fields, resolveSecretFiles(source));
    const problems: [string, string][] = result.success ? crossFieldProblems(result.output) : result.issues.map(i => [v.getDotPath(i) ?? '(root)', i.message]);
    if (problems.length) throw new Error(`Invalid configuration:\n${problems.map(([key, message]) => `  - ${key}: ${message}`).join('\n')}`);
    return toConfig(result.output as Fields); // success is certain here: a failed parse always has problems
}
