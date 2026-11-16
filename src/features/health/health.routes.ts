import { Router } from 'express';

import type { AppDeps } from '#src/container.ts';
import { log } from '#src/lib/logger.ts';

/**
 * Liveness and readiness, outside API_PREFIX (nginx does not forward them to the internet).
 * - /health/live: the process answers. Docker HEALTHCHECK uses it; failing it means "restart me".
 * - /health/ready: the database (and Redis, if configured) answer, and the process is not shutting down.
 *   A load balancer stops sending traffic while it fails.
 * hapi-alive answered "Application is running..." whether or not the database was reachable.
 */
export function healthRouter(deps: AppDeps): Router {
    const router = Router();

    router.get('/health/live', (_req, res) => {
        res.json({ status: 'ok' });
    });

    router.get('/health/ready', async (_req, res) => {
        const checks: Record<string, 'ok' | 'fail'> = {};
        const check = async (name: string, fn: () => Promise<unknown>) => {
            try {
                await fn();
                checks[name] = 'ok';
            } catch (err) {
                log().warn({ err, check: name }, 'Readiness check failed');
                checks[name] = 'fail';
            }
        };
        const redis = deps.redis;
        await Promise.all([check('database', () => deps.db.ping()), redis ? check('redis', () => redis.ping()) : undefined]);
        const ready = !deps.lifecycle.shuttingDown && Object.values(checks).every(v => v === 'ok');
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ok' : 'unavailable',
            shuttingDown: deps.lifecycle.shuttingDown,
            checks,
            version: deps.config.version
        });
    });

    return router;
}
