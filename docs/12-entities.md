# 12 — Entities & first migration

## Why

PRD §10 specifies seven tables, their key columns, three indexes, a unique constraint and one subtle foreign-key
requirement. Every one of the current entity files is an empty, undecorated class — so `autoLoadEntities` finds
nothing and the database has no tables at all.

This is the document where the schema becomes real. Get the constraints right here: changing a primary key or adding
a unique index after production data exists is a migration with downtime.

## The model

| Entity | Table | Purpose |
|---|---|---|
| `User` | `users` | Account identity |
| `AuthIdentity` | `auth_identities` | Google (and future) provider links |
| `Session` | `sessions` | Refresh-token sessions with replay detection |
| `AuthToken` | `auth_tokens` | Email verification and password reset |
| `Form` | `forms` | Draft + published snapshot, JSONB |
| `Submission` | `submissions` | Answers + the snapshot that validated them |
| `SubmissionIdempotency` | `submission_idempotency` | 24h idempotency keys |

Rules from §10 that apply throughout: UUID IDs, UTC `timestamptz`, `snake_case` columns (doc 03's naming strategy
handles this), `lower_snake_case` enum values.

## 1. Enums

```ts
// src/modules/users/entities/user.entity.ts (top of file)
export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

export enum AuthProvider {
  GOOGLE = 'google',
}

export enum AuthTokenPurpose {
  EMAIL_VERIFICATION = 'email_verification',
  PASSWORD_RESET = 'password_reset',
}

export enum FormStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
}
```

Values are `lower_snake_case` per §10. Put each enum beside its entity; they are inlined here for readability.

## 2. `User`

```ts
// src/modules/users/entities/user.entity.ts
import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { AuthIdentity } from '../../auth/entities/auth-identity.entity';
import { Session } from '../../auth/entities/session.entity';
import { Form } from '../../forms/entities/form.entity';

export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

@Entity('users')
export class User extends BaseEntity {
  /** PRD §4: 2–100 characters. */
  @Column({ type: 'varchar', length: 100 })
  name: string;

  /**
   * PRD §4: "email normalized by trim/lowercase and unique". Normalization
   * happens in the service before write; this column stores the result.
   *
   * §4 also warns: "Do not apply provider-specific email dot/plus
   * rewriting" — so a.b@gmail.com and ab@gmail.com are different accounts.
   */
  @Index('uq_users_normalized_email', { unique: true })
  @Column({ type: 'varchar', length: 320 })
  normalizedEmail: string;

  /** The address as the user typed it, for display and outgoing mail. */
  @Column({ type: 'varchar', length: 320 })
  email: string;

  /**
   * Null for Google-only accounts. PRD §4: "Google-only accounts do not
   * gain a password through the reset endpoint."
   *
   * select: false means a plain find() never loads it — the single most
   * effective guard against leaking it through a response DTO.
   */
  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  passwordHash: string | null;

  /** Null until verified. PRD §4: unverified users may sign in but not manage forms. */
  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @OneToMany(() => AuthIdentity, (identity) => identity.user)
  identities: AuthIdentity[];

  @OneToMany(() => Session, (session) => session.user)
  sessions: Session[];

  @OneToMany(() => Form, (form) => form.user)
  forms: Form[];

  get isEmailVerified(): boolean {
    return this.emailVerifiedAt !== null;
  }
}
```

`select: false` on `passwordHash` is worth the inconvenience. Doc 13 must opt in explicitly
(`.addSelect('user.passwordHash')`) to verify a login, and every other query physically cannot return it.

## 3. `AuthIdentity`

```ts
// src/modules/auth/entities/auth-identity.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';

export enum AuthProvider {
  GOOGLE = 'google',
}

/** PRD §10: unique(provider, provider_subject). */
@Entity('auth_identities')
@Unique('uq_auth_identities_provider_subject', ['provider', 'providerSubject'])
export class AuthIdentity extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, (user) => user.identities, {
    // Deleting a user removes their provider links.
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: AuthProvider })
  provider: AuthProvider;

  /**
   * The provider's stable subject identifier (Google's `sub`).
   *
   * PRD §4: "Resolve an identity using provider subject." Never match on
   * the provider's email — a Google account's email address can change,
   * and matching on it is how accounts get silently merged.
   */
  @Column({ type: 'varchar', length: 255 })
  providerSubject: string;
}
```

## 4. `Session`

```ts
// src/modules/auth/entities/session.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * PRD §4: refresh session 30 days, hash stored in the database, rotated on
 * use with replay detection.
 */
@Entity('sessions')
@Index('idx_sessions_user_id_expires_at', ['userId', 'expiresAt'])
export class Session extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, (user) => user.sessions, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /**
   * SHA-256 of the refresh token. PRD §4: "hash stored in database" and
   * §11: "Never return password/token hashes in API serialization."
   *
   * Indexed and unique because every refresh is a lookup by this value.
   */
  @Index('uq_sessions_refresh_token_hash', { unique: true })
  @Column({ type: 'varchar', length: 64, select: false })
  refreshTokenHash: string;

  /**
   * Replay detection (PRD §4). All rotations of one login share a family
   * ID. If a token hash that was already rotated is presented again, the
   * whole family is revoked — the token was stolen, and we cannot tell
   * whether the attacker or the user is holding the current one.
   */
  @Index('idx_sessions_family_id')
  @Column({ type: 'uuid' })
  familyId: string;

  /** How many times this family has rotated. Evidence for replay analysis. */
  @Column({ type: 'int', default: 0 })
  rotationCount: number;

  /** Set when this row is superseded by a rotation. */
  @Column({ type: 'timestamptz', nullable: true })
  rotatedAt: Date | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /** Set on logout, on password reset, or on replay detection. */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** Coarse evidence for a future session list. Not an audit log (PRD §14). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  get isActive(): boolean {
    return this.revokedAt === null && this.expiresAt > new Date();
  }
}
```

## 5. `AuthToken`

```ts
// src/modules/auth/entities/auth-token.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';

export enum AuthTokenPurpose {
  EMAIL_VERIFICATION = 'email_verification',
  PASSWORD_RESET = 'password_reset',
}

/**
 * PRD §4: verification and reset tokens are random, hashed, single-use and
 * expiring (24 hours and 30 minutes respectively).
 */
@Entity('auth_tokens')
@Index('idx_auth_tokens_user_purpose', ['userId', 'purpose'])
export class AuthToken extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: AuthTokenPurpose })
  purpose: AuthTokenPurpose;

  /** SHA-256 of the token sent by email. The plaintext is never stored. */
  @Index('uq_auth_tokens_token_hash', { unique: true })
  @Column({ type: 'varchar', length: 64, select: false })
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /** Set on use. PRD §4: "single-use" — this column is what enforces it. */
  @Column({ type: 'timestamptz', nullable: true })
  consumedAt: Date | null;
}
```

## 6. `Form`

PRD §7 is emphatic: *"Use JSONB form schemas and JSONB answers. Do not create database columns for questions."*

```ts
// src/modules/forms/entities/form.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';
import { Submission } from '../../submissions/entities/submission.entity';
import { FormSchema, FormSettings, PublishedSnapshot } from '../types/form-schema.types';

export enum FormStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
}

/** PRD §10: index (user_id, updated_at, id) — the My Forms list query. */
@Entity('forms')
@Index('idx_forms_user_id_updated_at_id', ['userId', 'updatedAt', 'id'])
export class Form extends BaseEntity {
  /** PRD §3: "forms.user_id identifies the owner." */
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, (user) => user.forms, {
    // PRD §9: "Form deletion removes all associated responses…
    // transactionally". Deleting a user removes their forms, and the
    // cascade below removes those forms' submissions.
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * PRD §7: "globally unique opaque public slug". Opaque matters — a slug
   * derived from the title would let anyone enumerate forms by guessing
   * titles. Public URL: /f/:slug
   */
  @Index('uq_forms_slug', { unique: true })
  @Column({ type: 'varchar', length: 32 })
  slug: string;

  @Column({ type: 'enum', enum: FormStatus, default: FormStatus.DRAFT })
  status: FormStatus;

  /** The in-progress schema. PRD §7: JSONB, no columns per question. */
  @Column({ type: 'jsonb', default: () => `'{"schemaVersion":1,"fields":[]}'` })
  draftSchema: FormSchema;

  @Column({ type: 'jsonb', default: () => `'{}'` })
  draftSettings: FormSettings;

  /**
   * PRD §6: optimistic concurrency for autosave. "Include
   * expectedDraftRevision; stale writes return 409 rather than overwrite
   * edits from another tab."
   */
  @Column({ type: 'int', default: 0 })
  draftRevision: number;

  /**
   * PRD §7: ONE published snapshot. Null until first publish and after
   * unpublish. Draft edits never touch this — that separation is what
   * makes "Publish Changes" meaningful.
   */
  @Column({ type: 'jsonb', nullable: true })
  publishedSnapshot: PublishedSnapshot | null;

  /**
   * PRD §7: incremented on every publish. §8: a submission carrying a
   * stale value is rejected with 409 FORM_CHANGED.
   */
  @Column({ type: 'int', default: 0 })
  publicationVersion: number;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @OneToMany(() => Submission, (submission) => submission.form)
  submissions: Submission[];

  get isPublished(): boolean {
    return this.status === FormStatus.PUBLISHED && this.publishedSnapshot !== null;
  }
}
```

The JSONB shapes (doc 16 defines them fully):

```ts
// src/modules/forms/types/form-schema.types.ts
export type FieldType = 'text' | 'textarea' | 'email' | 'multiple_choice' | 'checkbox';

export interface FieldOption {
  id: string;
  label: string;
}

export interface FieldValidation {
  minLength?: number;
  maxLength?: number;
  minSelections?: number;
  maxSelections?: number;
}

export interface FormField {
  /** PRD §6: "Field and option IDs are stable." Label changes never change this. */
  id: string;
  type: FieldType;
  label: string;
  helpText?: string;
  placeholder?: string;
  required: boolean;
  options?: FieldOption[];
  validation?: FieldValidation;
}

export interface FormSchema {
  schemaVersion: 1;
  fields: FormField[];
}

export interface FormSettings {
  submitText?: string;
  successMessage?: string;
}

/** PRD §7: publishing snapshots title, description, fields, submit text and success message. */
export interface PublishedSnapshot {
  schemaVersion: 1;
  title: string;
  description: string | null;
  fields: FormField[];
  submitText: string;
  successMessage: string;
  publishedAt: string;
}
```

## 7. `Submission`

```ts
// src/modules/submissions/entities/submission.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Form } from '../../forms/entities/form.entity';
import { FormField } from '../../forms/types/form-schema.types';

export type SubmissionAnswers = Record<string, string | string[]>;

export interface SubmissionSnapshot {
  schemaVersion: 1;
  title: string;
  fields: FormField[];
}

/**
 * PRD §10: index (form_id, created_at, id). PRD §10 also gives submissions
 * created_at but no updated_at — submissions are immutable, so this does
 * NOT extend BaseEntity.
 */
@Entity('submissions')
@Index('idx_submissions_form_id_created_at_id', ['formId', 'createdAt', 'id'])
export class Submission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  formId: string;

  @ManyToOne(() => Form, (form) => form.submissions, {
    // PRD §9: "Form deletion removes all associated responses… transactionally".
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'form_id' })
  form: Form;

  /** PRD §7: JSONB answers, keyed by stable field ID. */
  @Column({ type: 'jsonb' })
  answers: SubmissionAnswers;

  /**
   * PRD §7: "Each response stores the snapshot used to validate it,
   * preserving old labels/options after republishing."
   *
   * This duplication is the design. Without it, renaming an option after
   * publication silently rewrites the meaning of past answers.
   */
  @Column({ type: 'jsonb' })
  schemaSnapshot: SubmissionSnapshot;

  @Column({ type: 'int' })
  publicationVersion: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

## 8. `SubmissionIdempotency`

This entity carries §10's most easily-missed requirement:

> Use form-qualified foreign keys for idempotency-to-submission references so records cannot point to another form's
> submission.

```ts
// src/modules/submissions/entities/submission-idempotency.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Form } from '../../forms/entities/form.entity';
import { Submission } from './submission.entity';

/**
 * PRD §8: "Support optional Idempotency-Key scoped to form for 24 hours.
 * Store key/payload hash and original response result."
 */
@Entity('submission_idempotency')
@Unique('uq_submission_idempotency_form_key', ['formId', 'keyHash'])
@Index('idx_submission_idempotency_expires_at', ['expiresAt'])
export class SubmissionIdempotency {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  formId: string;

  @ManyToOne(() => Form, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'form_id' })
  form: Form;

  /** SHA-256 of the client's Idempotency-Key. PRD §11: never logged. */
  @Column({ type: 'varchar', length: 64 })
  keyHash: string;

  /**
   * SHA-256 of the canonical request body. PRD §8: "same key/payload
   * returns previous success; changed payload returns 409."
   */
  @Column({ type: 'varchar', length: 64 })
  payloadHash: string;

  @Column({ type: 'uuid', nullable: true })
  submissionId: string | null;

  @ManyToOne(() => Submission, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'submission_id' })
  submission: Submission | null;

  /** PRD §8: 24 hours. */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

The form-qualified foreign key cannot be expressed by TypeORM decorators alone — it needs a composite key on
`submissions`. Add it by hand to the migration:

```ts
// In the generated migration's up(), after the tables are created:

// PRD §10: "Use form-qualified foreign keys for idempotency-to-submission
// references so records cannot point to another form's submission."
//
// Without this, a crafted request could associate form A's idempotency
// record with form B's submission, leaking a submission ID across forms.
await queryRunner.query(`
  ALTER TABLE submissions
  ADD CONSTRAINT uq_submissions_id_form_id UNIQUE (id, form_id)
`);

await queryRunner.query(`
  ALTER TABLE submission_idempotency
  DROP CONSTRAINT IF EXISTS "FK_submission_idempotency_submission_id"
`);

await queryRunner.query(`
  ALTER TABLE submission_idempotency
  ADD CONSTRAINT fk_submission_idempotency_submission
  FOREIGN KEY (submission_id, form_id)
  REFERENCES submissions (id, form_id)
  ON DELETE CASCADE
`);
```

Now the database itself rejects a cross-form reference. An application-level check would be a bug waiting to happen.

## 9. Register the entities

Each module declares the entities its repositories need:

```ts
// src/modules/forms/forms.module.ts
import { TypeOrmModule } from '@nestjs/typeorm';
import { Form } from './entities/form.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Form])],
  // …
})
```

Same pattern for `users` (`User`), `auth` (`AuthIdentity`, `Session`, `AuthToken`, `User`) and `submissions`
(`Submission`, `SubmissionIdempotency`, `Form`).

## 10. Generate and run the migration

```bash
rm -f src/modules/*/entities/*.ts.orig
pnpm build                                     # surfaces type errors first
pnpm migration:generate src/database/migrations/InitialSchema
```

**Read the generated file before running it.** Check specifically:

- Column names are `snake_case` (`password_hash`, not `passwordHash`) — if not, doc 03's naming strategy is not wired
- `jsonb`, not `json`, on the five JSONB columns
- `timestamp with time zone` on every date column
- The three §10 indexes are present
- `ON DELETE CASCADE` on every foreign key

Then add the composite-key block from section 8 to `up()`, and run:

```bash
pnpm migration:run
```

## Verify

```bash
# 1. All seven tables exist, correctly named
docker compose exec postgres psql -U openform -d openform -c '\dt'
# expected: auth_identities, auth_tokens, forms, migrations, sessions,
#           submission_idempotency, submissions, users

# 2. Columns are snake_case with the right types
docker compose exec postgres psql -U openform -d openform -c '\d users'
# expected: normalized_email, password_hash, email_verified_at
#           created_at/updated_at as "timestamp with time zone"

docker compose exec postgres psql -U openform -d openform -c '\d forms'
# expected: draft_schema / draft_settings / published_snapshot as jsonb

# 3. The PRD §10 indexes exist
docker compose exec postgres psql -U openform -d openform -c "
  select indexname from pg_indexes
  where tablename in ('forms','submissions','submission_idempotency')
  order by indexname;"
# expected to include:
#   idx_forms_user_id_updated_at_id
#   idx_submissions_form_id_created_at_id
#   uq_submission_idempotency_form_key

# 4. The form-qualified foreign key is in place
docker compose exec postgres psql -U openform -d openform -c "
  select conname, pg_get_constraintdef(oid)
  from pg_constraint
  where conrelid = 'submission_idempotency'::regclass and contype = 'f';"
# expected: FOREIGN KEY (submission_id, form_id) REFERENCES submissions(id, form_id)

# 5. That constraint actually blocks a cross-form reference
docker compose exec postgres psql -U openform -d openform <<'SQL'
BEGIN;
INSERT INTO users (id, name, email, normalized_email, status)
  VALUES (gen_random_uuid(), 'T', 't@e.com', 't@e.com', 'active');
INSERT INTO forms (id, user_id, title, slug, status)
  SELECT gen_random_uuid(), id, 'A', 'slug-a', 'draft' FROM users LIMIT 1;
INSERT INTO forms (id, user_id, title, slug, status)
  SELECT gen_random_uuid(), id, 'B', 'slug-b', 'draft' FROM users LIMIT 1;
INSERT INTO submissions (id, form_id, answers, schema_snapshot, publication_version)
  SELECT gen_random_uuid(), id, '{}', '{}', 1 FROM forms WHERE slug = 'slug-a';
-- Point form B's idempotency record at form A's submission. Must fail.
INSERT INTO submission_idempotency (id, form_id, key_hash, payload_hash, submission_id, expires_at)
  SELECT gen_random_uuid(),
         (SELECT id FROM forms WHERE slug = 'slug-b'),
         'k', 'p',
         (SELECT id FROM submissions LIMIT 1),
         now() + interval '1 day';
ROLLBACK;
SQL
# expected: ERROR: insert or update on table "submission_idempotency"
#           violates foreign key constraint

# 6. Unique email is enforced
docker compose exec postgres psql -U openform -d openform -c "
  select indexdef from pg_indexes where indexname = 'uq_users_normalized_email';"
# expected: CREATE UNIQUE INDEX …

# 7. The migration is reversible
pnpm migration:revert && pnpm migration:run
# expected: both succeed; \dt shows the same tables afterwards

# 8. The app boots against the migrated schema
pnpm start:dev
```

Step 5 is the one to actually run. It is the only direct test of the §10 requirement that is easiest to skip and
hardest to retrofit.

## If you skip this

Nothing after this point has a table to write to. More specifically: the composite foreign key and the unique
`(form_id, key_hash)` constraint cannot be added cleanly once submission data exists, because adding a unique
constraint to a table with duplicates fails and you must then decide which rows to delete.

---

Previous: [11 — Rate limiting](./11-rate-limiting.md) · Next: [13 — Auth module](./13-auth.md)
