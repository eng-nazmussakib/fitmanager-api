---
name: fitmanager-api
description: Conventions and workflow for the FitManager backend (Express 5 + TypeScript run natively by Node, Prisma, PostgreSQL 18 on Neon, deployed to Cloudflare Workers). Use for any work in fitmanager-api — adding or changing features, routes, schemas, Prisma models/migrations, tenancy (branch) scoping, auth/permissions, jobs, tests, or the Docker/CI setup of the API.
---

# FitManager API (Express)

Backend for **FitManager**, a gym management system built for **one client** (a gym business in Bangladesh). Each **branch is a tenant**. HQ sits above the branches. The product docs live in `../fitmanager-infra/docs/`. Read the ones relevant to the task first:

- `../fitmanager-infra/docs/00-overview.md` (scope), `../fitmanager-infra/docs/02-architecture.md` (§5 tenancy, §6 API), `../fitmanager-infra/docs/04-decisions.md` (decision log, open questions)
- the current phase doc in `../fitmanager-infra/docs/phases/`

The API is Express because it runs on Cloudflare Workers (D-028). Don't add NestJS here.

## Current state vs target

| Area        | Now (skeleton)                                                                               | Target (phase 1+)                                                            |
| ----------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Data access | Raw `pg`/PGlite with the `sql` tag (`src/db/*`, SQL in `../fitmanager-infra/db/migrations/`) | **Prisma** (`prisma/schema/*.prisma`, one file per module, `prisma migrate`) |
| Features    | `src/features/items/` (reference CRUD example)                                               | Domain features in `src/features/<module>/`                                  |
| Tenancy     | None                                                                                         | Branch scoping in three layers (see below)                                   |
| Entry       | `src/server.ts` (Node `listen`, graceful shutdown)                                           | plus a Workers entry around the same `createApp(deps)` (Q-007 spike)         |
| Contract    | Valibot schemas + the API table in `README.md` + `requests.http`                             | the same: no Swagger or OpenAPI (D-030)                                      |

Until the Prisma migration lands (phase 1), follow the existing patterns. Don't start new raw-SQL repositories for domain features. Ask whether the Prisma migration should come first.

## Commands

```bash
nvm use && npm ci
# first, once and after each new migration (API stopped): cd ../fitmanager-infra/db && PGLITE_DIR=../../fitmanager-api/storage/pglite npm run seed
npm run dev          # http://localhost:3000/api · PGlite in storage/pglite; the web demo's staff (owner/Owner@123, manager.gulshan/Manager@123, desk.gulshan/Desk@123…)
npm run typecheck    # Node strips types without checking them, so always run this
npm run lint         # type-checked ESLint
npm test             # Vitest (watch); npm run test:ci for one run with coverage
npm run test:pg      # one run on the local PostgreSQL 17 (TEST_DATABASE_URL in .env.local): a throwaway fm_test_* database per test file
npm run validate     # format check + typecheck + lint + tests (the CI gate). Run before saying work is done.
docker compose up -d # Postgres 18, Redis, Mailpit for running like a server
```

There is **no build step**: Node runs the `.ts` files (type stripping). Only erasable syntax is allowed (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties, no decorators.

## Architecture rules

- **Modular monolith.** One folder per subsystem under `src/features/`. A feature may call another feature's **exported service functions** or react to its **domain events**. It never queries another feature's tables.
- **Feature layout** (target):
    ```
    src/features/<module>/
      <module>.routes.ts   <module>.service.ts   <module>.schema.ts
      <module>.events.ts   <module>.test.ts
    ```
    `<module>Router(deps)` does HTTP only: `authenticate`, `requireAbility`, `parse(schema, …)`, mapping, `ok(res, …)`. Services hold the business rules and transactions, take their dependencies as arguments, and never import Express.
- **Mounting:** every router is mounted explicitly in `src/app.ts` (no glob loading). Paths include the version: `/v1/<module>/…` under `config.apiPrefix` (`/api`).
- **Dependencies:** `src/container.ts` builds `AppDeps` once (db, cache, mailer, tokens, …) and passes them in. No module opens a connection at import time; tests override any piece through `createTestApp(env, overrides)`.
- **Infrastructure stays where it is:** `auth/`, `config/`, `db/`, `lib/`, `jobs/`, `templates/`, `testing/`, `types/`, and the skeleton features `auth`, `ddl`, `files`, `mail`, `otp`, `health`.
- **Domain events** (`PaymentRecorded`, `SubscriptionExpired`, `MemberSuspended`, …) feed the audit log, notifications and the access rules engine.

## Tenancy (branch = tenant): never skip this

- **One `branch` table (D-023):** one row `kind = 'HQ'`, the rest `kind = 'BRANCH'`. Every owned table has `branch_id NOT NULL REFERENCES branch`. HQ master data (plan templates, policies, exercise library, catalogue, roles) points at the HQ row: every staff member can read it, and writing it requires HQ permissions. Members, subscriptions, payments and check-ins must reference a `BRANCH` row.
- The request context (`AsyncLocalStorage`, next to the logger's in `src/lib/logger.ts`) carries the user, the active branch (`X-Branch-Id` header) and the allowed branches. A `requireBranch` middleware, after `authenticate`, validates `X-Branch-Id` against the user's `StaffAssignment`s.
- A **Prisma extension** adds the `branch_id` filter to reads and writes on branch-scoped models, and rejects any write outside the context.
- **Branch-aware permissions (D-034, in place):** `staff_assignment` holds one role per (user, branch); `all_branches` (owner) adds every branch with the HQ role. `authenticate` builds `req.auth.ability` from `GLOBAL_RULES[kind]` + the assignment at `X-Branch-Id`. A branch route is `authenticate(deps), requireBranch('BRANCH'), requireAbility('create', 'Member')`; read the branch with `currentBranch(req)`, never from the body. Subjects are the web app's list (`src/auth/ability.ts`); role rules live in migration 002 and mirror the web mock's `ROLE_RULES`, so change both together. `Item` is the skeleton example only.
- **PostgreSQL RLS** acts as a safety net. Queries run in a transaction after `set_config('app.branch_ids', …, true)`. The app connects as the non-owner role `fitmanager_app`, and migrations run as the owner.
- Background jobs and HQ reports set an **explicit** system or HQ context. A missing context **fails closed** (no rows).
- Every new branch-scoped model needs: a `branch_id` column and index, an RLS policy in its migration, and a test proving that another branch's rows can't be read or written.
- Members belong to one branch. Moving between branches is an explicit transfer, never an update of `branch_id`.

## Database: local Postgres now, Neon later (D-021)

Production runs on **Neon** (Postgres 18, pooled through PgBouncer in transaction mode). Development uses a local Postgres 18 container. Write everything so the move is only a change of connection strings (details: `../fitmanager-infra/docs/02-architecture.md` §2):

- Prisma: the `pg` driver adapter (`@prisma/adapter-pg`, `pg` ≥ 8.16.3), on `DATABASE_URL` locally and the Hyperdrive binding on Workers (D-024). Migrations, `pg_dump` and seeds use `DIRECT_URL` (owner role), run from CI or a laptop, never from a Worker.
- **No session state on the app connection:** branch context only through `set_config(…, true)` inside the request transaction; no session `SET`, no session advisory locks, no `LISTEN/NOTIFY`, no temp tables that outlive a transaction. (The skeleton's migration and job locks are already transaction-scoped, `pg_advisory_xact_lock`; keep any new lock that way.)
- **The database lives in `../fitmanager-infra/db/` (D-033, D-039), and the API never migrates or seeds:** migrations (`migrations/NNN_name.sql`), demo seeds (`seeds/demo/NNN_name.sql`, SQL with precomputed password hashes), the runner (`tools/runner.ts`, `npm run migrate | seed | status` there), the roles script and the local Postgres 18 compose file. A schema change is a new migration file there plus, if demo data needs it, a seed file; never code in this repo. The API's tests build their databases with that runner (`src/testing/test-app.ts`); demo ids for tests are in `src/testing/demo.ts`. Docker builds take the folder as a named context: `docker build --build-context db=../fitmanager-infra/db .`.
- Roles (`fitmanager_owner`, `fitmanager_app` with `NOBYPASSRLS`) come from the versioned script `../fitmanager-infra/db/roles/001_roles.sql`, run on both databases, never from a Docker-only init file or the Neon Console.
- Branch-scoped tables: `ENABLE` and `FORCE ROW LEVEL SECURITY`.
- Only extensions Neon supports; UUIDs with `gen_random_uuid()`. Database settings with `ALTER DATABASE/ROLE … SET`, never `postgresql.conf`.
- Keep the Postgres major version at 18 in Docker, CI and Neon. Local development is on 17 (D-031): no 18-only features.

## Runtime: Cloudflare Workers (D-024, D-028)

The API deploys as a Worker with `nodejs_compat`, on the **Cloudflare Free plan only (D-026)**: 10 ms CPU per request, 100,000 requests and Hyperdrive queries a day. Express is Cloudflare's documented route (`httpServerHandler` from `cloudflare:node` wraps the app); whether it fits the Free plan's CPU limit is **open (Q-007)**: phase 1 starts with a spike that measures it. Until it is settled, write code that ports either way:

- `createApp(deps)` stays free of `listen`, process signals and globals; `server.ts` is the Node entry only. The Workers entry will build `deps` from the Worker `env` (Hyperdrive, KV, R2 bindings) and reuse the same app.
- Business rules in plain services with no dependency on Express, the Node `http` server or the file system.
- No long-lived in-process state: anything that must survive a request goes to Postgres, KV or a Durable Object.
- Replacements (free ones only): files → **R2** (needs a card on file, Q-008); jobs → **Queues** + **one Cron Trigger** that dispatches every scheduled job (Free allows 5); cache → **KV** (reads only: 1,000 writes a day); throttling and live occupancy → a **Durable Object** (SQLite, free); email → a free email API, Brevo or Resend (Cloudflare's sending is paid); secrets → Workers secrets.
- Skeleton pieces that are **Node-server only** and get replaced on Workers: `ioredis` and `rate-limit-redis` (→ KV / Durable Object), `croner` (→ Cron Trigger), `multer` to local disk (→ signed R2 uploads), `puppeteer-core` PDFs (→ browser-side receipts), `nodemailer` SMTP (→ email API over `fetch`), `prom-client` `/metrics` (→ Workers observability). Don't build new features on them.
- Worker limits (both plans): 64 MiB uncompressed bundle, 128 MB memory per isolate, 1 s start-up. So: uploads go straight from the browser to R2 with a signed URL (never through the Worker); exports and reports stream or page through rows instead of loading everything; PDF receipts are generated in the browser (the web app already does this with jsPDF), not in the API.
- Never add a paid Cloudflare product (Containers, Email Service sending, Workers Paid features) without the user's say-so.
- Don't add a dependency that needs native modules, raw TCP other than the Postgres driver, or `fs` at runtime.

## Conventions

- **ESM, native TypeScript:** relative imports end in `.ts` (`'./items.repo.ts'`); cross-folder imports use the `#src/*` alias (`'#src/lib/http.ts'`). Top-level `await` is allowed.
- **Validation:** **Valibot** 1 schemas in `<module>.schema.ts` (D-030; never add zod back, and no Swagger/OpenAPI), applied with `parse(schema, req.body | req.query | req.params)` (throws a 400 with `errors: [{ path, message }]`; `path` comes from `v.getDotPath`). Use `v.strictObject` for bodies (an unknown field is reported under its own name). Query strings are strings: coerce numbers with a `v.union([v.string(), v.number()])` → `v.transform(Number)` → `v.number()` pipe, as `queryInt` in `items.schema.ts` does. Types come from `v.InferOutput<typeof schema>`. Sort and filter columns come from whitelists (`SORT_COLUMNS`), never from input.
- **Auth is per router:** `router.use('/v1/<module>', authenticate(deps))`, then `requireAbility(action, subject)` on **every** route (CASL, typed). Public routes (login, refresh, public gym data) are the explicit exception and are rate-limited. Use `currentUser(req)` for the caller. When adding a subject, update the `Subject` type in `src/auth/ability.ts`, and tell the user to mirror it in the web app's `core/auth/ability.ts`.
- **Responses:** handlers call `ok(res, data, message?, status?)`, which writes the envelope `{ code, message, data }`. Errors are thrown as `AppError(status, message, errors?)`; Express 5 forwards async throws to `errorHandler` (`src/lib/errors.ts`). No try/catch in handlers just to format errors.
- **HTTP codes:** `ok()` answers 200 by default. Pass `201` only for a create; actions (freeze, check-in, login) stay 200. Wrong credentials answer 400, not 401 (the web app treats 401 as "session expired").
- **Routes:** declare static paths (`/v1/items/export`) before parameter paths (`/v1/items/:oid`).
- **Wire format** (the web app depends on it): `snake_case` fields, `oid` for IDs, ISO dates.
- **Money:** `Decimal(12,2)` / `NUMERIC`, never a float. Currency is BDT.
- **Time:** `timestamptz`. Plain `date` columns are read as text (see the note in `items.repo.ts`).
- **Financial rows are never deleted or edited in place.** Fix mistakes with reversing entries. Master data uses soft delete (`deleted_at`).
- **Audit:** every write produces an audit entry (who, what, before and after), written in the same transaction.
- **Payments:** manual methods only for now (`CASH`, `CARD_POS`, `BANK_TRANSFER`, `BKASH_MANUAL`, `NAGAD_MANUAL` + reference) through the `PaymentProvider` interface. Gateways come later.
- **Attendance:** check-ins go through the **access rules engine**, a pure function with table-driven tests. Overrides require a reason and are audited. `source` is `MANUAL` (RFID comes later).
- **Passwords:** `hashPassword`, `verifyAgainstDummy` and `needsRehash` take `config.auth.passwordHash` (`PASSWORD_SCRYPT_N/_R/_P`). The default is deliberately cheap for the Workers Free plan (10 ms CPU). Don't hard-code scrypt parameters and don't raise the default without measuring CPU per sign-in.
- **Logging:** `log()` from `src/lib/logger.ts` (pino, carries the request id). Never log request bodies, tokens or passwords.
- **Code style:** Prettier (4 spaces, single quotes, width 160). Imports are sorted by `simple-import-sort` (`npm run lint:fix`).

## Testing

- `createTestApp()` (`src/testing/test-app.ts`) builds the real app with `createApp(deps)` on a fresh database, an in-memory mailer and cache. Swap any dependency through its `overrides` argument. `signIn(t.app)` and `bearer(token)` give an authorised request.
- Test through HTTP with supertest. Cover: validation errors, 401/403 for each ability, branch isolation (once tenancy exists), and the main business rules.
- Local database (D-031): the machine's PostgreSQL **17** on the Unix socket, peer auth, no Docker. `npm run dev` uses the `fitmanager` database through `.env.local` (git-ignored); `npm test` still uses PGlite; `npm run test:pg` runs the same suite on throwaway `fm_test_*` databases on the local server. Because Neon and CI are 18, use nothing that is new in PostgreSQL 18 (for example the built-in `uuidv7()`: generate UUID v7 in app code).
- Test database in CI (D-025): a throwaway Postgres 18 container. Run all migrations from scratch, test as the `fitmanager_app` role so RLS applies, then drop it. New tenancy and RLS tests need the `fitmanager_app` role: your OS user has CREATEDB but not CREATEROLE on the local server, so create the roles once with `sudo -u postgres psql -d fitmanager -f ../fitmanager-infra/db/roles/001_roles.sql`. Risky migrations are also tried on a Neon branch before production.

## Before finishing a task

1. `npm run validate` passes.
2. New or changed endpoints are listed in the API table in `README.md` and in `requests.http` (they are the contract; there is no Swagger).
3. Any change to the wire contract is reported to the user, because `fitmanager-web` models and mocks must match.
4. If a decision changed, propose a new entry for `../fitmanager-infra/docs/04-decisions.md`. Tick finished items in the phase doc.

## After every finished task (D-016)

Log the task in `../fitmanager-infra/docs/CHANGELOG.md` before reporting it as done:

1. Add a new entry at the **top**: the next version number (`0.MINOR.PATCH`: bump MINOR for a feature or structural change, PATCH for a fix or docs-only change), today's date, a one-line title, and the repos touched.
2. Sections: **Summary** (2–4 sentences), **Changes** (bullets grouped by repo, with file paths), **Verification** (commands run and their result; say plainly what was not run).
3. **External resources:** list every resource taken from an external website for this task (fonts, images, icons, code snippets, articles or docs consulted, search result pages used), each with its URL and licence where known. Write "None" when nothing external was used. npm packages installed through `package.json` are not listed here.
