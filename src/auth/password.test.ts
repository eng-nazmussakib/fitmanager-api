import bcrypt from 'bcryptjs';

import { DEFAULT_SCRYPT_PARAMS, hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from './password.ts';

describe('password hashing', () => {
    it('hashes with a random salt and verifies', async () => {
        const [a, b] = await Promise.all([hashPassword('Secret@123'), hashPassword('Secret@123')]);
        expect(a).toMatch(/^scrypt\$1024\$8\$1\$/);
        expect(a).not.toBe(b);
        expect(await verifyPassword('Secret@123', a)).toBe(true);
        expect(await verifyPassword('secret@123', a)).toBe(false);
        expect(needsRehash(a)).toBe(false);
    });

    it('verifies legacy bcrypt hashes from the old services and flags them for upgrade', async () => {
        const legacy = await bcrypt.hash('Old@123', 4);
        expect(await verifyPassword('Old@123', legacy)).toBe(true);
        expect(await verifyPassword('wrong', legacy)).toBe(false);
        expect(needsRehash(legacy)).toBe(true);
    });

    it('uses configured parameters, still verifies hashes made with others, and flags them for re-hashing', async () => {
        const strong = { N: 2 ** 14, r: 8, p: 5 };
        const old = await hashPassword('Secret@123', strong);
        expect(old).toMatch(/^scrypt\$16384\$8\$5\$/);
        expect(needsRehash(old, strong)).toBe(false);
        expect(await verifyPassword('Secret@123', old)).toBe(true);
        expect(needsRehash(old, DEFAULT_SCRYPT_PARAMS)).toBe(true);
        expect(needsRehash(await hashPassword('Secret@123'), strong)).toBe(true);
        expect(await verifyAgainstDummy('anything', strong)).toBe(false);
    });

    it('rejects malformed hashes and always fails the dummy check', async () => {
        expect(await verifyPassword('x', 'plain-text-password')).toBe(false);
        expect(await verifyAgainstDummy('anything')).toBe(false);
    });
});
