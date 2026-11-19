import * as v from 'valibot';

/**
 * All configuration, read ONCE at startup and validated with Valibot: a missing or malformed variable stops the
 * process with a list of every problem, instead of an `undefined` deep inside a request hours later.
 *
 * Locally the values come from Node's `--env-file` flag (package.json scripts); on Cloudflare from the Worker's vars
 * and secrets (`wrangler.jsonc`, `wrangler secret put`). The app uses no outside service but R2 (D-075).
 */
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
const int = (min: number, max = Number.MAX_SAFE_INTEGER) => v.pipe(toNumber, v.integer('must be a whole number'), v.minValue(min), v.maxValue(max));
const str = v.string();

const fields = v.object({
    NODE_ENV: v.optional(v.picklist(['development', 'test', 'production']), 'production'),
    /** Deployment label for logs: local or demo. */
    APP_ENV: v.optional(str, 'local'),
    APP_VERSION: v.optional(str, 'dev'),
    PORT: v.optional(int(1, 65535), '3000'),
    HOST: v.optional(str, '0.0.0.0'),
    API_PREFIX: v.optional(v.pipe(v.string(), v.regex(/^\/[\w/-]*[^/]$/, 'must start with / and not end with /')), '/api'),
    /** Comma-separated origins allowed to call the API cross-origin. Empty: no CORS headers (same-origin: the web Worker or the dev proxy). */
    CORS_ORIGINS: v.optional(csv, ''),
    /** Proxies in front of the app (the Worker sets 1). Needed for the real client IP in logs and rate limits. */
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
    JWT_ISSUER: v.optional(str, 'fitmanager-api'),
    JWT_AUDIENCE: v.optional(str, 'fitmanager-web'),
    ACCESS_TOKEN_TTL: v.optional(int(1), '900'),
    REFRESH_TOKEN_TTL: v.optional(int(1), String(7 * 24 * 3600)),
    /** Seconds a just-rotated refresh token is still accepted (two tabs refreshing at once). */
    REFRESH_REUSE_GRACE: v.optional(int(0), '30'),
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

    /** Where member photos and documents live (D-058, D-069): `local` disk (development, tests) or R2 over its S3 API. */
    FILE_STORE: v.optional(v.picklist(['local', 's3']), 'local'),
    FILE_DIR: v.optional(str, 'storage/files'),
    /** R2: https://<account>.r2.cloudflarestorage.com. */
    S3_ENDPOINT: optional,
    S3_BUCKET: optional,
    S3_REGION: v.optional(str, 'auto'),
    S3_ACCESS_KEY_ID: optional,
    S3_SECRET_ACCESS_KEY: optional,
    /**
     * The most bytes all branches' photos and documents may take together (D-074, D-075). The default, 8 GiB, keeps
     * the files bucket inside R2's free 10 GB per account with room to spare.
     */
    FILE_STORAGE_LIMIT_MB: v.optional(int(1, 10_000_000), '8192')
});
type Fields = v.InferOutput<typeof fields>;

/** Rules across fields. They run once every field is valid on its own; each returns `[variable, message]`. */
function crossFieldProblems(f: Fields): [string, string][] {
    const problems: [string, string][] = [];
    if (f.DB_DRIVER === 'pg' && !f.DATABASE_URL) problems.push(['DATABASE_URL', 'required when DB_DRIVER=pg']);
    // scrypt needs 128 * N * r bytes; derive() allows at most 256 MiB.
    if (128 * f.PASSWORD_SCRYPT_N * f.PASSWORD_SCRYPT_R > 256 * 1024 * 1024) problems.push(['PASSWORD_SCRYPT_N', 'N * r needs more than 256 MiB of memory']);
    if (f.FILE_STORE === 's3' && !(f.S3_ENDPOINT && f.S3_BUCKET && f.S3_ACCESS_KEY_ID && f.S3_SECRET_ACCESS_KEY)) {
        problems.push(['S3_ENDPOINT', 'set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY when FILE_STORE=s3']);
    }
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
            passwordHash: { N: v.PASSWORD_SCRYPT_N, r: v.PASSWORD_SCRYPT_R, p: v.PASSWORD_SCRYPT_P }
        },
        files: {
            store: v.FILE_STORE,
            dir: v.FILE_DIR,
            storageLimitBytes: v.FILE_STORAGE_LIMIT_MB * 1024 * 1024,
            s3:
                v.S3_ENDPOINT && v.S3_BUCKET && v.S3_ACCESS_KEY_ID && v.S3_SECRET_ACCESS_KEY
                    ? {
                          endpoint: v.S3_ENDPOINT,
                          bucket: v.S3_BUCKET,
                          region: v.S3_REGION,
                          accessKeyId: v.S3_ACCESS_KEY_ID,
                          secretAccessKey: v.S3_SECRET_ACCESS_KEY
                      }
                    : undefined
        }
    };
}

export type Config = ReturnType<typeof toConfig>;
export type EnvSource = Record<string, string | undefined>;

/** Pure: pass a plain object in tests. Throws one error listing every invalid variable. */
export function loadConfig(source: EnvSource = process.env): Config {
    const result = v.safeParse(fields, source);
    const problems: [string, string][] = result.success ? crossFieldProblems(result.output) : result.issues.map(i => [v.getDotPath(i) ?? '(root)', i.message]);
    if (problems.length) throw new Error(`Invalid configuration:\n${problems.map(([key, message]) => `  - ${key}: ${message}`).join('\n')}`);
    return toConfig(result.output as Fields); // success is certain here: a failed parse always has problems
}
