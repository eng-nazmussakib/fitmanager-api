import { setTimeout as sleep } from 'node:timers/promises';

import { log } from './logger.ts';

/**
 * Cache-aside with single-flight, ported from ACAS public-api `util/cache.js` (the best piece of backend code in
 * these projects): on a miss only ONE caller runs the query and fills the cache, the others wait for its result
 * instead of all hitting PostgreSQL at once (the connection-pool stampede of the results-day incident). Failures
 * of the cache itself fall through to the database ("fail open"); `undefined` and `null` are never cached.
 *
 * Two implementations behind one interface: Redis when REDIS_URL is set (shared by all replicas), otherwise
 * in-process memory (single instance, dev, tests).
 */
export interface Cache {
    getOrSet<T>(key: string, load: () => Promise<T>, ttlSeconds: number): Promise<T>;
    del(key: string): Promise<void>;
}

export function createMemoryCache(): Cache {
    const entries = new Map<string, { value: unknown; expires: number }>();
    const inFlight = new Map<string, Promise<unknown>>();

    return {
        async getOrSet<T>(key: string, load: () => Promise<T>, ttlSeconds: number): Promise<T> {
            const hit = entries.get(key);
            if (hit && hit.expires > Date.now()) return hit.value as T;
            const running = inFlight.get(key);
            if (running) return running as Promise<T>;
            const promise = load()
                .then(value => {
                    if (value !== null && value !== undefined) entries.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
                    return value;
                })
                .finally(() => inFlight.delete(key));
            inFlight.set(key, promise);
            return promise;
        },
        del(key) {
            entries.delete(key);
            return Promise.resolve();
        }
    };
}

/** The Redis commands used, so tests can pass a fake and production an ioredis client. */
export interface RedisCommands {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ex: 'EX', seconds: number, nx?: 'NX'): Promise<unknown>;
    del(...keys: string[]): Promise<number>;
}

const LOCK_TTL_SECONDS = 5;
const WAIT_STEP_MS = 50;
const MAX_WAIT_MS = 5000;

export function createRedisCache(redis: RedisCommands, prefix = 'cache:'): Cache {
    const read = async <T>(key: string): Promise<T | undefined> => {
        const raw = await redis.get(key);
        if (raw === null) return undefined;
        try {
            return JSON.parse(raw) as T;
        } catch {
            await redis.del(key); // corrupted entry: drop it, so it is not a permanent miss
            return undefined;
        }
    };

    return {
        async getOrSet<T>(name: string, load: () => Promise<T>, ttlSeconds: number): Promise<T> {
            const key = prefix + name;
            let gotLock: boolean;
            try {
                const cached = await read<T>(key);
                if (cached !== undefined) return cached;
                gotLock = (await redis.set(`${key}:lock`, '1', 'EX', LOCK_TTL_SECONDS, 'NX')) === 'OK';
            } catch (err) {
                log().warn({ err, key }, 'Cache unavailable, reading from source');
                return load();
            }

            if (gotLock) {
                try {
                    const fresh = await load();
                    // ACAS cached with no expiry by default; here every entry has a TTL, so a missed
                    // invalidation heals by itself.
                    if (fresh !== null && fresh !== undefined) await redis.set(key, JSON.stringify(fresh), 'EX', ttlSeconds).catch(() => undefined);
                    return fresh;
                } finally {
                    await redis.del(`${key}:lock`).catch(() => undefined);
                }
            }

            for (let waited = 0; waited < MAX_WAIT_MS; waited += WAIT_STEP_MS) {
                await sleep(WAIT_STEP_MS);
                const cached = await read<T>(key).catch(() => undefined);
                if (cached !== undefined) return cached;
            }
            return load();
        },
        async del(name) {
            await redis.del(prefix + name).catch((err: unknown) => {
                log().warn({ err, key: prefix + name }, 'Cache invalidation failed');
            });
        }
    };
}
