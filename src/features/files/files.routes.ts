import express, { type Response, Router } from 'express';

import { authenticate, requireAbility, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { ok, parse } from '#src/lib/http.ts';

import type { FileRow } from './files.repo.ts';
import { fileParams, startSchema, uploadQuery } from './files.schema.ts';
import { completeUpload, deleteFile, type FileDeps, readByViewToken, readFileContent, receiveLocalUpload, startUpload } from './files.service.ts';

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
    const branch = [authenticate(deps), requireBranch('BRANCH')];

    router.post('/v1/files', ...branch, requireAbility('create', 'Member'), async (req, res) => {
        const body = parse(startSchema, req.body);
        ok(res, await startUpload(fileDeps, branchContext(req), body), 'Upload the file to the URL given', 201);
    });

    router.put('/v1/files/:oid/content', express.raw({ type: () => true, limit: '6mb' }), async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        const { token } = parse(uploadQuery, req.query);
        const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
        await receiveLocalUpload(fileDeps, oid, token, body, req.get('content-type') ?? 'application/octet-stream');
        ok(res, null, 'Uploaded');
    });

    router.post('/v1/files/:oid/complete', ...branch, requireAbility('create', 'Member'), async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        ok(res, await completeUpload(fileDeps, branchContext(req), oid), 'File saved');
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

    router.get('/v1/files/:oid', ...branch, requireAbility('read', 'Member'), async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        const { file, body } = await readFileContent(fileDeps, branchContext(req), oid);
        send(res, file, body, 300);
    });

    // `<img src>` and "open in a new tab": the token from `viewUrl()` is the permission (1 hour).
    router.get('/v1/files/:oid/view', async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        const { token } = parse(uploadQuery, req.query);
        const { file, body } = await readByViewToken(fileDeps, oid, token);
        send(res, file, body, 3000);
    });

    router.delete('/v1/files/:oid', ...branch, requireAbility('update', 'Member'), async (req, res) => {
        const { oid } = parse(fileParams, req.params);
        await deleteFile(fileDeps, branchContext(req), oid);
        ok(res, null, 'File deleted');
    });

    return router;
}
