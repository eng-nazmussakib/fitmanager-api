import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import type { AppDeps } from './container.ts';
import { attendanceRouter } from './features/attendance/attendance.routes.ts';
import { auditRouter } from './features/audit/audit.routes.ts';
import { authRouter } from './features/auth/auth.routes.ts';
import { branchesRouter } from './features/branches/branches.routes.ts';
import { dashboardRouter } from './features/dashboard/dashboard.routes.ts';
import { ddlRouter } from './features/ddl/ddl.routes.ts';
import { filesRouter } from './features/files/files.routes.ts';
import { healthRouter } from './features/health/health.routes.ts';
import { joinRouter } from './features/join/join.routes.ts';
import { membersRouter } from './features/members/members.routes.ts';
import { plansRouter } from './features/plans/plans.routes.ts';
import { portalRouter } from './features/portal/portal.routes.ts';
import { reconciliationRouter } from './features/reconciliation/reconciliation.routes.ts';
import { salesRouter } from './features/sales/sales.routes.ts';
import { settingsRouter } from './features/settings/settings.routes.ts';
import { siteRouter } from './features/site/site.routes.ts';
import { staffRouter } from './features/staff/staff.routes.ts';
import { errorHandler, notFound } from './lib/errors.ts';
import { rootLogger, runWithRequestContext } from './lib/logger.ts';

const REQUEST_ID = /^[\w-]{8,64}$/;

/** Builds the Express app from its dependencies. No listening, no globals: tests call this directly. */
export function createApp(deps: AppDeps): Express {
    const { config } = deps;
    const app = express();

    // Behind the Worker shim: take the client IP from X-Forwarded-For, but only from that many trusted hops.
    app.set('trust proxy', config.trustProxy);

    // Security headers. The API serves JSON and files, so the defaults fit.
    app.use(helmet());
    // An allow-list; empty means no CORS headers at all (the web app reaches the API same-origin, through the web
    // Worker's service binding or the dev proxy).
    app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false, exposedHeaders: ['Content-Disposition', 'X-Request-Id'], maxAge: 600 }));

    app.use(
        pinoHttp({
            logger: rootLogger(),
            // Honour an incoming X-Request-Id so one id follows the request through every hop; validated, so a
            // client cannot inject text into the logs.
            genReqId: (req, res) => {
                const incoming = req.headers['x-request-id'];
                const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
                res.setHeader('X-Request-Id', id);
                return id;
            },
            customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
            autoLogging: { ignore: req => req.url.startsWith('/health') },
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

    app.use(healthRouter(deps));

    app.use(express.json({ limit: '1mb' }));

    const api = express.Router();
    // API answers carry personal data: no browser or proxy cache may keep them (files set their own header).
    api.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    api.use(authRouter(deps));
    api.use(ddlRouter(deps));
    api.use(filesRouter(deps));
    api.use(siteRouter(deps));
    api.use(settingsRouter(deps));
    api.use(branchesRouter(deps));
    api.use(plansRouter(deps));
    api.use(membersRouter(deps));
    api.use(salesRouter(deps));
    api.use(attendanceRouter(deps));
    api.use(portalRouter(deps));
    api.use(joinRouter(deps));
    api.use(dashboardRouter(deps));
    api.use(reconciliationRouter(deps));
    api.use(auditRouter(deps));
    api.use(staffRouter(deps));
    app.use(config.apiPrefix, api);

    app.use(notFound);
    app.use(errorHandler);
    return app;
}
