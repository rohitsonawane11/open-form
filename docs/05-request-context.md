# 05 — Request ID & HTTP logging

## Why

PRD §12 specifies the error envelope:

> Standard errors include statusCode, code, message, requestId and optional field errors.

So every error response must carry a `requestId` — and that ID is only useful if the same value appears on the log
lines for that request. The exception filter (doc 06) and the logger (doc 04) both need it, and neither receives the
request object.

Passing a request ID down through every service signature would poison every method in the codebase. Node's
`AsyncLocalStorage` holds it in ambient context for the lifetime of the request instead.

## 1. The request context store

```ts
// src/common/logger/request-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` available to everything it awaits. */
export const runWithRequestContext = <T>(
  context: RequestContext,
  fn: () => T,
): T => storage.run(context, fn);

export const getRequestContext = (): RequestContext | undefined =>
  storage.getStore();

export const getRequestId = (): string | undefined =>
  storage.getStore()?.requestId;

/**
 * Attaches the authenticated user to the current context so log lines
 * carry it without every call site passing it. Called by the JWT guard
 * in doc 13.
 */
export const setContextUserId = (userId: string): void => {
  const store = storage.getStore();
  if (store) store.userId = userId;
};
```

## 2. The middleware

```ts
// src/common/middleware/request-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { runWithRequestContext } from '../logger/request-context';

export const REQUEST_ID_HEADER = 'x-request-id';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Honour an upstream ID so a trace spans the proxy and the API, but
    // only if it is plausible — an unbounded header value would end up in
    // logs and response headers verbatim.
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming && /^[\w-]{8,128}$/.test(incoming) ? incoming : randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);

    // Also hang it on the request: the exception filter can read it from
    // there even if a library breaks the async chain.
    (req as Request & { requestId: string }).requestId = requestId;

    runWithRequestContext({ requestId }, () => next());
  }
}
```

The regex guard is deliberate. Echoing an arbitrary client-supplied header into a response header and into every log
line for that request is a log-injection and header-injection vector.

## 3. The HTTP logging interceptor

```ts
// src/common/interceptors/logging.interceptor.ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { getRequestContext } from '../logger/request-context';

/**
 * One line per completed request: method, path, status, duration.
 *
 * Deliberately logs NO body and NO query values. PRD §14 forbids logging
 * answer bodies and credentials, and a request body is exactly where both
 * live. The route template (not the resolved URL) keeps IDs and slugs out
 * of the log too.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    // Health probes fire every few seconds; logging them buries real traffic.
    if (req.path.startsWith('/health')) return next.handle();

    const finish = (outcome: 'ok' | 'error') => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const ctx = getRequestContext();

      this.logger.log({
        event: 'http.request',
        method: req.method,
        // The route pattern, e.g. /api/v1/forms/:formId — not the resolved
        // path, so form IDs and public slugs stay out of logs.
        route: (req.route as { path?: string } | undefined)?.path ?? req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        outcome,
        userId: ctx?.userId,
        ip: req.ip,
        userAgent: req.header('user-agent')?.slice(0, 120),
      });
    };

    return next.handle().pipe({
      next: () => undefined,
      complete: () => finish('ok'),
      error: () => finish('error'),
    } as never) as Observable<unknown>;
  }
}
```

If the object-form `pipe` argument reads awkwardly, the equivalent with `tap` is:

```ts
return next.handle().pipe(
  tap({
    complete: () => finish('ok'),
    error: () => finish('error'),
  }),
);
```

Both are correct; use `tap`.

> On `req.ip`: it is only the real client address when Express trusts the proxy. Doc 07 sets `trust proxy` from the
> `TRUST_PROXY` env var. Until then, behind a proxy every request logs the proxy's IP — and more importantly, PRD §8's
> per-IP submission limit would throttle all users as one.

## 4. Register both

Middleware is registered on the module, not globally in `main.ts`, so it runs for every route including those added
later:

```ts
// src/app.module.ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

@Module({
  imports: [ /* …as before… */ ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*path');
  }
}
```

> Nest 11 runs on Express 5, whose router no longer accepts a bare `'*'` wildcard. Use `'*path'` (a named wildcard)
> or `{ path: '*path', method: RequestMethod.ALL }`. A bare `'*'` throws
> `TypeError: Missing parameter name` at boot — a confusing error with an easy fix.

## 5. Why middleware and not an interceptor

Middleware runs before guards, pipes and interceptors. An exception thrown by a guard — an expired JWT, say — never
reaches an interceptor, but it does happen inside the middleware's `runWithRequestContext` callback. Putting the
context there means even a 401 from the guard chain carries a `requestId`.

## Verify

```bash
pnpm start:dev

# 1. Every response carries an ID
curl -si localhost:3000/api/v1/forms | grep -i x-request-id
# expected: x-request-id: <a uuid>

# 2. A sane upstream ID is honoured
curl -si -H 'x-request-id: trace-abc-123' localhost:3000/api/v1/forms | grep -i x-request-id
# expected: x-request-id: trace-abc-123

# 3. A hostile one is replaced
curl -si -H 'x-request-id: ../../etc/passwd
injected' localhost:3000/api/v1/forms | grep -i x-request-id
# expected: a freshly generated uuid, not the input

# 4. The request is logged once, with a route template and duration
# expected in the server output:
#   [HTTP] {"event":"http.request","method":"GET","route":"/api/v1/forms","status":200,"durationMs":3.1,…}

# 5. Health probes are not logged
curl -s localhost:3000/health/live
# expected: no new HTTP log line

# 6. The ID in the log matches the one in the header
NODE_ENV=production node dist/main 2>&1 | jq -r 'select(.event=="http.request") | .requestId'
```

## If you skip this

Doc 06's envelope has a `requestId` field with nothing to put in it, which breaks the PRD §12 error contract and
makes support impossible — a user reporting "it failed" gives you an ID that appears in no log.

---

Previous: [04 — Logger](./04-logger.md) · Next: [06 — Exception handling](./06-exceptions.md)
