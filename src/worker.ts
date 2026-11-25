/**
 * Cloudflare Workers entry: the hosted demo. The same `createApp(deps)` as `server.ts`, behind
 * `handleAsNodeRequest` from `cloudflare:node`.
 *
 * Two Workers rules shape this file:
 * - **No I/O object outlives its request.** A `pg` pool made in one request cannot be used by the next, so `deps.db`
 *   is a facade that forwards to a pool made for the current request (`AsyncLocalStorage`) and closed after it.
 *   Hyperdrive keeps the real connections warm, so a new client per request is cheap.
 * - **No timers or I/O in global scope.** Rate limits count in a Durable Object (`RateLimitCounter`, no timers),
 *   so the app is built in global scope from `env` (`cloudflare:workers`): its cost moves from the first request
 *   to start-up, which has its own 1 s budget. Nothing here may open a connection at import.
 *
 * What differs from Node: a memory cache per isolate, rate limits in a Durable Object, files in R2. There
 * is no `scheduled` handler: the demo has no cron jobs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { handleAsNodeRequest } from 'cloudflare:node';
import { env as workerEnv } from 'cloudflare:workers';
import type { Express } from 'express';

import { createApp } from './app.ts';
import { createTokenService } from './auth/tokens.ts';
import { type EnvSource, loadConfig } from './config/env.ts';
import type { AppDeps } from './container.ts';
import { createDb, type Db } from './db/db.ts';
import { createMemoryCache } from './lib/cache.ts';
import { systemClock } from './lib/clock.ts';
import { createS3Store, type FileStore } from './lib/file-store.ts';
import { AppError } from './lib/http.ts';
import { createLogger, log, setRootLogger } from './lib/logger.ts';
import { type CounterNamespace, durableObjectStores } from './lib/rate-limit.ts';

export { RateLimitCounter } from './worker/rate-limit-counter.ts';

interface Env {
    /** Missing when the Worker is given a plain `DATABASE_URL` var instead. */
    HYPERDRIVE?: { connectionString: string };
    /** The `RateLimitCounter` Durable Object namespace (wrangler.jsonc). */
    RATE_LIMITER: CounterNamespace;
    [key: string]: unknown;
}

/** A routing key for the `cloudflare:node` HTTP shim, not a network port. */
const PORT = 8787;

const requestDb = new AsyncLocalStorage<Db>();
function current(): Db {
    const db = requestDb.getStore();
    if (!db) throw new Error('No database for this request'); // fail closed: never fall back to a shared pool
    return db;
}

/** `deps.db` for every router: forwards each call to the current request's pool. */
const dbFacade: Db = {
    driver: 'pg',
    query: q => current().query(q),
    exec: script => current().exec(script),
    transaction: fn => current().transaction(fn),
    ping: () => current().ping(),
    close: () => Promise.resolve()
};

/** Workers have no disk: files need FILE_STORE=s3 (R2 over its S3 API). Until then every file call says so. */
const noFiles: FileStore = {
    kind: 's3',
    uploadTarget: () => Promise.reject(new AppError(503, 'File storage is not configured')),
    head: () => Promise.reject(new AppError(503, 'File storage is not configured')),
    read: () => Promise.reject(new AppError(503, 'File storage is not configured')),
    write: () => Promise.reject(new AppError(503, 'File storage is not configured')),
    delete: () => Promise.reject(new AppError(503, 'File storage is not configured'))
};

/**
 * The request's connection string. Read per request: Hyperdrive's `connectionString` counts as I/O, which Workers
 * refuse in global scope, so the config built at start-up only gets a placeholder (the app never uses
 * `config.db.url` here: `deps.db` is the facade).
 */
const dbUrlOf = (env: Env) => env.HYPERDRIVE?.connectionString ?? (typeof env['DATABASE_URL'] === 'string' ? env['DATABASE_URL'] : '');

function build(env: Env): Express {
    const vars: EnvSource = {};
    for (const [key, value] of Object.entries(env)) if (typeof value === 'string') vars[key] = value;
    const dbUrl = 'HYPERDRIVE' in env ? 'postgres://hyperdrive.invalid/per-request' : (vars['DATABASE_URL'] ?? '');
    // TRUST_PROXY=1: `req.ip` is the X-Forwarded-For entry that `withClientIp` writes from CF-Connecting-IP.
    const config = loadConfig({ ...vars, DB_DRIVER: 'pg', DATABASE_URL: dbUrl, TRUST_PROXY: '1' });
    setRootLogger(createLogger({ level: config.log.level, pretty: false, base: { service: 'fitmanager-api', env: config.appEnv, version: config.version } }));

    const deps: AppDeps = {
        config,
        db: dbFacade,
        cache: createMemoryCache(),
        clock: systemClock,
        files: config.files.s3 ? createS3Store(config.files.s3) : noFiles,
        tokens: createTokenService(config.auth),
        rateLimits: durableObjectStores(env.RATE_LIMITER),
        lifecycle: { shuttingDown: false }
    };
    const built = createApp(deps);
    built.listen(PORT);
    return built;
}

// Built once per isolate, at start-up (global scope). Where the bindings are missing (`wrangler check startup`
// profiles without them), the config is refused here and the first request builds it instead, failing loudly then.
let app: Express | undefined;
try {
    app = build(workerEnv as Env);
} catch (err) {
    log().warn({ err }, 'App not built at start-up');
}

/**
 * Behind the `cloudflare:node` shim `req.socket.remoteAddress` is always 127.0.0.1. Cloudflare sets
 * CF-Connecting-IP to the real client; it REPLACES any X-Forwarded-For the client sent (which could be forged),
 * so with TRUST_PROXY=1 Express's `req.ip` (rate limits) is the client's address.
 */
export function withClientIp(request: Request): Request {
    const ip = request.headers.get('cf-connecting-ip');
    const headers = new Headers(request.headers);
    if (ip) headers.set('x-forwarded-for', ip);
    else headers.delete('x-forwarded-for');
    return new Request(request, { headers });
}

export default {
    async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
        app ??= build(env);
        const db = await createDb({ driver: 'pg', url: dbUrlOf(env), poolMax: 1 });
        try {
            return await requestDb.run(db, () => handleAsNodeRequest(PORT, withClientIp(request)));
        } finally {
            ctx.waitUntil(
                db.close().catch((err: unknown) => {
                    log().warn({ err }, 'Closing the request pool failed');
                })
            );
        }
    }
};
