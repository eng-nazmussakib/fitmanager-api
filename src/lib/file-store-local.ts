import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { expiry, type FileStore } from './file-store.ts';

/** Files on local disk (development, tests). Node only: worker.ts never imports it. */
export function createLocalStore(dir: string): FileStore {
    const root = resolve(dir);
    // The key is ours, but check anyway: nothing may leave the folder.
    const pathOf = (key: string) => {
        if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) throw new Error(`Bad file key: ${key}`);
        return join(root, key);
    };
    const typeOf = (key: string) => `${pathOf(key)}.type`;
    return {
        kind: 'local',
        uploadTarget: (_key, contentType, localUrl) =>
            Promise.resolve({ url: localUrl, method: 'PUT', headers: { 'Content-Type': contentType }, expires_at: expiry() }),
        async head(key) {
            try {
                const s = await stat(pathOf(key));
                const contentType = await readFile(typeOf(key), 'utf8').catch(() => null);
                return { size: s.size, contentType };
            } catch {
                return null;
            }
        },
        async read(key, maxBytes) {
            try {
                const all = await readFile(pathOf(key));
                return new Uint8Array(maxBytes === undefined ? all : all.subarray(0, maxBytes));
            } catch {
                return null;
            }
        },
        async write(key, body, contentType) {
            await mkdir(dirname(pathOf(key)), { recursive: true });
            await writeFile(pathOf(key), body);
            await writeFile(typeOf(key), contentType);
        },
        async delete(key) {
            await rm(pathOf(key), { force: true });
            await rm(typeOf(key), { force: true });
        }
    };
}
