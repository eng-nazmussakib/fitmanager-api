import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from './env.ts';

const base = { DB_DRIVER: 'pg', DATABASE_URL: 'postgres://u:p@db/app', JWT_SECRET: 'x'.repeat(32) };

describe('loadConfig', () => {
    it('applies defaults and parses types', () => {
        const c = loadConfig({ ...base, PORT: '8080', CORS_ORIGINS: 'https://a.example, https://b.example', DB_POOL_MAX: '4' });
        expect(c.port).toBe(8080);
        expect(c.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
        expect(c.db.poolMax).toBe(4);
        expect(c.apiPrefix).toBe('/api');
        expect(c.isProduction).toBe(true); // NODE_ENV defaults to production: safe settings unless told otherwise
    });

    // Cross-field rules (DATABASE_URL required for pg…) run once the individual fields are valid.
    it('lists every invalid field at once', () => {
        expect(() => loadConfig({ DB_DRIVER: 'pg', JWT_SECRET: 'short', PORT: 'abc' })).toThrow(/(?=[\s\S]*JWT_SECRET)(?=[\s\S]*PORT)/);
    });

    it('reads secrets from <NAME>_FILE (Docker/Swarm secrets)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
        writeFileSync(join(dir, 'jwt'), `${'s'.repeat(40)}\n`);
        expect(loadConfig({ ...base, JWT_SECRET: undefined, JWT_SECRET_FILE: join(dir, 'jwt') }).auth.jwtSecret).toBe('s'.repeat(40));
        expect(() => loadConfig({ ...base, JWT_SECRET_FILE: join(dir, 'missing') })).toThrow(/JWT_SECRET_FILE/);
    });

    it('refuses development shortcuts in production', () => {
        expect(() => loadConfig({ ...base, DB_DRIVER: 'pglite' })).toThrow(/pglite/);
        expect(() => loadConfig({ ...base, JWT_SECRET: `dev-${'x'.repeat(32)}` })).toThrow(/development secret/);
    });

    it('requires the OIDC settings together', () => {
        expect(() => loadConfig({ ...base, OIDC_ISSUER: 'https://sso.example.com/realms/x' })).toThrow(/together/);
    });

    it('defaults to cheap scrypt parameters and accepts stronger ones', () => {
        expect(loadConfig(base).auth.passwordHash).toEqual({ N: 1024, r: 8, p: 1 });
        expect(loadConfig({ ...base, PASSWORD_SCRYPT_N: '131072', PASSWORD_SCRYPT_P: '2' }).auth.passwordHash).toEqual({ N: 131072, r: 8, p: 2 });
        expect(() => loadConfig({ ...base, PASSWORD_SCRYPT_N: '3000' })).toThrow(/PASSWORD_SCRYPT_N: must be a power of two/);
        expect(() => loadConfig({ ...base, PASSWORD_SCRYPT_N: '1048576', PASSWORD_SCRYPT_R: '8' })).toThrow(/256 MiB/);
    });
});
