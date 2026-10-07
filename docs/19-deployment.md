# 19 — Docker, deployment & README

## Why

PRD §14:

> Deploy one NestJS API, PostgreSQL and Next.js frontend. Docker Compose supports local development. Email/Google
> credentials are environment settings; commit placeholders only. Document backups, restore and deployment
> migrations. CI runs lint, typecheck, meaningful tests and builds. README includes screenshots, demo, setup and
> ownership/security model.

And §15 defines completion partly as:

> a fresh documented deployment works without manual database changes.

That last clause is the acceptance criterion for this document: someone with the repository and an empty database
should get a running API from the written instructions alone.

There is also a correctness problem to fix. `README.md` currently describes the **superseded** product — multi-tenant
businesses, an RBAC role matrix, API keys, webhooks, Redis and BullMQ — all of which `target.md` v4.0 explicitly
deletes. It also links to `docs/architecture.md`, `docs/tenancy.md` and `docs/roadmap.md`, none of which exist.

## 1. Production Dockerfile

```dockerfile
# Dockerfile
# ---- build ----------------------------------------------------------
FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Drop dev dependencies from the tree that gets copied forward.
RUN pnpm prune --prod

# ---- runtime --------------------------------------------------------
FROM node:24-alpine AS runtime

# Signal handling: without an init process, PID 1 ignores SIGTERM and the
# container is SIGKILLed after the grace period — so enableShutdownHooks()
# (doc 07) never runs and TypeORM never closes its pool.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# Never run as root.
RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./

USER app
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
```

```
# .dockerignore
node_modules
dist
coverage
.git
.github
.env
.env.*
!.env.example
*.md
docs
test
.idea
.vscode
```

Excluding `.env` is not cosmetic. Without it the build context carries your real secrets into an image layer, where
they survive even if a later layer deletes the file.

## 2. Compose

The existing file has Postgres. The full development stack:

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    container_name: openform-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-openform}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-openform}
      POSTGRES_DB: ${POSTGRES_DB:-openform}
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-openform} -d ${POSTGRES_DB:-openform}"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s

  # Disposable database for `pnpm test:e2e` (doc 18).
  postgres-test:
    image: postgres:16-alpine
    container_name: openform-postgres-test
    environment:
      POSTGRES_USER: openform
      POSTGRES_PASSWORD: openform
      POSTGRES_DB: openform_test
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U openform -d openform_test"]
      interval: 3s
      retries: 10

  # Local inbox for verification and reset emails (doc 14).
  mailpit:
    image: axllent/mailpit:latest
    container_name: openform-mailpit
    restart: unless-stopped
    ports:
      - "8025:8025"   # web UI
      - "1025:1025"   # SMTP

  api:
    build: .
    container_name: openform-api
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file: .env
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      SMTP_HOST: mailpit
      SMTP_PORT: 1025
      TRUST_PROXY: "true"
    ports:
      - "${PORT:-3000}:3000"
    healthcheck:
      # Uses doc 08's readiness route, so an instance that cannot reach
      # Postgres is taken out of rotation rather than restarted.
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 20s
    profiles: ["full"]

volumes:
  postgres-data:
```

The `api` service sits behind a profile so `docker compose up -d` gives you just the dependencies for
`pnpm start:dev`, which is the normal development loop. `docker compose --profile full up -d` runs the whole stack.

## 3. Migrations on deploy

PRD §10: *"Production uses migrations, not automatic schema synchronization."* Doc 03 set `migrationsRun: false`, so
this is a deliberate deploy step:

```bash
# Run before the new image starts serving.
docker compose run --rm api node -e "
  require('./dist/database/data-source').default.initialize()
    .then(ds => ds.runMigrations())
    .then(ms => { console.log('Applied:', ms.map(m => m.name)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
"
```

Or as a script:

```json
"migration:run:prod": "node ./node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run"
```

**Do not set `migrationsRun: true`.** With multiple replicas, every container races to apply the same migration on
boot; with one, a crash-looping container can half-apply one and leave the schema in a state neither the old nor the
new code expects.

### Deploy order

1. Apply migrations (backward-compatible with the running version)
2. Deploy the new image
3. Watch `/health/ready`
4. Only then apply any destructive follow-up migration (dropping a column the old code still reads)

That split is what makes a rollback possible between steps 2 and 4.

## 4. Backup and restore

PRD §14 requires these to be documented.

```bash
# Backup — custom format, compressed, restorable selectively.
docker compose exec -T postgres pg_dump \
  -U openform -d openform -Fc \
  > "backups/openform-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Verify the dump is readable — an untested backup is not a backup.
pg_restore --list backups/openform-20261008T120000Z.dump | head

# Restore into a clean database.
docker compose exec -T postgres psql -U openform -d postgres \
  -c 'DROP DATABASE IF EXISTS openform_restore' \
  -c 'CREATE DATABASE openform_restore'
docker compose exec -T postgres pg_restore \
  -U openform -d openform_restore --no-owner \
  < backups/openform-20261008T120000Z.dump

# Confirm it came back.
docker compose exec postgres psql -U openform -d openform_restore \
  -c 'select count(*) from users; select count(*) from submissions;'
```

Two notes. Keep backups off the host running Postgres — a dump on the same disk does not survive the failure it
exists for. And practise the restore before you need it; the first time should not be during an incident.

## 5. CI

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: openform
          POSTGRES_PASSWORD: openform
          POSTGRES_DB: openform_test
        ports:
          - 5433:5432
        options: >-
          --health-cmd "pg_isready -U openform -d openform_test"
          --health-interval 5s --health-timeout 5s --health-retries 10

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      # PRD §14: "CI runs lint, typecheck, meaningful tests and builds."
      - name: Lint
        run: pnpm lint --max-warnings=0

      - name: Typecheck
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test

      - name: E2E tests
        run: pnpm test:e2e
        env:
          NODE_ENV: test
          DB_HOST: localhost
          DB_PORT: 5433
          DB_USERNAME: openform
          DB_PASSWORD: openform
          DB_NAME: openform_test
          JWT_ACCESS_SECRET: ci-access-secret-at-least-32-characters-long
          JWT_REFRESH_SECRET: ci-refresh-secret-at-least-32-characters-long
          MAIL_TRANSPORT: console
          ARGON2_MEMORY_COST: 8192
          THROTTLE_LIMIT: 10000
          SUBMISSION_THROTTLE_LIMIT: 10000

      - name: Build
        run: pnpm build

      - name: Docker build
        run: docker build -t openforms-api:ci .
```

`pnpm lint --max-warnings=0` is deliberate. The ESLint config sets `no-floating-promises` to *warn*, and an unawaited
promise in a transaction is exactly the kind of bug that produces an intermittent failure in production.

## 6. Production environment

Everything the Joi schema (doc 02) requires, with production values:

```bash
NODE_ENV=production
PORT=3000
APP_URL=https://api.openforms.example
FRONTEND_URL=https://openforms.example
TRUST_PROXY=true                   # PRD §8: real client IP behind the LB

DB_HOST=…
DB_PORT=5432
DB_USERNAME=…
DB_PASSWORD=…                      # from a secret store, not this file
DB_NAME=openform
DB_LOGGING=false                   # query logs can contain answer data

JWT_ACCESS_SECRET=…                # 48 random bytes, distinct
JWT_REFRESH_SECRET=…               # 48 random bytes, DIFFERENT
JWT_ACCESS_TTL=15m
REFRESH_TTL_DAYS=30

COOKIE_SECURE=true                 # PRD §4: Secure cookie in production
COOKIE_SAME_SITE=lax
COOKIE_DOMAIN=.openforms.example

ARGON2_MEMORY_COST=19456           # PRD §4: tune for deployment capacity
ARGON2_TIME_COST=2

GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
GOOGLE_CALLBACK_URL=https://api.openforms.example/api/v1/auth/google/callback

MAIL_TRANSPORT=smtp
MAIL_FROM=OpenForms <no-reply@openforms.example>
SMTP_HOST=…
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=…
SMTP_PASSWORD=…
```

PRD §14: *"Email/Google credentials are environment settings; commit placeholders only."* `.env.example` carries the
keys with placeholder values; real values come from the platform's secret store.

### Production checklist

- [ ] HTTPS terminated in front of the API (PRD §14)
- [ ] `TRUST_PROXY=true` and the proxy's forwarded headers verified — otherwise §8's per-IP limit sees one client
- [ ] `COOKIE_SECURE=true`
- [ ] `FRONTEND_URL` is the exact production origin (doc 07's CORS allowlist)
- [ ] Two distinct JWT secrets, neither from `.env.example`
- [ ] Swagger confirmed off: `curl https://api…/api/docs` returns 404
- [ ] Migrations applied; `synchronize` is false (doc 03 made it unconditional)
- [ ] A backup taken and a restore tested
- [ ] `/health/live` and `/health/ready` wired to the orchestrator's probes
- [ ] Logs confirmed free of credentials and answers (doc 18's log-hygiene suite)
- [ ] `ARGON2_MEMORY_COST` tuned against the production instance size

## 7. Rewrite the README

Replace the file entirely. The current one documents a product that no longer exists.

```markdown
# OpenForms

Create a form, publish a link, collect responses, export them. Each form belongs to the person who made it.

**Stack:** NestJS 11 · PostgreSQL 16 · TypeORM · Passport · Next.js (frontend, separate)

## Status

Backend implementation in progress. [`target.md`](./target.md) is the authoritative specification;
[`docs/`](./docs/README.md) is the step-by-step build guide.

## Quick start

```bash
git clone … && cd open-form
pnpm install
cp .env.example .env

# Generate the two JWT secrets
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))" >> .env
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))" >> .env

docker compose up -d          # Postgres + Mailpit
pnpm migration:run
pnpm start:dev
```

- API: http://localhost:3000/api/v1
- Docs: http://localhost:3000/api/docs
- Health: http://localhost:3000/health/ready
- Local inbox: http://localhost:8025

## Ownership and security model

Two actors: an authenticated **form owner**, and an **anonymous respondent**. There are no roles, teams or tenants.

- `forms.user_id` identifies the owner. Every private query is scoped to the authenticated user.
- Ownership lives in the **mutation predicate**, not in a preceding lookup.
- Another person's private resource returns **404, never 403** — the API does not confirm it exists.
- Nested submission routes verify the `(form_id, submission_id)` pair *and* ownership of the parent form.
- `userId` is always derived from the access token. It is rejected if it appears in a request body.
- Public endpoints expose only published rendering data. A submission receipt grants no read access.

## API

25 product endpoints under `/api/v1`, plus `/health/live` and `/health/ready`. Full catalogue in
[`target.md` §12](./target.md) or at `/api/docs` when running.

| Group | Count |
|---|---|
| Auth | 10 |
| Users | 2 |
| Forms | 7 |
| Submissions | 4 |
| Public | 2 |

Errors share one envelope: `{ statusCode, code, message, requestId, errors? }`.

## Testing

```bash
docker compose up -d postgres-test
pnpm test        # unit
pnpm test:e2e    # integration, against a real Postgres
```

## Documentation

| Document | Contents |
|---|---|
| [`target.md`](./target.md) | Product specification (PRD v4.0) |
| [`docs/`](./docs/README.md) | Step-by-step build guide, 00–19 |
| [`docs/19-deployment.md`](./docs/19-deployment.md) | Deployment, backups, CI |

## License

TODO — to be chosen before first public release.
```

PRD §14 also asks for screenshots and a demo link. Add those once the Next.js frontend exists; note the gap rather
than leaving a stale claim.

## Verify

The §15 acceptance criterion — *"a fresh documented deployment works without manual database changes"* — tested
literally:

```bash
# 1. Clone into a clean directory and follow the README verbatim
cd $(mktemp -d)
git clone <repo> openform && cd openform
pnpm install
cp .env.example .env
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))" >> .env
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))" >> .env
docker compose up -d
pnpm migration:run
pnpm start:dev
# expected: a working API, with NO psql commands typed by hand

# 2. The full journey against that fresh instance
API=localhost:3000/api/v1
curl -s -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct-horse-battery"}' | jq -r .accessToken
# → verify email from the Mailpit inbox at :8025
# → create form → publish → submit publicly → list responses → export CSV
# expected: every step succeeds

# 3. The image builds and runs
docker build -t openforms-api:local .
docker compose --profile full up -d
curl -s localhost:3000/health/ready | jq
# expected: {"status":"ok","db":"up"}

# 4. Production hardening holds
docker compose --profile full exec api env | grep NODE_ENV      # production
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/docs # 404

# 5. SIGTERM is handled (tini)
docker compose --profile full stop api
docker compose --profile full logs api | tail -5
# expected: a clean shutdown, no "connection terminated unexpectedly"

# 6. Backup and restore round-trip
docker compose exec -T postgres pg_dump -U openform -d openform -Fc > /tmp/test.dump
docker compose exec -T postgres psql -U openform -d postgres -c 'CREATE DATABASE restore_test'
docker compose exec -T postgres pg_restore -U openform -d restore_test --no-owner < /tmp/test.dump
docker compose exec postgres psql -U openform -d restore_test -c 'select count(*) from users;'
# expected: the same count as the source database

# 7. CI passes
gh workflow run ci.yml && gh run watch

# 8. The README no longer describes the old product
grep -iE 'tenant|business|api.key|webhook|bullmq|redis|RBAC' README.md
# expected: no output

# 9. No dead documentation links
grep -oE '\]\(\./[^)]+\)' README.md | sed 's/](\.\///;s/)//' | while read f; do
  [ -e "$f" ] || echo "MISSING: $f"
done
# expected: no output
```

Step 1 is the acceptance test. Run it in a genuinely clean directory — a `.env` or a Docker volume left over from
development is exactly what hides a missing instruction.

## If you skip this

PRD §15's completion criterion is unmet, and the README actively misleads: it documents businesses, roles, API keys
and webhooks that the code does not implement and the specification has removed.

---

Previous: [18 — Testing](./18-testing.md) · Back to the [index](./README.md)
