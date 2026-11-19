/**
 * The Durable Object behind rate limits on Workers (phase 1, D-026): one instance per counted key
 * (`login:<ip>:<username>`), named by `DurableObjectStore` in `src/lib/rate-limit.ts`. SQLite-backed, which the
 * Workers Free plan includes. Local development and tests count in memory instead.
 *
 * A fixed window: the first hit opens it, later hits count until it ends, and an alarm at its end deletes the
 * object's storage, so idle keys leave nothing behind.
 */
import { DurableObject } from 'cloudflare:workers';

import { nextWindow, type WindowState } from '../lib/rate-limit.ts';

const KEY = 'window';

export class RateLimitCounter extends DurableObject {
    async hit(windowMs: number): Promise<WindowState> {
        const now = Date.now();
        const previous = await this.ctx.storage.get<WindowState>(KEY);
        const next = nextWindow(previous, now, windowMs);
        await this.ctx.storage.put(KEY, next);
        if (next.resetAt !== previous?.resetAt) await this.ctx.storage.setAlarm(next.resetAt);
        return next;
    }

    /** express-rate-limit takes back a hit it should not have counted (e.g. `skipSuccessfulRequests`). */
    async undo(): Promise<void> {
        const w = await this.ctx.storage.get<WindowState>(KEY);
        if (w && w.hits > 0) await this.ctx.storage.put(KEY, { ...w, hits: w.hits - 1 });
    }

    async reset(): Promise<void> {
        await this.ctx.storage.deleteAll();
    }

    override async alarm(): Promise<void> {
        await this.ctx.storage.deleteAll();
    }
}
