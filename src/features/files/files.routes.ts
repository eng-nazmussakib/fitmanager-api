import express, { type Request, type Response, Router } from 'express';

import type { Action, Subject } from '#src/auth/ability.ts';
import { isGuest } from '#src/auth/guest.ts';
import { authenticate, currentUser, requireAnyBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

import type { FileKind, FileRow } from './files.repo.ts';
import { fileParams, startSchema, uploadQuery } from './files.schema.ts';
import { completeUpload, deleteFile, type FileDeps, readByViewToken, readFileContent, receiveLocalUpload, startUpload } from './files.service.ts';

/**
 * Who may upload (and complete), read and delete each kind of file, and where: member files and trainer photos at a
 * branch; exercise media at HQ (the HQ library) or a branch (its own exercises); measurement photos at the member's
 * home branch (members upload their own through the portal, portal.routes.ts).
 */
const KIND_RULES: Record<FileKind, { write: [Action, Subject]; read: [Action, Subject]; remove: [Action, Subject]; hq: boolean }> = {
    member_photo: { write: ['create', 'Member'], read: ['read', 'Member'], remove: ['update', 'Member'], hq: false },
    member_document: { write: ['create', 'Member'], read: ['read', 'Member'], remove: ['update', 'Member'], hq: false },
    trainer_photo: { write: ['update', 'Trainer'], read: ['read', 'Trainer'], remove: ['update', 'Trainer'], hq: false },
    exercise_photo: { write: ['create', 'Exercise'], read: ['read', 'Exercise'], remove: ['update', 'Exercise'], hq: true },
    exercise_video: { write: ['create', 'Exercise'], read: ['read', 'Exercise'], remove: ['update', 'Exercise'], hq: true },
    measurement_photo: { write: ['create', 'Measurement'], read: ['read', 'Measurement'], remove: ['update', 'Measurement'], hq: false },
    incident_evidence: { write: ['create', 'Incident'], read: ['read', 'Incident'], remove: ['manage', 'Incident'], hq: false },
    complaint_photo: { write: ['create', 'Complaint'], read: ['read', 'Complaint'], remove: ['update', 'Complaint'], hq: false },
    // Phase 6: product photos at HQ (the catalogue), equipment and ticket photos at a branch.
    product_photo: { write: ['update', 'Product'], read: ['read', 'Product'], remove: ['update', 'Product'], hq: true },
    equipment_photo: { write: ['update', 'Equipment'], read: ['read', 'Equipment'], remove: ['update', 'Equipment'], hq: false },
    ticket_photo: { write: ['create', 'Equipment'], read: ['read', 'Equipment'], remove: ['update', 'Equipment'], hq: false }
};

/**
 * Files (phase 2 step 2; D-058, D-069). Member photos and documents of the branch in `X-Branch-Id`:
 * - `POST /v1/files` → `{ file, upload }`: a pending row and where to PUT the bytes (`create Member`);
 * - `PUT /v1/files/:oid/content?token=`: the local store's stand-in for a signed bucket URL (no session; the
 *   token names the file and expires in 10 minutes);
 * - `POST /v1/files/:oid/complete`: the API checks the stored bytes and marks the file ready (audited);
 * - `GET /v1/files/:oid`: the bytes, after the branch and permission check (`read Member`);
 * - `GET /v1/files/:oid/view?token=`: the same bytes for a signed link (`viewUrl()`), for `<img>` tags;
 * - `DELETE /v1/files/:oid` (`update Member`, audited).
 */
export function filesRouter(deps: AppDeps): Router {
    const router = Router();
    const fileDeps: FileDeps = {
        db: deps.db,
        files: deps.files,
        jwtSecret: deps.config.auth.jwtSecret,
        apiPrefix: deps.config.apiPrefix,
        storageLimitBytes: deps.config.files.storageLimitBytes
    };
    const branch = [authenticate(deps), requireAnyBranch()];
    /** The caller may do `op` with files of `kind` at the branch in `X-Branch-Id`. */
    const may = (req: Request, op: 'write' | 'read' | 'remove') => (kind: FileKind) => {
        const rule = KIND_RULES[kind];
        if (req.auth?.assignment?.branch.kind === 'HQ' && !rule.hq) return false;
        return req.auth?.ability.can(...rule[op]) ?? false;
    };

    router.post('/v1/files', ...branch, async (req, res) => {
        const body = parse(startSchema, req.body);
        if (!may(req, 'write')(body.kind)) throw new AppError(403, 'You do not have permission to do this');
        // A guest's upload is kept 7 days only (D-077).
        ok(
            res,
            await startUpload(fileDeps, branchContext(req), body, isGuest(deps.config, currentUser(req).username)),
            'Upload the file to the URL given',
            201
        );
    });

    router.put('/v1/files/:oid/content', express.raw({ type: () => true, limit: '9mb' }), async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        const { token } = parse(uploadQuery, req.query);
        const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
        await receiveLocalUpload(fileDeps, oid, token, body, req.get('content-type') ?? 'application/octet-stream');
        ok(res, null, 'Uploaded');
    });

    router.post('/v1/files/:oid/complete', ...branch, async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        ok(res, await completeUpload(fileDeps, branchContext(req), oid, may(req, 'write')), 'File saved');
    });

    const send = (res: Response, file: FileRow, body: Uint8Array, maxAge: number) => {
        // `nosniff` + the type we checked: the browser never guesses the bytes into something executable.
        res.set({
            'Content-Type': file.content_type,
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            'Cache-Control': `private, max-age=${maxAge}`,
            'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
            // The signed link carries its own permission; never send it on to another site.
            'Referrer-Policy': 'no-referrer'
        });
        res.end(Buffer.from(body));
    };

    router.get('/v1/files/:oid', ...branch, async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        const { file, body } = await readFileContent(fileDeps, branchContext(req), oid, may(req, 'read'));
        send(res, file, body, 300);
    });

    // `<img src>` and "open in a new tab": the token from `viewUrl()` is the permission (1 hour).
    router.get('/v1/files/:oid/view', async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        const { token } = parse(uploadQuery, req.query);
        const { file, body } = await readByViewToken(fileDeps, oid, token);
        send(res, file, body, 3000);
    });

    router.delete('/v1/files/:oid', ...branch, async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        await deleteFile(fileDeps, branchContext(req), oid, may(req, 'remove'));
        ok(res, null, 'File deleted');
    });

    return router;
}
