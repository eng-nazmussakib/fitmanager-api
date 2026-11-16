import { defineConfig } from 'vitest/config';

/**
 * Integration tests run the real Express app against PGlite: real PostgreSQL (compiled to WebAssembly) in the
 * test process, a fresh in-memory database per test file. So SQL, constraints and migrations are tested for real,
 * with no database server and no mocks of `pg`.
 */
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.test.ts'],
        setupFiles: ['src/testing/setup.ts'],
        // Each file boots its own PGlite (~1 s); threads would only fight over CPU.
        pool: 'forks',
        testTimeout: 20_000,
        hookTimeout: 30_000,
        coverage: {
            provider: 'v8',
            reporter: ['text-summary', 'html', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/server.ts', 'src/instrument.ts', 'src/db/cli.ts', 'src/types/**']
        }
    }
});
