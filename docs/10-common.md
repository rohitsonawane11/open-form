# 10 — Shared `common/` utilities

## Why

PRD §13:

> Common utilities cover exception handling, pagination and authentication decorators.

Exception handling landed in doc 06. This document builds the other two, plus the small pieces every module from doc
13 onward imports. Doing it now means no module invents its own pagination shape.

Two PRD requirements drive the design:

> Default page size 20, maximum 100; default order updated descending, then ID. (§5)

> Support title search, pagination and **safe allowlisted sorting**. (§5)

"Allowlisted" is the security requirement. A `?sort=` value interpolated into an `ORDER BY` is SQL injection; a value
naming a column that exists but should not be sortable (`password_hash`) is an oracle. The base class below makes
the allowlist mandatory rather than optional.

## 1. Pagination

```ts
// src/common/dto/pagination-query.dto.ts
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** PRD §5: default page size 20, maximum 100. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export abstract class PaginationQueryDto {
  /** 1-based page number. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Items per page. Maximum 100. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }

  get take(): number {
    return this.limit;
  }

  /**
   * The ORDER BY clause for this query, restricted to columns the
   * subclass explicitly allows.
   *
   * PRD §5 requires "safe allowlisted sorting". Subclasses declare the
   * allowlist; nothing a client sends can widen it. The tie-breaker on id
   * is not cosmetic — without it, rows with equal sort values can appear
   * on two pages or on none.
   */
  protected buildOrder<T extends string>(
    requested: string | undefined,
    direction: 'ASC' | 'DESC',
    allowed: readonly T[],
    fallback: T,
  ): Record<string, 'ASC' | 'DESC'> {
    const column = allowed.includes(requested as T)
      ? (requested as T)
      : fallback;
    return { [column]: direction, id: direction };
  }
}
```

```ts
// src/common/dto/paginated.dto.ts
import { ApiProperty } from '@nestjs/swagger';

/** PRD §12: "List responses include items and page/limit/total metadata." */
export class PaginatedDto<T> {
  items: T[];

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 143 })
  total: number;

  @ApiProperty({ example: 8 })
  totalPages: number;

  constructor(items: T[], total: number, page: number, limit: number) {
    this.items = items;
    this.total = total;
    this.page = page;
    this.limit = limit;
    this.totalPages = Math.ceil(total / limit) || 1;
  }

  /** Builds a page from TypeORM's findAndCount tuple. */
  static from<T>(
    [items, total]: [T[], number],
    query: { page: number; limit: number },
  ): PaginatedDto<T> {
    return new PaginatedDto(items, total, query.page, query.limit);
  }

  /** Maps entities to response DTOs while preserving the metadata. */
  map<U>(fn: (item: T) => U): PaginatedDto<U> {
    return new PaginatedDto(
      this.items.map(fn),
      this.total,
      this.page,
      this.limit,
    );
  }
}
```

Generics do not survive into an OpenAPI schema on their own. One helper makes a paginated response documentable:

```ts
// src/common/decorators/api-paginated-response.decorator.ts
import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { PaginatedDto } from '../dto/paginated.dto';

export const ApiPaginatedResponse = <T extends Type<unknown>>(model: T) =>
  applyDecorators(
    ApiExtraModels(PaginatedDto, model),
    ApiOkResponse({
      schema: {
        allOf: [
          { $ref: getSchemaPath(PaginatedDto) },
          {
            properties: {
              items: { type: 'array', items: { $ref: getSchemaPath(model) } },
            },
          },
        ],
      },
    }),
  );
```

### A concrete query DTO

How doc 15 will use the base — PRD §5's "title search, pagination and safe allowlisted sorting":

```ts
// src/modules/forms/dto/form-query.dto.ts
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

const SORTABLE = ['updatedAt', 'createdAt', 'title'] as const;

export class FormQueryDto extends PaginationQueryDto {
  /** Case-insensitive substring match on the form title. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsIn(SORTABLE)
  sort?: (typeof SORTABLE)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';

  /** PRD §5: "default order updated descending, then ID". */
  get orderBy(): Record<string, 'ASC' | 'DESC'> {
    return this.buildOrder(
      this.sort,
      this.order === 'asc' ? 'ASC' : 'DESC',
      SORTABLE,
      'updatedAt',
    );
  }
}
```

Belt and braces: `@IsIn` rejects an out-of-range value at the pipe, and `buildOrder` falls back to a safe column even
if the decorator is ever removed.

## 2. Authentication decorators

```ts
// src/common/decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Exempts a route from authentication.
 *
 * PRD §13: "Public marker exempts authentication only, not validation or
 * abuse controls." Throttling, DTO validation and body limits still apply
 * to every route marked this way.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

```ts
// src/common/decorators/current-user.decorator.ts
import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';

/** What the JWT guard (doc 13) attaches to the request. */
export interface AuthUser {
  id: string;
  email: string;
  /** PRD §4: the access JWT carries user ID and session ID. */
  sessionId: string;
  /** PRD §4: unverified users may sign in but not manage forms. */
  emailVerified: boolean;
}

/**
 * The authenticated user, from the validated access token.
 *
 * PRD §11: "Derive userId from authentication." This decorator is the only
 * sanctioned source of a user ID in a controller — never read one from a
 * body or a path parameter.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
```

Both forms work:

```ts
create(@CurrentUser() user: AuthUser, @Body() dto: CreateFormDto) {}
create(@CurrentUser('id') userId: string, @Body() dto: CreateFormDto) {}
```

## 3. The UUID path parameter convention

Every private resource is addressed by a UUID. Validate it at the boundary, so a malformed value is a clean 400
instead of a Postgres `invalid input syntax for type uuid` error surfacing as a 500:

```ts
// src/common/pipes/parse-uuid.pipe.ts
import { ParseUUIDPipe } from '@nestjs/common';

/**
 * PRD §10 uses UUID v4 throughout. Shared instance so every route is
 * consistent; `version: '4'` rejects a v1 UUID whose timestamp leaks
 * creation time.
 */
export const UuidParam = new ParseUUIDPipe({ version: '4' });
```

```ts
@Get(':formId')
findOne(
  @CurrentUser('id') userId: string,
  @Param('formId', UuidParam) formId: string,
) {}
```

## 4. Where each PRD §11 DTO lives

The §11 contract, mapped to files, so later documents do not have to re-derive it:

| DTO | File | Document |
|---|---|---|
| `RegisterDto` | `modules/auth/dto/register.dto.ts` | 13 |
| `LoginDto` | `modules/auth/dto/login.dto.ts` | 13 |
| `VerifyEmailDto` | `modules/auth/dto/verify-email.dto.ts` | 13 |
| `ForgotPasswordDto` | `modules/auth/dto/forgot-password.dto.ts` | 13 |
| `ResetPasswordDto` | `modules/auth/dto/reset-password.dto.ts` | 13 |
| `UpdateUserDto` | `modules/users/dto/update-user.dto.ts` | 14 |
| `CreateFormDto` | `modules/forms/dto/create-form.dto.ts` | 15 |
| `UpdateFormDto` | `modules/forms/dto/update-form.dto.ts` | 15 |
| `PublishFormDto` | `modules/forms/dto/publish-form.dto.ts` | 15 |
| `FormQueryDto` | `modules/forms/dto/form-query.dto.ts` | 15 (above) |
| Field DTOs (5 types) | `modules/forms/dto/fields/` | 16 |
| `CreateSubmissionDto` | `modules/submissions/dto/create-submission.dto.ts` | 17 |
| `SubmissionQueryDto` | `modules/submissions/dto/submission-query.dto.ts` | 17 |

Response DTOs live beside them under `dto/responses/`. PRD §11: *"API response DTOs omit all secrets"* — they are
separate classes from the entities, never the entities themselves.

## 5. A barrel file

```ts
// src/common/index.ts
export * from './decorators/current-user.decorator';
export * from './decorators/public.decorator';
export * from './decorators/api-paginated-response.decorator';
export * from './decorators/api-standard-responses.decorator';
export * from './dto/pagination-query.dto';
export * from './dto/paginated.dto';
export * from './dto/api-error.dto';
export * from './errors/error-codes';
export * from './errors/domain.exception';
export * from './pipes/parse-uuid.pipe';
```

## Verify

```bash
pnpm build

# Unit-test the pieces that enforce a PRD rule.
cat > src/common/dto/pagination-query.spec.ts <<'EOF'
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FormQueryDto } from '../../modules/forms/dto/form-query.dto';

const build = (raw: Record<string, unknown>) =>
  plainToInstance(FormQueryDto, raw, { enableImplicitConversion: false });

describe('FormQueryDto', () => {
  it('defaults to page 1, limit 20 (PRD §5)', () => {
    const dto = build({});
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('rejects a limit above 100 (PRD §5)', async () => {
    expect(await validate(build({ limit: 500 }))).toHaveLength(1);
  });

  it('defaults to updatedAt DESC with an id tie-breaker (PRD §5)', () => {
    expect(build({}).orderBy).toEqual({ updatedAt: 'DESC', id: 'DESC' });
  });

  it('ignores a sort column that is not allowlisted', () => {
    // Even if validation were bypassed, the column cannot leak through.
    expect(build({ sort: 'passwordHash' }).orderBy).toEqual({
      updatedAt: 'DESC',
      id: 'DESC',
    });
  });

  it('rejects a non-allowlisted sort at validation', async () => {
    expect(await validate(build({ sort: 'passwordHash' }))).toHaveLength(1);
  });

  it('computes skip from page and limit', () => {
    const dto = build({ page: 3, limit: 20 });
    expect(dto.skip).toBe(40);
  });
});
EOF

cat > src/common/dto/paginated.spec.ts <<'EOF'
import { PaginatedDto } from './paginated.dto';

describe('PaginatedDto', () => {
  it('computes totalPages', () => {
    expect(PaginatedDto.from([[], 143], { page: 1, limit: 20 }).totalPages).toBe(8);
  });

  it('reports one page when empty', () => {
    expect(PaginatedDto.from([[], 0], { page: 1, limit: 20 }).totalPages).toBe(1);
  });

  it('preserves metadata through map()', () => {
    const page = PaginatedDto.from([[{ id: 'a' }], 1], { page: 2, limit: 20 });
    const mapped = page.map((x) => x.id);
    expect(mapped.items).toEqual(['a']);
    expect(mapped.page).toBe(2);
  });
});
EOF

pnpm test pagination paginated
# expected: 9 passing
```

The two allowlist tests are the ones worth keeping. They are the regression guard for the §5 sorting requirement.

## If you skip this

Docs 15 and 17 both need pagination and both need `@CurrentUser()`; without a shared version they diverge, and `GET
/forms` and `GET /forms/:id/submissions` return different metadata shapes for the same concept. The sort allowlist in
particular is the kind of thing that gets added "later" and never does.

---

Previous: [09 — Swagger](./09-swagger.md) · Next: [11 — Rate limiting](./11-rate-limiting.md)
