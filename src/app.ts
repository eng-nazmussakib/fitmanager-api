import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import type { AppDeps } from './container.ts';
import { authRouter } from './features/auth/auth.routes.ts';
import { ddlRouter } from './features/ddl/ddl.routes.ts';
import { filesRouter } from './features/files/files.routes.ts';
import { healthRouter } from './features/health/health.routes.ts';
import { itemsRouter } from './features/items/items.routes.ts';
import { mailRouter } from './features/mail/mail.routes.ts';
import { otpRouter } from './features/otp/otp.routes.ts';
import { siteRouter } from './features/site/site.routes.ts';
import { errorHandler, notFound } from './lib/errors.ts';
import { rootLogger, runWithRequestContext } from './lib/logger.ts';
import { createMetrics } from './lib/metrics.ts';

const REQUEST_ID = /^[\w-]{8,64}$/;

/** Builds the Express app from its dependencies. No listening, no globals: tests call this directly. */
export function createApp(deps: AppDeps): Express {
    const { config } = deps;
    const app = express();
    const metrics = createMetrics();

    // Behind nginx: take the client IP from X-Forwarded-For, but only from that many trusted hops.
    app.set('trust proxy', config.trustProxy);

    // Security headers (the hapi services set none). The API serves JSON and files, so the defaults fit.
    app.use(helmet());
    // `origin: ['*']` in every hapi service let any website call the API with a user's token. Now an allow-list;
    // empty means no CORS headers at all (the frontends reach the API same-origin through nginx or the dev proxy).
    app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false, exposedHeaders: ['Content-Disposition', 'X-Request-Id'], maxAge: 600 }));

    app.use(
        pinoHttp({
            logger: rootLogger(),
            // Honour an id from nginx (`proxy_set_header X-Request-Id $request_id`) so one id follows the request
            // through every hop; validated, so a client cannot inject text into the logs.
            genReqId: (req, res) => {
                const incoming = req.headers['x-request-id'];
                const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
                res.setHeader('X-Request-Id', id);
                return id;
            },
            customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
            autoLogging: { ignore: req => req.url.startsWith('/health') || req.url === '/metrics' },
            // Method, URL, status and time; no headers, no bodies (passwords, tokens, personal data).
            serializers: {
                req: (req: { id: unknown; method: unknown; url: unknown }) => ({ id: req.id, method: req.method, url: req.url }),
                res: (res: { statusCode: unknown }) => ({ statusCode: res.statusCode })
            }
        })
    );
    app.use((req, _res, next) => {
        runWithRequestContext({ log: req.log, requestId: req.id as string }, next); // genReqId above returns strings
    });
    app.use(metrics.middleware);

    app.use(healthRouter(deps));
    app.get('/metrics', metrics.handler);

    app.use(express.json({ limit: '1mb' }));

    const api = express.Router();
    // API answers carry personal data: no browser or proxy cache may keep them (files set their own header).
    api.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    api.use(authRouter(deps));
    api.use(ddlRouter(deps));
    api.use(itemsRouter(deps));
    api.use(filesRouter(deps));
    api.use(mailRouter(deps));
    api.use(otpRouter(deps));
    api.use(siteRouter(deps));
    app.use(config.apiPrefix, api);

    app.use(notFound);
    app.use(errorHandler);
    return app;
}
