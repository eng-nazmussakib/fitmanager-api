import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';

import { AppError, type FieldError } from './http.ts';

/**
 * The only place that turns errors into responses. Express 5 forwards a rejected promise from an async handler
 * here by itself, so routes just `throw`; no try/catch + `generate_error_response()` in every handler (the hapi
 * services wrapped each one, and logged and swallowed the cause).
 *
 * 4xx: the message is meant for the user and is sent. 5xx: logged with the stack and request id, and the user
 * gets a generic message: SQL errors and stack traces never reach the browser.
 */
export const notFound: RequestHandler = req => {
    throw new AppError(404, `No route for ${req.method} ${req.path}`);
};

export function statusOf(err: unknown): number {
    if (err instanceof AppError) return err.status;
    if (err instanceof multer.MulterError) return err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    // body-parser, send (res.sendFile) and other http-errors carry their status.
    const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status ?? (err as { statusCode?: unknown } | null)?.statusCode;
    return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

function publicMessage(err: unknown, status: number): string {
    if (status >= 500) return 'Something went wrong. Please try again.';
    if (err instanceof AppError) return err.message;
    if (err instanceof multer.MulterError) return err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : 'Invalid upload';
    const e = err as { type?: unknown; expose?: unknown; message?: unknown };
    if (e.type === 'entity.parse.failed') return 'The request body is not valid JSON';
    if (e.type === 'entity.too.large') return 'The request body is too large';
    if (status === 404) return 'Not found';
    return e.expose === true && typeof e.message === 'string' ? e.message : 'Bad request';
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
    const status = statusOf(err);
    const logger = req.log;
    if (status >= 500) logger.error({ err }, 'Request failed');
    else logger.debug({ status, msg: (err as Error).message }, 'Request rejected');

    // The response already started (a stream broke mid-way): let Express close the connection.
    if (res.headersSent) {
        next(err);
        return;
    }
    const errors: FieldError[] | undefined = err instanceof AppError ? err.errors : undefined;
    if (status === 429) res.set('Retry-After', '60');
    res.status(status).json({ code: status, message: publicMessage(err, status), data: null, ...(errors ? { errors } : {}) });
};
