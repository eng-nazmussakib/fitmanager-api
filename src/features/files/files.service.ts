import { fileTypeFromBuffer } from 'file-type';
import { jwtVerify, SignJWT } from 'jose';

import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import type { FileStore, UploadTarget } from '#src/lib/file-store.ts';
import { UPLOAD_URL_SECONDS } from '#src/lib/file-store.ts';
import { AppError } from '#src/lib/http.ts';
import { log } from '#src/lib/logger.ts';

import { type FileKind, type FileRow, filesRepo, GUEST_KEY_PREFIX } from './files.repo.ts';

/**
 * Member photos and documents (phase 2 step 2; D-058, D-069). The upload is two calls around the browser's PUT:
 * 1. `start`: a `pending` row and a short-lived signed URL (the bucket's, or the API's own route for the local
 *    store);
 * 2. the browser PUTs the bytes there;
 * 3. `complete`: the API reads the stored object back, checks its REAL type (magic bytes, not the name or the
 *    browser's claim) and size, and marks it `ready`, or deletes it and refuses.
 * Only `ready` files are served or attached to a member.
 */
export const FILE_RULES: Record<FileKind, { types: readonly string[]; maxBytes: number; perMember: number; label: string }> = {
    member_photo: {
        types: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 2 * 1024 * 1024,
        perMember: 1,
        label: 'A photo is a JPEG, PNG or WebP of at most 2 MB'
    },
    member_document: {
        types: ['application/pdf', 'image/jpeg', 'image/png'],
        maxBytes: 5 * 1024 * 1024,
        perMember: 10,
        label: 'A document is a PDF, JPEG or PNG of at most 5 MB'
    },
    trainer_photo: {
        types: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 2 * 1024 * 1024,
        perMember: 0,
        label: 'A photo is a JPEG, PNG or WebP of at most 2 MB'
    },
    // Small, on purpose (D-085): resized in the browser to 800 px.
    exercise_photo: {
        types: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 300 * 1024,
        perMember: 0,
        label: 'An exercise photo is a JPEG, PNG or WebP of at most 300 KB'
    },
    // At most 10 seconds, checked in the browser (D-085).
    exercise_video: {
        types: ['video/mp4', 'video/webm'],
        maxBytes: 8 * 1024 * 1024,
        perMember: 0,
        label: 'An exercise video is an MP4 or WebM of at most 8 MB'
    },
    measurement_photo: {
        types: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 300 * 1024,
        perMember: 0,
        label: 'A progress photo is a JPEG, PNG or WebP of at most 300 KB'
    },
    // Phase 5 (D-094): photos resized in the browser like other photos, or a PDF (a written statement). No video.
    incident_evidence: {
        types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
        maxBytes: 2 * 1024 * 1024,
        perMember: 0,
        label: 'Evidence is a photo (JPEG, PNG or WebP) or a PDF of at most 2 MB'
    },
    // Phase 5 (D-095): one photo on a complaint, resized in the browser.
    complaint_photo: {
        types: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 300 * 1024,
        perMember: 0,
        label: 'A complaint photo is a JPEG, PNG or WebP of at most 300 KB'
    },
    // Phase 6 (D-098, D-099): resized in the browser to 800 px, like exercise photos. Product photos are HQ's.
    product_photo: {
        types: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 300 * 1024,
        perMember: 0,
        label: 'A product photo is a JPEG, PNG or WebP of at most 300 KB'
    },
    equipment_photo: {
        types: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 300 * 1024,
        perMember: 0,
        label: 'An equipment photo is a JPEG, PNG or WebP of at most 300 KB'
    },
    ticket_photo: {
        types: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 300 * 1024,
        perMember: 0,
        label: 'A ticket photo is a JPEG, PNG or WebP of at most 300 KB'
    },
    // Phase 7c (D-109): website images (post covers, gallery and branch photos), shrunk in the browser, public.
    site_image: {
        types: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 500 * 1024,
        perMember: 0,
        label: 'A website image is a JPEG, PNG or WebP of at most 500 KB'
    }
};

/** The largest file of any kind: the local store's upload route refuses more. */
const MAX_FILE_BYTES = Math.max(...Object.values(FILE_RULES).map(r => r.maxBytes));

/** Bytes file-type needs to recognise every allowed type. */
const SNIFF_BYTES = 4100;
const UPLOAD_AUDIENCE = 'fitmanager-file-upload';
const VIEW_AUDIENCE = 'fitmanager-file-view';
/** How long a photo or document link handed to the browser works. */
export const VIEW_URL_SECONDS = 3600;

export interface FileDeps {
    db: Db;
    files: FileStore;
    jwtSecret: string;
    apiPrefix: string;
    /** The total for every branch together (`FILE_STORAGE_LIMIT_MB`, D-074). Left out: no total limit. */
    storageLimitBytes?: number;
}

const MB = 1024 * 1024;
/** Above this share of the limit, each upload logs a warning, so the owner hears before uploads stop. */
const STORAGE_WARN_SHARE = 0.8;

/** Refuses (409) when `adding` more bytes would pass the limit; warns past 80 %. Call inside the branch transaction. */
async function checkStorage(deps: FileDeps, tx: Queryable, ctx: BranchContext, adding: number, exceptOid: string | null = null): Promise<string | null> {
    const limit = deps.storageLimitBytes;
    if (limit === undefined) return null;
    const used = await filesRepo.storageUsed(tx, ctx.branchOids, exceptOid);
    if (used + adding > limit) {
        log().warn({ used_mb: Math.round(used / MB), limit_mb: Math.round(limit / MB) }, 'file storage limit reached: upload refused');
        return `File storage is full (${Math.round(used / MB)} of ${Math.round(limit / MB)} MB used). Delete old documents, or ask the owner to raise the limit.`;
    }
    if (used + adding > limit * STORAGE_WARN_SHARE) {
        log().warn({ used_mb: Math.round((used + adding) / MB), limit_mb: Math.round(limit / MB) }, 'file storage above 80% of its limit');
    }
    return null;
}

const secretOf = (deps: Pick<FileDeps, 'jwtSecret'>) => new TextEncoder().encode(`upload:${deps.jwtSecret}`);

/**
 * The key never comes from the client: `<branch>/<file oid>`, or `guest/<branch>/<file oid>` for an upload from a
 * guest session (D-077), which the bucket deletes after 7 days.
 */
const storageKey = (branchOid: string, oid: string, guest: boolean) => `${guest ? GUEST_KEY_PREFIX : ''}${branchOid}/${oid}`;

export interface StartInput {
    kind: FileKind;
    name: string;
    content_type: string;
    size: number;
    member_oid?: string | null | undefined;
}

export async function startUpload(deps: FileDeps, ctx: BranchContext, input: StartInput, guest = false): Promise<{ file: FileRow; upload: UploadTarget }> {
    const rule = FILE_RULES[input.kind];
    if (!rule.types.includes(input.content_type)) throw new AppError(415, rule.label, [{ path: 'content_type', message: rule.label }]);
    if (input.size > rule.maxBytes) throw new AppError(413, rule.label, [{ path: 'size', message: rule.label }]);
    if (!ctx.actor) throw new AppError(401, 'Please sign in');
    const actor = ctx.actor.oid;
    const oid = crypto.randomUUID();
    const key = storageKey(ctx.branchOid, oid, guest);
    const file = await withBranchTx(deps.db, ctx, async tx => {
        if (input.member_oid && input.kind === 'member_document' && (await filesRepo.countReady(tx, input.member_oid, input.kind)) >= rule.perMember) {
            throw new AppError(409, `A member has at most ${rule.perMember} documents. Delete one first.`);
        }
        const full = await checkStorage(deps, tx, ctx, input.size);
        if (full) throw new AppError(409, full);
        await filesRepo.create(
            tx,
            {
                oid,
                branch_oid: ctx.branchOid,
                member_oid: input.member_oid ?? null,
                kind: input.kind,
                storage_key: key,
                name: input.name,
                content_type: input.content_type,
                size_bytes: input.size
            },
            actor
        );
        const row = await filesRepo.get(tx, oid, [ctx.branchOid]);
        if (!row) throw new Error('File row missing inside its own transaction');
        return row;
    });
    const token = await new SignJWT({ key })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(oid)
        .setAudience(UPLOAD_AUDIENCE)
        .setExpirationTime(`${UPLOAD_URL_SECONDS}s`)
        .sign(secretOf(deps));
    const upload = await deps.files.uploadTarget(key, input.content_type, `${deps.apiPrefix}/v1/files/${oid}/content?token=${token}`);
    const { storage_key: _key, ...shown } = file;
    return { file: shown, upload };
}

/** The local store's upload route: the token says which file, so no session is needed (like a signed URL). */
export async function receiveLocalUpload(deps: FileDeps, oid: string, token: string, body: Uint8Array, contentType: string): Promise<void> {
    if (deps.files.kind !== 'local') throw new AppError(404, 'Not found');
    let key: string;
    try {
        const { payload } = await jwtVerify(token, secretOf(deps), { audience: UPLOAD_AUDIENCE, algorithms: ['HS256'] });
        if (payload.sub !== oid || typeof payload['key'] !== 'string') throw new Error('mismatch');
        key = payload['key'];
    } catch {
        throw new AppError(403, 'This upload link is not valid or has expired');
    }
    if (body.byteLength > MAX_FILE_BYTES) throw new AppError(413, 'The file is too large');
    await deps.files.write(key, body, contentType);
}

type Completion = { ok: true; file: FileRow } | { ok: false; status: 409 | 413 | 415; message: string };

/** The caller's permission for a kind of file (files.routes.ts): checked once the row says which kind it is. */
export type KindCheck = (kind: FileKind, file: FileRow) => boolean;
const anyKind: KindCheck = () => true;

export async function completeUpload(deps: FileDeps, ctx: BranchContext, oid: string, allowed: KindCheck = anyKind): Promise<FileRow> {
    const result = await withBranchTx(deps.db, ctx, async (tx): Promise<Completion> => {
        const row = await filesRepo.get(tx, oid, [ctx.branchOid], true);
        if (!row) throw new AppError(404, 'File not found');
        if (!allowed(row.kind, row)) throw new AppError(403, 'You do not have permission to do this');
        const { storage_key: key, ...shown } = row;
        if (row.status === 'ready') return { ok: true, file: shown };
        if (row.status !== 'pending') throw new AppError(409, 'This upload was refused or deleted. Start again.');
        const rule = FILE_RULES[row.kind];
        const stored = await deps.files.head(key);
        if (!stored || stored.size === 0) throw new AppError(409, 'The file has not arrived yet. Upload it, then try again.');
        const head = await deps.files.read(key, SNIFF_BYTES);
        const sniffed = head ? await fileTypeFromBuffer(head) : undefined;
        const refused = stored.size > rule.maxBytes ? 413 : !sniffed || !rule.types.includes(sniffed.mime) ? 415 : null;
        // The real size, not the declared one, against the limit (this file's own reservation left out).
        const full = refused ? null : await checkStorage(deps, tx, ctx, stored.size, oid);
        if (refused || full) {
            // Kept as `rejected` (the transaction commits); the error is thrown after it.
            await deps.files.delete(key);
            await filesRepo.setStatus(tx, oid, 'rejected', { size_bytes: stored.size });
            return { ok: false, status: refused ?? 409, message: full ?? rule.label };
        }
        const contentType = sniffed?.mime ?? row.content_type;
        await filesRepo.setStatus(tx, oid, 'ready', { size_bytes: stored.size, content_type: contentType });
        const after: FileRow = { ...shown, status: 'ready', size_bytes: stored.size, content_type: contentType };
        await recordAudit(tx, ctx, { action: 'create', entity: 'file', entityKey: oid, before: null, after });
        return { ok: true, file: after };
    });
    if (!result.ok) throw new AppError(result.status, result.message);
    return result.file;
}

/**
 * A link an `<img>` or a new tab can open without the bearer token. Issued only by code that has already
 * checked the caller may see the file (the member's profile, a check-in row): holding it is the permission.
 * The token names the file and its branch, so serving it needs no session.
 */
export async function viewUrl(deps: Pick<FileDeps, 'jwtSecret' | 'apiPrefix'>, file: { oid: string; branch_oid: string }): Promise<string> {
    const token = await new SignJWT({ br: file.branch_oid })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(file.oid)
        .setAudience(VIEW_AUDIENCE)
        .setExpirationTime(`${VIEW_URL_SECONDS}s`)
        .sign(secretOf(deps));
    return `${deps.apiPrefix}/v1/files/${file.oid}/view?token=${token}`;
}

export async function readByViewToken(deps: FileDeps, oid: string, token: string): Promise<{ file: FileRow; body: Uint8Array }> {
    let branchOid: string;
    try {
        const { payload } = await jwtVerify(token, secretOf(deps), { audience: VIEW_AUDIENCE, algorithms: ['HS256'] });
        if (payload.sub !== oid || typeof payload['br'] !== 'string') throw new Error('mismatch');
        branchOid = payload['br'];
    } catch {
        throw new AppError(403, 'This link is not valid or has expired');
    }
    const row = await withBranchTx(deps.db, systemContext(branchOid), tx => filesRepo.get(tx, oid, [branchOid]));
    if (row?.status !== 'ready') throw new AppError(404, 'File not found');
    const body = await deps.files.read(row.storage_key);
    if (!body) throw new AppError(404, 'File not found');
    const { storage_key: _key, ...file } = row;
    return { file, body };
}

/**
 * A website image (`site_image`, D-109) for the public site: anyone may read a ready one, at a stable URL
 * (`/v1/public/images/:oid`), so prerendered pages can point at it. Every other kind stays private.
 */
export async function readSiteImage(deps: FileDeps, oid: string): Promise<{ file: FileRow; body: Uint8Array }> {
    const all = (await deps.db.query<{ oid: string }>(sql`select oid from branch`)).map(b => b.oid);
    const first = all[0];
    if (!first) throw new AppError(404, 'File not found');
    const row = await withBranchTx(deps.db, systemContext(first, all), tx => filesRepo.get(tx, oid, all));
    if (row?.status !== 'ready' || row.kind !== 'site_image') throw new AppError(404, 'File not found');
    const body = await deps.files.read(row.storage_key);
    if (!body) throw new AppError(404, 'File not found');
    const { storage_key: _key, ...file } = row;
    return { file, body };
}

/** A ready file of the branch, with its bytes (at most 5 MB, so read whole). */
export async function readFileContent(
    deps: FileDeps,
    ctx: BranchContext,
    oid: string,
    allowed: KindCheck = anyKind
): Promise<{ file: FileRow; body: Uint8Array }> {
    const row = await withBranchTx(deps.db, ctx, tx => filesRepo.get(tx, oid, ctx.branchOids));
    if (row?.status !== 'ready') throw new AppError(404, 'File not found');
    if (!allowed(row.kind, row)) throw new AppError(403, 'You do not have permission to do this');
    const body = await deps.files.read(row.storage_key);
    if (!body) throw new AppError(404, 'File not found');
    const { storage_key: _key, ...file } = row;
    return { file, body };
}

export async function deleteFile(deps: FileDeps, ctx: BranchContext, oid: string, allowed: KindCheck = anyKind): Promise<void> {
    const key = await withBranchTx(deps.db, ctx, async tx => {
        const row = await filesRepo.get(tx, oid, [ctx.branchOid], true);
        if (!row || row.status === 'deleted') throw new AppError(404, 'File not found');
        if (!allowed(row.kind, row)) throw new AppError(403, 'You do not have permission to do this');
        await filesRepo.setStatus(tx, oid, 'deleted', { actor: ctx.actor?.oid });
        const { storage_key: storageKeyOf, ...before } = row;
        await recordAudit(tx, ctx, { action: 'delete', entity: 'file', entityKey: oid, before, after: null });
        return storageKeyOf;
    });
    // After the commit: a failed delete leaves an orphan object, never a row pointing at nothing.
    await deps.files.delete(key);
}

/**
 * For other features (members): check that a ready file of this kind belongs to the branch and is free or
 * already this member's, then link it. Runs in the caller's transaction.
 */
export async function claimFile(tx: Queryable, branchOid: string, fileOid: string, memberOid: string, kind: FileKind): Promise<void> {
    const row = await filesRepo.get(tx, fileOid, [branchOid], true);
    if (row?.status !== 'ready' || row.kind !== kind || (row.member_oid !== null && row.member_oid !== memberOid)) {
        throw new AppError(400, kind === 'member_photo' ? 'Upload the photo first' : 'Upload the document first', [
            { path: 'photo_file_oid', message: 'Not an uploaded file' }
        ]);
    }
    if (row.member_oid === null) await filesRepo.setMember(tx, fileOid, memberOid);
}

/**
 * For other features (trainers, exercises, measurements): check that a ready file of this kind belongs to the branch
 * (`branchOid`) and is not someone else's, so a profile can point at it. Runs in the caller's transaction.
 */
export async function claimKindFile(tx: Queryable, branchOid: string, fileOid: string, kind: FileKind, memberOid: string | null = null): Promise<void> {
    const row = await filesRepo.get(tx, fileOid, [branchOid], true);
    if (row?.status !== 'ready' || row.kind !== kind || (row.member_oid !== null && row.member_oid !== memberOid)) {
        throw new AppError(400, 'Upload the file first', [{ path: 'file_oid', message: 'Not an uploaded file' }]);
    }
    if (memberOid && row.member_oid === null) await filesRepo.setMember(tx, fileOid, memberOid);
}

/** A member's ready documents, each with a view link (the caller has checked the member is theirs to see). */
export async function memberDocuments(deps: Pick<FileDeps, 'jwtSecret' | 'apiPrefix'>, tx: Queryable, memberOid: string, branchOids: readonly string[]) {
    const rows = await filesRepo.forMember(tx, memberOid, branchOids);
    return Promise.all(rows.filter(r => r.kind === 'member_document').map(async r => ({ ...r, url: await viewUrl(deps, r) })));
}

/** Moves a member's files with them (transfer), or deletes them (anonymise). Caller's transaction. */
export const memberFiles = {
    move: (tx: Queryable, memberOid: string, toBranchOid: string) => filesRepo.moveMember(tx, memberOid, toBranchOid),
    /** Marks every file deleted and returns the storage keys, to delete from the store after the commit. */
    deleteAll: (tx: Queryable, memberOid: string, actor: string) => filesRepo.deleteMember(tx, memberOid, actor)
};
