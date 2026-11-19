import { setTimeout as sleep } from 'node:timers/promises';

import { createMemoryCache } from './cache.ts';

describe.each([['memory', () => createMemoryCache()]])('%s cache', (_name, make) => {
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
