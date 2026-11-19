import { Router } from 'express';

import type { AppDeps } from '#src/container.ts';
import { log } from '#src/lib/logger.ts';

/**
 * Liveness and readiness, outside API_PREFIX.
 * - /health/live: the process answers.
 * - /health/ready: the database answers, and the process is not shutting down. Checked after each deploy.
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
        await check('database', () => deps.db.ping());
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
