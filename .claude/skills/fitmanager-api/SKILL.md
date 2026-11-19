---
name: fitmanager-api
description: Conventions and workflow for the FitManager backend (Express 5 + TypeScript run natively by Node, raw SQL on `pg`, PostgreSQL 18), a hobby project that only runs as a free demo on Cloudflare Workers with Neon and R2 (D-075) — no outside-service integrations, no cron jobs. Use for any work in fitmanager-api — adding or changing features, routes, schemas, SQL repositories/migrations, tenancy (branch) scoping, auth/permissions, time-based rules, tests, or the Worker setup of the API.
---

# FitManager API (Express)

Backend for **FitManager**, a gym management system for a multi-branch gym in Bangladesh. **It is a hobby project, always run as a free demo (D-075).** Each **branch is a tenant**. HQ sits above the branches. The product docs live in `../fitmanager-infra/docs/`. Read the ones relevant to the task first:

- `../fitmanager-infra/docs/00-overview.md` (scope), `../fitmanager-infra/docs/02-architecture.md` (§5 tenancy, §6 API), `../fitmanager-infra/docs/04-decisions.md` (decision log, open questions)
- the current phase doc in `../fitmanager-infra/docs/phases/`

The API is Express because it runs on Cloudflare Workers (the hosted demo) and on plain Node for local development and tests (D-028). Don't add NestJS here.

**Scope rule (D-075):** no outside services but R2. No mail, SMS, payment gateway, captcha, identity provider, Sentry, Redis or metrics endpoint. A feature that would need one gets a free manual stand-in (a record made by hand, a temporary password, an in-app message staff send on from their own phone). No scheduled work: no Cron Triggers, Queues or croner; a time-based rule runs when its data is read, inside that request's transaction, and must be idempotent (`closeFinishedVisits`, `writeDueReminders`, `refreshTokens.prune`).

**No ORM (D-047):** Prisma was dropped because raw SQL is lighter on the Workers Free plan's 10 ms CPU. Write SQL with the `sql` tag in `<module>.repo.ts`, with a hand-written row type per query. Don't add Prisma, Drizzle, Kysely or another query builder without the user's say-so.

## Commands

```bash
nvm use && npm ci
# first, once and after each new migration (API stopped): cd ../fitmanager-infra/db && PGLITE_DIR=../../fitmanager-api/storage/pglite npm run seed
npm run dev          # http://localhost:3000/api · PGlite in storage/pglite; the web demo's staff (owner/Owner@123, manager.gulshan/Manager@123, desk.gulshan/Desk@123…)
npm run typecheck    # Node strips types without checking them, so always run this
npm run lint         # type-checked ESLint
npm test             # Vitest (watch); npm run test:ci for one run with coverage
npm run test:pg      # one run on the local PostgreSQL 17 (TEST_DATABASE_URL in .env.local): a throwaway fm_test_* database per test file
npm run validate     # format check + typecheck + lint + tests (no CI, D-046). Run before saying work is done.
npm run worker:db & npm run worker:dev   # the Workers path locally, on http://localhost:8787
```

There is **no build step**: Node runs the `.ts` files (type stripping). Only erasable syntax is allowed (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties, no decorators.

## Architecture rules

- **Modular monolith.** One folder per subsystem under `src/features/`. A feature may call another feature's **exported service functions** or react to its **domain events**. It never queries another feature's tables.
- **Feature layout:**
    ```
    src/features/<module>/
      <module>.routes.ts   <module>.service.ts   <module>.schema.ts
      <module>.repo.ts     <module>.test.ts
    ```
    `<module>Router(deps)` does HTTP only: `authenticate`, `requireAbility`, `parse(schema, …)`, mapping, `ok(res, …)`. Services hold the business rules and transactions, take their dependencies as arguments, and never import Express.
- **Mounting:** every router is mounted explicitly in `src/app.ts` (no glob loading). Paths include the version: `/v1/<module>/…` under `config.apiPrefix` (`/api`).
- **Dependencies:** `src/container.ts` builds `AppDeps` once (db, cache, clock, files, tokens, rate-limit stores) and passes them in. No module opens a connection at import time; tests override any piece through `createTestApp(env, overrides)`.
- **Infrastructure folders:** `auth/`, `config/`, `db/`, `lib/`, `testing/`, `types/`, `worker/`; the features are in `features/`.
- **Domain events** (`PaymentRecorded`, `MemberSuspended`, …) feed the audit log, in-app messages and the access rules engine.

## Tenancy (branch = tenant): never skip this

- **One `branch` table (D-023):** one row `kind = 'HQ'`, the rest `kind = 'BRANCH'`. Every owned table has `branch_id NOT NULL REFERENCES branch`. HQ master data (plan templates, policies, exercise library, catalogue, roles) points at the HQ row: every staff member can read it, and writing it requires HQ permissions. Members, subscriptions, payments and check-ins must reference a `BRANCH` row.
- `authenticate` resolves the user and their assignments; a `requireBranch` middleware, after it, validates `X-Branch-Id` against the user's `StaffAssignment`s. `branchContext(req)` then gives the explicit `BranchContext` (actor, active branch, allowed branch ids, request id, IP); it is passed to services as an argument, not kept in `AsyncLocalStorage`.
- **Branch-scoped repositories** (raw SQL, D-047; built in 0.34.0): `const ctx = branchContext(req)` (behind `requireBranch`), then `withBranchTx(db, ctx, async tx => …)` in `src/db/tenancy.ts`. It opens the transaction and sets `app.branch_oids` for RLS. Every statement still filters or inserts `branch_oid` explicitly (the column name is `branch_oid`, not `branch_id`), with the id from `ctx`, never from the body. Automatic writes (closing finished visits) use `systemContext(branchOid, [...])`. An empty context throws.
- **Column names:** one English field per value: `name`, never `name_en` / `name_bn` (D-015). The audit log and sessions have no `ip` column; do not add one.
- **Audit:** every write calls `recordAudit(tx, ctx, { action, entity, entityKey, before, after })` (`src/features/audit/audit.service.ts`) with the SAME `tx`. A new POST/PUT/PATCH/DELETE route must go into `AUDITED` (with a test) or `EXEMPT` (with a reason) in `src/features/audit/audit-coverage.test.ts`, or that test fails. Reading: `GET /v1/hq/audit` (HQ, across the user's branches, optional `branch_oid`) and `GET /v1/branch/audit` (that branch), subject `AuditLog` (read only; OWNER, HQ_ADMIN, BRANCH_MANAGER, migration 006). Filters `actor_oid`, `action`, `entity`, `entity_key`, `from`/`to` (Dhaka days, inclusive); newest first, cursor paging (`next` → `?before=`), not offsets.
- **Branch-aware permissions (D-034, in place):** `staff_assignment` holds one role per (user, branch); `all_branches` (owner) adds every branch with the HQ role. `authenticate` builds `req.auth.ability` from `GLOBAL_RULES[kind]` + the assignment at `X-Branch-Id`. A branch route is `authenticate(deps), requireBranch('BRANCH'), requireAbility('create', 'Member')`; read the branch with `currentBranch(req)`, never from the body. Subjects are the web app's list (`src/auth/ability.ts`); role rules live in migrations 002, 004 and 006 (each rewrites a role's full rule set) and mirror the web mock's `ROLE_RULES`, so change both together.
- **PostgreSQL RLS** acts as a safety net. Queries run in a transaction after `set_config('app.branch_oids', '{…}', true)`; policies use `branch_oid = any (app_branch_oids())` (migration 005). RLS tests in raw SQL: `src/db/tenancy.test.ts` (`asRlsSubject`). The app connects as the non-owner role `fitmanager_app`, and migrations run as the owner.
- Automatic writes and HQ reports set an **explicit** system or HQ context. A missing context **fails closed** (no rows).
- Every new branch-scoped model needs: a `branch_id` column and index, an RLS policy in its migration, and a test proving that another branch's rows can't be read or written.
- Members belong to one branch. Moving between branches is an explicit transfer, never an update of `branch_id`.

## Database: local Postgres, Neon for the demo (D-021, D-075)

**Neon is the hosted demo database** (through Hyperdrive); there is no production database. Development uses PGlite or the local PostgreSQL 17 (D-031). Write everything so the two differ only in connection strings (details: `../fitmanager-infra/docs/02-architecture.md` §2):

- `pg` (≥ 8.16.3) on `DATABASE_URL` locally and on the Hyperdrive binding on Workers (D-024), a pool per request there (`src/worker.ts`). Migrations and seeds use the owner role on the direct URL, run from a laptop (no CI, D-046), never from a Worker.
- **Local migrations never go to Neon automatically (D-049).** Apply a new migration to the local `fitmanager` database and the tests; Neon is reset to the current files only when the user asks to deploy the demo (`../fitmanager-infra/cloudflare/demo-deploy.md`).
- **No session state on the app connection:** branch context only through `set_config(…, true)` inside the request transaction; no session `SET`, no session advisory locks, no `LISTEN/NOTIFY`, no temp tables that outlive a transaction. Any lock is transaction-scoped (`pg_advisory_xact_lock`).
- **The database lives in `../fitmanager-infra/db/` (D-033, D-039), and the API never migrates or seeds:** migrations (`migrations/NNN_name.sql`), seeds (`seeds/demo/`, `seeds/showcase/`, SQL with precomputed password hashes), the runner (`tools/runner.ts`, `npm run migrate | seed | status | reset` there) and the roles script. A schema change is a migration there (a new file, or, to drop or rename a column, an edit of the file that created it plus `npm run reset`: D-051, the `fitmanager-db` skill) plus, if demo data needs it, a seed file; never code in this repo. The API's tests build their databases with that runner (`src/testing/test-app.ts`); demo ids for tests are in `src/testing/demo.ts`.
- Roles (`fitmanager_owner`, `fitmanager_app` with `NOBYPASSRLS`) come from the versioned script `../fitmanager-infra/db/roles/001_roles.sql`, run on both databases, never from the Neon Console.
- Branch-scoped tables: `ENABLE` and `FORCE ROW LEVEL SECURITY`.
- Only extensions Neon supports; UUIDs with `gen_random_uuid()`. Database settings with `ALTER DATABASE/ROLE … SET`, never `postgresql.conf`.
- Neon is on 18, local development on 17 (D-031): no 18-only features.

## Runtime: Cloudflare Workers, Node for development (D-024, D-028, D-075)

The hosted demo runs `src/worker.ts`; local development and the tests run `src/server.ts` / `createApp` on Node. Both share `createApp(deps)`.

| Concern     | Workers (the demo)              | Node (local, tests)              | Seam                       |
| ----------- | ------------------------------- | -------------------------------- | -------------------------- |
| Entry       | `src/worker.ts`                 | `src/server.ts`                  | `createApp(deps)`          |
| Database    | Hyperdrive → Neon, pool/request | `pg` pool or PGlite              | `Db`                       |
| Rate limits | Durable Object store            | memory                           | express-rate-limit `Store` |
| Cache       | memory per isolate              | memory                           | `Cache`                    |
| Files       | R2 over its S3 API (aws4fetch)  | local disk, memory in tests      | `FileStore`                |
| Logs        | Workers Logs                    | pino to stdout (pretty)          | `log()`                    |
| Secrets     | Workers secrets                 | `.env.development`, `.env.local` | `loadConfig()`             |

Rules:

- **Only `src/worker.ts` and `src/worker/` import `cloudflare:*`.** ESLint (`no-restricted-imports`) fails anywhere else. Bindings are turned into `AppDeps` implementations there.
- **Tests run on the Node path** (`createTestApp` → `createApp`). Check the Workers path with `npm run worker:dev`.
- Receipts are made in the browser (jsPDF), and uploads go from the browser straight to R2 with a signed URL.

On Cloudflare the API runs on the **Free plan only (D-026)**: 10 ms CPU per request, 100,000 requests and Hyperdrive queries a day. It fits (D-048: warm 0–10 ms, cold first request 9–44 ms). Keep it that way:

- `createApp(deps)` stays free of `listen`, process signals and globals; `server.ts` and `worker.ts` are the only entries.
- Business rules in plain services with no dependency on Express, the Node `http` server, the file system or Cloudflare.
- No long-lived in-process state: anything that must survive a request goes to Postgres, or to the cache or rate-limit store behind its interface.
- Worker limits: 64 MiB uncompressed bundle, 128 MB memory per isolate, 1 s start-up. So: uploads never pass through the Worker; exports and reports page through rows instead of loading everything; no PDFs in the API.
- Never add a paid Cloudflare product (Containers, Email Service sending, Workers Paid features) or any outside service without the user's say-so (D-075).
- Don't add a dependency that needs native modules, raw TCP other than the Postgres driver, or `fs` at runtime.
- Learned in the spike (phase 1 doc §1): no I/O object (pool, client, socket) may be shared between requests, so `deps.db` on Workers is a per-request facade; nothing that starts timers or does I/O may run in global scope; no `eval`/`new Function` (no Handlebars); no `import.meta.dirname` or file reads at import; never read `env.HYPERDRIVE.connectionString` in global scope (it counts as I/O; read it per request); limiters get their store from `deps.rateLimits`, never a store of their own; `req.ip` is `127.0.0.1` behind the shim, so `withClientIp` copies `CF-Connecting-IP` (rate limits; the audit log and sessions store no IP). Check a change with `npm run worker:dev` (and `worker:db`).

## Conventions

- **ESM, native TypeScript:** relative imports end in `.ts` (`'./members.repo.ts'`); cross-folder imports use the `#src/*` alias (`'#src/lib/http.ts'`). Top-level `await` is allowed.
- **Validation:** **Valibot** 1 schemas in `<module>.schema.ts` (D-030; never add zod back, and no Swagger/OpenAPI), applied with `parse(schema, req.body | req.query | req.params)` (throws a 400 with `errors: [{ path, message }]`; `path` comes from `v.getDotPath`). Use `v.strictObject` for bodies (an unknown field is reported under its own name). Query strings are strings: coerce numbers with a `v.union([v.string(), v.number()])` → `v.transform(Number)` → `v.number()` pipe. Types come from `v.InferOutput<typeof schema>`. Sort and filter columns come from whitelists (`SORT_COLUMNS`), never from input.
- **Auth is per router:** `router.use('/v1/<module>', authenticate(deps))`, then `requireAbility(action, subject)` on **every** route (CASL, typed). Public routes (login, refresh, public gym data) are the explicit exception and are rate-limited. Use `currentUser(req)` for the caller. When adding a subject, update the `Subject` type in `src/auth/ability.ts`, and tell the user to mirror it in the web app's `core/auth/ability.ts`.
- **Responses:** handlers call `ok(res, data, message?, status?)`, which writes the envelope `{ code, message, data }`. Errors are thrown as `AppError(status, message, errors?)`; Express 5 forwards async throws to `errorHandler` (`src/lib/errors.ts`). No try/catch in handlers just to format errors.
- **HTTP codes:** `ok()` answers 200 by default. Pass `201` only for a create; actions (freeze, check-in, login) stay 200. Wrong credentials answer 400, not 401 (the web app treats 401 as "session expired").
- **Routes:** declare static paths (`/v1/members/export`) before parameter paths (`/v1/members/:oid`).
- **Wire format** (the web app depends on it): `snake_case` fields, `oid` for IDs, ISO dates.
- **Money:** `Decimal(12,2)` / `NUMERIC`, never a float. Currency is BDT.
- **Time:** `timestamptz`. Plain `date` columns are read as text (`::text`), so no time zone shifts them.
- **Financial rows are never deleted or edited in place.** Fix mistakes with reversing entries. Master data uses soft delete (`deleted_at`).
- **Audit:** every write produces an audit entry (who, what, before and after), written in the same transaction.
- **Payments:** recorded by hand only (cash, card, bank, bKash, Nagad, each non-cash method with its reference). No payment gateway, ever (D-075).
- **Attendance:** check-ins go through the **access rules engine**, a pure function with table-driven tests. Overrides require a reason and are audited. Check-in is by search or a USB barcode scanner; no RFID (D-075).
- **Messages:** `notify()` writes an in-app message (`notification` row); nothing is sent. Staff pass one on by hand from the member profile (SMS or email link, copy).
- **Passwords:** `hashPassword`, `verifyAgainstDummy` and `needsRehash` take `config.auth.passwordHash` (`PASSWORD_SCRYPT_N/_R/_P`). The default is deliberately cheap for the Workers Free plan (10 ms CPU). Don't hard-code scrypt parameters and don't raise the default without measuring CPU per sign-in.
- **Logging:** `log()` from `src/lib/logger.ts` (pino, carries the request id). Never log request bodies, tokens or passwords.
- **Code style:** Prettier (4 spaces, single quotes, width 160). Imports are sorted by `simple-import-sort` (`npm run lint:fix`).

## Testing

- `createTestApp()` (`src/testing/test-app.ts`) builds the real app with `createApp(deps)` on a fresh database, an in-memory cache and file store. A time-based rule is tested by passing a movable clock (`createTestApp({}, { clock: () => now })`). Swap any dependency through its `overrides` argument. `signIn(t.app)` and `bearer(token)` give an authorised request.
- Test through HTTP with supertest. Cover: validation errors, 401/403 for each ability, branch isolation (once tenancy exists), and the main business rules.
- Local database (D-031): the machine's PostgreSQL **17** on the Unix socket, peer auth, no Docker. `npm run dev` uses the `fitmanager` database through `.env.local` (git-ignored); `npm test` still uses PGlite; `npm run test:pg` runs the same suite on throwaway `fm_test_*` databases on the local server. Because Neon is 18, use nothing that is new in PostgreSQL 18 (for example the built-in `uuidv7()`: generate UUID v7 in app code).
- New tenancy and RLS tests need the `fitmanager_app` role: your OS user has CREATEDB but not CREATEROLE on the local server, so create the roles once with `sudo -u postgres psql -d fitmanager -f ../fitmanager-infra/db/roles/001_roles.sql`.

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
