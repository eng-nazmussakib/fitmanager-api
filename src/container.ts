import { createTokenService, type TokenService } from './auth/tokens.ts';
import type { Config } from './config/env.ts';
import { createDb, type Db } from './db/db.ts';
import { type Cache, createMemoryCache } from './lib/cache.ts';
import { type Clock, systemClock } from './lib/clock.ts';
import { createS3Store, type FileStore } from './lib/file-store.ts';
import { createLocalStore } from './lib/file-store-local.ts';
import { log } from './lib/logger.ts';
import type { RateLimitStores } from './lib/rate-limit.ts';

/**
 * Everything a request handler may need, created once at startup and passed to the routers explicitly. No module
 * opens its own connection at import time, so tests swap any piece: PGlite for PostgreSQL, a memory file store.
 * There are no outside services but R2 (D-075): nothing here sends mail, texts or talks to a third party.
 */
export interface AppDeps {
    config: Config;
    db: Db;
    /** In memory, per process (Node) or per isolate (Workers). */
    cache: Cache;
    /** "Now" for every business rule (tests set it). */
    clock: Clock;
    /** Member photos and documents (D-058): R2 over its S3 API, local disk in development. */
    files: FileStore;
    tokens: TokenService;
    /** Where rate limits are counted: Durable Objects on Workers, memory when undefined (local, tests). */
    rateLimits?: RateLimitStores | undefined;
    /** Flipped by the shutdown handler; /health/ready reports 503 from then on. */
    lifecycle: { shuttingDown: boolean };
}

export async function createDeps(config: Config, overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
    return {
        config,
        db: overrides.db ?? (await createDb(config.db)),
        cache: overrides.cache ?? createMemoryCache(),
        clock: overrides.clock ?? systemClock,
        files: overrides.files ?? (config.files.store === 's3' && config.files.s3 ? createS3Store(config.files.s3) : createLocalStore(config.files.dir)),
        tokens: overrides.tokens ?? createTokenService(config.auth),
        rateLimits: overrides.rateLimits,
        lifecycle: { shuttingDown: false }
    };
}

export async function closeDeps(deps: AppDeps): Promise<void> {
    try {
        await deps.db.close();
    } catch (err) {
        log().warn({ err, resource: 'db' }, 'Close failed');
    }
}
