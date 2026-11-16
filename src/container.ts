import { Redis } from 'ioredis';

import { createTokenService, type TokenService } from './auth/tokens.ts';
import type { Config } from './config/env.ts';
import { createDb, type Db } from './db/db.ts';
import { type Cache, createMemoryCache, createRedisCache } from './lib/cache.ts';
import { log } from './lib/logger.ts';
import { createMailer, type Mailer } from './lib/mailer.ts';
import { createPdfRenderer, type PdfRenderer } from './lib/pdf.ts';
import { createRecaptchaVerifier, type RecaptchaVerifier } from './lib/recaptcha.ts';

/**
 * Everything a request handler may need, created once at startup and passed to the routers explicitly. No module
 * opens its own connection at import time (SPN's db.config.js created the pool, and loaded dotenv again, the
 * moment any file required it), so tests swap any piece: PGlite for PostgreSQL, a memory mailer for SMTP.
 */
export interface AppDeps {
    config: Config;
    db: Db;
    cache: Cache;
    mailer: Mailer;
    pdf: PdfRenderer;
    tokens: TokenService;
    recaptcha: RecaptchaVerifier;
    redis?: Redis | undefined;
    /** Flipped by the shutdown handler; /health/ready reports 503 from then on. */
    lifecycle: { shuttingDown: boolean };
}

export async function createDeps(config: Config, overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
    const redis =
        'redis' in overrides
            ? overrides.redis
            : config.redisUrl
              ? new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, connectionName: 'skeleton-api' })
              : undefined;
    redis?.on('error', err => {
        log().warn({ err }, 'Redis error');
    });

    return {
        config,
        db: overrides.db ?? (await createDb(config.db)),
        cache: overrides.cache ?? (redis ? createRedisCache(redis) : createMemoryCache()),
        mailer: overrides.mailer ?? createMailer({ ...config.mail, logBodies: config.env === 'development' }),
        pdf: overrides.pdf ?? createPdfRenderer(config.chromePath),
        tokens: overrides.tokens ?? createTokenService(config.auth),
        recaptcha: overrides.recaptcha ?? createRecaptchaVerifier(config.recaptcha),
        redis,
        lifecycle: { shuttingDown: false }
    };
}

/** Closes in reverse order of need. Each step is independent, so one failure does not skip the rest. */
export async function closeDeps(deps: AppDeps): Promise<void> {
    const steps: [string, () => unknown][] = [
        ['pdf', () => deps.pdf.close()],
        [
            'mailer',
            () => {
                deps.mailer.close();
            }
        ],
        ['redis', () => deps.redis?.quit()],
        ['db', () => deps.db.close()]
    ];
    for (const [name, close] of steps) {
        try {
            await close();
        } catch (err) {
            log().warn({ err, resource: name }, 'Close failed');
        }
    }
}
