# Express skeleton (API)

A starter for Node.js APIs, distilled from the backend services of the celloscope projects (ACAS, ARDS, AUCTION, CU-Pay, IMS auth server, OMS services, Policy Repository, SIB, SPN, TRP) and the IB portals' Express mock servers. It carries over their **technologies and practices**, not their business features: the only domain is a generic `Item` CRUD, the same one the [Angular](../angular) and [React](../react) skeletons use, so both frontends run against it unchanged.

Every service studied is built on **hapi 20/21** in CommonJS JavaScript. This skeleton moves to **Express 5 + TypeScript**, as the IB Express code and the monorepo backend already do. Each pattern it carries over was checked against current versions; the outdated ones are listed under [Old → current](#old--current).

```bash
nvm use            # Node 26 (>= 24.12 works)
npm ci
# The schema and demo data come from fitmanager-infra/db (D-039); this API never migrates or seeds.
(cd ../fitmanager-infra/db && npm ci && PGLITE_DIR=../../fitmanager-api/storage/pglite npm run seed)
npm run dev        # http://localhost:3000/api — no database server needed (PGlite)
```

With `.env.local` pointing at a PostgreSQL server instead, run `DATABASE_URL=… npm run seed` in `../fitmanager-infra/db`. After a new migration lands there, run `npm run migrate` there again (stop the API first when it uses PGlite).

Sign in with the web demo's staff accounts (`fitmanager-infra/db/seeds/demo/001_branches_and_staff.sql`): `owner` / `Owner@123` (every branch through HQ), `manager.gulshan` / `Manager@123`, `desk.gulshan` / `Desk@123`, `desk.uttara` / `Desk@123` (front desk at two branches) and the rest of the list on the web app's `/demo` page. Rules apply per branch: send `X-Branch-Id` with a branch id from `/v1/auth/me`. Try the requests in [requests.http](requests.http) (VS Code REST Client), or point the web app at it:

```bash
cd ../fitmanager-web && API_TARGET=http://localhost:3000 npm run start:proxy   # http://localhost:4200
```

## Scripts

| Command                        | What it does                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `npm run dev`                  | API with auto-restart (`node --watch`), PGlite in `storage/pglite`, pretty logs, mail logged            |
| `npm start`                    | Production start (what the Docker image runs)                                                           |
| `npm test` / `npm run test:ci` | Vitest (watch) / one run with coverage                                                                  |
| `npm run test:pg`              | One run on a real PostgreSQL: `TEST_DATABASE_URL` from `.env.local`, a throwaway database per test file |
| `npm run typecheck`            | `tsc --noEmit`                                                                                          |
| `npm run lint` / `format`      | ESLint 10 (type-checked) / Prettier                                                                     |
| `npm run validate`             | format check + typecheck + lint + tests, the CI gate                                                    |
| `k6 run load-test/smoke.js`    | Load test with thresholds (needs [k6](https://k6.io))                                                   |
| `docker compose up -d`         | Local PostgreSQL 18, Redis and Mailpit, for running the way a server does                               |

There is **no build step**: Node runs the `.ts` files itself (type stripping, stable since Node 24.12). `tsc` only type-checks. The code is therefore limited to syntax that can be erased (no `enum`, no `namespace`, no constructor parameter properties), and `erasableSyntaxOnly` enforces that. Imports use `.ts` extensions and the `#src/*` subpath alias from `package.json`, which Node, TypeScript and Vitest all understand without extra config.

## Layout

```
../fitmanager-infra/db/            migrations, demo seeds and their runner (D-039): the schema is not this repo's job
src/
  server.ts            process entry: config → logger → deps → listen → jobs; graceful shutdown
  instrument.ts        Sentry (loaded with --import, before the app)
  app.ts               createApp(deps): middleware order, routers, 404, error handler (no listening, no globals)
  container.ts         AppDeps: db, cache, mailer, pdf, tokens, recaptcha, redis, all created once, injectable
  config/env.ts        every env var, validated with Valibot; <NAME>_FILE secrets
  db/                  Db interface (pg | PGlite), sql`` tagged template
  auth/                CASL abilities, scrypt passwords, jose tokens, refresh rotation, authenticate/requireAbility
  lib/                 http envelope + parse(), errors, logger, cache, rate limit, mailer, templates, pdf, metrics, scheduler, recaptcha
  features/<name>/     one router per feature (+ repo, schema, tests): auth, items, ddl, files, mail, otp, health
  jobs/                scheduled jobs (cleanup)
  templates/           Handlebars: PDF report, mail layouts
  testing/             createTestApp() on a fresh PGlite, signIn() helper
```

To add a feature, copy `features/items`: a Valibot schema, a repository with SQL, a router with `authenticate` + `requireAbility(...)`, and a test file. Mount it in `app.ts`. Add the subject to `auth/ability.ts` **and** the frontends' `ability.ts`.

## Technologies: projects → skeleton

| Concern                 | In the projects                                                              | Here                                                                                            | Why                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Framework               | hapi 20/21 + 10 plugins                                                      | **Express 5**                                                                                   | Async errors handled natively (no try/catch in each handler), the ecosystem the IB code already uses                                  |
| Language                | CommonJS JavaScript                                                          | **TypeScript 6**, ESM, run natively by Node                                                     | Types for the request/DB boundary, no build step. TypeScript 6, not 7: typescript-eslint does not support 7 yet                       |
| Validation              | joi + `failAction` + generic messages                                        | **Valibot 1**, `parse(schema, input)`                                                           | Modular and tree-shakeable (small Workers bundle); one schema gives the type too; one error per field (`errors: [{ path, message }]`) |
| Routing                 | hapi-router / hapi-auto-route (glob of `src/routes/**`)                      | One `Router` per feature, mounted in `app.ts`                                                   | One place lists the API; a stray file cannot become a public route                                                                    |
| Auth tokens             | hapi-auth-jwt2 + jsonwebtoken 8 (HS256, shared secret)                       | **jose**: HS256 with `iss`/`aud` checked, + optional JWKS (Keycloak, the in-house OAuth server) | jsonwebtoken 8 has CVEs; JWKS means the API holds no secret that can mint tokens                                                      |
| Refresh tokens          | JWT signed with a 2nd secret, stored in plain text, never rotated            | Random 256-bit, stored as SHA-256, **rotated** with reuse detection and a grace window          | A DB leak exposes no usable token; a stolen token is detected on replay                                                               |
| Authorization           | hapi-authorization registered with `roles: false` and switched off per route | **CASL**, the same rules sent to the frontends in `/me`                                         | The hidden button and the refused request come from the same rule                                                                     |
| Passwords               | bcrypt (native) or bcryptjs                                                  | **scrypt** (node:crypto), legacy bcrypt hashes verified and upgraded on sign-in                 | No native add-on; memory-hard; migrates existing databases without a reset                                                            |
| Database                | `pg` / `oracledb`, string-built SQL, a `dao.js` per service                  | **pg** pool + `sql` tagged template + `Db` interface; **PGlite** for dev and tests              | Injection-proof by construction; real PostgreSQL in tests, no server                                                                  |
| Migrations              | one hand-run `db.sql`                                                        | `migrations/*.sql`, applied in one transaction under an advisory lock                           | Every environment knows its version; two replicas cannot migrate at once                                                              |
| Logging                 | winston + daily-rotate-file, files inside the container                      | **pino** + pino-http, JSON to stdout, redaction, request id via AsyncLocalStorage               | promtail already ships Docker stdout to Loki; one request id across nginx → API                                                       |
| Cache                   | ioredis / redis@3 (callback API), ACAS cache-aside                           | **ioredis 6**, ACAS's single-flight cache-aside ported; memory fallback                         | Kept the one pattern that prevented an incident                                                                                       |
| Rate limiting           | hapi-rate-limit (disabled)                                                   | **express-rate-limit 8**, Redis store when `REDIS_URL`                                          | Actually on; 429 + `Retry-After`; shared across replicas                                                                              |
| Mail                    | nodemailer + handlebars, transporter built per request                       | **nodemailer 10** + handlebars (compiled once), **sanitize-html** for editor HTML               | One pooled transport; HTML from a request is sanitised before it reaches a mailbox                                                    |
| OTP                     | otplib TOTP + `Math.random()` offset                                         | `crypto.randomInt`, HMAC-stored, TTL + 5 attempts + single use                                  | See [bugs](#bugs-found-in-the-projects)                                                                                               |
| PDF reports             | node-jasper (JVM) or Puppeteer (new browser per request)                     | **puppeteer-core**, one shared browser, max 3 pages, JS + network off                           | Bangla shaping works (Chrome), no Java, no leaked browsers                                                                            |
| Excel / CSV             | exceljs, xlsx 0.18.5, csv-writer                                             | **exceljs** streamed; CSV hand-written with escaping and formula guard                          | xlsx on npm is abandoned and vulnerable                                                                                               |
| Jobs                    | node-cron / setInterval, in every replica                                    | **croner** + PostgreSQL advisory lock                                                           | Runs once per schedule, not once per replica                                                                                          |
| Health                  | hapi-alive (always "running") + hapijs-status-monitor page                   | `/health/live`, `/health/ready` (DB + Redis), **prom-client** `/metrics`                        | Readiness means something; Prometheus (already deployed) can scrape the app                                                           |
| Errors                  | Sentry with hard-coded DSN in one service                                    | **@sentry/node 11** from env, 5xx only, request bodies not collected                            |                                                                                                                                       |
| Security headers / CORS | none / `origin: ['*']`                                                       | **helmet**, CORS allow-list (empty = off)                                                       |                                                                                                                                       |
| Uploads                 | hapi multipart stream, extension check                                       | **multer 2** (memory, size limit) + **file-type** (magic bytes)                                 |                                                                                                                                       |
| Config                  | dotenv per `NODE_ENV` + `/run/secrets` when not `loc`                        | `node --env-file`, Valibot-validated, `<NAME>_FILE`                                             | Fails at startup with the full list of problems                                                                                       |
| Dev loop                | nodemon                                                                      | `node --watch`                                                                                  | Built in                                                                                                                              |
| Tests                   | mocha + chai-http + mochawesome (mostly "no test specified")                 | **Vitest 5** + **supertest** on PGlite                                                          | 63 tests, ~15 s, 90–93 % line coverage                                                                                                |
| Lint                    | ESLint 8 + sonarjs (SIB), prettier-eslint                                    | ESLint 10 type-checked + simple-import-sort + Prettier                                          | Same setup as the frontend skeletons                                                                                                  |
| Load testing            | k6 (ACAS 17-load-testing)                                                    | `load-test/smoke.js` with thresholds                                                            |                                                                                                                                       |
| Container               | `node18-oracleclient-bullseye`, `npm install`, root                          | `node:26-alpine`, `npm ci --omit=dev`, user `node`, tini, HEALTHCHECK, test stage               | Node 18 is end-of-life                                                                                                                |

## Old → current

Outdated APIs and versions in the projects' code, and what replaces them here.

| Old (where)                                                                                 | Current                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 18 base image (all Dockerfiles)                                                        | Node 26 (LTS since Oct 2026); engines `>=24.12`                                                                                                                                                                                         |
| `require('dotenv').config({ path })`, repeated in several modules                           | `node --env-file=… --env-file-if-exists=…`                                                                                                                                                                                              |
| `nodemon`                                                                                   | `node --watch`                                                                                                                                                                                                                          |
| `@hapi/joi` (deprecated package name) next to `joi` in the same package.json                | Valibot 1                                                                                                                                                                                                                               |
| `jsonwebtoken@8` (CVE-2022-23539/23540/23541, fixed in v9)                                  | `jose` 6                                                                                                                                                                                                                                |
| `axios@0.23` (ACAS, Policy Repository; SSRF and CSRF advisories)                            | native `fetch` + `AbortSignal.timeout`                                                                                                                                                                                                  |
| `moment` / `moment-timezone` (maintenance mode)                                             | `Intl.DateTimeFormat` with `timeZone: 'Asia/Dhaka'`; PostgreSQL `timestamptz`                                                                                                                                                           |
| `underscore` (`_.clone`, `_.extend`), `core-util-is`, `bluebird`, `uuid`, `ms@3.0.0-canary` | spread / `structuredClone`, `??`, native promises, `crypto.randomUUID()`                                                                                                                                                                |
| `redis@3` (callback API, unmaintained)                                                      | ioredis 6                                                                                                                                                                                                                               |
| `xlsx@0.18.5` (prototype pollution, ReDoS; newer versions only on the SheetJS CDN)          | exceljs 4 (its `uuid@8` dependency is overridden to a fixed 11.x)                                                                                                                                                                       |
| `node-jasper@0.2.5` (last published 2016, needs a JVM)                                      | HTML template + puppeteer-core                                                                                                                                                                                                          |
| `puppeteer@19` with `headless: "new"`                                                       | puppeteer-core 25 (`headless: true` is the new mode)                                                                                                                                                                                    |
| `oracledb` with Instant Client in the image                                                 | node-oracledb 6+ THIN mode needs no client libraries (Oracle is not implemented here; see [Database](#database))                                                                                                                        |
| `@sentry/node` 10 `setupHapiErrorHandler`, `sendDefaultPii: true`                           | Sentry 11: the Express integration captures errors itself (`setupExpressErrorHandler` is deprecated), and `sendDefaultPii` was replaced by `dataCollection`, whose **defaults collect request bodies**; switched off in `instrument.ts` |
| `eslint@8` + `.eslintrc` + eslint-plugin-sonarjs 0.24 (SIB)                                 | ESLint 10 flat config                                                                                                                                                                                                                   |
| `prettier-eslint`                                                                           | Prettier + eslint-config-prettier                                                                                                                                                                                                       |
| `@types/redis@4` installed next to `redis@3` (TRP, Bima Tathya)                             | typings ship with the libraries                                                                                                                                                                                                         |

## Bugs found in the projects

None of these is copied. Each is fixed in the skeleton, and most have a test.

**Security**

- **SQL injection.** The ACAS admin API builds `limit ${request.query.limit} offset ${request.query.offset}` into SQL strings (`get-complaint-list.js` and three more routes). → `sql` tagged template; paging values are Valibot-validated numbers. Test: `sql.test.ts`, `items.test.ts`.
- **Usernames revealed.** SPN sign-in answers "User not found" and "User ID/Password does not match" separately, and faster for unknown users. → one message, and a dummy hash check that takes the same time.
- **Passwords in the logs.** Handlers log `JSON.stringify(request.payload)`, and the masking regex looks only at a JSON object at the end of the message. → request bodies are never logged; pino `redact`.
- **Refresh tokens.** They are stored in plain text, never rotated, and the revocation check reads `token.revoked` on a _string_, so it never fires (SPN `validate_token`). → hashed, rotated, reuse revokes the session. Test: `auth.test.ts`.
- **Guessable OTPs.** The OMS/CU-Pay OTP is a 4-digit `Math.random()` number, stored as an offset from a TOTP whose secret is in the same row, so the table reveals every code. Verification has no attempt limit, so all 9 000 codes can be tried before it expires. → see `otp.routes.ts`. Test: `otp.test.ts`.
- **CORS.** `origin: ['*']` in every service. → allow-list.
- **Upload type by extension.** An HTML file renamed `.png` is accepted. → magic bytes. Test: `files.test.ts`.
- **Hard-coded Sentry DSN and `sendDefaultPii: true`** (OMS sec-service).
- **Rate limiting off.** Policy Repository's limiter is registered with `enabled: false`, and its limit response is HTTP 201.
- **Shared secrets in the auth server.** IMS's yar cookie password is the literal `"your-32-character-minimum-password-here"`.

**Correctness**

- **Upload reports success before the write.** `file_data.pipe(ws)` is not awaited, so "Successfully uploaded" is sent before the file is written, and a write error is lost.
- **Errors inside HTTP 200.** Failures answer HTTP 200 with `code` 201/202/203/204 in the body. Monitoring and Sentry see successes. → real status codes, same envelope (both frontends handle either).
- **Leaked Chrome.** OMS starts a new Puppeteer browser per report, and never closes it when rendering throws.
- **Jobs run once per replica.** node-cron / `setInterval` in Swarm services with 2+ replicas runs each job on every replica. → advisory lock.
- **Deploys cut requests.** There is no graceful shutdown: SPN has no SIGTERM handler, and IMS exits without closing the server or the pool. → `server.ts`.
- **Sporadic 502s behind the pooled nginx.** ACAS's nginx now keeps upstream connections open (`keepalive 256`, added after the load tests), but Node closes idle sockets after 5 s by default, so nginx sometimes reuses a socket the API has just closed. → `keepAliveTimeout` 65 s.
- **Unbounded `cache.get_or_set`.** ACAS's otherwise excellent cache stores entries with no TTL by default. → TTL always.
- **ANSI colour codes in log files** (`colorize({ all: true })` on file transports).
- **`onRequest` writes a header into the request** (`request.headers['request-time']`) and uses `enterWith` for the trace id. The id then leaks into unrelated async work.

## Not carried over

| What                                                                                          | Why                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment gateways (sslcommerz-lts, shurjopay), NID verification, complaint/donation/HR modules | Business features                                                                                                                                          |
| socket.io (SIB), @hapi/nes (OMS notification)                                                 | Declared in package.json but **not used** anywhere in the code. Add `ws` or socket.io when a feature needs push                                            |
| sharp (ACAS image dimensions)                                                                 | Native libvips; add it when an image pipeline is needed                                                                                                    |
| blipp (route table at startup)                                                                | Routes are listed explicitly in `app.ts` and in `requests.http`                                                                                            |
| hapijs-status-monitor                                                                         | Replaced by Prometheus metrics                                                                                                                             |
| @hapi/yar sessions, @hapi/vision server-rendered login page (IMS)                             | Those belong to an OAuth/identity server. This API is a resource server that can trust one (`OIDC_*`)                                                      |
| mysql2, xml2js, archiver, csv-reader, zip-local (single uses in OMS/Policy Repository)        | Feature-specific                                                                                                                                           |
| Oracle adapter                                                                                | No database to test it against. The `Db` interface is the seam: implement `query`/`exec`/`transaction` with node-oracledb (thin mode) and `:1`-style binds |

## API

The envelope is `{ code, message, data }` with `code` equal to the HTTP status; validation errors add `errors: [{ path, message }]`. Lists return `data: { rows, count }`.

| Method & path                                                    | Permission                    | Notes                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/auth/login`                                        | public, rate-limited          | `{ username, password, recaptcha_token? }` → `{ access_token, refresh_token, token_type, expires_in }` |
| `POST /api/v1/auth/refresh`                                      | public, rate-limited          | `{ refresh_token }` → a new pair (rotation)                                                            |
| `POST /api/v1/auth/logout`                                       | signed in                     | `{ refresh_token }` ends this session; without it, every session                                       |
| `GET /api/v1/auth/me`                                            | signed in                     | D-034: `{ user_id, name, kind, rules, assignments[{ branch, role, rules }], all_branches, member }`    |
| `GET /api/v1/ddl?ddl_key=category`                               | signed in                     | cached lookups                                                                                         |
| `GET /api/v1/items`                                              | read Item                     | `offset, limit (≤100), search_text, status, category_oid, sort_by, sort_order`                         |
| `GET /api/v1/items/export?format=csv\|xlsx`                      | export Item                   | same filters, all matching rows                                                                        |
| `GET /api/v1/items/:oid` · `/:oid/pdf`                           | read Item                     | PDF needs `CHROME_PATH` (else 501)                                                                     |
| `POST` · `PUT /:oid` · `DELETE /:oid` `/api/v1/items`            | create / update / delete Item | 409 duplicate name, 400 unknown category                                                               |
| `POST /api/v1/files/upload` · `GET /api/v1/files/:name`          | signed in                     | multipart `file`; JPG/PNG/PDF by content, `UPLOAD_MAX_BYTES`                                           |
| `POST /api/v1/mail/send`                                         | manage Settings (HQ)          | `{ to[], subject, body (HTML) }`, sanitised                                                            |
| `POST /api/v1/otp/send` · `/verify`                              | signed in                     | `{ email }` → `{ otp_id }`; `{ otp_id, code }`                                                         |
| `GET /api/v1/public/site-groups`                                 | public, cached 60 s           | D-040: each group's `section` and `page` switch (`null` = it has none), `required`, in order           |
| `GET` · `PATCH /:key {section?, page?}` `/api/v1/hq/site-groups` | read / update Settings (HQ)   | 409 when switching off part of a required group (home, programs, membership, facilities)               |
| `GET /health/live` · `/health/ready` · `/metrics`                | internal                      | outside `/api`, so nginx does not expose them                                                          |

## Configuration

All variables are in [.env.example](.env.example) and validated in [src/config/env.ts](src/config/env.ts); the app refuses to start with any invalid one and lists them all. `NODE_ENV` defaults to `production`. Production also refuses PGlite and the development JWT secret.

**Secrets** come from files. `JWT_SECRET_FILE=/run/secrets/jwt` reads the file into `JWT_SECRET`, and the same works for `DATABASE_URL`, `REDIS_URL`, `SMTP_URL`, `RECAPTCHA_SECRET` and `OTP_SECRET`. This is the convention of the official postgres/redis images, and it works the same in Swarm, Compose and Kubernetes. **Non-secret config** is a plain env file mounted at `/app/.env` (the Swarm config that the pipelines already mount).

## Auth design

- **Access token:** a JWT (HS256), 15 minutes, with `sub` = user id only (roles are per branch, so they are not in the token); `iss` and `aud` are checked. Each request verifies it in memory and reads the user's profile and rules from the cache (30 s), not from the database every time.
- **Refresh token:** opaque, 7 days, stored as SHA-256. Each refresh issues a new one and retires the old one. Replaying a retired token revokes the whole sign-in "family". Within `REFRESH_REUSE_GRACE` (30 s) a replay is treated as two tabs refreshing at once and gets a new token. Both frontends already single-flight their refreshes, and the Angular one already avoids re-refreshing after a race.
- **External IdP:** set `OIDC_ISSUER`, `OIDC_JWKS_URL` and `OIDC_AUDIENCE`, and tokens from Keycloak (IB portals) or the in-house OAuth server (IMS) are accepted. They are verified against the provider's public keys and mapped to the local user by `preferred_username`. Local tokens keep working alongside.
- **Authorization (D-034):** CASL rules per role (`app_role.rules`, JSON, versioned in migration 002). A user holds one role per branch (`staff_assignment`); `all_branches` users (the owner) reach every branch with their HQ role. The ability for a request is the global rules (by user kind) plus the rules of the assignment at `X-Branch-Id`, built in `authenticate`. Branch routes add `requireBranch('BRANCH' | 'HQ')` (403 for a branch the user does not work at) before `requireAbility(action, subject)`. Actions and subjects are typed, so a typo is a compile error. `/me` sends the same rules to the web app.
- **Passwords:** scrypt, `scrypt$N$r$p$salt$hash`. The cost of new hashes is `PASSWORD_SCRYPT_N`, `_R`, `_P`. The default (1024, 8, 1: about 2 ms of CPU) is cheap on purpose, for the 10 ms CPU limit of Cloudflare Workers on the Free plan; it is below OWASP's minimum, so raise it on a server (for example 131072, 8, 1). Hashes made with other settings still verify and are re-hashed at the next sign-in.
- **Login:** limited per IP + username, one message for unknown user and wrong password, and reCAPTCHA v3 (score and action checked) when `RECAPTCHA_SECRET` is set. Wrong credentials answer **400**, not 401, because the frontends treat 401 as "session expired" and would not show the message.

## Database

- **Drivers:** `DB_DRIVER=pg` (node-postgres pool, statement timeout, `application_name`) for every real environment; `pglite` (PostgreSQL 17 in WebAssembly) for `npm run dev` and the tests. Repositories only see `Queryable`.
- **SQL:** ``sql`… ${value} …` `` produces `$n` parameters. Fragments compose (`sql.where([...])`, `sql.join`). `sql.raw` is only for whitelisted identifiers (the ORDER BY map in `items.schema.ts`). `containsPattern()` escapes LIKE wildcards.
- **Pitfalls handled:** `date` is selected `::text` (node-postgres otherwise makes a JS Date at local midnight, which shifts a day across time zones; SPN works around it with `to_char` per query), `numeric` is `::float8`, counts are `::int` (pg returns bigint as a string), and unique/foreign-key violations map to 409/400.
- **Migrations and seeds are not the API's job (D-039):** `fitmanager-infra/db` holds `migrations/` and `seeds/demo/` and the runner that applies them (`npm run migrate | seed | status` there), and is run from a laptop for dev and prod while CI/CD is off (D-046). Deploy an API version only after the migrations it needs are applied. The tests build each throwaway database with the same runner (`src/testing/test-app.ts` imports `../fitmanager-infra/db/tools/runner.ts`), so CI and the Docker test stage need the infra repo next to this one (`docker build --build-context db=../fitmanager-infra/db .`).
- **Transactions:** `db.transaction(async tx => …)` rolls back on throw. When a change must survive a failure (an OTP attempt counter, a revoked session), the transaction **returns** an outcome and the error is thrown after the commit.

## Testing

`npm test` runs the real app (`createApp`) on a fresh in-memory PGlite per test file, with an in-memory mailer and cache, through supertest. There are no mocks of `pg`, and the SQL, constraints and migrations are the production ones. `db.test.ts` covers the `pg` driver itself over a real wire connection, using PGlite behind its socket server. `npm run test:pg` runs the same suite on a real PostgreSQL server instead: each test file creates its own `fm_test_<random>` database from `TEST_DATABASE_URL` (the role needs CREATEDB), migrates and seeds it with the infra runner, and drops it at the end. On this project's machines that is the local PostgreSQL 17 (`postgres:///postgres?host=/var/run/postgresql`, set in `.env.local`). The PDF tests run when `CHROME_PATH` points at a Chrome or Chromium binary and are skipped otherwise.

Verified for this skeleton: 63 tests, 93 % of lines with `CHROME_PATH` set (61 tests and 90 % without, since the 2 browser tests skip). Both frontend skeletons' Playwright suites (default tenant, 8 tests each) also pass against this API through their dev proxies.

## Deployment

- **Image:** `docker build --build-arg APP_VERSION=… .` builds the deps stage, then the test stage (format, typecheck, lint, tests; a failure stops the build), then the runtime: `node:26-alpine` with Chromium and Noto Bengali fonts for PDFs, `npm ci --omit=dev`, user `node`, tini, and a HEALTHCHECK on `/health/live`.
- **Swarm (VM only; CI/CD is off, D-046):** the [.gitlab-ci.yml.disabled](.gitlab-ci.yml.disabled) flow (rename it to `.gitlab-ci.yml` to turn it on) keeps the projects' build → service-update model. It adds secrets as files (migrations run from fitmanager-infra's pipeline), `start-first` updates with automatic rollback, and 2 replicas. Jobs are safe with 2+ replicas (advisory lock). So are rate limits and the cache, once `REDIS_URL` is set.
- **nginx:** proxy only `/api/`, and set `proxy_set_header X-Request-Id $request_id;` so nginx and API logs share an id. Set `TRUST_PROXY=1`. Node's keep-alive (65 s) is already longer than nginx's (60 s).
- **Observability:** add the service to Prometheus `scrape_configs` (`/metrics` on port 3000, internal network). The logs are JSON on stdout, which the existing promtail → Loki pipeline picks up. Filter by `reqId`.

## Known limitations

- **Not run here:** the Docker image, the GitLab pipeline and the Compose file (Docker isn't installed on this machine). The same goes for the Redis-backed paths: the cache logic is tested with a fake, but the rate-limit store and the readiness check haven't run against a live Redis. The Alpine package names (`chromium`, `font-noto-bengali`) are from the Alpine repositories and haven't been tried in a build.
- **k6:** the script is written but hasn't been run (k6 isn't installed here).
- **Large exports:** they load up to 50 000 rows into memory. For more, stream with a cursor (`pg-query-stream`).
- **Uploads:** files go to local disk (a volume). With several replicas, use a shared volume or object storage (S3/MinIO).
- **Dev-only audit warnings:** `npm audit` reports `minimatch` inside ESLint 10's own dependencies (dev only; it never handles untrusted input).
