import * as Sentry from '@sentry/node';

/**
 * Sentry, loaded with `node --import ./src/instrument.ts` BEFORE the app, so its instrumentation hooks Express,
 * pg and http as they are imported. Off unless SENTRY_DSN is set.
 *
 * OMS sec-service had the DSN hard-coded in the source (so every environment, including developer laptops,
 * reported into production's project) and `sendDefaultPii: true` (user IPs, cookies and headers sent to a third
 * party). Here the DSN comes from the environment and collection is explicit. Only 5xx errors are reported: a 404
 * or a validation error is not a bug.
 *
 * Sentry 11 changes to know about: `sendDefaultPii` is gone, replaced by `dataCollection`, whose DEFAULTS collect
 * request headers, cookies and HTTP bodies (a sign-in body holds the password). Bodies, cookies and user info are
 * switched off here. `Sentry.setupExpressErrorHandler` (the v8–v10 way) is deprecated: the Express integration
 * captures errors itself.
 */
const dsn = process.env['SENTRY_DSN'];

if (dsn) {
    Sentry.init({
        dsn,
        environment: process.env['APP_ENV'] ?? 'local',
        release: process.env['APP_VERSION'],
        dataCollection: { userInfo: false, cookies: false, httpBodies: [], httpHeaders: { request: { deny: ['authorization', 'cookie'] }, response: false } },
        tracesSampleRate: Number(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? 0),
        integrations: [
            Sentry.expressIntegration({
                shouldHandleError: (error: { status?: number | string; statusCode?: number | string }) => Number(error.status ?? error.statusCode ?? 500) >= 500
            })
        ]
    });
}
