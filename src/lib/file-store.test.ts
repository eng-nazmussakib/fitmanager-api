import { createS3Store } from './file-store.ts';

const CFG = { endpoint: 'https://acct.r2.cloudflarestorage.com/', bucket: 'fm-files', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'SECRET' };

describe('S3 file store (R2, MinIO) over fetch', () => {
    it('signs every request with SigV4 and maps the answers', async () => {
        const seen: Request[] = [];
        const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const req = new Request(input, init);
            seen.push(req);
            if (req.method === 'HEAD')
                return Promise.resolve(new Response(null, { status: 200, headers: { 'content-length': '42', 'content-type': 'image/png' } }));
            if (req.method === 'GET' && req.url.endsWith('/missing')) return Promise.resolve(new Response(null, { status: 404 }));
            if (req.method === 'GET') return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
            return Promise.resolve(new Response(null, { status: 204 }));
        };
        const store = createS3Store(CFG, fake);
        expect(await store.head('a/b')).toEqual({ size: 42, contentType: 'image/png' });
        expect(await store.read('a/b', 4100)).toEqual(new Uint8Array([1, 2, 3]));
        expect(await store.read('a/missing')).toBeNull();
        await store.delete('a/b');
        expect(seen.map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
            'HEAD /fm-files/a/b',
            'GET /fm-files/a/b',
            'GET /fm-files/a/missing',
            'DELETE /fm-files/a/b'
        ]);
        expect(seen[0]?.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/);
        expect(seen[1]?.headers.get('range')).toBe('bytes=0-4099');
    });

    it('a presigned PUT: signature in the query, expiring in 10 minutes, the content type fixed', async () => {
        const store = createS3Store(CFG, () => Promise.reject(new Error('no network')));
        const target = await store.uploadTarget('br/file', 'application/pdf', '/unused');
        const url = new URL(target.url);
        expect(url.origin + url.pathname).toBe('https://acct.r2.cloudflarestorage.com/fm-files/br/file');
        expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
        expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
        expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
        expect(target).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf' } });
    });
});
