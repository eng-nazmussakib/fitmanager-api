import type { Response } from 'express';
import * as v from 'valibot';

/**
 * The response envelope the web app parses: `{ code, message, data }`. `code` always EQUALS the HTTP status, so
 * a failure is never sent as a 2xx. The web app treats `!res.ok || code >= 400` as an error.
 */
export interface FieldError {
    path: string;
    message: string;
}

export class AppError extends Error {
    readonly status: number;
    readonly errors: FieldError[] | undefined;

    constructor(status: number, message: string, errors?: FieldError[]) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.errors = errors;
    }
}

export function ok(res: Response, data: unknown, message = 'Success', status = 200): void {
    res.status(status).json({ code: status, message, data: data ?? null });
}

/**
 * Validates request input against a Valibot schema and returns the typed, transformed value; 400 with one entry per
 * invalid field otherwise. Called inside the handler (`const body = parse(schema, req.body)`) rather than as a
 * middleware: Express 5 made `req.query` a read-only getter, and the result is typed without casts.
 */
export function parse<S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> {
    const result = v.safeParse(schema, input);
    if (result.success) return result.output;
    const errors = result.issues.map(i => ({ path: v.getDotPath(i) ?? '', message: i.message }));
    const [first] = errors;
    throw new AppError(400, errors.length === 1 && first ? `${first.path || 'input'}: ${first.message}` : 'Validation failed', errors);
}

/** RFC 6266 Content-Disposition with a UTF-8 file name (non-ASCII names survive), plus an ASCII fallback. */
export function attachment(fileName: string): string {
    const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
