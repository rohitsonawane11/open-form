# 07 — `main.ts` bootstrap

## Why

`main.ts` is still the six-line starter. PRD §12 requires every product route under `/api/v1` with health routes
outside it; §11 requires DTOs that whitelist properties and reject unknown ones; §14 requires HTTPS-oriented security
headers, restrictive CORS and secure cookies; §8 requires a 256 KiB body limit and correct client-IP resolution behind
a proxy.

All of that is bootstrap configuration. This document writes the final file.

## The complete file

```ts
// src/main.ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import * as cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';

import { AppModule } from './app.module';
import { AppLogger } from './common/logger/app.logger';
import { setupSwagger } from './config/swagger.config';
import { validationExceptionFactory } from './common/pipes/validation-exception.factory';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Hold startup logs until useLogger() below, so they get the same
    // formatting and redaction as everything else (doc 04).
    bufferLogs: true,
  });

  const config = app.get(ConfigService);
  const isProduction = config.get<string>('NODE_ENV') === 'production';
  const port = config.get<number>('PORT') ?? 3000;
  const frontendUrl = config.get<string>('FRONTEND_URL')!;
  const maxBodyBytes = config.get<number>('MAX_BODY_BYTES') ?? 262144;

  // --- Logging -------------------------------------------------------
  const logger = new AppLogger();
  logger.setLogLevels(
    isProduction
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  );
  app.useLogger(logger);

  // --- Proxy awareness (PRD §8) --------------------------------------
  // Without this, req.ip behind a load balancer is the balancer's address,
  // so the per-IP submission limit throttles every respondent as one client.
  // Only enable when a trusted proxy really is in front: otherwise a client
  // can spoof X-Forwarded-For and evade the limit entirely.
  if (config.get<boolean>('TRUST_PROXY')) {
    app.set('trust proxy', 1);
  }

  // --- Security headers (PRD §14) ------------------------------------
  app.use(
    helmet({
      // The API serves JSON, not HTML. CSP matters for the Swagger UI page,
      // which needs its own inline styles — so disable it in development
      // where Swagger is served, and keep the strict default in production
      // where Swagger is off.
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // --- Body parsing and the 256 KiB limit (PRD §6, §8) ---------------
  // Express throws PayloadTooLargeError, which Nest maps to 413; the
  // filter from doc 06 turns it into the PAYLOAD_TOO_LARGE envelope.
  app.use(json({ limit: maxBodyBytes }));
  app.use(urlencoded({ extended: true, limit: maxBodyBytes }));

  // --- Cookies (PRD §4: HttpOnly refresh cookie) ---------------------
  app.use(cookieParser());

  // --- CORS (PRD §14: restrictive) -----------------------------------
  app.enableCors({
    // A single known origin, never a wildcard: credentials: true and
    // origin: '*' are mutually exclusive in browsers anyway, and a
    // reflected origin would defeat the point.
    origin: [frontendUrl],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'Idempotency-Key',
    ],
    // So the browser can read the request ID and the CSV filename.
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    maxAge: 86400,
  });

  // --- Routing (PRD §12) ---------------------------------------------
  // All 25 product endpoints live under /api/v1. The two health routes
  // are explicitly outside it, so probes do not break on a version bump.
  app.setGlobalPrefix('api/v1', {
    exclude: ['health/live', 'health/ready'],
  });

  // --- Validation (PRD §11) ------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties with no decorator on the DTO.
      whitelist: true,
      // PRD §11: "DTOs whitelist accepted properties and reject unexpected
      // fields." Rejecting rather than stripping is what stops a client
      // smuggling userId into CreateFormDto.
      forbidNonWhitelisted: true,
      // Apply @Type() conversions so query params arrive as numbers.
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // Produce structured field errors instead of flat strings (below).
      exceptionFactory: validationExceptionFactory,
      // Do not echo the submitted value back in the error message —
      // on a register request that value is the password.
      validationError: { target: false, value: false },
    }),
  );

  // --- API documentation (doc 09) ------------------------------------
  if (!isProduction) {
    setupSwagger(app);
  }

  // --- Graceful shutdown ---------------------------------------------
  // Lets TypeORM close its pool and in-flight requests finish when the
  // container receives SIGTERM.
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(
    { event: 'app.started', port, env: config.get('NODE_ENV') },
    'Bootstrap',
  );
}

void bootstrap();
```

## The validation exception factory

Doc 06's filter splits ValidationPipe's flat strings on whitespace to guess a field name. That works, but a factory
gives you the real property path and the failed rule:

```ts
// src/common/pipes/validation-exception.factory.ts
import { ValidationError } from 'class-validator';
import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../errors/domain.exception';
import { ErrorCode, FieldError } from '../errors/error-codes';

const flatten = (errors: ValidationError[], parent = ''): FieldError[] =>
  errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;

    const own = Object.entries(error.constraints ?? {}).map(
      ([rule, message]): FieldError => ({ field: path, rule, message }),
    );

    const nested = error.children?.length ? flatten(error.children, path) : [];

    return [...own, ...nested];
  });

/**
 * Turns class-validator output into the PRD §12 envelope's `errors` array.
 * Status is 422, matching the answer-validation path, so a client has one
 * branch for "input was invalid" rather than two.
 */
export const validationExceptionFactory = (
  errors: ValidationError[],
): DomainException =>
  new DomainException(
    ErrorCode.VALIDATION_FAILED,
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Request validation failed.',
    flatten(errors),
  );
```

With this in place, a nested failure reports `fields.0.validation.maxLength` rather than `fields`.

## Notes on three choices

**`forbidNonWhitelisted: true` is a security control, not tidiness.** PRD §3 says *"Never accept userId/ownerId from
form creation bodies."* With only `whitelist: true`, a `userId` in the body is silently dropped — which is fine until
someone adds a `userId` property to the DTO for an unrelated reason. Rejecting the request outright fails loudly.

**Health routes are excluded from the global prefix.** PRD §12 lists them as `/health/live` and `/health/ready`,
separate from the 25 product endpoints. Container and load-balancer probes get configured once and should not move
when the API version does.

**`import * as cookieParser` rather than a default import.** `tsconfig.json` uses `module: nodenext` without
`esModuleInterop`, so CommonJS packages need the namespace form. Same reason the existing code writes
`import * as Joi from 'joi'`.

## Verify

```bash
pnpm build && pnpm start:dev

# 1. Product routes are prefixed, health routes are not
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/forms   # 401 (after doc 13) or 404
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health/live     # 200 (after doc 08)
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/health/live  # 404 — correct

# 2. Security headers are present
curl -sI localhost:3000/health/live | grep -iE 'x-frame-options|x-content-type|strict-transport'
# expected: X-Frame-Options, X-Content-Type-Options, (HSTS over https only)

# 3. CORS allows only the configured origin
curl -si -X OPTIONS localhost:3000/api/v1/forms \
  -H 'Origin: http://evil.example' \
  -H 'Access-Control-Request-Method: GET' | grep -i access-control-allow-origin
# expected: NO allow-origin header at all

curl -si -X OPTIONS localhost:3000/api/v1/forms \
  -H 'Origin: http://localhost:3001' \
  -H 'Access-Control-Request-Method: GET' | grep -i access-control-allow-origin
# expected: Access-Control-Allow-Origin: http://localhost:3001

# 4. The body limit returns 413 in the standard envelope (PRD §8)
head -c 300000 /dev/zero | tr '\0' 'a' > /tmp/big.txt
curl -s -X POST localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  --data-binary "{\"name\":\"$(cat /tmp/big.txt)\"}" | jq
# expected: {"statusCode":413,"code":"PAYLOAD_TOO_LARGE",…}

# 5. Unknown properties are REJECTED, not stripped (PRD §11)
curl -s -X POST localhost:3000/api/v1/forms \
  -H 'content-type: application/json' \
  -d '{"title":"Test","userId":"00000000-0000-0000-0000-000000000000"}' | jq
# expected: 422 VALIDATION_FAILED mentioning the userId property

# 6. The submitted value is not echoed back
curl -s -X POST localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"x","password":"hunter2","name":"a"}' | jq
# expected: error messages describe the rules; the string "hunter2" appears nowhere

# 7. Graceful shutdown
# Ctrl-C — expected: no "connection terminated unexpectedly" from TypeORM
```

## If you skip this

Nothing under `/api/v1` resolves, no DTO is validated (every endpoint accepts arbitrary JSON), bodies are unbounded,
and the browser cannot call the API at all because CORS is off by default.

---

Previous: [06 — Exceptions](./06-exceptions.md) · Next: [08 — Health module](./08-health.md)
