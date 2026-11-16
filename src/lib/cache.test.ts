import { setTimeout as sleep } from 'node:timers/promises';

import { createMemoryCache, createRedisCache, type RedisCommands } from './cache.ts';

/** Just enough Redis (GET, SET with EX/NX, DEL) to test the cache logic without a server. */
function fakeRedis(): RedisCommands & { store: Map<string, string>; failing: boolean } {
    const store = new Map<string, string>();
    const fake = {
        store,
        failing: false,
        get(key: string) {
            if (fake.failing) return Promise.reject(new Error('ECONNREFUSED'));
            return Promise.resolve(store.get(key) ?? null);
        },
        set(key: string, value: string, _ex: 'EX', _seconds: number, nx?: 'NX') {
            if (fake.failing) return Promise.reject(new Error('ECONNREFUSED'));
            if (nx && store.has(key)) return Promise.resolve(null);
            store.set(key, value);
            return Promise.resolve('OK');
        },
        del(...keys: string[]) {
            keys.forEach(k => store.delete(k));
            return Promise.resolve(keys.length);
        }
    };
    return fake;
}

describe.each([
    ['memory', () => createMemoryCache()],
    ['redis', () => createRedisCache(fakeRedis())]
])('%s cache', (_name, make) => {
    it('runs the loader once for concurrent misses (single flight) and serves hits from the cache', async () => {
        const cache = make();
        let calls = 0;
        const load = async () => {
            calls++;
            await sleep(30);
            return { value: 42 };
        };
        const results = await Promise.all(Array.from({ length: 5 }, () => cache.getOrSet('k', load, 60)));
        expect(results).toEqual(Array(5).fill({ value: 42 }));
        expect(calls).toBe(1);
        await cache.getOrSet('k', load, 60);
        expect(calls).toBe(1);
    });

    it('does not cache null, and del() forces a reload', async () => {
        const cache = make();
        let calls = 0;
        const loadNull = () => {
            calls++;
            return Promise.resolve(null);
        };
        await cache.getOrSet('n', loadNull, 60);
        await cache.getOrSet('n', loadNull, 60);
        expect(calls).toBe(2);

        await cache.getOrSet('d', () => Promise.resolve('first'), 60);
        await cache.del('d');
        expect(await cache.getOrSet('d', () => Promise.resolve('second'), 60)).toBe('second');
    });
});

describe('redis cache', () => {
    it('falls back to the loader when Redis is down (fail open)', async () => {
        const redis = fakeRedis();
        redis.failing = true;
        expect(await createRedisCache(redis).getOrSet('k', () => Promise.resolve('from-db'), 60)).toBe('from-db');
    });

    it('drops a corrupted entry and reloads', async () => {
        const redis = fakeRedis();
        redis.store.set('cache:k', '{not json');
        expect(await createRedisCache(redis).getOrSet('k', () => Promise.resolve('fresh'), 60)).toBe('fresh');
        expect(redis.store.get('cache:k')).toBe('"fresh"');
    });
});
