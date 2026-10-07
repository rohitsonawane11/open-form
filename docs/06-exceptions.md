# 06 — Exception handling & error envelope

## Why

PRD §12 defines one error shape for the entire API:

> Standard errors include statusCode, code, message, requestId and optional field errors. Use 401 invalid
> authentication, 403 unverified account, 404 unavailable private/public resource, 409 stale version/idempotency
> conflict, 413 oversized body, 422 invalid answers and 429 rate limit.

Nest's default `HttpException` output is `{statusCode, message, error}` — no `code`, no `requestId`, and the shape
changes depending on whether a `ValidationPipe`, a guard or a filter produced it. A frontend cannot branch on that.

This document makes every failure — thrown by your code, by a pipe, by a guard, by TypeORM, or by an unhandled bug —
emerge as one object.

## The status code contract

| Status | `code` | Raised when | PRD |
|---|---|---|---|
| 400 | `BAD_REQUEST` | Malformed request, bad UUID in a path | — |
| 401 | `UNAUTHENTICATED` | Missing, expired or invalid access token | §12 |
| 403 | `EMAIL_NOT_VERIFIED` | Signed in, but email unverified, on a form/response route | §4, §12 |
| 404 | `NOT_FOUND` | Unknown resource **or another user's resource** | §3, §12 |
| 409 | `FORM_CHANGED` | Submitted `publicationVersion` is stale | §8 |
| 409 | `DRAFT_CONFLICT` | `expectedDraftRevision` is stale | §6 |
| 409 | `IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key`, different payload | §8 |
| 409 | `ACCOUNT_EXISTS` | Google email matches a password account | §4 |
| 409 | `RESOURCE_CONFLICT` | Unique constraint violation | — |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 256 KiB | §6, §8 |
| 422 | `VALIDATION_FAILED` | DTO validation, or an answer failing the schema | §8, §12 |
| 429 | `RATE_LIMITED` | Throttle exceeded | §8 |
| 500 | `INTERNAL_ERROR` | Anything unhandled | — |

The 404-not-403 rule in §3 is worth dwelling on:

> Return 404 for another person's private resource.

A 403 confirms the resource exists. Across many requests that is an enumeration oracle. Every ownership check returns
404.

## 1. The envelope and error codes

```ts
// src/common/errors/error-codes.ts
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  NOT_FOUND: 'NOT_FOUND',
  FORM_CHANGED: 'FORM_CHANGED',
  DRAFT_CONFLICT: 'DRAFT_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  ACCOUNT_EXISTS: 'ACCOUNT_EXISTS',
  RESOURCE_CONFLICT: 'RESOURCE_CONFLICT',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  FORM_NOT_PUBLISHED: 'FORM_NOT_PUBLISHED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  EXPORT_TOO_LARGE: 'EXPORT_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** A single field-level problem. PRD §12 "optional field errors". */
export interface FieldError {
  /** Field path — a DTO property, or a form field ID like 'fld_email'. */
  field: string;
  /** Machine-readable reason, e.g. 'required', 'maxLength', 'unknownOption'. */
  rule: string;
  message: string;
}

/** The ONE error shape this API returns. PRD §12. */
export interface ErrorEnvelope {
  statusCode: number;
  code: ErrorCodeValue;
  message: string;
  requestId?: string;
  errors?: FieldError[];
}
```

## 2. Domain exceptions

Services should throw meaning, not HTTP:

```ts
// src/common/errors/domain.exception.ts
import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, ErrorCodeValue, FieldError } from './error-codes';

export class DomainException extends HttpException {
  constructor(
    readonly code: ErrorCodeValue,
    status: HttpStatus,
    message: string,
    readonly fieldErrors?: FieldError[],
  ) {
    super({ code, message, errors: fieldErrors }, status);
  }
}

/**
 * PRD §3: another person's private resource returns 404, not 403.
 * Use this for "does not exist" AND "not yours" — the caller cannot tell
 * the difference, which is the point.
 */
export class NotFoundError extends DomainException {
  constructor(message = 'Resource not found') {
    super(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND, message);
  }
}

/** PRD §8: submitted publicationVersion no longer matches. */
export class FormChangedError extends DomainException {
  constructor(currentVersion: number) {
    super(
      ErrorCode.FORM_CHANGED,
      HttpStatus.CONFLICT,
      `This form has been updated. Current version is ${currentVersion}. ` +
        'Reload and review your answers before submitting.',
    );
  }
}

/** PRD §6: autosave raced another tab. */
export class DraftConflictError extends DomainException {
  constructor(currentRevision: number) {
    super(
      ErrorCode.DRAFT_CONFLICT,
      HttpStatus.CONFLICT,
      `This form was changed elsewhere. Current revision is ${currentRevision}.`,
    );
  }
}

/** PRD §8: same Idempotency-Key, different payload. */
export class IdempotencyConflictError extends DomainException {
  constructor() {
    super(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      HttpStatus.CONFLICT,
      'This idempotency key was already used with a different payload.',
    );
  }
}

/** PRD §4: unverified users cannot manage forms or responses. */
export class EmailNotVerifiedError extends DomainException {
  constructor() {
    super(
      ErrorCode.EMAIL_NOT_VERIFIED,
      HttpStatus.FORBIDDEN,
      'Verify your email address to continue.',
    );
  }
}

/** PRD §8 / §12: answers failed schema validation. */
export class AnswerValidationError extends DomainException {
  constructor(errors: FieldError[]) {
    super(
      ErrorCode.VALIDATION_FAILED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Some answers are invalid.',
      errors,
    );
  }
}

/** PRD §4: generic login failure — never reveals whether the email exists. */
export class InvalidCredentialsError extends DomainException {
  constructor() {
    super(
      ErrorCode.INVALID_CREDENTIALS,
      HttpStatus.UNAUTHORIZED,
      'Incorrect email or password.',
    );
  }
}
```

The `InvalidCredentialsError` message is load-bearing. PRD §4: *"Login failures use a generic message."* "No account
with that email" versus "Wrong password" is an account-enumeration oracle.

## 3. The filter

```ts
// src/common/filters/all-exceptions.filter.ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { QueryFailedError, EntityNotFoundError } from 'typeorm';
import { Request } from 'express';
import {
  ErrorCode,
  ErrorCodeValue,
  ErrorEnvelope,
  FieldError,
} from '../errors/error-codes';
import { DomainException } from '../errors/domain.exception';
import { getRequestId } from '../logger/request-context';

/** Postgres SQLSTATE codes we translate. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();

    const envelope = this.toEnvelope(exception);
    envelope.requestId =
      getRequestId() ?? (req as Request & { requestId?: string }).requestId;

    this.logException(exception, envelope, req);

    httpAdapter.reply(ctx.getResponse(), envelope, envelope.statusCode);
  }

  private toEnvelope(exception: unknown): ErrorEnvelope {
    // 1. Our own exceptions already carry a code.
    if (exception instanceof DomainException) {
      const body = exception.getResponse() as {
        code: ErrorCodeValue;
        message: string;
        errors?: FieldError[];
      };
      return {
        statusCode: exception.getStatus(),
        code: body.code,
        message: body.message,
        ...(body.errors?.length ? { errors: body.errors } : {}),
      };
    }

    // 2. Throttler (PRD §8).
    if (exception instanceof ThrottlerException) {
      return {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: ErrorCode.RATE_LIMITED,
        message: 'Too many requests. Please slow down and try again shortly.',
      };
    }

    // 3. Framework HttpExceptions: pipes, guards, Nest internals.
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    // 4. TypeORM.
    if (exception instanceof EntityNotFoundError) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found',
      };
    }
    if (exception instanceof QueryFailedError) {
      const driverCode = (exception as QueryFailedError & { code?: string }).code;
      if (driverCode === PG_UNIQUE_VIOLATION) {
        return {
          statusCode: HttpStatus.CONFLICT,
          code: ErrorCode.RESOURCE_CONFLICT,
          // Never echo the constraint name or the conflicting value: on the
          // users table that would confirm an email is registered.
          message: 'That value is already in use.',
        };
      }
      if (driverCode === PG_FOREIGN_KEY_VIOLATION) {
        return {
          statusCode: HttpStatus.CONFLICT,
          code: ErrorCode.RESOURCE_CONFLICT,
          message: 'Related resource is missing or still in use.',
        };
      }
    }

    // 5. Anything else is a bug. Say nothing useful to the caller.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
    };
  }

  private fromHttpException(exception: HttpException): ErrorEnvelope {
    const status = exception.getStatus();
    const response = exception.getResponse();

    // ValidationPipe produces { message: string[], error, statusCode }.
    if (
      typeof response === 'object' &&
      response !== null &&
      Array.isArray((response as { message?: unknown }).message)
    ) {
      return {
        // PRD §12: invalid input is 422, not Nest's default 400.
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Request validation failed.',
        errors: this.toFieldErrors(
          (response as { message: string[] }).message,
        ),
      };
    }

    const message =
      typeof response === 'string'
        ? response
        : ((response as { message?: string }).message ?? exception.message);

    return {
      statusCode: status,
      code: this.codeForStatus(status),
      message,
    };
  }

  /**
   * ValidationPipe gives flat strings like 'email must be an email'.
   * Split the leading property name out so clients can attach the error
   * to a field. Configure the pipe with exceptionFactory (doc 07) for
   * structured output instead if you want richer rules.
   */
  private toFieldErrors(messages: string[]): FieldError[] {
    return messages.map((message) => {
      const field = message.split(' ')[0] ?? 'body';
      return { field, rule: 'invalid', message };
    });
  }

  private codeForStatus(status: number): ErrorCodeValue {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.EMAIL_NOT_VERIFIED;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.RESOURCE_CONFLICT;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return ErrorCode.INTERNAL_ERROR;
      default:
        return ErrorCode.BAD_REQUEST;
    }
  }

  private logException(
    exception: unknown,
    envelope: ErrorEnvelope,
    req: Request,
  ): void {
    const base = {
      event: 'request.failed',
      status: envelope.statusCode,
      code: envelope.code,
      method: req.method,
      route: (req.route as { path?: string } | undefined)?.path ?? req.path,
    };

    // 5xx is a bug: log the stack. Note that NO request body is logged —
    // PRD §14 forbids logging credentials and answer bodies, and the body
    // is exactly where both live.
    if (envelope.statusCode >= 500) {
      this.logger.error(
        base,
        exception instanceof Error ? exception.stack : String(exception),
      );
      return;
    }

    // 4xx is normal traffic. Log at warn, without a stack.
    this.logger.warn(base);
  }
}
```

Three deliberate choices:

- **Validation failures become 422, not 400.** PRD §12 lists 422 for invalid input. Nest's `ValidationPipe` throws
  400 by default; the filter remaps it so DTO failures and answer failures have the same status.
- **The 500 message is useless on purpose.** Stack traces and ORM messages leak schema and file paths. They go to
  the log, where the `requestId` ties them to the user's report.
- **Unique-violation messages never name the column.** On `users.normalized_email` a specific message would confirm
  an account exists.

## 4. Register it

Registering through `APP_FILTER` rather than `app.useGlobalFilters()` means it participates in DI — it needs
`HttpAdapterHost`:

```ts
// src/app.module.ts
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

providers: [
  { provide: APP_FILTER, useClass: AllExceptionsFilter },
  { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
],
```

## 5. Using it

```ts
// A service — throws meaning, knows no HTTP
async findOwned(formId: string, userId: string): Promise<Form> {
  const form = await this.forms.findOne({ where: { id: formId, userId } });
  // PRD §3: not found and not yours are indistinguishable to the caller.
  if (!form) throw new NotFoundError('Form not found');
  return form;
}
```

## Verify

```bash
pnpm start:dev

# 1. A 404 has the full envelope
curl -s localhost:3000/api/v1/nope | jq
# expected:
# { "statusCode": 404, "code": "NOT_FOUND", "message": "...",
#   "requestId": "<uuid>" }

# 2. The requestId matches the response header
curl -si localhost:3000/api/v1/nope | grep -iE 'x-request-id|requestId'
# expected: the same value in both

# 3. An unhandled error returns nothing useful but logs everything.
#    Add a temporary route:  @Get('boom') boom() { throw new Error('kaboom'); }
curl -s localhost:3000/api/v1/boom | jq
# expected: {"statusCode":500,"code":"INTERNAL_ERROR",
#            "message":"An unexpected error occurred.","requestId":"…"}
#    and in the server log: the full 'kaboom' stack with the same requestId.
#    The word 'kaboom' must NOT appear in the HTTP response.

# 4. Validation failures are 422 with field errors (after doc 07 adds the pipe)
curl -s -X POST localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' -d '{"email":"nope"}' | jq
# expected: {"statusCode":422,"code":"VALIDATION_FAILED",
#            "errors":[{"field":"email","rule":"invalid","message":"email must be an email"},…]}

# 5. No password appears in the log for that request
#    expected: the server logged status/code/route only — no body
```

## If you skip this

Every endpoint invents its own error shape, and the frontend cannot reliably detect `FORM_CHANGED` (PRD §8 requires
the client to preserve input and prompt a reload on that specific code) or `DRAFT_CONFLICT`. Worse, the default Nest
500 handler returns the exception message, which for a `QueryFailedError` includes your SQL.

---

Previous: [05 — Request context](./05-request-context.md) · Next: [07 — `main.ts` bootstrap](./07-bootstrap.md)
