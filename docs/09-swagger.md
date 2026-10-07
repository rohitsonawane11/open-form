# 09 — Swagger / OpenAPI

## Why

PRD §12 closes with a one-line requirement:

> Document all routes in Swagger/OpenAPI.

`@nestjs/swagger` is already installed and entirely unused. Beyond the requirement, a browsable spec is the fastest
way to verify the §12 catalogue is complete — all 25 product endpoints, correctly grouped, with the right auth
scheme.

## 1. Enable the CLI plugin first

This is the highest-leverage line in the document. Without it, every DTO property needs a hand-written
`@ApiProperty()`; with it, the plugin reads your TypeScript types and `class-validator` decorators and generates the
schema.

```json
// nest-cli.json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "plugins": [
      {
        "name": "@nestjs/swagger",
        "options": {
          "dtoFileNameSuffix": [".dto.ts", ".entity.ts"],
          "introspectComments": true,
          "classValidatorShim": true
        }
      }
    ]
  }
}
```

`introspectComments: true` turns a JSDoc comment above a property into its `description`, so documentation lives
next to the code:

```ts
export class CreateFormDto {
  /** Form title shown to respondents. 1–200 characters. */
  @IsString()
  @Length(1, 200)
  title: string;
}
```

The plugin runs during `nest build` and `nest start`. It does **not** run under `ts-jest`, so e2e tests that assert
on the spec need the decorators explicitly — rarely an issue.

## 2. The setup function

```ts
// src/config/swagger.config.ts
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * PRD §12: document all routes. Called from main.ts and skipped in
 * production — the spec enumerates every endpoint and its auth scheme,
 * which is free reconnaissance for an attacker.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('OpenForms API')
    .setDescription(
      [
        'Personal form builder API.',
        '',
        'All product endpoints are under `/api/v1`. Health routes',
        '(`/health/live`, `/health/ready`) sit outside the prefix.',
        '',
        '**Errors** share one envelope:',
        '`{ statusCode, code, message, requestId, errors? }`.',
        '',
        '**Ownership**: another user’s private resource returns 404,',
        'never 403 — the API does not confirm that it exists.',
      ].join('\n'),
    )
    .setVersion('1.0')

    // PRD §4: access JWT in the Authorization header, kept in memory by
    // the browser.
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token from /auth/login. Expires in 15 minutes.',
      },
      'access-token',
    )

    // PRD §4: the refresh token travels as an HttpOnly cookie, so
    // /auth/refresh and /auth/logout authenticate differently.
    .addCookieAuth(
      'refresh_token',
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          'HttpOnly refresh cookie. Used only by /auth/refresh and /auth/logout.',
      },
      'refresh-cookie',
    )

    // Tags in catalogue order (PRD §12).
    .addTag('Auth', 'Registration, login, sessions and recovery')
    .addTag('Users', 'Current account profile')
    .addTag('Forms', 'Private form management (owner only)')
    .addTag('Submissions', 'Private response management and CSV export')
    .addTag('Public', 'Anonymous form rendering and submission')

    .addServer('http://localhost:3000', 'Local development')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    // Stable operationIds, so a generated client has readable method names.
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace('Controller', '')}_${methodKey}`,
  });

  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'OpenForms API',
    swaggerOptions: {
      // Keep the entered bearer token across page reloads.
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      docExpansion: 'none',
    },
    // The raw spec, for client generation.
    jsonDocumentUrl: 'api/docs-json',
  });
}
```

Doc 07 already calls this behind `if (!isProduction)`.

## 3. The shared error response DTO

Documenting `{statusCode, code, message, requestId}` once means every route references the same schema:

```ts
// src/common/dto/api-error.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FieldErrorDto {
  /** The property or form field the error applies to. */
  @ApiProperty({ example: 'fld_email' })
  field: string;

  /** Machine-readable reason. */
  @ApiProperty({ example: 'isEmail' })
  rule: string;

  @ApiProperty({ example: 'email must be a valid email address' })
  message: string;
}

/** The PRD §12 error envelope. Every failing response has this shape. */
export class ApiErrorDto {
  @ApiProperty({ example: 409 })
  statusCode: number;

  @ApiProperty({ example: 'FORM_CHANGED' })
  code: string;

  @ApiProperty({ example: 'This form has been updated.' })
  message: string;

  @ApiProperty({ example: '7f3c1a80-2b4e-4c1d-9f0a-1b2c3d4e5f60' })
  requestId: string;

  @ApiPropertyOptional({ type: [FieldErrorDto] })
  errors?: FieldErrorDto[];
}
```

## 4. Reusable response decorators

Repeating six `@ApiResponse` blocks on every route is noise. Compose them:

```ts
// src/common/decorators/api-standard-responses.decorator.ts
import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ApiErrorDto } from '../dto/api-error.dto';

const described = (status: number, description: string) =>
  ApiResponse({ status, description, type: ApiErrorDto });

/** Applied to every authenticated route. */
export const ApiAuthErrors = () =>
  applyDecorators(
    described(401, 'Missing, expired or invalid access token'),
    described(403, 'Account email is not verified'),
    described(422, 'Request validation failed'),
    described(429, 'Rate limit exceeded'),
  );

/** Applied to routes addressing a specific owned resource. */
export const ApiOwnedResourceErrors = () =>
  applyDecorators(
    ApiAuthErrors(),
    described(404, 'Not found, or not owned by the authenticated user'),
  );

/** Applied to the public submission endpoint. */
export const ApiPublicSubmissionErrors = () =>
  applyDecorators(
    described(404, 'Form is unknown, unpublished or deleted'),
    described(409, 'Stale publicationVersion, or idempotency key conflict'),
    described(413, 'Body exceeds 256 KiB'),
    described(422, 'One or more answers are invalid'),
    described(429, 'Submission rate limit exceeded'),
  );
```

The 404 description on `ApiOwnedResourceErrors` states the PRD §3 rule in the published documentation, so a frontend
developer is not surprised when another user's valid UUID returns 404.

## 5. Controller conventions

Apply these consistently; doc 13 onward assumes them.

```ts
@ApiTags('Forms')
@ApiBearerAuth('access-token')
@Controller('forms')
export class FormsController {
  @Post()
  @ApiOperation({
    summary: 'Create a form',
    description:
      'Creates a draft form owned by the authenticated user. ' +
      'Ownership is derived from the access token; a userId in the body is rejected.',
  })
  @ApiCreatedResponse({ type: FormResponseDto })
  @ApiAuthErrors()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateFormDto) {}
}
```

| Element | Convention |
|---|---|
| `@ApiTags` | Once per controller, matching a tag from the builder |
| `@ApiBearerAuth('access-token')` | Once per controller for private routes; omit entirely on `Public` |
| `@ApiOperation` | On every route; `summary` matches the §12 "Purpose" column |
| Success response | Always typed — `@ApiOkResponse({ type: X })`, never bare |
| Error responses | One of the composed decorators above |
| Response DTOs | Separate from entities. PRD §11: "API response DTOs omit all secrets." Never return an entity directly — `User` has `passwordHash`. |

That last row matters more than it looks. The plugin documents whatever type you declare, so returning a `User`
entity publishes `password_hash` in your public API specification.

## 6. Checking the catalogue

Once the modules exist, this counts your endpoints against PRD §12:

```bash
curl -s localhost:3000/api/docs-json \
  | jq '[.paths | to_entries[] | .key as $p | .value | keys[] | "\(. | ascii_upcase) \($p)"] | sort | .[]'

curl -s localhost:3000/api/docs-json \
  | jq '[.paths[] | keys[]] | length'
# expected after doc 17: 25
```

The expected breakdown: Auth 10, Users 2, Forms 7, Submissions 4, Public 2. Health is excluded via
`@ApiExcludeController` and is not in the count — matching §12's "25 product endpoints + 2 health endpoints".

## Verify

```bash
pnpm start:dev

# 1. The UI loads
open http://localhost:3000/api/docs

# 2. The raw spec is valid JSON with the right metadata
curl -s localhost:3000/api/docs-json | jq '{title: .info.title, version: .info.version, servers: .servers}'

# 3. Both auth schemes are declared
curl -s localhost:3000/api/docs-json | jq '.components.securitySchemes | keys'
# expected: ["access-token", "refresh-cookie"]

# 4. Health is NOT in the product spec
curl -s localhost:3000/api/docs-json | jq '.paths | keys | map(select(startswith("/health")))'
# expected: []

# 5. The error envelope is a shared schema
curl -s localhost:3000/api/docs-json | jq '.components.schemas.ApiErrorDto.properties | keys'
# expected: ["code","errors","message","requestId","statusCode"]

# 6. The CLI plugin is working — no @ApiProperty needed.
#    After doc 13 adds RegisterDto:
curl -s localhost:3000/api/docs-json | jq '.components.schemas.RegisterDto'
# expected: properties name/email/password with types and constraints.
# If this is null or empty, the plugin is not configured — re-check nest-cli.json
# and restart (the plugin only runs through the Nest CLI, not ts-node directly).

# 7. Swagger is OFF in production
NODE_ENV=production node dist/main &
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/docs
# expected: 404
kill %1
```

Step 6 is the one that silently fails. If schemas come back empty, you are documenting nothing and will not notice
until a client generator produces `any` everywhere.

## If you skip this

PRD §12's documentation requirement is unmet, and you lose the cheapest check that the endpoint catalogue is complete
and correctly shaped — the `jq` count above catches a missing route or a wrong HTTP method in one command.

---

Previous: [08 — Health](./08-health.md) · Next: [10 — Shared utilities](./10-common.md)
