/**
 * Cache-aside with single-flight: on a miss only ONE caller runs the query and fills the cache, the others wait for
 * its result instead of all hitting PostgreSQL at once. `undefined` and `null` are never cached. In memory, per
 * process (Node) or per isolate (Workers): short TTLs keep isolates close enough for a demo.
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
