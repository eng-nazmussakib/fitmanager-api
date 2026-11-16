import type { Server } from 'node:http';

import { createApp } from './app.ts';
import { type Config, loadConfig } from './config/env.ts';
import { closeDeps, createDeps } from './container.ts';
import { cleanupJob } from './jobs/cleanup.job.ts';
import { createLogger, log, setRootLogger } from './lib/logger.ts';
import { type Scheduler, startScheduler } from './lib/scheduler.ts';

/**
 * Process entry: config → logger → dependencies → HTTP server → jobs, and the reverse on shutdown.
 *
 * The API never changes the schema or seeds data (D-039): `fitmanager-infra/db` does, before the API starts
 * (`npm run migrate` / `npm run seed` there).
 *
 * Shutdown, compared with the hapi services: SPN called `process.exit(1)` on an unhandled rejection and had no
 * SIGTERM handler, so every deploy cut in-flight requests; IMS handled SIGTERM but exited without closing the
 * server or the pool. Here: stop accepting connections, let running requests finish (up to 8 s, inside Swarm's
 * default 10 s stop grace period), close Chrome, Redis and the pool, then exit.
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

let config: Config;
try {
    config = loadConfig();
} catch (err) {
    process.stderr.write(`${(err as Error).message}\n`); // the list of problems, without a stack trace
    process.exit(1);
}
setRootLogger(
    createLogger({ level: config.log.level, pretty: config.log.pretty, base: { service: 'skeleton-api', env: config.appEnv, version: config.version } })
);

const deps = await createDeps(config);

const app = createApp(deps);
const scheduler: Scheduler | undefined = config.schedulerEnabled ? startScheduler(deps.db, [cleanupJob]) : undefined;

const server: Server = app.listen(config.port, config.host, err => {
    if (err) {
        log().fatal({ err }, 'Cannot listen');
        process.exit(1);
    }
    log().info({ url: `http://${config.host}:${config.port}${config.apiPrefix}`, db: deps.db.driver, cache: deps.redis ? 'redis' : 'memory' }, 'API started');
});
// Longer than nginx's upstream keep-alive (60 s): otherwise Node closes an idle socket just as nginx reuses it,
// and the user gets a random 502.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let stopping = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    deps.lifecycle.shuttingDown = true;
    log().info({ signal }, 'Shutting down');
    scheduler?.stop();

    const force = setTimeout(() => {
        log().warn('Requests still running after the timeout, closing their connections');
        server.closeAllConnections();
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    await new Promise<void>(resolve => {
        server.close(() => {
            resolve();
        });
        server.closeIdleConnections();
    });
    clearTimeout(force);
    await closeDeps(deps);
    log().info('Stopped');
    process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', reason => {
    log().fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', err => {
    log().fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
});
