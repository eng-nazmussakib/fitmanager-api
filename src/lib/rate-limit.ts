import type { Request, RequestHandler } from 'express';
import { type ClientRateLimitInfo, ipKeyGenerator, type Options, rateLimit, type Store } from 'express-rate-limit';

/**
 * Rate limits with express-rate-limit:
 * - Cloudflare Workers: one Durable Object per counted key (`durableObjectStores`, the `RateLimitCounter` class in
 *   `src/worker/rate-limit-counter.ts`, free on the Workers Free plan), so every isolate sees the same count;
 * - Node (local development, tests): express-rate-limit's memory store, per process.
 * The store is chosen once, in `AppDeps.rateLimits`; routes only name their limit. Answers 429 with Retry-After.
 */
export interface LimiterOptions {
    name: string;
    windowMs: number;
    limit: number;
    /** What to count by. Default: client IP (behind a proxy this needs TRUST_PROXY). */
    key?: (req: Request) => string;
    /** `deps.rateLimits`: undefined means memory. */
    stores?: RateLimitStores | undefined;
}

/** Makes the store for one named limiter (its keys are prefixed with the name). */
export type RateLimitStores = (name: string) => Store;

export function createLimiter(opts: LimiterOptions): RequestHandler {
    const store = opts.stores?.(opts.name);
    return rateLimit({
        windowMs: opts.windowMs,
        limit: opts.limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        ...(store ? { store } : {}),
        keyGenerator: opts.key ?? (req => ipKeyGenerator(req.ip ?? 'unknown')),
        handler: (_req, res) => {
            res.status(429).json({ code: 429, message: 'Too many attempts. Please wait a while and try again.', data: null });
        }
    });
}

// ---- Durable Objects (Workers) ----

/** One fixed window: hits so far and when it ends (epoch ms). */
export interface WindowState {
    hits: number;
    resetAt: number;
}

/** The counter's rule, kept free of Workers APIs so it is tested in Node: a hit opens a new window once the old one ended. */
export function nextWindow(state: WindowState | undefined, now: number, windowMs: number): WindowState {
    if (!state || state.resetAt <= now) return { hits: 1, resetAt: now + windowMs };
    return { hits: state.hits + 1, resetAt: state.resetAt };
}

/** The RPC methods of the `RateLimitCounter` Durable Object, as the store calls them. */
export interface CounterStub {
    hit(windowMs: number): Promise<WindowState>;
    undo(): Promise<void>;
    reset(): Promise<void>;
}

/** The slice of a `DurableObjectNamespace` binding the store needs. */
export interface CounterNamespace {
    idFromName(name: string): unknown;
    get(id: never): CounterStub;
}

/**
 * express-rate-limit's `Store` over Durable Objects: each key (`login:<ip>:<username>`) is its own object, so a
 * count is exact across every isolate and location, and an object's storage is wiped by an alarm when its window
 * ends. No timers in this class, so the app can be built in global scope on Workers.
 */
export class DurableObjectStore implements Store {
    readonly localKeys = false;
    readonly prefix: string;
    private readonly ns: CounterNamespace;
    private windowMs = 60_000;

    constructor(ns: CounterNamespace, name: string) {
        this.ns = ns;
        this.prefix = `${name}:`;
    }

    init(options: Options): void {
        this.windowMs = options.windowMs;
    }

    private stub(key: string): CounterStub {
        return this.ns.get(this.ns.idFromName(this.prefix + key) as never);
    }

    async increment(key: string): Promise<ClientRateLimitInfo> {
        const w = await this.stub(key).hit(this.windowMs);
        return { totalHits: w.hits, resetTime: new Date(w.resetAt) };
    }

    async decrement(key: string): Promise<void> {
        await this.stub(key).undo();
    }

    async resetKey(key: string): Promise<void> {
        await this.stub(key).reset();
    }
}

export function durableObjectStores(ns: CounterNamespace): RateLimitStores {
    return name => new DurableObjectStore(ns, name);
}
