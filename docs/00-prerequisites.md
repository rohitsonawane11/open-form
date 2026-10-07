# 00 — Prerequisites & dependency audit

## Why

Every later document assumes a running Postgres, a valid `.env` and a complete dependency tree. Installing packages
piecemeal mid-build means you discover a missing peer dependency three files into a module. This document front-loads
all of it.

## 1. Toolchain

```bash
node --version    # v22 or newer (v24 verified)
pnpm --version    # v10 or newer (v11 verified)
docker --version
```

NestJS 11 requires Node 20+. If you use `nvm`, pin it so the version does not drift:

```bash
node --version | sed 's/^v//' > .nvmrc
```

## 2. Dependency audit

The repo already has most of what the PRD needs. Confirm:

```bash
pnpm list --depth=0
```

**Already installed — do not re-add:**

| Purpose | Package |
|---|---|
| Framework | `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` (v11) |
| Config | `@nestjs/config`, `joi` |
| Database | `@nestjs/typeorm`, `typeorm`, `pg` |
| Auth | `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-local`, `passport-jwt`, `passport-google-oauth20`, `argon2` |
| Validation | `class-validator`, `class-transformer`, `@nestjs/mapped-types` |
| API docs | `@nestjs/swagger` |
| Security | `helmet`, `cookie-parser`, `@nestjs/throttler` |
| Testing | `jest`, `ts-jest`, `supertest`, `@nestjs/testing` |

A note on `typeorm@1.1.1`: this is correct, not a typo. `@nestjs/typeorm@12`'s peer range is
`^0.3.0 || ^1.0.0-dev`, so the 1.x line is the intended pairing. Confirm with:

```bash
cat node_modules/typeorm/package.json | grep '"version"'
cat node_modules/@nestjs/typeorm/package.json | grep -A3 peerDependencies
```

**To install now** — this is the complete list for documents 00 through 19, so there are no surprise installs later:

```bash
pnpm add nodemailer
pnpm add -D @types/nodemailer
```

That is all. The design deliberately avoids further dependencies:

| Need | Choice | Why not a library |
|---|---|---|
| Structured logging | Nest's built-in `Logger`, subclassed (doc 04) | PRD §14 asks only for "basic scrubbed structured logs". Swapping to `nestjs-pino` later is a one-file change, documented in doc 04. |
| Health checks | Hand-rolled `DataSource.query('SELECT 1')` (doc 08) | PRD §12 needs exactly two routes. `@nestjs/terminus` is noted as an optional upgrade in doc 08. |
| CSV export | Hand-written streaming writer (doc 17) | PRD §9 requires spreadsheet-formula neutralization, which no CSV library does by default — you would write that guard regardless. |
| UUID generation | Postgres `gen_random_uuid()` via `pgcrypto` (doc 03) | The database already generates them. |

## 3. Environment file

`ConfigModule.forRoot()` has no `envFilePath`, so it loads `.env` from the **repository root** — the working directory
`nest start` runs in.

There is an empty, stray `src/.env` in the tree. It is never read. Delete it so nobody edits it expecting an effect:

```bash
rm -f src/.env
```

Create your working env file from the example:

```bash
cp .env.example .env
```

Doc 02 rewrites both files with the full variable set. For now, the five `DB_*` variables are enough to boot.

### Secrets management

`.infisical.json` is present, suggesting [Infisical](https://infisical.com) is intended for secrets. It is not wired
into any script and its `defaultEnvironment` is empty. These documents use a plain `.env`. If you want Infisical as
the source of truth instead, the equivalent commands are:

```bash
infisical run --env=dev -- pnpm start:dev
infisical run --env=dev -- pnpm migration:run
```

Either way, add the file to version control hygiene — it is currently untracked and un-ignored:

```bash
grep -q '^\.infisical\.json$' .gitignore || echo '.infisical.json' >> .gitignore
```

(It contains only a workspace ID, no secret, so committing it is also defensible — just make it a deliberate choice.)

## 4. Start Postgres

`docker-compose.yml` already defines a Postgres 16 service with a healthcheck and a named volume.

```bash
docker compose up -d
docker compose ps
```

Wait for the `postgres` service to report `healthy` — the healthcheck polls `pg_isready` every 5s with a 10s start
period.

## 5. Clear the stale build

A `dist/` directory from a previous build is on disk and contains files for source that no longer exists (for example
`dist/modules/users/users.controller.js`). `nest build` has `deleteOutDir: true`, but clear it now so nothing stale
runs:

```bash
rm -rf dist
```

## Verify

```bash
# 1. Postgres is up and accepting connections
docker compose exec postgres pg_isready -U openform -d openform
# expected: /var/run/postgresql:5432 - accepting connections

# 2. Credentials in .env actually work
docker compose exec postgres psql -U openform -d openform -c 'select version();'
# expected: a PostgreSQL 16.x version string

# 3. The app boots against it
pnpm start:dev
# expected: "Nest application successfully started", no TypeORM connection error
# Ctrl-C to stop.

# 4. Baseline lint and build are clean
pnpm lint && pnpm build
```

If step 3 prints a `ECONNREFUSED` or `password authentication failed`, your `.env` `DB_*` values disagree with the
`POSTGRES_*` values the container was created with. The volume persists the original credentials, so changing `.env`
alone will not help — recreate it:

```bash
docker compose down -v && docker compose up -d
```

## If you skip this

Doc 03 generates migrations by connecting to a live database; without Postgres running, the TypeORM CLI fails with a
connection error that looks like a configuration bug. The `nodemailer` install is needed in doc 14, mid-way through the
auth flow.

---

Next: [01 — Module layout cleanup](./01-module-layout.md)
