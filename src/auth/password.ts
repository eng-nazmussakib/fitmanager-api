import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';

/**
 * Password hashing with scrypt from node:crypto: memory-hard (OWASP's second choice after Argon2id), no native
 * add-on to compile, and it runs on libuv's thread pool, so the event loop is never blocked.
 *
 * The projects used `bcrypt` (native, rebuilt per Node version) in some services and `bcryptjs` in others.
 * Existing bcrypt hashes still verify, and are upgraded to scrypt at the next successful sign-in
 * (`needsRehash`), so a database can migrate without a password reset.
 *
 * Format: `scrypt$<N>$<r>$<p>$<salt>$<hash>` (base64url). The parameters travel with the hash, so they can be
 * changed later without breaking old hashes: a hash made with other parameters still verifies, and `needsRehash`
 * re-hashes it with the current ones at the next successful sign-in.
 *
 * The cost is configurable (`PASSWORD_SCRYPT_N`, `_R`, `_P`). The DEFAULT is deliberately cheap: N=2^10, r=8, p=1
 * (1 MiB, about 1/80 of the work of N=2^14, r=8, p=5), because Cloudflare Workers on the Free plan allow only
 * 10 ms of CPU per request (D-026, Q-007). It is weaker than OWASP's minimum; raise it once the API runs where
 * sign-in can afford it, for example N=2^17, r=8, p=1 (OWASP's first scrypt setting, 128 MiB).
 */
export interface ScryptParams {
    N: number;
    r: number;
    p: number;
}
export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = { N: 2 ** 10, r: 8, p: 1 };
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...opts, maxmem: 256 * 1024 * 1024 }, (err, key) => {
            if (err) reject(err);
            else resolve(key);
        });
    });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, params);
    return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    if (stored.startsWith('$2')) return bcrypt.compare(password, stored); // legacy bcrypt hash
    const [scheme, n, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True for a legacy bcrypt hash and for a scrypt hash made with other parameters than `params`. */
export function needsRehash(stored: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
    return stored !== '' && !stored.startsWith(`scrypt$${params.N}$${params.r}$${params.p}$`);
}

/** One dummy hash per parameter set, so the dummy check costs the same as a real one. */
const dummies = new Map<string, Promise<string>>();

/**
 * Burns the same time as a real check when the user does not exist. Otherwise "unknown user" answers faster than
 * "wrong password" and reveals which usernames exist (SPN answered the two with different MESSAGES as well).
 */
export async function verifyAgainstDummy(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<false> {
    const key = `${params.N}$${params.r}$${params.p}`;
    let dummy = dummies.get(key);
    if (!dummy) {
        dummy = hashPassword('dummy-password-for-timing', params);
        dummies.set(key, dummy);
    }
    await verifyPassword(password, await dummy);
    return false;
}
