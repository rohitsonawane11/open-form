# OpenForms

OpenForms is an open-source, self-hostable form platform. Businesses build, publish and embed forms through a visual builder, then collect, inspect and export the responses. Developers can use the same backend for forms built in their own applications, submitting through a business-scoped API key and receiving signed webhooks.

Forms belong to the **business**, not to the person who created them — removing a colleague's membership never removes their business's forms or responses.

## Status

**Pre-implementation.** This repository currently contains a NestJS starter and generated resource stubs. No feature of the product below is implemented yet. [`target.md`](./target.md) is the authoritative PRD; the documents in [`docs/`](./docs) describe how it gets built.

## Stack

NestJS · Passport · PostgreSQL · TypeORM · Redis · BullMQ

Backend first. The Next.js frontend described in PRD §29 is out of scope until the API is usable.

## Tenancy in one paragraph

The interface says **business**. The backend says `tenantId`. Database columns say `tenant_id`. These are three names for one thing — there is exactly one business/tenant entity, mapped consistently to `businesses.id`. They do not represent two separate concepts, and nothing in the codebase should imply that they do.

Users have global accounts and can belong to several businesses with a different role in each. Isolation is enforced in the application, not by PostgreSQL RLS (PRD §1, §12).

## Role matrix

Permissions are business-wide. `created_by` is attribution only — it neither grants nor restricts access. Public respondents have no membership at all.

| Action | OWNER | ADMIN | MEMBER | VIEWER |
|---|:---:|:---:|:---:|:---:|
| Read business metadata/dashboard | Yes | Yes | Yes | Yes |
| Read forms and preview | Yes | Yes | Yes | Yes |
| Read response contents | Yes | Yes | Yes | Yes |
| Create/edit/duplicate forms | Yes | Yes | Yes | No |
| Publish/unpublish/close/reopen | Yes | Yes | Yes | No |
| Delete forms | Yes | Yes | No | No |
| Export responses | Yes | Yes | Yes | No |
| Delete responses | Yes | Yes | No | No |
| Configure form notification recipients | Yes | Yes | No | No |
| Create/revoke API keys | Yes | Yes | No | No |
| Configure webhooks and inspect deliveries | Yes | Yes | No | No |
| Read member directory: name/email/role | Yes | Yes | Yes | Yes |
| Invite/manage MEMBER and VIEWER | Yes | Yes | No | No |
| Invite/manage ADMIN | Yes | No | No | No |
| Manage OWNER or transfer ownership | Yes | No | No | No |
| Update business settings | Yes | Yes | No | No |
| Read audit logs | Yes | Yes | No | No |
| Delete business | Yes | No | No | No |
| Leave business | After ownership transfer | Yes | Yes | Yes |

An ADMIN cannot modify or remove another ADMIN or the OWNER, including through self-demotion endpoints. OWNER is assignable only through ownership transfer — never through an invitation or an ordinary role update. No role bypasses tenant isolation (PRD §7).

## Documentation

| Document | What it covers |
|---|---|
| [`target.md`](./target.md) | The product requirements document. Authoritative; everything else derives from it. |
| [`docs/architecture.md`](./docs/architecture.md) | Module layout, data model, and persistence conventions. |
| [`docs/tenancy.md`](./docs/tenancy.md) | The tenant isolation contract. Read before writing any query. |
| [`docs/roadmap.md`](./docs/roadmap.md) | Build order, phase exit gates, and decisions already settled. |

## Quick start

TODO — written once Phase 0 (bootstrap) lands. It will cover `docker compose up`, `.env` setup, running migrations and starting the API. See [`docs/roadmap.md`](./docs/roadmap.md).

## License

TODO — to be chosen before the first public release (PRD §33).
