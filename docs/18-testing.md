# 18 — Testing

## Why

PRD §15 lists eleven required tests and §14 requires CI to run "lint, typecheck, meaningful tests and builds". This
document turns that list into named files.

The list is not generic coverage advice. Every item is a specific failure this design can produce — which is why they
are written as assertions about behaviour, not about functions.

## The PRD §15 checklist

| # | Requirement | File |
|---|---|---|
| 1 | Register/verify/reset tokens are single-use, expire and handle delivery failure through resend | `auth-tokens.e2e-spec.ts` |
| 2 | OAuth state mismatch fails; existing-email accounts are not silently merged | `auth-google.e2e-spec.ts` |
| 3 | Refresh rotation, reset and logout invalidate appropriate sessions | `auth-sessions.e2e-spec.ts` |
| 4 | User A cannot list/read/update/delete/export user B's forms or submissions, including mixed parent/child IDs | `ownership.e2e-spec.ts` |
| 5 | Creation cannot override user ownership through a DTO | `ownership.e2e-spec.ts` |
| 6 | All five field types reject wrong types, unknown fields/options and invalid required answers | `answer-validator.spec.ts` (doc 16) |
| 7 | Draft edits do not affect published rendering; stale saves/public versions conflict | `publication.e2e-spec.ts` |
| 8 | Historical snapshots render correctly after republishing | `publication.e2e-spec.ts` |
| 9 | Concurrent submission retries store once; unpublish/delete races do not accept afterward | `submission-races.e2e-spec.ts` |
| 10 | CSV escaping/formula protection and ownership checks pass | `csv-export.spec.ts` |
| 11 | Logs omit secrets and submitted answers | `redact.spec.ts` (doc 04) + `logging.e2e-spec.ts` |

## 1. Test database setup

E2E tests need a real Postgres — the row locks in doc 17 and the composite foreign key in doc 12 cannot be tested
against a mock.

```yaml
# docker-compose.yml — add alongside the existing postgres service
  postgres-test:
    image: postgres:16-alpine
    container_name: openform-postgres-test
    environment:
      POSTGRES_USER: openform
      POSTGRES_PASSWORD: openform
      POSTGRES_DB: openform_test
    ports:
      - "5433:5432"
    # No volume: the data is disposable, and a fresh container per CI run
    # is faster than cleaning one.
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U openform -d openform_test"]
      interval: 3s
      retries: 10
```

```bash
# .env.test
NODE_ENV=test
DB_HOST=localhost
DB_PORT=5433
DB_USERNAME=openform
DB_PASSWORD=openform
DB_NAME=openform_test
JWT_ACCESS_SECRET=test-access-secret-at-least-32-characters-long
JWT_REFRESH_SECRET=test-refresh-secret-at-least-32-characters-long
MAIL_TRANSPORT=console
# Effectively disable throttling, so a test that makes 30 requests does not
# fail on a rate limit. Doc 11's limits get their own dedicated test.
THROTTLE_LIMIT=10000
SUBMISSION_THROTTLE_LIMIT=10000
ARGON2_MEMORY_COST=8192
ARGON2_TIME_COST=2
```

Lowering the Argon2 cost for tests is the difference between a suite that runs in 30 seconds and one that runs in
five minutes — each registration is otherwise a deliberate ~50ms.

```ts
// test/setup.ts
import { config } from 'dotenv';
config({ path: '.env.test' });
```

```json
// test/jest-e2e.json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" },
  "setupFiles": ["<rootDir>/test/setup.ts"],
  "testTimeout": 30000,
  "maxWorkers": 1
}
```

`maxWorkers: 1` matters. The race tests in item 9 depend on controlling concurrency themselves; parallel test files
sharing one database make failures non-deterministic.

## 2. Shared harness

```ts
// test/helpers/app.helper.ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { validationExceptionFactory } from '../../src/common/pipes/validation-exception.factory';

export interface TestContext {
  app: INestApplication;
  dataSource: DataSource;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();

  // Mirror main.ts, or the tests validate a different application than
  // the one you deploy.
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.use(require('cookie-parser')());

  await app.init();

  const dataSource = app.get(DataSource);
  await dataSource.runMigrations();

  return { app, dataSource };
}

/**
 * TRUNCATE … CASCADE between tests. Faster than re-running migrations,
 * and RESTART IDENTITY keeps sequences predictable.
 */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  const tables = dataSource.entityMetadatas.map((e) => `"${e.tableName}"`).join(', ');
  await dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
```

```ts
// test/helpers/auth.helper.ts
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { User } from '../../src/modules/users/entities/user.entity';

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  refreshCookie: string;
}

/** Registers a user and marks them verified, which most tests need. */
export async function createVerifiedUser(
  app: INestApplication,
  dataSource: DataSource,
  email = `user-${Date.now()}-${Math.random()}@example.com`,
): Promise<TestUser> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ name: 'Test User', email, password: 'correct-horse-battery-staple' })
    .expect(201);

  await dataSource
    .getRepository(User)
    .update({ normalizedEmail: email.toLowerCase() }, { emailVerifiedAt: new Date() });

  // Re-login so the token carries emailVerified: true.
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: 'correct-horse-battery-staple' })
    .expect(200);

  return {
    id: login.body.user.id,
    email,
    accessToken: login.body.accessToken,
    refreshCookie: extractCookie(login.headers['set-cookie']),
  };
}

const extractCookie = (headers: string[] | undefined): string =>
  (headers ?? []).find((c) => c.startsWith('refresh_token='))?.split(';')[0] ?? '';
```

## 3. The ownership matrix (items 4 and 5)

The most important test file. PRD §3 is the product's entire authorization model, and §15 asks for it explicitly.

```ts
// test/ownership.e2e-spec.ts
import * as request from 'supertest';
import { createTestApp, resetDatabase, TestContext } from './helpers/app.helper';
import { createVerifiedUser, TestUser } from './helpers/auth.helper';

describe('Ownership (PRD §3, §15)', () => {
  let ctx: TestContext;
  let alice: TestUser;
  let bob: TestUser;
  let aliceForm: { id: string; slug: string };
  let aliceSubmissionId: string;
  let bobForm: { id: string };
  let bobSubmissionId: string;

  const api = () => request(ctx.app.getHttpServer());
  const as = (user: TestUser) => ({ Authorization: `Bearer ${user.accessToken}` });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    alice = await createVerifiedUser(ctx.app, ctx.dataSource, 'alice@example.com');
    bob = await createVerifiedUser(ctx.app, ctx.dataSource, 'bob@example.com');

    aliceForm = await publishFormWithSubmission(alice);
    aliceSubmissionId = aliceForm.submissionId;
    bobForm = await publishFormWithSubmission(bob);
    bobSubmissionId = bobForm.submissionId;
  });

  // --- PRD §15: "User A cannot list/read/update/delete/export user B's
  //     forms or submissions, including mixed parent/child IDs." ---

  describe("Bob cannot reach Alice's form", () => {
    // Every one of these is 404, never 403 — PRD §3: "Return 404 for
    // another person's private resource." A 403 would confirm it exists.
    it.each([
      ['GET',    (id: string) => api().get(`/api/v1/forms/${id}`)],
      ['PATCH',  (id: string) => api().patch(`/api/v1/forms/${id}`).send({ expectedDraftRevision: 0, title: 'hijacked' })],
      ['DELETE', (id: string) => api().delete(`/api/v1/forms/${id}`)],
      ['PUBLISH',   (id: string) => api().post(`/api/v1/forms/${id}/publish`).send({ expectedDraftRevision: 0 })],
      ['UNPUBLISH', (id: string) => api().post(`/api/v1/forms/${id}/unpublish`)],
    ])('%s returns 404', async (_label, call) => {
      await call(aliceForm.id).set(as(bob)).expect(404);
    });

    it('does not appear in his list', async () => {
      const { body } = await api().get('/api/v1/forms').set(as(bob)).expect(200);
      expect(body.items.map((f: { id: string }) => f.id)).not.toContain(aliceForm.id);
      expect(body.items).toHaveLength(1);
    });

    it('is not mutated by his failed PATCH', async () => {
      await api().patch(`/api/v1/forms/${aliceForm.id}`)
        .set(as(bob)).send({ expectedDraftRevision: 0, title: 'hijacked' }).expect(404);

      const { body } = await api().get(`/api/v1/forms/${aliceForm.id}`).set(as(alice)).expect(200);
      expect(body.title).not.toBe('hijacked');
    });
  });

  describe("Bob cannot reach Alice's submissions", () => {
    it.each([
      ['list',   () => api().get(`/api/v1/forms/${aliceForm.id}/submissions`)],
      ['detail', () => api().get(`/api/v1/forms/${aliceForm.id}/submissions/${aliceSubmissionId}`)],
      ['export', () => api().get(`/api/v1/forms/${aliceForm.id}/submissions/export`)],
      ['delete', () => api().delete(`/api/v1/forms/${aliceForm.id}/submissions/${aliceSubmissionId}`)],
    ])('%s returns 404', async (_label, call) => {
      await call().set(as(bob)).expect(404);
    });
  });

  // PRD §15: "including mixed parent/child IDs". The case a naive
  // implementation fails: each ID alone passes its own check.
  describe('mixed parent/child IDs', () => {
    it("rejects Alice's form ID with Bob's submission ID", async () => {
      await api()
        .get(`/api/v1/forms/${aliceForm.id}/submissions/${bobSubmissionId}`)
        .set(as(alice))
        .expect(404);
    });

    it("rejects Bob's form ID with Alice's submission ID", async () => {
      await api()
        .get(`/api/v1/forms/${bobForm.id}/submissions/${aliceSubmissionId}`)
        .set(as(bob))
        .expect(404);
    });

    it('rejects deletion through a mismatched parent', async () => {
      await api()
        .delete(`/api/v1/forms/${aliceForm.id}/submissions/${bobSubmissionId}`)
        .set(as(alice))
        .expect(404);

      // And Bob's submission still exists.
      await api()
        .get(`/api/v1/forms/${bobForm.id}/submissions/${bobSubmissionId}`)
        .set(as(bob))
        .expect(200);
    });
  });

  // --- PRD §15: "Creation cannot override user ownership through a DTO." ---

  describe('ownership cannot be set through a DTO (PRD §3)', () => {
    it.each(['userId', 'ownerId', 'user_id'])(
      'rejects %s in the create body',
      async (property) => {
        await api()
          .post('/api/v1/forms')
          .set(as(bob))
          .send({ title: 'Mine now', [property]: alice.id })
          .expect(422);
      },
    );

    it('assigns ownership from the token, not the body', async () => {
      const { body } = await api()
        .post('/api/v1/forms').set(as(bob)).send({ title: 'Bob form' }).expect(201);

      // Alice cannot see it, so it is Bob's.
      await api().get(`/api/v1/forms/${body.id}`).set(as(alice)).expect(404);
      await api().get(`/api/v1/forms/${body.id}`).set(as(bob)).expect(200);
    });

    it('rejects slug and status in the create body', async () => {
      await api().post('/api/v1/forms').set(as(bob))
        .send({ title: 'X', slug: 'chosen-slug', status: 'published' })
        .expect(422);
    });
  });

  describe('public access grants nothing private (PRD §8)', () => {
    it('does not expose owner or draft data', async () => {
      const { body } = await api().get(`/api/v1/public/forms/${aliceForm.slug}`).expect(200);
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('draftSchema');
      expect(body).not.toHaveProperty('user');
      expect(JSON.stringify(body)).not.toContain('alice@example.com');
    });

    it('does not allow reading responses', async () => {
      await api().get(`/api/v1/public/forms/${aliceForm.slug}/submissions`).expect(404);
    });

    it('a submission receipt grants no read access', async () => {
      const { body } = await api()
        .post(`/api/v1/public/forms/${aliceForm.slug}/submissions`)
        .send({ publicationVersion: 1, answers: { fld_name: 'Anon' } })
        .expect(201);

      // The receipt ID is real, but unauthenticated reads are refused.
      await api().get(`/api/v1/forms/${aliceForm.id}/submissions/${body.id}`).expect(401);
      await api().get(`/api/v1/forms/${aliceForm.id}/submissions/${body.id}`)
        .set(as(bob)).expect(404);
    });
  });
});
```

## 4. Publication and snapshots (items 7 and 8)

```ts
// test/publication.e2e-spec.ts
describe('Publication (PRD §7, §15)', () => {
  it('draft edits do not affect published rendering', async () => {
    const form = await createPublishedForm(alice, { title: 'Original' });

    await api().patch(`/api/v1/forms/${form.id}`).set(as(alice))
      .send({ expectedDraftRevision: form.draftRevision, title: 'Edited draft' })
      .expect(200);

    const { body } = await api().get(`/api/v1/public/forms/${form.slug}`).expect(200);
    expect(body.title).toBe('Original');
  });

  it('a stale draft save returns 409 and does not overwrite', async () => {
    const form = await createForm(alice);

    await api().patch(`/api/v1/forms/${form.id}`).set(as(alice))
      .send({ expectedDraftRevision: 0, title: 'Tab one' }).expect(200);

    const conflict = await api().patch(`/api/v1/forms/${form.id}`).set(as(alice))
      .send({ expectedDraftRevision: 0, title: 'Tab two' }).expect(409);
    expect(conflict.body.code).toBe('DRAFT_CONFLICT');

    const { body } = await api().get(`/api/v1/forms/${form.id}`).set(as(alice)).expect(200);
    expect(body.title).toBe('Tab one');
  });

  it('a stale publicationVersion returns 409 FORM_CHANGED', async () => {
    const form = await createPublishedForm(alice);
    const response = await api().post(`/api/v1/public/forms/${form.slug}/submissions`)
      .send({ publicationVersion: 99, answers: {} }).expect(409);
    expect(response.body.code).toBe('FORM_CHANGED');
  });

  // PRD §15: "Historical snapshots render correctly after republishing."
  it('renders a historical response with its original labels', async () => {
    const form = await createPublishedForm(alice, {
      fields: [{
        id: 'fld_pick', type: 'multiple_choice', label: 'Pick one', required: true,
        options: [{ id: 'opt_a', label: 'Original label' }],
      }],
    });

    const submission = await api().post(`/api/v1/public/forms/${form.slug}/submissions`)
      .send({ publicationVersion: 1, answers: { fld_pick: 'opt_a' } }).expect(201);

    // Rename the label and republish.
    await api().patch(`/api/v1/forms/${form.id}`).set(as(alice)).send({
      expectedDraftRevision: 1,
      schema: { schemaVersion: 1, fields: [{
        id: 'fld_pick', type: 'multiple_choice', label: 'Pick one', required: true,
        options: [{ id: 'opt_a', label: 'Renamed label' }],
      }] },
    }).expect(200);
    await api().post(`/api/v1/forms/${form.id}/publish`).set(as(alice))
      .send({ expectedDraftRevision: 2 }).expect(201);

    // The old response still shows what the respondent actually saw.
    const { body } = await api()
      .get(`/api/v1/forms/${form.id}/submissions/${submission.body.id}`)
      .set(as(alice)).expect(200);
    expect(JSON.stringify(body)).toContain('Original label');
    expect(JSON.stringify(body)).not.toContain('Renamed label');
  });
});
```

## 5. Races (item 9)

```ts
// test/submission-races.e2e-spec.ts
describe('Submission races (PRD §8, §15)', () => {
  // "Concurrent submission retries store once"
  it('stores one submission for concurrent identical idempotent requests', async () => {
    const form = await createPublishedForm(alice);
    const payload = { publicationVersion: 1, answers: { fld_name: 'Grace' } };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api().post(`/api/v1/public/forms/${form.slug}/submissions`)
          .set('Idempotency-Key', 'same-key').send(payload),
      ),
    );

    // Some may 409 on the unique (form_id, key_hash) constraint; what
    // matters is that exactly one row exists.
    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const ids = new Set(succeeded.map((r) => r.body.id));
    expect(ids.size).toBe(1);

    const count = await ctx.dataSource.query(
      'SELECT count(*)::int FROM submissions WHERE form_id = $1', [form.id],
    );
    expect(count[0].count).toBe(1);
  });

  // "unpublish/delete races do not accept afterward"
  it('refuses a submission after unpublish, even with a prior key', async () => {
    const form = await createPublishedForm(alice);
    const payload = { publicationVersion: 1, answers: { fld_name: 'Ada' } };

    await api().post(`/api/v1/public/forms/${form.slug}/submissions`)
      .set('Idempotency-Key', 'key-1').send(payload).expect(201);

    await api().post(`/api/v1/forms/${form.id}/unpublish`).set(as(alice)).expect(201);

    // PRD §8: "Unpublished/deleted forms remain unavailable even when
    // retrying a prior key."
    await api().post(`/api/v1/public/forms/${form.slug}/submissions`)
      .set('Idempotency-Key', 'key-1').send(payload).expect(404);
  });

  it('refuses a submission after the form is deleted', async () => {
    const form = await createPublishedForm(alice);
    await api().delete(`/api/v1/forms/${form.id}`).set(as(alice)).expect(204);
    await api().post(`/api/v1/public/forms/${form.slug}/submissions`)
      .send({ publicationVersion: 1, answers: { fld_name: 'Ada' } }).expect(404);
  });

  it('returns 409 for the same key with a different payload', async () => {
    const form = await createPublishedForm(alice);
    await api().post(`/api/v1/public/forms/${form.slug}/submissions`)
      .set('Idempotency-Key', 'k').send({ publicationVersion: 1, answers: { fld_name: 'A' } })
      .expect(201);

    const conflict = await api().post(`/api/v1/public/forms/${form.slug}/submissions`)
      .set('Idempotency-Key', 'k').send({ publicationVersion: 1, answers: { fld_name: 'B' } })
      .expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
```

## 6. CSV (item 10)

```ts
// src/modules/submissions/csv-export.spec.ts
describe('CsvExportService (PRD §9, §15)', () => {
  const service = new CsvExportService();

  describe('formula injection', () => {
    // The real attack: the form OWNER opens the export, and the formula
    // runs with access to their spreadsheet.
    it.each(['=HYPERLINK("http://evil","x")', '+1+1', '-1+1', '@SUM(A1)', '\t=1+1'])(
      'neutralizes %s',
      (dangerous) => {
        const cell = service.escapeCell(dangerous);
        expect(cell.startsWith('\t')).toBe(true);
      },
    );

    it('leaves safe values untouched', () => {
      expect(service.escapeCell('Ada Lovelace')).toBe('Ada Lovelace');
      expect(service.escapeCell('3 - 2')).toBe('3 - 2');  // not leading
    });
  });

  describe('RFC 4180 escaping', () => {
    it('quotes and doubles embedded quotes', () => {
      expect(service.escapeCell('Smith, "Bob"')).toBe('"Smith, ""Bob"""');
    });

    it('quotes newlines', () => {
      expect(service.escapeCell('line one\nline two')).toBe('"line one\nline two"');
    });

    it('renders null and undefined as empty', () => {
      expect(service.escapeCell(null)).toBe('');
      expect(service.escapeCell(undefined)).toBe('');
    });
  });

  describe('columns', () => {
    it('unions field IDs across differing snapshots', () => {
      const columns = service.buildColumns([
        submissionWith([field('fld_a', 'A')]),
        submissionWith([field('fld_a', 'A'), field('fld_b', 'B')]),
      ]);
      expect(columns.map((c) => c.id)).toEqual(['fld_a', 'fld_b']);
    });

    it('disambiguates duplicate labels with an ID suffix', () => {
      const columns = service.buildColumns([
        submissionWith([field('fld_one', 'Name'), field('fld_two', 'Name')]),
      ]);
      expect(columns[0].header).not.toBe(columns[1].header);
      expect(columns[0].header).toContain('Name');
    });

    it('includes headers for an empty export', async () => {
      const csv = await streamToString(service.stream([]));
      expect(csv.trim()).toBe('Response ID,Submitted at (UTC)');
    });
  });
});
```

## 7. Log hygiene (item 11)

```ts
// test/logging.e2e-spec.ts
describe('Log hygiene (PRD §14, §15)', () => {
  let captured: string[];

  beforeEach(() => {
    captured = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured.push(String(chunk));
      return true;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      captured.push(String(chunk));
      return true;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('never logs a registration password', async () => {
    await api().post('/api/v1/auth/register')
      .send({ name: 'Ada', email: 'log@example.com', password: 'super-secret-password-1' });
    expect(captured.join('')).not.toContain('super-secret-password-1');
  });

  it('never logs a password on a FAILED registration', async () => {
    // The validation-error path is where bodies most often leak.
    await api().post('/api/v1/auth/register')
      .send({ name: 'x', email: 'bad', password: 'super-secret-password-2' });
    expect(captured.join('')).not.toContain('super-secret-password-2');
  });

  it('never logs submitted answers (PRD §14)', async () => {
    const form = await createPublishedForm(alice);
    await api().post(`/api/v1/public/forms/${form.slug}/submissions`)
      .send({ publicationVersion: 1, answers: { fld_name: 'CONFIDENTIAL-ANSWER' } });
    expect(captured.join('')).not.toContain('CONFIDENTIAL-ANSWER');
  });

  it('never logs an answer on a 422 either', async () => {
    const form = await createPublishedForm(alice);
    await api().post(`/api/v1/public/forms/${form.slug}/submissions`)
      .send({ publicationVersion: 1, answers: { fld_unknown: 'SECRET-VALUE' } });
    expect(captured.join('')).not.toContain('SECRET-VALUE');
  });

  it('never logs a bearer token or an Idempotency-Key (PRD §11)', async () => {
    await api().get('/api/v1/users/me')
      .set('Authorization', 'Bearer SECRET-TOKEN-VALUE')
      .set('Idempotency-Key', 'SECRET-IDEMPOTENCY-KEY');
    const output = captured.join('');
    expect(output).not.toContain('SECRET-TOKEN-VALUE');
    expect(output).not.toContain('SECRET-IDEMPOTENCY-KEY');
  });
});
```

## 8. Scripts

```json
"test": "jest",
"test:watch": "jest --watch",
"test:cov": "jest --coverage",
"test:e2e": "jest --config ./test/jest-e2e.json --runInBand",
"test:all": "pnpm test && pnpm test:e2e",
"typecheck": "tsc --noEmit"
```

Add `typecheck` explicitly — `pnpm build` emits, which is slower and writes to disk. CI wants the check alone.

## Verify

```bash
docker compose up -d postgres-test

pnpm test
# expected: unit suites pass — redact, answer-validator, pagination, csv-export

pnpm test:e2e
# expected: all e2e suites pass

# The §15 checklist, by file:
pnpm test:e2e -- ownership          # items 4, 5
pnpm test:e2e -- publication        # items 7, 8
pnpm test:e2e -- submission-races   # item 9
pnpm test:e2e -- auth-tokens        # item 1
pnpm test:e2e -- auth-sessions      # item 3
pnpm test:e2e -- logging            # item 11
pnpm test -- answer-validator       # item 6
pnpm test -- csv-export             # item 10

# Coverage on the files that enforce a security rule
pnpm test:cov -- --collectCoverageFrom='src/modules/**/+(answer-validator|csv-export).service.ts'
```

A useful sanity check: temporarily break one rule and confirm a test fails. Remove `userId` from the predicate in
`FormsService.findOwned` and `ownership.e2e-spec.ts` should go red. A security test that never fails is not testing
anything.

## If you skip this

PRD §15 defines MVP completion partly as "ownership tests pass". More practically: the ownership matrix and the race
tests cover behaviour that is invisible in manual testing — nobody discovers a mixed parent/child ID bug by clicking
around, and nobody notices a leaked password in a log until it is in an aggregator.

---

Previous: [17 — Submissions](./17-submissions.md) · Next: [19 — Docker, deployment & README](./19-deployment.md)
