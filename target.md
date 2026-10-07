# OpenForms — Personal Form Builder PRD

**Version:** 4.0  
**Date:** 8 October 2026  
**Status:** MVP implementation scope  
**Stack:** Next.js, NestJS, Passport, PostgreSQL and TypeORM

## 1. Product and goal

OpenForms lets individual users create forms, publish public links, collect anonymous submissions and review/export the
results. Each form belongs to the user who created it.

The core journey is: register → verify email → create form → publish → share link → receive submission → review
responses → export CSV.

This replaces the previous business-based scope. There are no businesses, tenants, memberships, teams, invitations, role
hierarchies or business switching. User ownership checks still protect every private resource.

## 2. MVP scope

Included:

- Email/password registration/login and Google login using Passport.
- Email verification, forgot/reset password, refresh tokens and logout.
- User profile retrieval and name update.
- Five field types: text, textarea, email, multiple choice and checkbox group.
- Form creation/editing/deletion, autosave and preview.
- Publishing, republishing and unpublishing.
- Public rendering and anonymous submissions with server validation.
- Response list/detail/deletion and CSV export.
- Basic abuse protection, tests, CI and deployment documentation.

Deferred: collaboration, business accounts, API keys, authenticated developer APIs, webhooks, submission notifications,
queues, Redis, file uploads, payments, AI generation, conditional logic, multi-page forms, custom domains, advanced
analytics, form duplication, account linking, session-management UI and audit-log dashboard.

## 3. Users and authorization

Two product actors exist:

| Actor                    | Capabilities                                                             |
|--------------------------|--------------------------------------------------------------------------|
| Authenticated form owner | Manage their own forms, view/delete their submissions and export results |
| Anonymous respondent     | Read a published form and submit answers                                 |

No role enum or RBAC tables are required. `forms.user_id` identifies the owner. An authenticated person cannot access
another user's private resources, regardless of known UUIDs or public slugs.

Every private form query includes `user_id = authenticatedUser.id`. Updates/deletes include ownership in the mutation
predicate, not only an earlier lookup. Nested response operations verify `(form_id, response_id)` and ownership of the
parent form. Never accept userId/ownerId from form creation bodies.

Return 404 for another person's private resource. Public endpoints expose only rendering data and never permit response
retrieval. Clear user-specific frontend caches on logout/account changes.

## 4. Authentication

### Email registration

Input: name, email and password only. Name: 2–100 characters; email normalized by trim/lowercase and unique; password:
12–128 characters. Do not apply provider-specific email dot/plus rewriting.

Create user and hashed verification-token record in a transaction. Send verification email after commit. Email failure
preserves the account and exposes a resend option. Verification tokens are random, single-use and expire after 24 hours.

Unverified users can sign in, inspect their account, resend verification and log out. Form/response management requires
verified email.

Hash passwords with Argon2id and configure cost for deployment capacity. Login failures use a generic message and rate
limiting.

### Google login

Use Passport Google OAuth with minimal identity scopes and validated browser-bound state. Resolve an identity using
provider subject. A provider-verified email may verify a newly created account.

If the Google email matches an existing password account without a linked identity, ask the user to use their existing
sign-in method. Do not silently merge accounts by email. Explicit linking is deferred.

After Google login, go directly to My Forms. Do not place access/refresh tokens in redirect URLs. Complete login through
secure cookies or a short-lived single-use exchange code and restrict redirect destinations.

### Session and recovery

- Passport local strategy handles password credentials; JWT strategy handles access authentication.
- Access JWT: 15 minutes, with user ID and session ID; browser keeps it in memory.
- Refresh session: 30 days; hash stored in database; Secure, HttpOnly refresh cookie in production.
- Rotate refresh token on use and detect replay. Frontend serializes refresh calls; document concurrent-request
  behavior.
- Validate user/session active state on authenticated requests. Logout revokes the current session.
- Protect cookie refresh/logout with Origin validation and CSRF controls matching the deployment.
- Password-reset requests respond neutrally. Reset token is hashed, single-use and expires in 30 minutes.
- Successful password reset revokes existing sessions. Google-only accounts do not gain a password through the reset
  endpoint.
- Never return password/token hashes in API serialization.

## 5. My Forms and profile

My Forms shows title, draft/published state, response count and updated time. Support title search, pagination and safe
allowlisted sorting. Default page size 20, maximum 100; default order updated descending, then ID.

Actions: create, edit, preview, publish/unpublish, responses and delete. Deletion confirmation explains that responses
will also be deleted.

Profile supports current account retrieval and display-name update. Email changes and account deletion are deferred to
avoid expanding identity workflows.

## 6. Builder

Desktop layout: field palette, canvas and selected-field settings. On mobile, use drawers. Operations:
add/edit/delete/duplicate fields, reorder, change labels/help text/placeholders, mark required and configure
validation/options.

Field and option IDs are stable. Label changes do not change IDs; duplicating a field creates new IDs. Drag-and-drop has
keyboard reorder alternatives.

| Type              | Answer           | Validation/configuration                             |
|-------------------|------------------|------------------------------------------------------|
| `text`            | String           | Required, min/max length                             |
| `textarea`        | String           | Required, min/max length                             |
| `email`           | String           | Required, valid email, max length                    |
| `multiple_choice` | Option ID string | Required, one defined option                         |
| `checkbox`        | Option ID array  | Required, unique defined options, min/max selections |

Limits: 50 fields/form, 50 options/choice field, labels 200 characters, help text 1,000 characters, text answers 10,000
characters; schema and submission body each at most 256 KiB. Enforce limits server-side.

Autosave after approximately 800 ms of inactivity. Show Saving, Saved and Unsaved/Retry. Include expectedDraftRevision;
stale writes return 409 rather than overwrite edits from another tab. Preview uses the public renderer with the draft
and never stores responses.

## 7. Schema and publication

Use JSONB form schemas and JSONB answers. Do not create database columns for questions.

```json
{
  "schemaVersion": 1,
  "fields": [
    {
      "id": "fld_name",
      "type": "text",
      "label": "Your name",
      "required": true,
      "validation": {
        "minLength": 2,
        "maxLength": 100
      }
    }
  ]
}
```

Forms have `draft` or `published` state. New forms have a globally unique opaque public slug, draft schema and revision
counter. Public URL: `/f/:slug`.

Keep draft schema/settings and one published snapshot on the form. Publishing validates and snapshots title,
description, fields, submit text and success message, then increments publicationVersion. Draft changes do not affect
the public form until Publish Changes. Unpublish disables public access immediately.

Each response stores the snapshot used to validate it, preserving old labels/options after republishing. No
revision-history table or UI is required.

Publication requires title, at least one field, unique IDs, valid constraints and nonempty valid choices. Redirect URLs,
scheduled closing and response limits are deferred.

## 8. Public forms and submissions

Respondents need no account. Public GET returns the safe published snapshot and publicationVersion. Unknown, unpublished
or deleted forms return generic not found. Do not return owner email, sessions or response data.

```json
{
  "publicationVersion": 1,
  "answers": {
    "fld_name": "Rohit"
  },
  "honeypot": ""
}
```

Server checks publication state and validates every answer against the current snapshot. Reject unknown field IDs, wrong
JSON types, whitespace-only required strings, invalid email, invalid choice IDs, duplicate checkbox options and exceeded
bounds. Missing/null optional answers are absent; required null is invalid.

Stale publicationVersion returns 409 `FORM_CHANGED`; client preserves input and prompts reload/review. Invalid answers
return 422 with field-level errors. Success returns 201 with response ID, timestamp and success message, granting no
private read access.

Use a transaction and form row lock, or equivalent ordering, so publication/unpublish/delete cannot race response
acceptance. Store the exact validated snapshot with the response.

Support optional Idempotency-Key scoped to form for 24 hours. Store key/payload hash and original response result: same
key/payload returns previous success; changed payload returns 409. Client retries reuse the key. Unpublished/deleted
forms remain unavailable even when retrying a prior key.

Apply payload limits, honeypot and initial rate limit of ten submissions/minute/IP/form plus configurable form-wide
abuse ceiling. A single API instance may use an in-memory limiter; shared limiting is required before horizontal
scaling. Configure trusted reverse proxy IP handling. Honeypot matches produce no stored response and a generic
success-like reply. CORS is not spam protection.

## 9. Response management and export

Owner lists responses with pagination, submitted-time ordering and UTC date filters. Detail uses the stored snapshot for
human-readable labels/options. Response count is retained submissions, so deletion decreases it.

Owner may delete one response after confirmation. Form deletion removes all associated responses/idempotency records
transactionally for this bounded MVP.

CSV export uses owner/form/date scope, streams output and caps at 10,000 responses. Above that limit return an
actionable error. Include response ID, submitted-at UTC and a union of stable field IDs across snapshots; use readable
labels plus short ID suffixes for duplicate labels. Translate option IDs using each response snapshot. Escape
quotes/newlines/delimiters and neutralize spreadsheet formula injection. Empty exports include headers.

Full respondent IP/user-agent storage is disabled by default. No submission emails or external deliveries exist in this
release.

## 10. Database model

UUID IDs, UTC timestamptz, snake_case columns; enum values lower_snake_case.

| Entity/table                                       | Main fields                                                                                                                                                                           |
|----------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `User` / `users`                                   | id, name, normalized_email unique, password_hash nullable, email_verified_at, status, created_at, updated_at                                                                          |
| `AuthIdentity` / `auth_identities`                 | id, user_id FK, provider, provider_subject; unique(provider, provider_subject)                                                                                                        |
| `Session` / `sessions`                             | id, user_id FK, refresh_token_hash, family/replay evidence, expires_at, revoked_at, timestamps                                                                                        |
| `AuthToken` / `auth_tokens`                        | id, user_id FK, purpose, token_hash, expires_at, consumed_at                                                                                                                          |
| `Form` / `forms`                                   | id, user_id FK, title, description, slug unique, status, draft_schema JSONB, draft_settings JSONB, draft_revision, published_snapshot JSONB nullable, publication_version, timestamps |
| `Submission` / `submissions`                       | id, form_id FK, answers JSONB, schema_snapshot JSONB, publication_version, created_at                                                                                                 |
| `SubmissionIdempotency` / `submission_idempotency` | id, form_id FK, key_hash, payload_hash, submission_id FK, expires_at                                                                                                                  |

Use Submission as the backend entity name; UI may say Responses. These are the same data, not separate
submission/response tables.

Index forms `(user_id, updated_at, id)` and submissions `(form_id, created_at, id)`. Enforce unique
`(form_id, key_hash)`. Use form-qualified foreign keys for idempotency-to-submission references so records cannot point
to another form's submission. Explicitly configure deletion behavior. Production uses migrations, not automatic schema
synchronization.

## 11. DTO contract

| DTO                   | Input                                                             |
|-----------------------|-------------------------------------------------------------------|
| `RegisterDto`         | name, email, password                                             |
| `LoginDto`            | email, password                                                   |
| `VerifyEmailDto`      | token                                                             |
| `ForgotPasswordDto`   | email                                                             |
| `ResetPasswordDto`    | token, password                                                   |
| `UpdateUserDto`       | name                                                              |
| `CreateFormDto`       | title, optional description                                       |
| `UpdateFormDto`       | expectedDraftRevision, optional title/description/schema/settings |
| `PublishFormDto`      | expectedDraftRevision                                             |
| `CreateSubmissionDto` | publicationVersion, answers, optional honeypot                    |
| `FormQueryDto`        | page, limit, search, allowed sort/order                           |
| `SubmissionQueryDto`  | page, limit, from, to, allowed sort/order                         |

Nested field DTOs are discriminated by field type and validate configuration. Dynamic answers are validated by a
schema-driven server service; validating only that answers is an object is insufficient.

DTOs whitelist accepted properties and reject unexpected fields. Derive userId from authentication. Tokens and
Idempotency-Key are never logged. API response DTOs omit all secrets.

## 12. API catalogue — 25 product endpoints + 2 health routes

All paths are under `/api/v1`. Count each HTTP method separately. Product count includes Google callbacks; health routes
are counted separately.

### Authentication — 10

| Method | Path                        | Purpose                 |
|--------|-----------------------------|-------------------------|
| POST   | `/auth/register`            | Create personal account |
| POST   | `/auth/login`               | Email/password login    |
| GET    | `/auth/google`              | Start Google OAuth      |
| GET    | `/auth/google/callback`     | Complete Google OAuth   |
| POST   | `/auth/refresh`             | Rotate refresh token    |
| POST   | `/auth/logout`              | Revoke current session  |
| POST   | `/auth/verify-email`        | Verify email token      |
| POST   | `/auth/resend-verification` | Resend verification     |
| POST   | `/auth/forgot-password`     | Request password reset  |
| POST   | `/auth/reset-password`      | Consume reset token     |

### User — 2

| Method | Path        | Purpose             |
|--------|-------------|---------------------|
| GET    | `/users/me` | Current profile     |
| PATCH  | `/users/me` | Update display name |

### Private forms — 7

| Method | Path                       | Purpose                           |
|--------|----------------------------|-----------------------------------|
| POST   | `/forms`                   | Create owned form                 |
| GET    | `/forms`                   | List/search own forms             |
| GET    | `/forms/:formId`           | Read owned draft/settings         |
| PATCH  | `/forms/:formId`           | Save draft with concurrency check |
| DELETE | `/forms/:formId`           | Delete own form and submissions   |
| POST   | `/forms/:formId/publish`   | Publish/republish saved draft     |
| POST   | `/forms/:formId/unpublish` | Disable public access             |

### Private submissions — 4

| Method | Path                                       | Purpose                |
|--------|--------------------------------------------|------------------------|
| GET    | `/forms/:formId/submissions`               | List owner's responses |
| GET    | `/forms/:formId/submissions/export`        | Export CSV             |
| GET    | `/forms/:formId/submissions/:submissionId` | Read response          |
| DELETE | `/forms/:formId/submissions/:submissionId` | Delete response        |

### Public — 2

| Method | Path                              | Purpose                        |
|--------|-----------------------------------|--------------------------------|
| GET    | `/public/forms/:slug`             | Published renderer data        |
| POST   | `/public/forms/:slug/submissions` | Anonymous validated submission |

### Health — 2 additional operational routes

| Method | Path            | Purpose            |
|--------|-----------------|--------------------|
| GET    | `/health/live`  | Process liveness   |
| GET    | `/health/ready` | Database readiness |

Total: **25 product endpoints + 2 health endpoints = 27**. Preview is frontend-only; there is no preview submission API.
Register export before dynamic submission-detail routes.

Standard errors include statusCode, code, message, requestId and optional field errors. Use 401 invalid authentication,
403 unverified account, 404 unavailable private/public resource, 409 stale version/idempotency conflict, 413 oversized
body, 422 invalid answers and 429 rate limit. List responses include items and page/limit/total metadata. Document all
routes in Swagger/OpenAPI.

## 13. Architecture and frontend

NestJS modules: Auth, Users, Forms, Submissions, Mail and Health. Common utilities cover exception handling, pagination
and authentication decorators. Keep a modular monolith with explicit user IDs passed to ownership-scoped services. No
TenantContext, membership guard, RBAC guard, workers or queue.

Suggested guard flow: JWT/session validation → verified-email check → ownership-scoped service. Public marker exempts
authentication only, not validation or abuse controls.

Frontend: Next.js, TypeScript, Tailwind, shadcn/ui, Lucide, TanStack Query, Axios, React Hook Form, Zod, dnd-kit,
date-fns and pnpm. Zustand optional for selected-field state; server data remains in TanStack Query.

Routes: `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/account`, `/forms`,
`/forms/new`, `/forms/:id/edit`, `/forms/:id/preview`, `/forms/:id/responses`, `/forms/:id/responses/:submissionId` and
`/f/:slug`.

Do not share authenticated caches between users. Clearing account state on logout is mandatory. Server validation
remains independent from frontend validation.

## 14. UX, security and deployment

Provide clear empty states, loading states, inline errors, autosave status and safe deletion confirmation. Public forms
work on phones and with keyboard/screen readers. Labels, visible focus, contrast and accessible error announcements are
required. Preview and public rendering use the same component. Light/dark dashboard themes are optional polish.

HTTPS, security headers, restrictive CORS, secure cookies, CSRF checks, DTO whitelists, parameterized SQL, hashing and
ownership checks are required. Render labels/descriptions as text. Never log credentials, answer bodies or OAuth codes.
Basic scrubbed structured logs and optional Sentry suffice; no audit database/UI is required.

Deploy one NestJS API, PostgreSQL and Next.js frontend. Docker Compose supports local development. Email/Google
credentials are environment settings; commit placeholders only. Document backups, restore and deployment migrations. CI
runs lint, typecheck, meaningful tests and builds. README includes screenshots, demo, setup and ownership/security
model.

## 15. Tests and delivery

Required tests:

- Register/verify/reset tokens are single-use, expire and handle delivery failure through resend.
- OAuth state mismatch fails; existing-email accounts are not silently merged.
- Refresh rotation, reset and logout invalidate appropriate sessions.
- User A cannot list/read/update/delete/export user B's forms or submissions, including mixed parent/child IDs.
- Creation cannot override user ownership through a DTO.
- All five field types reject wrong types, unknown fields/options and invalid required answers.
- Draft edits do not affect published rendering; stale saves/public versions conflict.
- Historical snapshots render correctly after republishing.
- Concurrent submission retries store once; unpublish/delete races do not accept afterward.
- CSV escaping/formula protection and ownership checks pass.
- Logs omit secrets and submitted answers.

Implementation order:

1. Auth and users, with ownership-scoped form skeleton.
2. Builder, JSONB schemas, autosave and preview.
3. Publication, anonymous submission and response dashboard.
4. CSV, deletion, accessibility, tests and deployment.

The MVP is complete when both login methods and the register-to-export journey work through the UI, ownership tests pass
and a fresh documented deployment works without manual database changes.
