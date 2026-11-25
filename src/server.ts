import type { Server } from 'node:http';

import { createApp } from './app.ts';
import { type Config, loadConfig } from './config/env.ts';
import { closeDeps, createDeps } from './container.ts';
import { createLogger, log, setRootLogger } from './lib/logger.ts';

/**
 * The Node entry for local development and tests' manual runs (`npm run dev`): config → logger → dependencies →
 * HTTP server, and the reverse on Ctrl-C. The hosted demo runs the same `createApp(deps)` on Cloudflare Workers
 * (`src/worker.ts`). There are no scheduled jobs.
 *
 * The API never changes the schema or seeds data: `fitmanager-infra/db` does, before the API starts
 * (`npm run migrate` / `npm run seed` there).
 */
let config: Config;
try {
    config = loadConfig();
} catch (err) {
    process.stderr.write(`${(err as Error).message}\n`); // the list of problems, without a stack trace
    process.exit(1);
}
setRootLogger(
    createLogger({ level: config.log.level, pretty: config.log.pretty, base: { service: 'fitmanager-api', env: config.appEnv, version: config.version } })
);

const deps = await createDeps(config);
const app = createApp(deps);

const server: Server = app.listen(config.port, config.host, err => {
    if (err) {
        log().fatal({ err }, 'Cannot listen');
        process.exit(1);
    }
    log().info({ url: `http://${config.host}:${config.port}${config.apiPrefix}`, db: deps.db.driver }, 'API started');
});

let stopping = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    deps.lifecycle.shuttingDown = true;
    log().info({ signal }, 'Shutting down');
    await new Promise<void>(resolve => {
        server.close(() => {
            resolve();
        });
        server.closeAllConnections();
    });
    await closeDeps(deps);
    process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', reason => {
    log().fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
});
