# OpenForms backend — build documentation

These documents take the repository from the current NestJS skeleton to the MVP described in
[`../target.md`](../target.md) (PRD v4.0). They are **numbered and ordered**: each one assumes the previous ones are
done.

Every document has the same shape:

- **Why** — the PRD requirement it satisfies
- **The code** — what to create or change, in full
- **Verify** — a runnable command and the output you should see
- **If you skip this** — what breaks later

Do not advance past a `## Verify` block that fails.

## Order

### Phase A — foundation

| # | Document | Gives you |
|---|---|---|
| 00 | [Prerequisites & dependency audit](./00-prerequisites.md) | A running Postgres, a correct `.env`, and every dependency installed up front |
| 01 | [Module layout cleanup](./01-module-layout.md) | The six modules the PRD actually calls for |
| 02 | [Config & env validation](./02-config.md) | Typed config, fail-fast on a missing secret |
| 03 | [Database, DataSource & migrations](./03-database.md) | Migration-based schema, snake_case columns |
| 04 | [Logger](./04-logger.md) | Structured JSON logs with secret redaction |
| 05 | [Request ID & HTTP logging](./05-request-context.md) | A `requestId` on every log line and error |
| 06 | [Exception handling & error envelope](./06-exceptions.md) | The one error shape every endpoint returns |

### Phase B — app shell

| # | Document | Gives you |
|---|---|---|
| 07 | [`main.ts` bootstrap](./07-bootstrap.md) | Security headers, CORS, global pipes, `/api/v1` |
| 08 | [Health module](./08-health.md) | `/health/live` and `/health/ready` |
| 09 | [Swagger / OpenAPI](./09-swagger.md) | Browsable API docs at `/api/docs` |

### Phase C — cross-cutting

| # | Document | Gives you |
|---|---|---|
| 10 | [Shared `common/` utilities](./10-common.md) | Pagination, `@CurrentUser()`, `@Public()` |
| 11 | [Rate limiting & abuse controls](./11-rate-limiting.md) | Throttling and the public-submission limit |

### Phase D — feature modules

Follows the implementation order in PRD §15.

| # | Document | Gives you |
|---|---|---|
| 12 | [Entities & first migration](./12-entities.md) | All 7 tables, indexes and constraints |
| 13 | [Auth module](./13-auth.md) | 10 auth endpoints, Argon2id, JWT + refresh rotation, Google |
| 14 | [Users & Mail modules](./14-users-mail.md) | `/users/me`, transactional email |
| 15 | [Forms module](./15-forms.md) | 7 form endpoints, ownership, publish/unpublish |
| 16 | [Schema & answer validation](./16-validation.md) | The five field types, validated server-side |
| 17 | [Submissions module](./17-submissions.md) | Public submission, idempotency, CSV export |

### Phase E — operations

| # | Document | Gives you |
|---|---|---|
| 18 | [Testing](./18-testing.md) | The PRD §15 test checklist, implemented |
| 19 | [Docker, deployment & README](./19-deployment.md) | Dockerfile, CI, a truthful README |

## Progress checklist

- [ ] 00 Prerequisites
- [ ] 01 Module layout
- [ ] 02 Config
- [ ] 03 Database & migrations
- [ ] 04 Logger
- [ ] 05 Request context
- [ ] 06 Exceptions
- [ ] 07 Bootstrap
- [ ] 08 Health
- [ ] 09 Swagger
- [ ] 10 Common utilities
- [ ] 11 Rate limiting
- [ ] 12 Entities
- [ ] 13 Auth
- [ ] 14 Users & Mail
- [ ] 15 Forms
- [ ] 16 Validation
- [ ] 17 Submissions
- [ ] 18 Testing
- [ ] 19 Deployment

## Conventions used throughout

| Rule | Source |
|---|---|
| All product routes live under `/api/v1`; health routes do not | PRD §12 |
| UUID primary keys, `timestamptz`, `snake_case` columns, `lower_snake_case` enums | PRD §10 |
| Ownership goes in the mutation predicate, never a prior lookup | PRD §3 |
| Another user's private resource returns **404**, never 403 | PRD §3 |
| Never log credentials, tokens, OAuth codes or submitted answers | PRD §14 |
| DTOs whitelist properties and reject unknown ones | PRD §11 |
| Production migrates; it never uses `synchronize` | PRD §10 |
