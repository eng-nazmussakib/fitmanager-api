// @ts-check
/**
 * ESLint 10 flat config, the same base as the Angular and React skeletons: type-checked typescript-eslint,
 * simple-import-sort and the deprecated-API check. Formatting is Prettier's job.
 * (The SIB service's eslint 8 + `.eslintrc` + eslint-plugin-sonarjs setup does not run on ESLint 10.)
 */
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
    { ignores: ['node_modules/**', 'coverage/**', 'storage/**', '.wrangler/**', 'eslint.config.mjs', '.prettierrc.mjs'] },
    {
        files: ['**/*.ts'],
        extends: [eslint.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked, prettier],
        languageOptions: { globals: globals.node, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
        plugins: { 'simple-import-sort': simpleImportSort },
        rules: {
            'simple-import-sort/imports': ['error', { groups: [['^\\u0000'], ['^node:'], ['^@?\\w'], ['^#src/'], ['^\\.']] }],
            'simple-import-sort/exports': 'error',
            '@typescript-eslint/no-deprecated': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
            // Express 5 awaits async handlers itself and forwards a rejection to the error middleware.
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
            // Log through pino (structured, redacted), never console.
            'no-console': 'error',
            eqeqeq: ['error', 'smart'],
            // Two hosting targets: Cloudflare Workers and a VM. Only the Workers entry may use
            // Cloudflare's runtime modules; everything else runs on plain Node.
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            regex: '^cloudflare:',
                            message:
                                'Cloudflare modules only in src/worker.ts and src/worker/: put the feature behind an AppDeps interface, so the app still runs on Node for local development and tests.'
                        }
                    ]
                }
            ]
        }
    },
    {
        files: ['**/*.test.ts', 'src/testing/**'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off'
        }
    },
    {
        // The Workers entry and its Durable Objects are the one place that adapts the app to Cloudflare (local dev and tests run on Node).
        files: ['src/worker.ts', 'src/worker/**/*.ts', 'src/types/cloudflare-*.d.ts'],
        rules: { 'no-restricted-imports': 'off' }
    }
);
