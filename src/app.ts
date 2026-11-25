import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { trainingRouter } from '#src/features/training/training.routes.ts';

import type { AppDeps } from './container.ts';
import { attendanceRouter } from './features/attendance/attendance.routes.ts';
import { auditRouter } from './features/audit/audit.routes.ts';
import { authRouter } from './features/auth/auth.routes.ts';
import { branchesRouter } from './features/branches/branches.routes.ts';
import { catalogueRouter } from './features/catalogue/catalogue.routes.ts';
import { dashboardRouter } from './features/dashboard/dashboard.routes.ts';
import { ddlRouter } from './features/ddl/ddl.routes.ts';
import { disciplineRouter } from './features/discipline/discipline.routes.ts';
import { equipmentRouter } from './features/equipment/equipment.routes.ts';
import { exportsRouter } from './features/exports/exports.routes.ts';
import { feedbackRouter } from './features/feedback/feedback.routes.ts';
import { filesRouter } from './features/files/files.routes.ts';
import { healthRouter } from './features/health/health.routes.ts';
import { joinRouter } from './features/join/join.routes.ts';
import { membersRouter } from './features/members/members.routes.ts';
import { notificationsRouter } from './features/notifications/notifications.routes.ts';
import { plansRouter } from './features/plans/plans.routes.ts';
import { policiesRouter } from './features/policies/policies.routes.ts';
import { portalRouter } from './features/portal/portal.routes.ts';
import { posRouter } from './features/pos/pos.routes.ts';
import { reconciliationRouter } from './features/reconciliation/reconciliation.routes.ts';
import { reportsRouter } from './features/reports/reports.routes.ts';
import { salesRouter } from './features/sales/sales.routes.ts';
import { schedulingRouter } from './features/scheduling/scheduling.routes.ts';
import { settingsRouter } from './features/settings/settings.routes.ts';
import { siteRouter } from './features/site/site.routes.ts';
import { staffRouter } from './features/staff/staff.routes.ts';
import { stockRouter } from './features/stock/stock.routes.ts';
import { websiteRouter } from './features/website/website.routes.ts';
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
    api.use(schedulingRouter(deps));
    api.use(trainingRouter(deps));
    api.use(policiesRouter(deps));
    api.use(disciplineRouter(deps));
    api.use(feedbackRouter(deps));
    api.use(equipmentRouter(deps));
    api.use(catalogueRouter(deps));
    api.use(stockRouter(deps));
    api.use(posRouter(deps));
    api.use(joinRouter(deps));
    api.use(dashboardRouter(deps));
    api.use(reconciliationRouter(deps));
    api.use(reportsRouter(deps));
    api.use(exportsRouter(deps));
    api.use(notificationsRouter(deps));
    api.use(websiteRouter(deps));
    api.use(auditRouter(deps));
    api.use(staffRouter(deps));
    app.use(config.apiPrefix, api);

    app.use(notFound);
    app.use(errorHandler);
    return app;
}
