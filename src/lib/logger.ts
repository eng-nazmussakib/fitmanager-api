import { AsyncLocalStorage } from 'node:async_hooks';

import { type Logger, pino } from 'pino';

/**
 * Structured JSON logs with pino, one line per event, to stdout.
 *
 * Replaces the winston + winston-daily-rotate-file setup copied into every hapi service:
 * - Files rotated INSIDE the container (`log/info/..`, bind-mounted) → stdout. Docker keeps it, and the ACAS
 *   promtail config already ships container stdout to Loki (`docker_sd_configs`); rotation is the log driver's job.
 * - `format.colorize({ all: true })` applied to the FILE transports wrote ANSI escape codes into the logs → colour
 *   only in development (`LOG_PRETTY=true`, pino-pretty).
 * - The trace id kept with `asyncLocalStorage.enterWith()` in an `onRequest` hook (it leaks into whatever runs
 *   next on that async path) → pino-http's request id, kept with `AsyncLocalStorage.run()` for exactly one request.
 * - A regex that masked `password|token|secret` only in a JSON object at the END of a message string, so
 *   `log.debug('Request received - ' + JSON.stringify(payload))` still logged nested passwords → pino `redact`
 *   on structured fields, and request bodies are never logged.
 * - `new Error().stack` parsing on EVERY log call to print file:line → removed (expensive, and the stack of a
 *   logged `err` already says where it happened).
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
