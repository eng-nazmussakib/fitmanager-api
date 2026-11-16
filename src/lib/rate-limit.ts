import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { type RedisReply, RedisStore } from 'rate-limit-redis';

/**
 * Rate limits with express-rate-limit: in memory by default, in Redis when REDIS_URL is set (then the limit holds
 * across all replicas; in memory each replica counts on its own).
 *
 * Policy Repository's hapi-rate-limit was registered with `enabled: false`, and its "limit exceeded" response was
 * HTTP 201 with `code: 401` in the body. This one answers 429 with a Retry-After header.
 */
export interface LimiterOptions {
    name: string;
    windowMs: number;
    limit: number;
    /** What to count by. Default: client IP (behind nginx this needs TRUST_PROXY). */
    key?: (req: Request) => string;
    redis?: Redis | undefined;
}

export function createLimiter(opts: LimiterOptions): RequestHandler {
    const redis = opts.redis;
    const store: Store | undefined = redis
        ? new RedisStore({
              prefix: `rl:${opts.name}:`,
              sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>
          })
        : undefined;
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
