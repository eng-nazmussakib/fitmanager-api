import { AwsClient } from 'aws4fetch';

/**
 * Where member photos and documents are kept. One interface, two implementations:
 * - `createS3Store`: Cloudflare R2's S3 API over `fetch` with SigV4 (aws4fetch), so the
 *   same code runs on Workers and on Node. The browser uploads straight to the bucket with a signed URL;
 *   nothing large passes through the API (Workers limits).
 * - `createLocalStore` (file-store-local.ts, Node only): a folder on disk, for development and tests. Its
 *   "signed URL" is an API route (`PUT /v1/files/:oid/content`) that writes the body there.
 * Keys are server-made (`<branch>/<file oid>`), never a client's file name.
 */
export interface StoredObject {
    size: number;
    contentType: string | null;
}

export interface UploadTarget {
    /** `PUT` the file's bytes here, with the `Content-Type` given. Relative for the local store. */
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expires_at: string;
}

export interface FileStore {
    readonly kind: 'local' | 's3';
    /** A short-lived URL the browser PUTs the file to. `localUrl` is the API route the local store answers on. */
    uploadTarget(key: string, contentType: string, localUrl: string): Promise<UploadTarget>;
    head(key: string): Promise<StoredObject | null>;
    /** The first bytes (type sniffing) or the whole object. */
    read(key: string, maxBytes?: number): Promise<Uint8Array | null>;
    /** Local store only: what the upload route writes. */
    write(key: string, body: Uint8Array, contentType: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export const UPLOAD_URL_SECONDS = 600;

export const expiry = (): string => new Date(Date.now() + UPLOAD_URL_SECONDS * 1000).toISOString();

export interface S3Config {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export function createS3Store(cfg: S3Config, fetchImpl: typeof fetch = fetch): FileStore {
    const aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: cfg.region });
    const urlOf = (key: string) => `${cfg.endpoint.replace(/\/$/, '')}/${encodeURIComponent(cfg.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const send = async (key: string, init: RequestInit) => fetchImpl(await aws.sign(urlOf(key), init));
    return {
        kind: 's3',
        async uploadTarget(key, contentType) {
            const url = new URL(urlOf(key));
            url.searchParams.set('X-Amz-Expires', String(UPLOAD_URL_SECONDS));
            const signed = await aws.sign(url.toString(), {
                method: 'PUT',
                headers: { 'Content-Type': contentType },
                aws: { signQuery: true, allHeaders: true }
            });
            return { url: signed.url, method: 'PUT', headers: { 'Content-Type': contentType }, expires_at: expiry() };
        },
        async head(key) {
            const res = await send(key, { method: 'HEAD' });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`S3 HEAD ${res.status}`);
            return { size: Number(res.headers.get('content-length') ?? 0), contentType: res.headers.get('content-type') };
        },
        async read(key, maxBytes) {
            const headers: Record<string, string> = maxBytes === undefined ? {} : { Range: `bytes=0-${maxBytes - 1}` };
            const res = await send(key, { method: 'GET', headers });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`S3 GET ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
        },
        async write(key, body, contentType) {
            const res = await send(key, { method: 'PUT', body, headers: { 'Content-Type': contentType } });
            if (!res.ok) throw new Error(`S3 PUT ${res.status}`);
        },
        async delete(key) {
            const res = await send(key, { method: 'DELETE' });
            if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${res.status}`);
        }
    };
}

/** In memory, for tests that swap the store (`createTestApp(env, { files })`). */
export function createMemoryStore(kind: 'local' | 's3' = 'local'): FileStore & { objects: Map<string, { body: Uint8Array; contentType: string }> } {
    const objects = new Map<string, { body: Uint8Array; contentType: string }>();
    return {
        kind,
        objects,
        uploadTarget: (key, contentType, localUrl) =>
            Promise.resolve({
                url: kind === 'local' ? localUrl : `https://bucket.test/${key}`,
                method: 'PUT',
                headers: { 'Content-Type': contentType },
                expires_at: expiry()
            }),
        head: key => {
            const o = objects.get(key);
            return Promise.resolve(o ? { size: o.body.byteLength, contentType: o.contentType } : null);
        },
        read: (key, maxBytes) => {
            const o = objects.get(key);
            return Promise.resolve(o ? o.body.subarray(0, maxBytes ?? o.body.byteLength) : null);
        },
        write: (key, body, contentType) => {
            objects.set(key, { body, contentType });
            return Promise.resolve();
        },
        delete: key => {
            objects.delete(key);
            return Promise.resolve();
        }
    };
}
