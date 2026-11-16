import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Router } from 'express';
import { fileTypeFromBuffer } from 'file-type';
import multer from 'multer';

import { authenticate } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { AppError, ok } from '#src/lib/http.ts';
import { log } from '#src/lib/logger.ts';

/** What may be uploaded, decided by the file's CONTENT (magic bytes), not by its name or the browser's claim. */
const ALLOWED = new Map([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['application/pdf', 'pdf']
]);
const STORED_NAME = /^[0-9a-f-]{36}\.(jpg|png|pdf)$/;

/**
 * Upload and download. Fixes of the SPN/ACAS upload route:
 * - The type was checked by file EXTENSION only (`evil.html` renamed to `.png` passed) → file-type reads the
 *   first bytes, and the stored extension comes from what the content really is.
 * - `file_data.pipe(fs.createWriteStream(...))` was never awaited, so "Successfully uploaded" was sent before
 *   the file was written, and a write error was lost → the file is written (and awaited) before answering.
 * - Errors answered HTTP 200 with codes 201/202/203 in the body → 400, 413 and 415.
 * - `fs.mkdirSync(dir)` per request, failing on nested folders → one recursive mkdir.
 * Names are random UUIDs; the original name is never used as a path. Download validates the name against the
 * same pattern and serves it with `root`, so `../` cannot leave the upload folder.
 * For many large files, stream to object storage (S3/MinIO) instead of memory + local disk.
 */
export function filesRouter(deps: AppDeps): Router {
    const { config } = deps;
    const dir = resolve(config.upload.dir);
    const router = Router();
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.upload.maxBytes, files: 1, fields: 10 } });

    router.post('/v1/files/upload', authenticate(deps), upload.single('file'), async (req, res) => {
        const file = req.file;
        if (!file) throw new AppError(400, 'No file received', [{ path: 'file', message: 'Required' }]);
        const type = await fileTypeFromBuffer(file.buffer);
        const ext = type && ALLOWED.get(type.mime);
        if (!ext) throw new AppError(415, 'Only JPG, PNG or PDF files are allowed');

        const fileName = `${randomUUID()}.${ext}`;
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, fileName), file.buffer, { flag: 'wx' });
        log().info({ fileName, bytes: file.size, mime: type.mime }, 'File uploaded');
        ok(res, { file_name: fileName, url: `${config.apiPrefix}/v1/files/${fileName}` }, 'File uploaded', 201);
    });

    router.get('/v1/files/:name', authenticate(deps), (req, res) => {
        const name = String(req.params['name'] ?? '');
        if (!STORED_NAME.test(name)) throw new AppError(404, 'File not found');
        // `nosniff` + an explicit type: the browser never guesses the content into something executable.
        res.sendFile(name, { root: dir, dotfiles: 'deny', headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' } });
    });

    return router;
}
