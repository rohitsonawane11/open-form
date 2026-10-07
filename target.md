# OpenForms — Product Requirements Document

**Version:** 1.0  
**Status:** MVP  
**Product Type:** Open-source form builder and form backend  
**Primary Stack:** Next.js + NestJS + PostgreSQL  
**Target:** GitHub portfolio + genuinely usable open-source product

---

# 1. Product Overview

OpenForms is an open-source platform for creating, publishing, embedding, and managing online forms.

Users can visually create forms similar to Google Forms, publish them using a shareable URL, embed them into websites, and collect responses.

Developers can also use OpenForms as a **form backend**. Instead of building APIs, databases, validation, email notifications, and response management for every contact or lead form, developers can send submissions directly to OpenForms.

Example:

```text
Business Owner
      │
      ▼
 Visual Form Builder
      │
      ▼
 Published Form
      │
      ▼
   Responses
      │
      ├── Dashboard
      ├── CSV Export
      ├── Email
      └── Webhook


Developer Website
      │
      │ API
      ▼
 OpenForms
      │
      ├── Validation
      ├── Storage
      ├── Notifications
      └── Webhooks
```

---

# 2. Problem

Creating a simple form often requires unnecessary engineering.

A developer building a contact form may need to implement:

- API endpoint
- validation
- database storage
- spam protection
- email notifications
- admin interface
- CSV export
- webhook integration

Non-technical users have products such as Google Forms, but developers frequently need more control over presentation, APIs, integrations, and self-hosting.

OpenForms provides both:

**No-code users**

Create forms visually.

**Developers**

Use OpenForms purely as a backend for custom forms.

---

# 3. Product Goals

The MVP must allow a user to:

1. Create an account.
2. Create a form.
3. Add and configure fields.
4. Preview the form.
5. Publish the form.
6. Share a public URL.
7. Receive submissions.
8. View responses.
9. Export responses.
10. Embed the form.
11. Submit responses using an API.
12. Receive email notifications.
13. Configure webhooks.

The project should also be easy to self-host.

---

# 4. Non-Goals for MVP

The MVP will NOT include:

- AI form generation
- payments
- complex conditional logic
- workflow automation
- team collaboration
- enterprise SSO
- advanced analytics
- custom domains
- marketplace/plugins
- native mobile apps
- Kafka
- microservices
- Kubernetes

These can be considered later.

---

# 5. User Types

## 5.1 Form Owner

Authenticated user who creates and manages forms.

Can:

- create forms
- edit forms
- publish forms
- view responses
- delete responses
- export data
- configure integrations
- generate API keys

---

## 5.2 Respondent

Person filling a published form.

Does not require an account.

Can:

- view form
- submit form
- upload files when enabled
- see submission confirmation

---

## 5.3 Developer

Uses OpenForms as infrastructure.

Can:

- submit responses using API
- embed forms
- use API keys
- configure webhooks
- integrate OpenForms into another application

---

# 6. Authentication

Support:

- Email/password registration
- Login
- Refresh token
- Logout
- Email verification
- Forgot password
- Reset password

JWT access tokens should be short-lived.

Refresh sessions should be revocable.

Passwords must be securely hashed.

---

# 7. Dashboard

After login, user lands on:

```text
/forms
```

Dashboard displays:

```text
My Forms

Customer Feedback
32 responses
Published
Updated 2 hours ago

Contact Form
18 responses
Published

Employee Survey
0 responses
Draft
```

Each card should show:

- form title
- status
- number of responses
- created date
- last updated
- actions menu

Actions:

- Edit
- Preview
- Responses
- Duplicate
- Publish/unpublish
- Delete

Dashboard should support basic search.

---

# 8. Form Lifecycle

Forms have the following statuses:

```text
DRAFT
PUBLISHED
CLOSED
```

### DRAFT

Editable but unavailable publicly.

### PUBLISHED

Publicly accessible and accepting responses.

### CLOSED

Public page exists but no new responses are accepted.

---

# 9. Form Creation

Endpoint:

```http
POST /api/v1/forms
```

Initial request:

```json
{
  "title": "Customer Feedback"
}
```

System creates:

```text
Form ID
Owner ID
Public slug
Default schema
Draft status
Created timestamp
Updated timestamp
```

Example slug:

```text
k7Dx92pQ
```

Public URL:

```text
/f/k7Dx92pQ
```

---

# 10. Form Builder

The builder should contain three main areas.

```text
┌──────────────────────────────────────────────┐
│ Customer Feedback             Preview Save  │
├──────────────┬──────────────────┬────────────┤
│              │                  │            │
│ Field Types  │ Form Canvas      │ Settings   │
│              │                  │            │
│ Text         │ Name             │ Required   │
│ Email        │ [__________]     │ Label      │
│ Choice       │                  │ Help text  │
│ Date         │ Rating           │ etc.       │
│              │ ★★★★★            │            │
└──────────────┴──────────────────┴────────────┘
```

The exact layout can be simplified for MVP.

---

# 11. Supported Fields

MVP should support:

### Short Text

Single-line text input.

Options:

- label
- placeholder
- required
- minimum length
- maximum length

---

### Long Text

Textarea.

Options:

- label
- placeholder
- required
- minimum length
- maximum length

---

### Email

Email input with validation.

---

### Number

Numeric input.

Options:

- minimum
- maximum
- required

---

### Multiple Choice

User selects one option.

---

### Checkbox

User selects multiple options.

---

### Dropdown

Select one option from a dropdown.

---

### Date

Date input.

---

### Rating

Example:

```text
How was your experience?

★ ★ ★ ★ ★
```

Configurable maximum:

```text
5
10
```

---

# 12. Form Schema

Store form structure as JSONB.

Example:

```json
{
  "version": 1,
  "fields": [
    {
      "id": "fld_name",
      "type": "text",
      "label": "Your name",
      "placeholder": "Enter your name",
      "required": true,
      "validation": {
        "minLength": 2,
        "maxLength": 100
      }
    },
    {
      "id": "fld_email",
      "type": "email",
      "label": "Email",
      "required": true
    },
    {
      "id": "fld_rating",
      "type": "rating",
      "label": "Rate your experience",
      "required": true,
      "validation": {
        "min": 1,
        "max": 5
      }
    }
  ]
}
```

Each field receives an immutable UUID/unique identifier.

Changing the label should not change the field ID.

---

# 13. Builder Operations

Users must be able to:

- add field
- edit field
- delete field
- duplicate field
- reorder fields
- mark required
- edit labels
- edit placeholders
- configure validation
- configure options

Drag-and-drop can be implemented using dnd-kit.

---

# 14. Form Settings

Each form supports:

```text
Title
Description
Status
Submit button text
Success message
Redirect URL
Accept responses
Response limit
Closing date
Email notification
```

Example:

```json
{
  "submitButtonText": "Send feedback",
  "successMessage": "Thanks for your feedback!",
  "redirectUrl": null
}
```

---

# 15. Preview

Owner can preview the form before publishing.

Preview should render using the exact same renderer used by the public form.

This avoids maintaining separate builder and production rendering implementations.

---

# 16. Publishing

Endpoint:

```http
POST /api/v1/forms/:id/publish
```

Publishing performs validation.

For example:

- title must exist
- form must contain at least one field
- every field must have a label
- choice fields must contain valid options

Once successful:

```text
DRAFT → PUBLISHED
```

---

# 17. Public Form

Public endpoint:

```http
GET /api/v1/public/forms/:slug
```

No authentication required.

Returns only information required for rendering the form.

Sensitive configuration must never be exposed.

---

# 18. Public Submission

Endpoint:

```http
POST /api/v1/public/forms/:slug/submissions
```

Example:

```json
{
  "answers": {
    "fld_name": "John Doe",
    "fld_email": "john@example.com",
    "fld_rating": 5
  }
}
```

The backend MUST NOT trust frontend validation.

Backend loads the current form schema and dynamically validates every answer.

---

# 19. Dynamic Validation

Submission validation includes:

- required fields
- valid field IDs
- text length
- email format
- number ranges
- allowed options
- checkbox values
- date format
- rating range

Example invalid response:

```json
{
  "statusCode": 400,
  "errors": [
    {
      "fieldId": "fld_email",
      "message": "Invalid email address"
    }
  ]
}
```

Unknown fields should be rejected or ignored according to a clearly defined global policy. For MVP, reject them.

---

# 20. Submission Processing

Submission flow:

```text
POST submission
       ↓
Rate limit
       ↓
Load published form
       ↓
Check accepting responses
       ↓
Validate answers
       ↓
Store response
       ↓
Return success
       ↓
Queue background jobs
       │
       ├── Email
       └── Webhooks
```

Saving the submission must not depend on successful email or webhook delivery.

---

# 21. Responses

Owner endpoint:

```http
GET /api/v1/forms/:id/responses
```

Supports:

```text
page
limit
sort
from
to
```

Example:

```http
GET /api/v1/forms/123/responses?page=1&limit=20
```

---

# 22. Response Table

UI should dynamically construct columns based on form fields.

Example:

| Submitted | Name | Email | Rating |
|---|---|---|---:|
| Oct 7 | John | john@example.com | 5 |
| Oct 7 | Sarah | sarah@example.com | 4 |

Clicking a row opens the complete response.

---

# 23. Individual Response

Endpoint:

```http
GET /api/v1/forms/:formId/responses/:responseId
```

Display:

```text
Customer Feedback

Submitted
7 October 2026 4:32 PM

Name
John Doe

Email
john@example.com

Rating
★★★★★
```

---

# 24. Delete Response

Endpoint:

```http
DELETE /api/v1/forms/:formId/responses/:responseId
```

Only the form owner can perform this action.

---

# 25. CSV Export

Endpoint:

```http
GET /api/v1/forms/:id/responses/export
```

Example output:

```csv
submitted_at,name,email,rating
2026-10-07T11:02:00Z,John Doe,john@example.com,5
```

Export should use field labels as human-readable column names while internally mapping them using field IDs.

---

# 26. Embedding

Users can embed a published form.

Simplest MVP implementation:

```html
<iframe
  src="https://openforms.example/f/k7Dx92pQ"
  width="100%"
  height="600">
</iframe>
```

Dashboard should provide:

```text
Embed

[Copy code]
```

A JavaScript embed SDK can be introduced later.

---

# 27. Developer Submission API

Developers should be able to use their own UI.

Example:

```http
POST /api/v1/forms/:formId/submissions
Authorization: Bearer frm_live_xxxxx
Content-Type: application/json
```

```json
{
  "answers": {
    "fld_name": "John",
    "fld_email": "john@example.com"
  }
}
```

The same validation engine used by public forms should validate API submissions.

---

# 28. API Keys

User can generate API keys.

Endpoints:

```text
POST   /api/v1/api-keys
GET    /api/v1/api-keys
DELETE /api/v1/api-keys/:id
```

Example generated key:

```text
frm_live_7hD92ks...
```

Only show the complete key once.

Store only a secure hash of the key.

Database compromise should not reveal usable API keys.

---

# 29. Webhooks

Form owner can configure webhook endpoints.

Example:

```text
https://example.com/webhooks/forms
```

When a response is created, send:

```http
POST /webhooks/forms
```

```json
{
  "event": "form.submitted",
  "formId": "form_123",
  "submissionId": "sub_123",
  "createdAt": "2026-10-07T11:02:00Z",
  "data": {
    "fld_name": "John",
    "fld_email": "john@example.com"
  }
}
```

---

# 30. Webhook Security

Each webhook has a secret.

Payload should be signed using HMAC-SHA256.

Example header:

```text
X-OpenForms-Signature
```

Consumer can verify that the request genuinely came from OpenForms.

---

# 31. Webhook Delivery

Do not make webhook calls synchronously during form submission.

Use a background queue.

```text
Submission
    ↓
Database
    ↓
BullMQ
    ↓
Webhook Worker
    ↓
Customer Endpoint
```

Retry failed deliveries.

Suggested retry policy:

```text
Attempt 1 → immediately
Attempt 2 → 1 minute
Attempt 3 → 5 minutes
Attempt 4 → 30 minutes
Attempt 5 → 2 hours
```

After maximum attempts, mark the delivery failed.

---

# 32. Email Notifications

Owner can enable:

```text
Notify me when someone submits this form
```

Email:

```text
New response: Customer Feedback

You received a new response.

Name: John Doe
Email: john@example.com
Rating: 5

View response →
```

Email processing should also use the background queue.

---

# 33. File Uploads

File upload can be V1.1 rather than initial MVP.

Field:

```text
FILE
```

Files should be uploaded directly to object storage using signed URLs where practical.

Use Cloudflare R2 or another S3-compatible provider.

Store file metadata rather than binary files in PostgreSQL.

---

# 34. Spam Protection

Public submission endpoints require protection.

MVP:

- IP-based rate limiting
- form-based rate limiting
- payload size limit
- honeypot field
- server-side validation

Later:

- CAPTCHA/Turnstile
- duplicate detection
- bot scoring

---

# 35. Rate Limiting

Examples:

Public submissions:

```text
10 submissions / minute / IP / form
```

Developer API:

```text
100 requests / minute / API key
```

Values should eventually be configurable.

---

# 36. Database Model

## users

```text
id UUID PK
email VARCHAR UNIQUE
password_hash VARCHAR
email_verified_at TIMESTAMP NULL
created_at
updated_at
```

## forms

```text
id UUID PK
owner_id UUID FK
title VARCHAR
description TEXT
slug VARCHAR UNIQUE
status ENUM
schema JSONB
settings JSONB
published_at TIMESTAMP NULL
created_at
updated_at
```

## form_responses

```text
id UUID PK
form_id UUID FK
answers JSONB
source ENUM
submitted_at
```

Possible source values:

```text
PUBLIC
API
EMBED
```

## api_keys

```text
id UUID PK
user_id UUID FK
name VARCHAR
key_prefix VARCHAR
key_hash VARCHAR
last_used_at TIMESTAMP
created_at
revoked_at TIMESTAMP NULL
```

## webhooks

```text
id UUID PK
form_id UUID FK
url VARCHAR
secret_encrypted VARCHAR
enabled BOOLEAN
created_at
updated_at
```

## webhook_deliveries

```text
id UUID PK
webhook_id UUID FK
response_id UUID FK
status ENUM
attempt_count INTEGER
last_status_code INTEGER
next_attempt_at TIMESTAMP
created_at
updated_at
```

## sessions

```text
id UUID PK
user_id UUID FK
refresh_token_hash VARCHAR
expires_at
revoked_at
created_at
```

---

# 37. Backend Modules

NestJS structure:

```text
src/
├── auth/
├── users/
├── forms/
├── submissions/
├── responses/
├── api-keys/
├── webhooks/
├── notifications/
├── queue/
├── storage/
├── mail/
└── common/
```

Keep this as a modular monolith.

Do not create microservices for the MVP.

---

# 38. Frontend Structure

Suggested routes:

```text
/
 /login
 /register

/dashboard
/forms
/forms/new
/forms/:id
/forms/:id/edit
/forms/:id/responses
/forms/:id/responses/:responseId
/forms/:id/settings
/forms/:id/integrations

/f/:slug
```

The `/f/:slug` route is public.

---

# 39. Main APIs

## Authentication

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
POST /api/v1/auth/verify-email
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
```

## Forms

```text
POST   /api/v1/forms
GET    /api/v1/forms
GET    /api/v1/forms/:id
PATCH  /api/v1/forms/:id
DELETE /api/v1/forms/:id

POST /api/v1/forms/:id/publish
POST /api/v1/forms/:id/unpublish
POST /api/v1/forms/:id/close
POST /api/v1/forms/:id/duplicate
```

## Public

```text
GET  /api/v1/public/forms/:slug
POST /api/v1/public/forms/:slug/submissions
```

## Responses

```text
GET    /api/v1/forms/:id/responses
GET    /api/v1/forms/:id/responses/:responseId
DELETE /api/v1/forms/:id/responses/:responseId

GET /api/v1/forms/:id/responses/export
```

## API Keys

```text
POST   /api/v1/api-keys
GET    /api/v1/api-keys
DELETE /api/v1/api-keys/:id
```

## Developer API

```text
POST /api/v1/forms/:id/submissions
```

Authenticated using API key.

## Webhooks

```text
POST   /api/v1/forms/:id/webhooks
GET    /api/v1/forms/:id/webhooks
PATCH  /api/v1/forms/:id/webhooks/:webhookId
DELETE /api/v1/forms/:id/webhooks/:webhookId

GET /api/v1/forms/:id/webhooks/:webhookId/deliveries
```

---

# 40. Authorization

Every private form operation must verify ownership.

A user must never be able to access another user's form by changing the UUID.

For example:

```text
User A
   ↓
GET /forms/form-owned-by-B
   ↓
404
```

Prefer `404` rather than exposing whether another user's resource exists.

---

# 41. Security Requirements

Minimum security requirements:

- Argon2/bcrypt password hashing
- hashed refresh tokens
- hashed API keys
- secure HTTP-only refresh cookie
- CORS configuration
- Helmet/security headers
- request size limits
- rate limiting
- DTO validation
- dynamic submission validation
- authorization on every private resource
- webhook HMAC signatures
- encrypted sensitive webhook secrets
- safe file upload validation
- SQL injection protection through ORM/query parameters

Never log:

- passwords
- access tokens
- refresh tokens
- complete API keys

---

# 42. Observability

MVP should have:

- structured application logs
- request IDs
- error tracking
- health endpoint

Example:

```text
GET /health
```

Response:

```json
{
  "status": "ok",
  "database": "up"
}
```

Sentry can be used for error tracking.

Prometheus/Grafana are unnecessary for the first version.

---

# 43. Technology Stack

## Frontend

```text
Next.js
TypeScript
Tailwind CSS
shadcn/ui
React Hook Form
Zod
dnd-kit
TanStack Query
Axios
```

## Backend

```text
NestJS
TypeScript
TypeORM
PostgreSQL
Swagger/OpenAPI
```

## Async Processing

```text
Redis
BullMQ
```

## Storage

```text
Cloudflare R2
```

## Email

```text
Resend
```

## Infrastructure

```text
Docker
Docker Compose
GitHub Actions
```

## Monitoring

```text
Sentry
```

---

# 44. Docker Development Environment

A contributor should be able to run:

```bash
docker compose up -d
```

and get:

```text
PostgreSQL
Redis
```

Application development can then run locally.

The repository should include:

```text
.env.example
docker-compose.yml
README.md
```

---

# 45. API Documentation

NestJS Swagger should expose:

```text
/api/docs
```

Documentation should explain:

- authentication
- API keys
- form APIs
- submission APIs
- webhook payloads
- error responses

---

# 46. Testing

Priority backend tests:

### Unit

- form schema validation
- submission validation
- webhook signature generation
- API key hashing/verification

### Integration

- create form
- publish form
- submit response
- invalid submission
- private form access
- response retrieval

### E2E Critical Flow

```text
Register
   ↓
Create form
   ↓
Add fields
   ↓
Publish
   ↓
Public fetch
   ↓
Submit
   ↓
Owner views response
```

This flow should always be covered.

---

# 47. CI

GitHub Actions pipeline:

```text
Pull Request
     ↓
Install
     ↓
Lint
     ↓
Type Check
     ↓
Unit Tests
     ↓
Integration Tests
     ↓
Build
     ↓
PASS
```

Merges should require CI success.

---

# 48. UX Requirements

Creating the first form should be extremely fast.

Target:

```text
Register → published form
< 2 minutes
```

The builder should autosave.

Users should not have to manually press Save repeatedly.

Display:

```text
Saving...
```

then:

```text
Saved ✓
```

Use debouncing rather than sending a request for every keystroke.

---

# 49. Empty States

Do not leave dashboards blank.

Example:

```text
You haven't created a form yet.

Create a form and start collecting responses.

[ Create your first form ]
```

Responses:

```text
No responses yet.

Share your form to start collecting responses.

https://openforms.example/f/abc123

[ Copy link ]
```

---

# 50. Error States

Public forms should gracefully handle:

### Form doesn't exist

```text
Form not found.
```

### Form closed

```text
This form is no longer accepting responses.
```

### Submission failure

```text
We couldn't submit your response.
Please try again.
```

Never expose internal stack traces.

---

# 51. MVP Analytics

Keep analytics extremely simple.

Form dashboard:

```text
Responses        142

Today             12

Last 7 days       54
```

Do not build advanced charts initially.

---

# 52. README

GitHub README should immediately explain the project.

Example:

```text
OpenForms

Open-source form builder and form backend.

Build forms visually, embed them anywhere, collect
submissions, trigger webhooks, and integrate using APIs.
```

Include:

- screenshots
- live demo
- features
- architecture
- quick start
- Docker setup
- API example
- webhook example
- contributing guide
- license

---

# 53. Recommended Repository Structure

A monorepo works well:

```text
openforms/
│
├── apps/
│   ├── web/
│   └── api/
│
├── packages/
│   ├── types/
│   └── validation/
│
├── docker-compose.yml
├── README.md
└── package.json
```

Use pnpm workspaces.

---

# 54. Development Phases

## Phase 1 — Core

Build:

```text
Auth
Forms CRUD
JSONB schema
Builder
Preview
Publish
Public rendering
Submission
Responses
```

At this point the application is usable.

---

## Phase 2 — Product Quality

Add:

```text
CSV export
Form duplication
Autosave
Search
Response limits
Closing dates
Email notifications
Rate limiting
```

---

## Phase 3 — Developer Features

Add:

```text
API keys
Developer submission API
Webhooks
Webhook signing
Webhook retries
Swagger documentation
Embed code
```

This is where OpenForms becomes more than a Google Forms clone.

---

## Phase 4 — Files

Add:

```text
File field
R2
Signed uploads
File validation
Download authorization
```

---

# 55. Future Features

After MVP, potential additions include:

### Conditional Logic

```text
If answer = "Business"
    show Company Name
else
    hide Company Name
```

### Form Themes

Allow:

```text
colors
fonts
logo
background
button styling
```

### Custom Domains

```text
forms.company.com/customer-feedback
```

### Partial Responses

Save unfinished submissions.

### Multi-page Forms

```text
Personal Info
     ↓
Preferences
     ↓
Confirmation
```

### Teams

Multiple users manage the same forms.

### Workspaces

```text
Company
 ├── Marketing
 ├── HR
 └── Product
```

### Webhook Events

Support:

```text
form.submitted
form.updated
form.closed
```

### Integration Ecosystem

Possible future integrations:

```text
Slack
Discord
Google Sheets
Notion
Zapier
CRM systems
```

### AI

Only after the core product works:

```text
"Create a customer satisfaction survey for a dentist"

        ↓

Automatically generated form
```

---

# 56. MVP Success Criteria

The MVP is considered complete when a new user can:

```text
Create account
      ↓
Create form
      ↓
Add questions
      ↓
Publish
      ↓
Send URL to another person
      ↓
Person submits response
      ↓
Owner sees response
      ↓
Owner exports responses
```

without manually interacting with the database or backend.

The developer workflow must also work:

```text
Create form
     ↓
Generate API key
     ↓
POST submission from custom application
     ↓
Submission appears in dashboard
     ↓
Webhook delivered
```

---

# 57. Most Important Engineering Principle

Do not design OpenForms around individual field types at the database level.

The core abstraction should be:

```text
FORM
 │
 ├── SCHEMA
 │     ├── Field
 │     ├── Field
 │     └── Field
 │
 └── RESPONSES
       ├── answers JSONB
       ├── answers JSONB
       └── answers JSONB
```

The schema defines what constitutes a valid response.

This allows new field types to be introduced without database migrations for every new question type.

---

# 58. Final MVP Scope

If speed matters, the actual first release should contain only:

**Authentication**

Email/password authentication.

**Builder**

Text, textarea, email, number, multiple choice, checkbox, dropdown, date and rating.

**Forms**

Create, edit, duplicate, preview, publish, close and delete.

**Responses**

Submit, view, delete and CSV export.

**Sharing**

Public URL and iframe embed.

**Developer**

API keys and submission API.

**Integration**

Email notification and webhook.

**Infrastructure**

PostgreSQL, Redis, Docker, GitHub Actions and Sentry.

Everything else should wait.

The product should prioritize being **small, reliable and polished** over having a large feature list.