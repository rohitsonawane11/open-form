# 16 — Schema & answer validation

## Why

PRD §11 names the problem directly:

> Nested field DTOs are discriminated by field type and validate configuration. **Dynamic answers are validated by a
> schema-driven server service; validating only that answers is an object is insufficient.**

There are two validation problems here and they need different tools:

1. **The schema** — does this form definition make sense? Fixed shape, so `class-validator` DTOs work.
2. **The answers** — does this submission match *that specific form's* published snapshot? The shape is only known at
   runtime, so no decorator can express it. This needs a service.

§8 enumerates exactly what the answer validator must reject:

> Reject unknown field IDs, wrong JSON types, whitespace-only required strings, invalid email, invalid choice IDs,
> duplicate checkbox options and exceeded bounds. Missing/null optional answers are absent; required null is invalid.

## Part 1 — Field DTOs

The five types from PRD §6:

| Type | Answer | Validation |
|---|---|---|
| `text` | String | Required, min/max length |
| `textarea` | String | Required, min/max length |
| `email` | String | Required, valid email, max length |
| `multiple_choice` | Option ID string | Required, one defined option |
| `checkbox` | Option ID array | Required, unique defined options, min/max selections |

### The base

```ts
// src/modules/forms/dto/fields/base-field.dto.ts
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { FORM_LIMITS } from '../../form-limits';

export abstract class BaseFieldDto {
  /**
   * PRD §6: "Field and option IDs are stable. Label changes do not change
   * IDs; duplicating a field creates new IDs."
   *
   * The pattern is restrictive because these IDs become CSV column headers
   * and JSONB object keys.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, {
    message: 'Field ID must be 1–64 characters of letters, digits, _ or -',
  })
  id: string;

  /** PRD §6: labels 200 characters. */
  @IsString()
  @MaxLength(FORM_LIMITS.MAX_LABEL_LENGTH)
  label: string;

  /** PRD §6: help text 1,000 characters. */
  @IsOptional()
  @IsString()
  @MaxLength(FORM_LIMITS.MAX_HELP_TEXT_LENGTH)
  helpText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(FORM_LIMITS.MAX_LABEL_LENGTH)
  placeholder?: string;

  @IsBoolean()
  required: boolean;
}
```

### The five types

```ts
// src/modules/forms/dto/fields/text-field.dto.ts
import { Type } from 'class-transformer';
import { Equals, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { BaseFieldDto } from './base-field.dto';
import { FORM_LIMITS } from '../../form-limits';

export class LengthValidationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(FORM_LIMITS.MAX_ANSWER_LENGTH)
  minLength?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(FORM_LIMITS.MAX_ANSWER_LENGTH)
  maxLength?: number;
}

export class TextFieldDto extends BaseFieldDto {
  @Equals('text')
  type: 'text';

  @IsOptional() @ValidateNested() @Type(() => LengthValidationDto)
  validation?: LengthValidationDto;
}

export class TextareaFieldDto extends BaseFieldDto {
  @Equals('textarea')
  type: 'textarea';

  @IsOptional() @ValidateNested() @Type(() => LengthValidationDto)
  validation?: LengthValidationDto;
}

export class EmailFieldDto extends BaseFieldDto {
  @Equals('email')
  type: 'email';

  /** PRD §6: email fields take a max length but no min. */
  @IsOptional() @ValidateNested() @Type(() => LengthValidationDto)
  validation?: Pick<LengthValidationDto, 'maxLength'>;
}
```

```ts
// src/modules/forms/dto/fields/choice-field.dto.ts
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BaseFieldDto } from './base-field.dto';
import { FORM_LIMITS } from '../../form-limits';

export class FieldOptionDto {
  /** PRD §6: option IDs are stable, like field IDs. */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  id: string;

  @IsString()
  @MaxLength(FORM_LIMITS.MAX_LABEL_LENGTH)
  label: string;
}

export class MultipleChoiceFieldDto extends BaseFieldDto {
  @Equals('multiple_choice')
  type: 'multiple_choice';

  /** PRD §6: 50 options per choice field. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FORM_LIMITS.MAX_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => FieldOptionDto)
  options: FieldOptionDto[];
}

export class CheckboxSelectionValidationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  minSelections?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  maxSelections?: number;
}

export class CheckboxFieldDto extends BaseFieldDto {
  @Equals('checkbox')
  type: 'checkbox';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FORM_LIMITS.MAX_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => FieldOptionDto)
  options: FieldOptionDto[];

  @IsOptional() @ValidateNested() @Type(() => CheckboxSelectionValidationDto)
  validation?: CheckboxSelectionValidationDto;
}
```

### Discriminating on `type`

PRD §11: *"Nested field DTOs are discriminated by field type."* `class-transformer`'s discriminator does this:

```ts
// src/modules/forms/dto/form-schema.dto.ts
import { Type } from 'class-transformer';
import { ArrayMaxSize, Equals, IsArray, ValidateNested } from 'class-validator';
import { FORM_LIMITS } from '../form-limits';
import { TextFieldDto, TextareaFieldDto, EmailFieldDto } from './fields/text-field.dto';
import { MultipleChoiceFieldDto, CheckboxFieldDto } from './fields/choice-field.dto';

export type AnyFieldDto =
  | TextFieldDto
  | TextareaFieldDto
  | EmailFieldDto
  | MultipleChoiceFieldDto
  | CheckboxFieldDto;

export class FormSchemaDto {
  @Equals(1, { message: 'Only schemaVersion 1 is supported' })
  schemaVersion: 1;

  /** PRD §6: 50 fields per form. */
  @IsArray()
  @ArrayMaxSize(FORM_LIMITS.MAX_FIELDS)
  @ValidateNested({ each: true })
  @Type(() => Object, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: TextFieldDto, name: 'text' },
        { value: TextareaFieldDto, name: 'textarea' },
        { value: EmailFieldDto, name: 'email' },
        { value: MultipleChoiceFieldDto, name: 'multiple_choice' },
        { value: CheckboxFieldDto, name: 'checkbox' },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  fields: AnyFieldDto[];
}
```

An unknown `type` leaves the object untransformed, so `@ValidateNested` fails — an unrecognised field type cannot be
saved.

## Part 2 — The answer validator

This is the service PRD §11 requires. It takes a published snapshot and a raw answers object, and returns either
validated answers or a list of field errors.

```ts
// src/modules/submissions/answer-validator.service.ts
import { Injectable } from '@nestjs/common';
import { FieldError } from '../../common/errors/error-codes';
import { FormField } from '../forms/types/form-schema.types';
import { FORM_LIMITS } from '../forms/form-limits';

export interface ValidationOutcome {
  valid: boolean;
  answers: Record<string, string | string[]>;
  errors: FieldError[];
}

// Deliberately conservative. The goal is to reject obvious nonsense, not
// to adjudicate RFC 5322 — the only real proof of a working address is a
// delivered message.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * PRD §11: "Dynamic answers are validated by a schema-driven server
 * service; validating only that answers is an object is insufficient."
 *
 * Validates against the snapshot the respondent's page was rendered from,
 * so republishing cannot retroactively invalidate an in-flight submission.
 */
@Injectable()
export class AnswerValidatorService {
  validate(
    fields: FormField[],
    rawAnswers: unknown,
  ): ValidationOutcome {
    const errors: FieldError[] = [];
    const answers: Record<string, string | string[]> = {};

    if (
      typeof rawAnswers !== 'object' ||
      rawAnswers === null ||
      Array.isArray(rawAnswers)
    ) {
      return {
        valid: false,
        answers: {},
        errors: [{ field: 'answers', rule: 'invalidType', message: 'Answers must be an object.' }],
      };
    }

    const submitted = rawAnswers as Record<string, unknown>;
    const knownIds = new Set(fields.map((f) => f.id));

    // PRD §8: "Reject unknown field IDs." Silently dropping them would
    // let a respondent believe an answer was recorded when it was not.
    for (const key of Object.keys(submitted)) {
      if (!knownIds.has(key)) {
        errors.push({
          field: key,
          rule: 'unknownField',
          message: `"${key}" is not a field on this form.`,
        });
      }
    }

    for (const field of fields) {
      const value = submitted[field.id];

      // PRD §8: "Missing/null optional answers are absent; required null
      // is invalid." So absent and null behave identically — and for a
      // required field, both fail.
      if (value === undefined || value === null) {
        if (field.required) {
          errors.push({
            field: field.id,
            rule: 'required',
            message: `"${field.label}" is required.`,
          });
        }
        // Optional and absent: contribute nothing to the stored answers.
        continue;
      }

      const result = this.validateField(field, value);
      if (result.errors.length) {
        errors.push(...result.errors);
      } else if (result.value !== undefined) {
        answers[field.id] = result.value;
      }
    }

    return { valid: errors.length === 0, answers, errors };
  }

  private validateField(
    field: FormField,
    value: unknown,
  ): { value?: string | string[]; errors: FieldError[] } {
    switch (field.type) {
      case 'text':
      case 'textarea':
        return this.validateText(field, value);
      case 'email':
        return this.validateEmail(field, value);
      case 'multiple_choice':
        return this.validateMultipleChoice(field, value);
      case 'checkbox':
        return this.validateCheckbox(field, value);
      default:
        return {
          errors: [{
            field: field.id,
            rule: 'unsupportedType',
            message: 'This field type is not supported.',
          }],
        };
    }
  }

  private validateText(field: FormField, value: unknown) {
    const errors: FieldError[] = [];

    // PRD §8: "Reject … wrong JSON types." A number is not a string, even
    // though it would coerce cleanly.
    if (typeof value !== 'string') {
      return { errors: [this.typeError(field, 'text')] };
    }

    const trimmed = value.trim();

    // PRD §8: "whitespace-only required strings" are invalid.
    if (field.required && trimmed.length === 0) {
      errors.push({ field: field.id, rule: 'required', message: `"${field.label}" is required.` });
      return { errors };
    }

    // An optional field answered with only whitespace is simply absent.
    if (trimmed.length === 0) return { errors: [] };

    // PRD §6: text answers 10,000 characters — a hard ceiling regardless
    // of what the form's own maxLength says.
    if (trimmed.length > FORM_LIMITS.MAX_ANSWER_LENGTH) {
      errors.push({
        field: field.id,
        rule: 'maxLength',
        message: `"${field.label}" is too long.`,
      });
      return { errors };
    }

    const min = field.validation?.minLength;
    const max = field.validation?.maxLength;

    if (min != null && trimmed.length < min) {
      errors.push({ field: field.id, rule: 'minLength', message: `"${field.label}" must be at least ${min} characters.` });
    }
    if (max != null && trimmed.length > max) {
      errors.push({ field: field.id, rule: 'maxLength', message: `"${field.label}" must be at most ${max} characters.` });
    }

    // Store the trimmed value: what was validated is what gets stored.
    return { value: trimmed, errors };
  }

  private validateEmail(field: FormField, value: unknown) {
    if (typeof value !== 'string') {
      return { errors: [this.typeError(field, 'text')] };
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return field.required
        ? { errors: [{ field: field.id, rule: 'required', message: `"${field.label}" is required.` }] }
        : { errors: [] };
    }

    const max = field.validation?.maxLength ?? 320;
    if (trimmed.length > max) {
      return { errors: [{ field: field.id, rule: 'maxLength', message: `"${field.label}" is too long.` }] };
    }

    // PRD §8: "invalid email".
    if (!EMAIL_PATTERN.test(trimmed)) {
      return { errors: [{ field: field.id, rule: 'isEmail', message: `"${field.label}" must be a valid email address.` }] };
    }

    // NOT lowercased. This is a respondent's answer, not an account
    // identity — PRD §4's normalization applies to users.normalized_email,
    // not to form data.
    return { value: trimmed, errors: [] };
  }

  private validateMultipleChoice(field: FormField, value: unknown) {
    if (typeof value !== 'string') {
      return { errors: [this.typeError(field, 'a single option ID')] };
    }

    // PRD §8: "invalid choice IDs". Validated against the SNAPSHOT's
    // options, so an option deleted after publication is still accepted
    // from a page rendered before the change.
    const option = field.options?.find((o) => o.id === value);
    if (!option) {
      return { errors: [{ field: field.id, rule: 'unknownOption', message: `That is not a valid choice for "${field.label}".` }] };
    }

    return { value, errors: [] };
  }

  private validateCheckbox(field: FormField, value: unknown) {
    const errors: FieldError[] = [];

    if (!Array.isArray(value)) {
      return { errors: [this.typeError(field, 'an array of option IDs')] };
    }

    if (value.some((v) => typeof v !== 'string')) {
      return { errors: [this.typeError(field, 'an array of option IDs')] };
    }

    const selected = value as string[];

    // PRD §6/§8: "unique defined options" — duplicates are an error, not
    // something to silently deduplicate. A client sending the same option
    // twice has a bug the respondent should know about.
    if (new Set(selected).size !== selected.length) {
      errors.push({ field: field.id, rule: 'duplicateOption', message: `"${field.label}" has a repeated selection.` });
    }

    const validIds = new Set(field.options?.map((o) => o.id) ?? []);
    for (const id of selected) {
      if (!validIds.has(id)) {
        errors.push({ field: field.id, rule: 'unknownOption', message: `That is not a valid choice for "${field.label}".` });
        break;   // one message is enough
      }
    }

    if (field.required && selected.length === 0) {
      errors.push({ field: field.id, rule: 'required', message: `Select at least one option for "${field.label}".` });
    }

    // PRD §6: min/max selections.
    const min = field.validation?.minSelections;
    const max = field.validation?.maxSelections;

    if (min != null && selected.length > 0 && selected.length < min) {
      errors.push({ field: field.id, rule: 'minSelections', message: `Select at least ${min} options for "${field.label}".` });
    }
    if (max != null && selected.length > max) {
      errors.push({ field: field.id, rule: 'maxSelections', message: `Select at most ${max} options for "${field.label}".` });
    }

    if (errors.length) return { errors };
    return { value: selected, errors: [] };
  }

  private typeError(field: FormField, expected: string): FieldError {
    return {
      field: field.id,
      rule: 'invalidType',
      // Never echo the submitted value back — it appears in logs and
      // error responses (PRD §14).
      message: `"${field.label}" must be ${expected}.`,
    };
  }
}
```

### Two decisions worth stating

**Validation runs against the snapshot, not the current draft.** The validator receives `fields` from
`submission.schemaSnapshot` / the published snapshot. PRD §7: *"Each response stores the snapshot used to validate
it."* A respondent who loaded the page before a republish is validated against what they actually saw.

**Error messages never echo the submitted value.** `"That is not a valid choice"` rather than
`` `"${value}" is not valid` ``. Those messages reach logs and responses, and for an email field the value is personal
data.

## Verify

```bash
cat > src/modules/submissions/answer-validator.spec.ts <<'EOF'
import { AnswerValidatorService } from './answer-validator.service';
import { FormField } from '../forms/types/form-schema.types';

const service = new AnswerValidatorService();

const text = (over: Partial<FormField> = {}): FormField => ({
  id: 'fld_t', type: 'text', label: 'Name', required: true, ...over,
});
const choice = (): FormField => ({
  id: 'fld_c', type: 'multiple_choice', label: 'Pick', required: true,
  options: [{ id: 'opt_a', label: 'A' }, { id: 'opt_b', label: 'B' }],
});
const checks = (over: Partial<FormField> = {}): FormField => ({
  id: 'fld_k', type: 'checkbox', label: 'Many', required: false,
  options: [{ id: 'opt_a', label: 'A' }, { id: 'opt_b', label: 'B' }], ...over,
});

describe('AnswerValidatorService (PRD §8)', () => {
  it('rejects unknown field IDs', () => {
    const r = service.validate([text()], { fld_t: 'Ada', fld_ghost: 'x' });
    expect(r.valid).toBe(false);
    expect(r.errors[0].rule).toBe('unknownField');
  });

  it('rejects wrong JSON types', () => {
    expect(service.validate([text()], { fld_t: 42 }).errors[0].rule).toBe('invalidType');
    expect(service.validate([checks()], { fld_k: 'opt_a' }).errors[0].rule).toBe('invalidType');
    expect(service.validate([choice()], { fld_c: ['opt_a'] }).errors[0].rule).toBe('invalidType');
  });

  it('rejects whitespace-only required strings', () => {
    expect(service.validate([text()], { fld_t: '   ' }).errors[0].rule).toBe('required');
  });

  it('treats a required null as invalid', () => {
    expect(service.validate([text()], { fld_t: null }).errors[0].rule).toBe('required');
  });

  it('treats an optional null or missing answer as absent', () => {
    const field = text({ required: false });
    expect(service.validate([field], { fld_t: null }).valid).toBe(true);
    expect(service.validate([field], {}).valid).toBe(true);
    expect(service.validate([field], {}).answers).toEqual({});
  });

  it('rejects an invalid email', () => {
    const f: FormField = { id: 'fld_e', type: 'email', label: 'Email', required: true };
    expect(service.validate([f], { fld_e: 'not-an-email' }).errors[0].rule).toBe('isEmail');
    expect(service.validate([f], { fld_e: 'ada@example.com' }).valid).toBe(true);
  });

  it('rejects an undefined choice ID', () => {
    expect(service.validate([choice()], { fld_c: 'opt_zzz' }).errors[0].rule).toBe('unknownOption');
    expect(service.validate([choice()], { fld_c: 'opt_a' }).valid).toBe(true);
  });

  it('rejects duplicate checkbox options', () => {
    const r = service.validate([checks()], { fld_k: ['opt_a', 'opt_a'] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.rule === 'duplicateOption')).toBe(true);
  });

  it('enforces min and max selections', () => {
    const f = checks({ validation: { minSelections: 2, maxSelections: 2 } });
    expect(service.validate([f], { fld_k: ['opt_a'] }).errors[0].rule).toBe('minSelections');
    expect(service.validate([f], { fld_k: ['opt_a', 'opt_b'] }).valid).toBe(true);
  });

  it('enforces length bounds and the 10,000 character ceiling', () => {
    const f = text({ validation: { minLength: 2, maxLength: 5 } });
    expect(service.validate([f], { fld_t: 'a' }).errors[0].rule).toBe('minLength');
    expect(service.validate([f], { fld_t: 'abcdef' }).errors[0].rule).toBe('maxLength');
    expect(service.validate([text()], { fld_t: 'x'.repeat(10001) }).errors[0].rule).toBe('maxLength');
  });

  it('stores the trimmed value', () => {
    expect(service.validate([text()], { fld_t: '  Ada  ' }).answers).toEqual({ fld_t: 'Ada' });
  });

  it('rejects a non-object answers payload', () => {
    expect(service.validate([text()], []).valid).toBe(false);
    expect(service.validate([text()], 'nope').valid).toBe(false);
    expect(service.validate([text()], null).valid).toBe(false);
  });

  it('never echoes the submitted value in an error message', () => {
    const r = service.validate([choice()], { fld_c: 'SENSITIVE-VALUE' });
    expect(JSON.stringify(r.errors)).not.toContain('SENSITIVE-VALUE');
  });

  it('reports every problem at once, not just the first', () => {
    const r = service.validate([text(), choice()], { fld_t: '', fld_c: 'bad' });
    expect(r.errors).toHaveLength(2);
  });
});
EOF

pnpm test answer-validator
# expected: 15 passing
```

These tests map one-to-one onto PRD §15's required test: *"All five field types reject wrong types, unknown
fields/options and invalid required answers."*

Also verify the DTO discrimination end to end:

```bash
API=localhost:3000/api/v1

# An unknown field type is rejected
curl -s -X PATCH $API/forms/$ID -H "authorization: Bearer $A" \
  -H 'content-type: application/json' -d '{
    "expectedDraftRevision":1,
    "schema":{"schemaVersion":1,"fields":[
      {"id":"fld_x","type":"file_upload","label":"CV","required":false}]}
  }' | jq -r .code
# expected: VALIDATION_FAILED (file upload is deferred, PRD §2)

# A choice field with no options is rejected
curl -s -X PATCH $API/forms/$ID -H "authorization: Bearer $A" \
  -H 'content-type: application/json' -d '{
    "expectedDraftRevision":1,
    "schema":{"schemaVersion":1,"fields":[
      {"id":"fld_c","type":"multiple_choice","label":"Pick","required":true,"options":[]}]}
  }' | jq -r '.errors[0].field'
# expected: a path naming fields.0.options

# schemaVersion 2 is rejected
curl -s -X PATCH $API/forms/$ID -H "authorization: Bearer $A" \
  -H 'content-type: application/json' \
  -d '{"expectedDraftRevision":1,"schema":{"schemaVersion":2,"fields":[]}}' | jq -r .code
# expected: VALIDATION_FAILED
```

## If you skip this

Doc 17's submission endpoint has nothing to validate answers with, which means the public write endpoint accepts
arbitrary JSONB from anonymous users on the internet. PRD §11's warning — *"validating only that answers is an object
is insufficient"* — describes exactly the failure mode.

---

Previous: [15 — Forms](./15-forms.md) · Next: [17 — Submissions module](./17-submissions.md)
