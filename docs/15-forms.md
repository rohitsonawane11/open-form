# 15 — Forms module

## Why

Seven endpoints (PRD §12), and the module where the ownership model lives. PRD §3 states the rule in a way that is
easy to read past:

> Every private form query includes `user_id = authenticatedUser.id`. Updates/deletes include ownership in the
> **mutation predicate, not only an earlier lookup**.

And:

> Return 404 for another person's private resource.

Plus §6's optimistic concurrency for autosave, and §7's draft/published separation.

## The endpoints (PRD §12)

| Method | Path | Purpose |
|---|---|---|
| POST | `/forms` | Create owned form |
| GET | `/forms` | List/search own forms |
| GET | `/forms/:formId` | Read owned draft/settings |
| PATCH | `/forms/:formId` | Save draft with concurrency check |
| DELETE | `/forms/:formId` | Delete own form and submissions |
| POST | `/forms/:formId/publish` | Publish/republish saved draft |
| POST | `/forms/:formId/unpublish` | Disable public access |

## 1. The ownership rule, concretely

The difference §3 is pointing at:

```ts
// WRONG — a check, then an unscoped mutation.
const form = await this.forms.findOneBy({ id: formId });
if (form.userId !== userId) throw new NotFoundError();
await this.forms.update(formId, { title });   // ← ownership is not here
```

Between the read and the write, nothing holds the row. More importantly, the mutation itself is correct only because
of code that ran earlier — delete the check during a refactor and the bug is silent.

```ts
// RIGHT — ownership is part of the mutation.
const result = await this.forms.update(
  { id: formId, userId },        // ← the predicate carries it
  { title },
);
if (result.affected === 0) throw new NotFoundError('Form not found');
```

`affected === 0` covers both "no such form" and "not yours", and the caller cannot tell which — PRD §3's 404 rule.

## 2. DTOs

```ts
// src/modules/forms/dto/create-form.dto.ts
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * PRD §11: CreateFormDto takes title and optional description.
 *
 * Note what is NOT here: userId, ownerId, slug, status. PRD §3: "Never
 * accept userId/ownerId from form creation bodies." With
 * forbidNonWhitelisted (doc 07) such a property is a 422, not a silent drop.
 */
export class CreateFormDto {
  /** PRD §6: labels 200 characters — the same bound applies to the title. */
  @IsString()
  @Length(1, 200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
```

```ts
// src/modules/forms/dto/update-form.dto.ts
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Length, Min, ValidateNested } from 'class-validator';
import { FormSchemaDto } from './form-schema.dto';   // doc 16
import { FormSettingsDto } from './form-settings.dto';

/**
 * PRD §11: UpdateFormDto takes expectedDraftRevision plus optional
 * title/description/schema/settings.
 */
export class UpdateFormDto {
  /**
   * PRD §6: "Include expectedDraftRevision; stale writes return 409 rather
   * than overwrite edits from another tab."
   *
   * Required, not optional — an autosave without it would silently win
   * every race, which is the behaviour this field exists to prevent.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedDraftRevision: number;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => FormSchemaDto)
  schema?: FormSchemaDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => FormSettingsDto)
  settings?: FormSettingsDto;
}

// src/modules/forms/dto/publish-form.dto.ts
export class PublishFormDto {
  /** PRD §11: publishing also carries the expected revision. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedDraftRevision: number;
}
```

`FormQueryDto` is in doc 10.

## 3. Create

```ts
// src/modules/forms/forms.service.ts
async create(userId: string, dto: CreateFormDto): Promise<Form> {
  const form = this.forms.create({
    // PRD §3 / §11: ownership comes from the access token. The DTO has no
    // userId property, so there is no path for a client to set it.
    userId,
    title: dto.title,
    description: dto.description ?? null,
    // PRD §7: "New forms have a globally unique opaque public slug."
    slug: await this.generateUniqueSlug(),
    status: FormStatus.DRAFT,
    draftSchema: { schemaVersion: 1, fields: [] },
    draftSettings: {},
    draftRevision: 0,
    publishedSnapshot: null,
    publicationVersion: 0,
  });

  return this.forms.save(form);
}

/**
 * PRD §7: "globally unique opaque public slug". Opaque is the requirement —
 * a title-derived slug would let anyone enumerate forms by guessing titles,
 * and would leak the title of an unpublished draft.
 */
private async generateUniqueSlug(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = randomBytes(12).toString('base64url');   // ~72 bits
    if (!(await this.forms.existsBy({ slug }))) return slug;
  }
  // The unique index is the real guarantee; this is a courtesy.
  throw new Error('Could not generate a unique slug');
}
```

## 4. List

```ts
/** PRD §5: title search, pagination, allowlisted sorting. */
async findAll(userId: string, query: FormQueryDto): Promise<PaginatedDto<FormListItem>> {
  const qb = this.forms
    .createQueryBuilder('form')
    // PRD §3: "Every private form query includes user_id = authenticatedUser.id."
    .where('form.user_id = :userId', { userId });

  if (query.search) {
    // Parameterized (PRD §14: "parameterized SQL"). The % wrappers are
    // bound as part of the VALUE, never concatenated into the SQL.
    qb.andWhere('form.title ILIKE :search', { search: `%${query.search}%` });
  }

  // PRD §5: "default order updated descending, then ID" — orderBy comes
  // from the allowlist in doc 10, so no client string reaches the SQL.
  for (const [column, direction] of Object.entries(query.orderBy)) {
    qb.addOrderBy(`form.${column}`, direction);
  }

  // PRD §5: "response count" in the list. A correlated subquery avoids
  // the N+1 that a per-row count would cause.
  qb.loadRelationCountAndMap('form.submissionCount', 'form.submissions');

  qb.skip(query.skip).take(query.take);

  return PaginatedDto.from(await qb.getManyAndCount(), query);
}
```

The `ILIKE` parameter is worth a second look: `` `%${query.search}%` `` builds the *value*, and TypeORM binds it. The
string never becomes part of the statement. A user searching for `%` matches everything, which is harmless; `'; DROP`
is matched literally.

## 5. Read, update, delete

```ts
/** PRD §3: scoped read; 404 when not found OR not owned. */
async findOwned(formId: string, userId: string): Promise<Form> {
  const form = await this.forms.findOne({ where: { id: formId, userId } });
  if (!form) throw new NotFoundError('Form not found');
  return form;
}

/**
 * PRD §6: autosave with optimistic concurrency.
 *
 * The revision check lives in the WHERE clause alongside ownership, so
 * one atomic statement enforces both. Two tabs saving concurrently: the
 * first bumps the revision, the second's predicate no longer matches, and
 * it gets a 409 instead of overwriting (PRD §6: "stale writes return 409
 * rather than overwrite edits from another tab").
 */
async updateDraft(formId: string, userId: string, dto: UpdateFormDto): Promise<Form> {
  if (dto.schema) this.validateSchemaLimits(dto.schema);   // §6, doc 16

  const patch: QueryDeepPartialEntity<Form> = {
    draftRevision: () => 'draft_revision + 1',
  };
  if (dto.title !== undefined) patch.title = dto.title;
  if (dto.description !== undefined) patch.description = dto.description;
  if (dto.schema !== undefined) patch.draftSchema = dto.schema;
  if (dto.settings !== undefined) patch.draftSettings = dto.settings;

  const result = await this.forms.update(
    {
      id: formId,
      userId,                                   // ownership (§3)
      draftRevision: dto.expectedDraftRevision, // concurrency (§6)
    },
    patch,
  );

  if (result.affected === 0) {
    // Distinguish the two causes with ONE extra scoped read. If the form
    // is visible to this user, the mismatch was the revision; otherwise
    // it does not exist or is not theirs, and both are 404 (§3).
    const current = await this.forms.findOne({
      where: { id: formId, userId },
      select: ['draftRevision'],
    });
    if (!current) throw new NotFoundError('Form not found');
    throw new DraftConflictError(current.draftRevision);
  }

  return this.findOwned(formId, userId);
}

/**
 * PRD §9: "Form deletion removes all associated responses/idempotency
 * records transactionally for this bounded MVP."
 *
 * The ON DELETE CASCADE from doc 12 does the removal; the delete itself
 * is a single statement, so it is already atomic.
 */
async remove(formId: string, userId: string): Promise<void> {
  const result = await this.forms.delete({ id: formId, userId });
  if (result.affected === 0) throw new NotFoundError('Form not found');
}
```

## 6. Publish and unpublish

PRD §7:

> Publishing validates and snapshots title, description, fields, submit text and success message, then increments
> publicationVersion. Draft changes do not affect the public form until Publish Changes.

> Publication requires title, at least one field, unique IDs, valid constraints and nonempty valid choices.

```ts
async publish(formId: string, userId: string, dto: PublishFormDto): Promise<Form> {
  return this.dataSource.transaction(async (manager) => {
    // Lock the row. PRD §8 requires that publication cannot race
    // submission acceptance; doc 17 takes the same lock.
    const form = await manager
      .createQueryBuilder(Form, 'form')
      .where('form.id = :formId AND form.user_id = :userId', { formId, userId })
      .setLock('pessimistic_write')
      .getOne();

    if (!form) throw new NotFoundError('Form not found');

    if (form.draftRevision !== dto.expectedDraftRevision) {
      throw new DraftConflictError(form.draftRevision);
    }

    // PRD §7 publication requirements. Throws 422 with field errors.
    this.validateForPublication(form);

    const snapshot: PublishedSnapshot = {
      schemaVersion: 1,
      title: form.title,
      description: form.description,
      // Deep copy. A shared reference would mean a later draft edit
      // mutating the published snapshot — exactly what §7's separation
      // forbids.
      fields: structuredClone(form.draftSchema.fields),
      submitText: form.draftSettings.submitText ?? 'Submit',
      successMessage: form.draftSettings.successMessage ?? 'Thanks for your response.',
      publishedAt: new Date().toISOString(),
    };

    await manager.update(Form, form.id, {
      status: FormStatus.PUBLISHED,
      publishedSnapshot: snapshot,
      // PRD §7: increments on every publish. §8: a submission carrying a
      // stale value is rejected with 409 FORM_CHANGED.
      publicationVersion: form.publicationVersion + 1,
      publishedAt: new Date(),
    });

    return manager.findOneOrFail(Form, { where: { id: form.id } });
  });
}

/** PRD §7: "Unpublish disables public access immediately." */
async unpublish(formId: string, userId: string): Promise<Form> {
  const result = await this.forms.update(
    { id: formId, userId },
    {
      status: FormStatus.DRAFT,
      // The snapshot is CLEARED, not kept. §8: "Unknown, unpublished or
      // deleted forms return generic not found."
      publishedSnapshot: null,
      publishedAt: null,
      // publicationVersion is NOT reset — republishing must produce a
      // higher number, or an old client's cached version would match again.
    },
  );
  if (result.affected === 0) throw new NotFoundError('Form not found');
  return this.findOwned(formId, userId);
}
```

Leaving `publicationVersion` alone on unpublish is subtle but necessary. Reset it to 0 and a respondent holding a page
rendered at version 3 could, after an unpublish/republish cycle, submit successfully against a different form
definition that happens to be numbered 3 again.

### Publication validation

```ts
/** PRD §7 publication requirements, as field errors. */
private validateForPublication(form: Form): void {
  const errors: FieldError[] = [];
  const fields = form.draftSchema?.fields ?? [];

  if (!form.title?.trim()) {
    errors.push({ field: 'title', rule: 'required', message: 'A title is required to publish.' });
  }

  if (fields.length === 0) {
    errors.push({ field: 'fields', rule: 'minItems', message: 'Add at least one field to publish.' });
  }

  // "unique IDs"
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.id)) {
      errors.push({ field: `fields.${field.id}`, rule: 'duplicateId', message: `Duplicate field ID "${field.id}".` });
    }
    seen.add(field.id);

    // "nonempty valid choices"
    if (field.type === 'multiple_choice' || field.type === 'checkbox') {
      if (!field.options?.length) {
        errors.push({ field: `fields.${field.id}.options`, rule: 'required', message: `"${field.label}" needs at least one option.` });
      }
      const optionIds = new Set<string>();
      for (const option of field.options ?? []) {
        if (optionIds.has(option.id)) {
          errors.push({ field: `fields.${field.id}.options`, rule: 'duplicateId', message: `Duplicate option ID in "${field.label}".` });
        }
        optionIds.add(option.id);
        if (!option.label?.trim()) {
          errors.push({ field: `fields.${field.id}.options`, rule: 'required', message: `An option in "${field.label}" has no text.` });
        }
      }
    }

    // "valid constraints"
    const v = field.validation;
    if (v?.minLength != null && v.maxLength != null && v.minLength > v.maxLength) {
      errors.push({ field: `fields.${field.id}.validation`, rule: 'range', message: `"${field.label}" has a minimum longer than its maximum.` });
    }
  }

  if (errors.length) throw new AnswerValidationError(errors);
}
```

### The §6 limits

> Limits: 50 fields/form, 50 options/choice field, labels 200 characters, help text 1,000 characters, text answers
> 10,000 characters; schema and submission body each at most 256 KiB. **Enforce limits server-side.**

```ts
// src/modules/forms/form-limits.ts
export const FORM_LIMITS = {
  MAX_FIELDS: 50,
  MAX_OPTIONS: 50,
  MAX_LABEL_LENGTH: 200,
  MAX_HELP_TEXT_LENGTH: 1000,
  MAX_ANSWER_LENGTH: 10_000,
  MAX_SCHEMA_BYTES: 262_144,
} as const;
```

```ts
private validateSchemaLimits(schema: FormSchemaDto): void {
  const errors: FieldError[] = [];

  if (schema.fields.length > FORM_LIMITS.MAX_FIELDS) {
    errors.push({ field: 'fields', rule: 'maxItems', message: `A form can have at most ${FORM_LIMITS.MAX_FIELDS} fields.` });
  }

  // The field-level DTO decorators (doc 16) cover label and help-text
  // lengths and the option count. This is the whole-schema bound, which
  // no per-field rule can express.
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  if (bytes > FORM_LIMITS.MAX_SCHEMA_BYTES) {
    errors.push({ field: 'schema', rule: 'maxSize', message: 'This form is too large to save.' });
  }

  if (errors.length) throw new AnswerValidationError(errors);
}
```

## 7. The controller

```ts
@ApiTags('Forms')
@ApiBearerAuth('access-token')
// PRD §13 guard flow: JWT → verified email → ownership-scoped service.
// JwtAuthGuard is global (doc 13); this adds the verification step.
// PRD §4: "Form/response management requires verified email."
@UseGuards(VerifiedEmailGuard)
@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Post()
  @ApiOperation({ summary: 'Create owned form' })
  @ApiCreatedResponse({ type: FormResponseDto })
  @ApiAuthErrors()
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateFormDto) {
    return FormResponseDto.from(await this.forms.create(userId, dto));
  }

  @Get()
  @ApiOperation({ summary: 'List/search own forms' })
  @ApiPaginatedResponse(FormListItemDto)
  @ApiAuthErrors()
  async findAll(@CurrentUser('id') userId: string, @Query() query: FormQueryDto) {
    return this.forms.findAll(userId, query);
  }

  @Get(':formId')
  @ApiOperation({ summary: 'Read owned draft/settings' })
  @ApiOkResponse({ type: FormResponseDto })
  @ApiOwnedResourceErrors()
  async findOne(
    @CurrentUser('id') userId: string,
    @Param('formId', UuidParam) formId: string,
  ) {
    return FormResponseDto.from(await this.forms.findOwned(formId, userId));
  }

  @Patch(':formId')
  @ApiOperation({
    summary: 'Save draft with concurrency check',
    description:
      'Requires expectedDraftRevision. A stale value returns 409 DRAFT_CONFLICT ' +
      'rather than overwriting edits made in another tab.',
  })
  @ApiOwnedResourceErrors()
  async update(
    @CurrentUser('id') userId: string,
    @Param('formId', UuidParam) formId: string,
    @Body() dto: UpdateFormDto,
  ) {
    return FormResponseDto.from(await this.forms.updateDraft(formId, userId, dto));
  }

  @Delete(':formId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete own form and submissions',
    description: 'Also deletes every submission and idempotency record for this form.',
  })
  @ApiOwnedResourceErrors()
  async remove(
    @CurrentUser('id') userId: string,
    @Param('formId', UuidParam) formId: string,
  ) {
    await this.forms.remove(formId, userId);
  }

  @Post(':formId/publish')
  @ApiOperation({ summary: 'Publish/republish saved draft' })
  @ApiOwnedResourceErrors()
  async publish(
    @CurrentUser('id') userId: string,
    @Param('formId', UuidParam) formId: string,
    @Body() dto: PublishFormDto,
  ) {
    return FormResponseDto.from(await this.forms.publish(formId, userId, dto));
  }

  @Post(':formId/unpublish')
  @ApiOperation({ summary: 'Disable public access' })
  @ApiOwnedResourceErrors()
  async unpublish(
    @CurrentUser('id') userId: string,
    @Param('formId', UuidParam) formId: string,
  ) {
    return FormResponseDto.from(await this.forms.unpublish(formId, userId));
  }
}
```

Every method takes `userId` from `@CurrentUser()` and passes it to a service method that uses it in the query. There
is no code path where a form is fetched unscoped.

## Verify

```bash
API=localhost:3000/api/v1
A=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}' | jq -r .accessToken)

# 1. Create
FORM=$(curl -s -X POST $API/forms -H "authorization: Bearer $A" \
  -H 'content-type: application/json' -d '{"title":"Feedback"}')
ID=$(echo $FORM | jq -r .id)
echo $FORM | jq '{id, slug, status, draftRevision, publicationVersion}'
# expected: status "draft", draftRevision 0, publicationVersion 0, an opaque slug

# 2. The slug is opaque, not derived from the title (PRD §7)
echo $FORM | jq -r .slug | grep -i feedback
# expected: no output

# 3. userId in the body is REJECTED (PRD §3)
curl -s -X POST $API/forms -H "authorization: Bearer $A" \
  -H 'content-type: application/json' \
  -d '{"title":"X","userId":"00000000-0000-0000-0000-000000000000"}' | jq -r .code
# expected: VALIDATION_FAILED

# 4. OPTIMISTIC CONCURRENCY (PRD §6) — the key autosave test
curl -s -X PATCH $API/forms/$ID -H "authorization: Bearer $A" \
  -H 'content-type: application/json' \
  -d '{"expectedDraftRevision":0,"title":"Tab one"}' | jq -r .draftRevision
# expected: 1

curl -s -X PATCH $API/forms/$ID -H "authorization: Bearer $A" \
  -H 'content-type: application/json' \
  -d '{"expectedDraftRevision":0,"title":"Tab two"}' | jq
# expected: 409 DRAFT_CONFLICT naming the current revision

curl -s $API/forms/$ID -H "authorization: Bearer $A" | jq -r .title
# expected: "Tab one" — the stale write did NOT overwrite it

# 5. Publication requirements (PRD §7)
curl -s -X POST $API/forms/$ID/publish -H "authorization: Bearer $A" \
  -H 'content-type: application/json' -d '{"expectedDraftRevision":1}' | jq
# expected: 422 — "Add at least one field to publish."

# Add a field, then publish:
curl -s -X PATCH $API/forms/$ID -H "authorization: Bearer $A" \
  -H 'content-type: application/json' -d '{
    "expectedDraftRevision":1,
    "schema":{"schemaVersion":1,"fields":[
      {"id":"fld_name","type":"text","label":"Your name","required":true}]}
  }' > /dev/null
curl -s -X POST $API/forms/$ID/publish -H "authorization: Bearer $A" \
  -H 'content-type: application/json' -d '{"expectedDraftRevision":2}' \
  | jq '{status, publicationVersion}'
# expected: {"status":"published","publicationVersion":1}

# 6. DRAFT EDITS DO NOT AFFECT THE PUBLISHED FORM (PRD §7)
SLUG=$(curl -s $API/forms/$ID -H "authorization: Bearer $A" | jq -r .slug)
curl -s -X PATCH $API/forms/$ID -H "authorization: Bearer $A" \
  -H 'content-type: application/json' \
  -d '{"expectedDraftRevision":2,"title":"Edited draft title"}' > /dev/null
curl -s $API/public/forms/$SLUG | jq -r .title
# expected: "Tab one" — the PUBLISHED title, not the edited draft

# 7. Republish bumps the version
curl -s -X POST $API/forms/$ID/publish -H "authorization: Bearer $A" \
  -H 'content-type: application/json' -d '{"expectedDraftRevision":3}' \
  | jq -r .publicationVersion
# expected: 2

# 8. Unpublish is immediate and does NOT reset the version (PRD §7)
curl -s -X POST $API/forms/$ID/unpublish -H "authorization: Bearer $A" \
  | jq '{status, publicationVersion, publishedSnapshot}'
# expected: status "draft", publicationVersion still 2, snapshot null
curl -s -o /dev/null -w '%{http_code}\n' $API/public/forms/$SLUG
# expected: 404

# 9. CROSS-USER ACCESS — the PRD §3 matrix. Register a second user:
B=$(curl -s -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"name":"Bob","email":"bob2@example.com","password":"correct-horse-battery"}' | jq -r .accessToken)
# (verify Bob's email first, or these return 403 rather than 404)

for method in GET PATCH DELETE; do
  curl -s -o /dev/null -w "$method %{http_code}\n" -X $method $API/forms/$ID \
    -H "authorization: Bearer $B" -H 'content-type: application/json' \
    -d '{"expectedDraftRevision":0,"title":"hijacked"}'
done
curl -s -o /dev/null -w "PUBLISH %{http_code}\n" -X POST $API/forms/$ID/publish \
  -H "authorization: Bearer $B" -H 'content-type: application/json' \
  -d '{"expectedDraftRevision":0}'
curl -s -o /dev/null -w "UNPUBLISH %{http_code}\n" -X POST $API/forms/$ID/unpublish \
  -H "authorization: Bearer $B"
# expected: 404 for EVERY line — never 403, never 200

curl -s $API/forms -H "authorization: Bearer $B" | jq '.items | length'
# expected: 0 — Bob's list does not contain Ada's form

curl -s $API/forms/$ID -H "authorization: Bearer $A" | jq -r .title
# expected: unchanged — Bob's PATCH did not mutate anything

# 10. Pagination and search (PRD §5)
curl -s "$API/forms?limit=200" -H "authorization: Bearer $A" | jq -r .code
# expected: VALIDATION_FAILED (max 100)
curl -s "$API/forms?search=feed" -H "authorization: Bearer $A" | jq '.items | length'
curl -s "$API/forms?sort=passwordHash" -H "authorization: Bearer $A" | jq -r .code
# expected: VALIDATION_FAILED

# 11. The §6 limits are enforced server-side
python3 -c "
import json
print(json.dumps({'expectedDraftRevision': 4, 'schema': {'schemaVersion': 1, 'fields': [
  {'id': f'fld_{i}', 'type': 'text', 'label': f'F{i}', 'required': False} for i in range(60)]}}))
" > /tmp/many.json
curl -s -X PATCH $API/forms/$ID -H "authorization: Bearer $A" \
  -H 'content-type: application/json' -d @/tmp/many.json | jq -r '.errors[0].message'
# expected: "A form can have at most 50 fields."

# 12. Deletion removes submissions (PRD §9)
docker compose exec postgres psql -U openform -d openform \
  -c "select count(*) from submissions where form_id = '$ID';"
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $API/forms/$ID -H "authorization: Bearer $A"
# expected: 204
docker compose exec postgres psql -U openform -d openform \
  -c "select count(*) from submissions where form_id = '$ID';"
# expected: 0
```

Steps 4, 6 and 9 are the ones that matter most. Step 9 in particular is PRD §15's required test —
*"User A cannot list/read/update/delete/export user B's forms"* — and every line must be 404.

## If you skip this

Doc 17 needs a published form to submit to, and the snapshot it stores on each submission comes from the publish path
here. The ownership pattern established in this document is the one doc 17 repeats for nested submission routes.

---

Previous: [14 — Users & Mail](./14-users-mail.md) · Next: [16 — Schema & answer validation](./16-validation.md)
