import { AsyncLocalStorage } from 'node:async_hooks';

import { type Logger, pino } from 'pino';

/**
 * Structured JSON logs with pino, one line per event, to stdout.
 *
 * Locally `LOG_PRETTY=true` colours them (pino-pretty); on Workers they go to Workers Logs (free). Request bodies
 * are never logged, and pino `redact` masks secrets in structured fields.
 */
const REDACT = [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    '*.password',
    '*.password_hash',
    '*.access_token',
    '*.refresh_token',
    '*.secret'
];

export function createLogger(opts: { level: string; pretty: boolean; base?: Record<string, unknown> }): Logger {
    return pino({
        level: opts.level,
        base: opts.base ?? null,
        redact: { paths: REDACT, censor: '[redacted]' },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: label => ({ level: label }) },
        ...(opts.pretty
            ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service,env,version' } } }
            : {})
    });
}

let root: Logger = createLogger({ level: process.env['LOG_LEVEL'] ?? 'info', pretty: false });

/** Called once by server.ts with the validated config. */
export function setRootLogger(logger: Logger): void {
    root = logger;
}

export function rootLogger(): Logger {
    return root;
}

interface RequestContext {
    log: Logger;
    requestId: string;
}

const context = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` (the rest of the request) with this request's logger as the ambient one. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
    return context.run(ctx, fn);
}

/**
 * The logger to use anywhere: inside a request it is the request's child logger (every line carries `reqId`),
 * outside one (startup, jobs) the root logger. No logger has to be passed down through repositories.
 */
export function log(): Logger {
    return context.getStore()?.log ?? root;
}
