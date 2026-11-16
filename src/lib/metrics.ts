import type { Request, RequestHandler } from 'express';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics at GET /metrics. The ACAS/UMP observability stack (Prometheus + Grafana + Loki) only scrapes
 * node_exporter and cAdvisor, so it sees CPU and memory but nothing from inside the apps: no request rate, latency
 * or error rate per route, no event-loop lag, no heap. This adds them; add the app to prometheus.yml.
 *
 * (hapijs-status-monitor, in most services, served an HTML page of the same numbers, unauthenticated, that no
 * monitoring system could scrape.)
 *
 * /metrics sits outside API_PREFIX: nginx forwards only /api, so it is reachable from the internal network only.
 */
export interface Metrics {
    middleware: RequestHandler;
    handler: RequestHandler;
}

export function createMetrics(): Metrics {
    // A registry per app (not the global one): tests create several apps in one process.
    const registry = new Registry();
    collectDefaultMetrics({ register: registry });
    const duration = new Histogram({
        name: 'http_request_duration_seconds',
        help: 'HTTP request duration by route template',
        labelNames: ['method', 'route', 'status_code'],
        buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [registry]
    });

    return {
        middleware: (req, res, next) => {
            const end = duration.startTimer();
            res.on('finish', () => end({ method: req.method, route: routeLabel(req), status_code: res.statusCode }));
            next();
        },
        handler: async (_req, res) => {
            res.type(registry.contentType).send(await registry.metrics());
        }
    };
}

/** The route TEMPLATE (`/api/v1/items/:oid`), never the raw URL: one time series per route, not per item id. */
function routeLabel(req: Request): string {
    const path = (req.route as { path?: unknown } | undefined)?.path;
    return typeof path === 'string' ? req.baseUrl + path : 'unmatched';
}
