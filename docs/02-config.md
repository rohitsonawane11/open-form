# 02 — Config & env validation

## Why

The current Joi schema validates six variables — `NODE_ENV` and five `DB_*`. The PRD needs JWT secrets and TTLs
(§4), Google OAuth credentials (§4), SMTP settings (§13 Mail), app and frontend URLs for email links and CORS (§14),
Argon2 cost tuned "for deployment capacity" (§4), and throttle limits (§8).

Validating these at boot means a missing `JWT_ACCESS_SECRET` fails immediately with a clear message, instead of
producing tokens signed with `undefined` at 3am.

The schema also moves out of `app.module.ts`. It is about to triple in size and does not belong inline.

## 1. The validation schema

```ts
// src/config/env.validation.ts
import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // --- Runtime ---------------------------------------------------------
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),

  // Public base URL of this API. Used to build verification and
  // password-reset links, and the Google OAuth callback.
  APP_URL: Joi.string().uri().default('http://localhost:3000'),

  // The single allowed browser origin. PRD §14 requires restrictive CORS.
  FRONTEND_URL: Joi.string().uri().default('http://localhost:3001'),

  // Set when the API sits behind a reverse proxy, so req.ip is the real
  // client address and not the proxy's. PRD §8 requires this for the
  // per-IP submission limit to mean anything.
  TRUST_PROXY: Joi.boolean().default(false),

  // --- Database --------------------------------------------------------
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  DB_LOGGING: Joi.boolean().default(false),

  // --- Auth: tokens ----------------------------------------------------
  // Two distinct secrets. Sharing one means a refresh token is accepted
  // as an access token.
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),

  // PRD §4: access 15 minutes, refresh session 30 days.
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  REFRESH_TTL_DAYS: Joi.number().integer().min(1).default(30),

  // PRD §4: verification 24 hours, password reset 30 minutes.
  VERIFICATION_TTL_HOURS: Joi.number().integer().min(1).default(24),
  PASSWORD_RESET_TTL_MINUTES: Joi.number().integer().min(1).default(30),

  // --- Auth: cookies ---------------------------------------------------
  COOKIE_DOMAIN: Joi.string().allow('').default(''),
  // PRD §4: Secure, HttpOnly refresh cookie in production.
  COOKIE_SECURE: Joi.boolean().default(false),
  COOKIE_SAME_SITE: Joi.string().valid('lax', 'strict', 'none').default('lax'),

  // --- Auth: Argon2id --------------------------------------------------
  // PRD §4: "configure cost for deployment capacity". Defaults are the
  // OWASP second recommended profile: 19 MiB, 2 iterations, 1 lane.
  ARGON2_MEMORY_COST: Joi.number().integer().min(8192).default(19456),
  ARGON2_TIME_COST: Joi.number().integer().min(2).default(2),
  ARGON2_PARALLELISM: Joi.number().integer().min(1).default(1),

  // --- Google OAuth ----------------------------------------------------
  // Optional so the app boots without Google configured; the strategy
  // registers only when all three are present (doc 13).
  GOOGLE_CLIENT_ID: Joi.string().allow('').default(''),
  GOOGLE_CLIENT_SECRET: Joi.string().allow('').default(''),
  GOOGLE_CALLBACK_URL: Joi.string()
    .uri()
    .default('http://localhost:3000/api/v1/auth/google/callback'),

  // --- Mail ------------------------------------------------------------
  // 'console' prints the email to the log instead of sending. PRD §4
  // requires send failure to preserve the account, so local development
  // must never depend on a reachable SMTP server.
  MAIL_TRANSPORT: Joi.string().valid('console', 'smtp').default('console'),
  MAIL_FROM: Joi.string().default('OpenForms <no-reply@openforms.local>'),
  SMTP_HOST: Joi.string().allow('').default(''),
  SMTP_PORT: Joi.number().port().default(1025),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASSWORD: Joi.string().allow('').default(''),

  // --- Abuse controls (PRD §8) -----------------------------------------
  THROTTLE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),
  // Ten submissions per minute per IP per form.
  SUBMISSION_THROTTLE_LIMIT: Joi.number().integer().min(1).default(10),
  // Configurable form-wide ceiling, per minute across all IPs.
  FORM_SUBMISSION_CEILING: Joi.number().integer().min(1).default(300),

  // --- Limits (PRD §6, §9) ---------------------------------------------
  MAX_BODY_BYTES: Joi.number().integer().default(262144), // 256 KiB
  CSV_EXPORT_MAX_ROWS: Joi.number().integer().default(10000),
});
```

A note on the two JWT secrets: `.min(32)` is deliberate. Generate real ones with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## 2. Typed configuration namespaces

`configService.get<string>('JWT_ACCESS_SECRET')` returns `string | undefined` and typos compile fine. Namespaced
config objects give you one typed accessor per area.

```ts
// src/config/configuration.ts
import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  env: process.env.NODE_ENV as 'development' | 'production' | 'test',
  isProduction: process.env.NODE_ENV === 'production',
  port: parseInt(process.env.PORT ?? '3000', 10),
  url: process.env.APP_URL!,
  frontendUrl: process.env.FRONTEND_URL!,
  trustProxy: process.env.TRUST_PROXY === 'true',
  maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES ?? '262144', 10),
  csvExportMaxRows: parseInt(process.env.CSV_EXPORT_MAX_ROWS ?? '10000', 10),
}));

export const databaseConfig = registerAs('database', () => ({
  host: process.env.DB_HOST!,
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME!,
  password: process.env.DB_PASSWORD!,
  database: process.env.DB_NAME!,
  logging: process.env.DB_LOGGING === 'true',
}));

export const authConfig = registerAs('auth', () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET!,
  refreshSecret: process.env.JWT_REFRESH_SECRET!,
  accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  refreshTtlDays: parseInt(process.env.REFRESH_TTL_DAYS ?? '30', 10),
  verificationTtlHours: parseInt(process.env.VERIFICATION_TTL_HOURS ?? '24', 10),
  passwordResetTtlMinutes: parseInt(
    process.env.PASSWORD_RESET_TTL_MINUTES ?? '30',
    10,
  ),
  cookie: {
    domain: process.env.COOKIE_DOMAIN || undefined,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: (process.env.COOKIE_SAME_SITE ?? 'lax') as
      | 'lax'
      | 'strict'
      | 'none',
  },
  argon2: {
    memoryCost: parseInt(process.env.ARGON2_MEMORY_COST ?? '19456', 10),
    timeCost: parseInt(process.env.ARGON2_TIME_COST ?? '2', 10),
    parallelism: parseInt(process.env.ARGON2_PARALLELISM ?? '1', 10),
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    callbackUrl: process.env.GOOGLE_CALLBACK_URL!,
    get enabled() {
      return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    },
  },
}));

export const mailConfig = registerAs('mail', () => ({
  transport: (process.env.MAIL_TRANSPORT ?? 'console') as 'console' | 'smtp',
  from: process.env.MAIL_FROM!,
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '1025', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
  },
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttlSeconds: parseInt(process.env.THROTTLE_TTL_SECONDS ?? '60', 10),
  limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  submissionLimit: parseInt(process.env.SUBMISSION_THROTTLE_LIMIT ?? '10', 10),
  formCeiling: parseInt(process.env.FORM_SUBMISSION_CEILING ?? '300', 10),
}));

export const configurations = [
  appConfig,
  databaseConfig,
  authConfig,
  mailConfig,
  throttleConfig,
];
```

The non-null assertions (`!`) are honest here: Joi has already guaranteed those variables exist before any factory
runs.

Usage from then on:

```ts
constructor(private readonly config: ConfigService) {}

const auth = this.config.get<ConfigType<typeof authConfig>>('auth')!;
auth.argon2.memoryCost;  // typed, no string key
```

Or inject a namespace directly, which is cleaner:

```ts
constructor(
  @Inject(authConfig.KEY)
  private readonly auth: ConfigType<typeof authConfig>,
) {}
```

## 3. Wire it into `app.module.ts`

```ts
import { configurations } from './config/configuration';
import { envValidationSchema } from './config/env.validation';

ConfigModule.forRoot({
  isGlobal: true,
  load: configurations,
  validationSchema: envValidationSchema,
  validationOptions: {
    // Report every bad variable at once, not just the first.
    abortEarly: false,
    // Reject unknown variables? No — the process env contains PATH, HOME
    // and hundreds of others.
    allowUnknown: true,
  },
  // Config is read many times per request; cache it.
  cache: true,
}),
```

## 4. Regenerate `.env.example`

```bash
cat > .env.example <<'EOF'
# ---------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3000
FRONTEND_URL=http://localhost:3001
TRUST_PROXY=false

# ---------------------------------------------------------------------
# Postgres container (docker-compose.yml)
# ---------------------------------------------------------------------
POSTGRES_USER=openform
POSTGRES_PASSWORD=change-me
POSTGRES_DB=openform
POSTGRES_PORT=5432

# ---------------------------------------------------------------------
# Application database connection
# ---------------------------------------------------------------------
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=openform
DB_PASSWORD=change-me
DB_NAME=openform
DB_LOGGING=false

# ---------------------------------------------------------------------
# JWT / sessions
# Generate each secret with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# ---------------------------------------------------------------------
JWT_ACCESS_SECRET=replace-me-with-a-32-char-minimum-random-string
JWT_REFRESH_SECRET=replace-me-with-a-different-32-char-random-string
JWT_ACCESS_TTL=15m
REFRESH_TTL_DAYS=30
VERIFICATION_TTL_HOURS=24
PASSWORD_RESET_TTL_MINUTES=30

# ---------------------------------------------------------------------
# Cookies
# ---------------------------------------------------------------------
COOKIE_DOMAIN=
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax

# ---------------------------------------------------------------------
# Argon2id (OWASP second recommended profile)
# ---------------------------------------------------------------------
ARGON2_MEMORY_COST=19456
ARGON2_TIME_COST=2
ARGON2_PARALLELISM=1

# ---------------------------------------------------------------------
# Google OAuth — leave blank to disable Google login
# ---------------------------------------------------------------------
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/api/v1/auth/google/callback

# ---------------------------------------------------------------------
# Mail — 'console' logs the email instead of sending it
# ---------------------------------------------------------------------
MAIL_TRANSPORT=console
MAIL_FROM=OpenForms <no-reply@openforms.local>
SMTP_HOST=
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=

# ---------------------------------------------------------------------
# Abuse controls
# ---------------------------------------------------------------------
THROTTLE_TTL_SECONDS=60
THROTTLE_LIMIT=100
SUBMISSION_THROTTLE_LIMIT=10
FORM_SUBMISSION_CEILING=300

# ---------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------
MAX_BODY_BYTES=262144
CSV_EXPORT_MAX_ROWS=10000
EOF
```

Then bring your real `.env` up to date — keep your existing database password, fill in the two JWT secrets:

```bash
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))" >> .env
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))" >> .env
```

Copy the remaining new keys across from `.env.example`. Confirm `.env` is gitignored (it already is).

## Verify

```bash
# 1. Missing secret fails fast with a readable message
mv .env .env.bak && cp .env.example .env
sed -i '' 's/^JWT_ACCESS_SECRET=.*/JWT_ACCESS_SECRET=/' .env
pnpm start:dev
# expected: Error: Config validation error: "JWT_ACCESS_SECRET" is not allowed
#           to be empty  — and the process exits
mv .env.bak .env

# 2. With a valid .env, it boots
pnpm start:dev
# expected: "Nest application successfully started"

# 3. All variables resolved — add this temporarily to main.ts, then remove it
#    console.log(app.get(ConfigService).get('auth'));
# expected: a fully populated object, no undefined values
```

## If you skip this

Doc 03 reads `database` config from the namespace; doc 13 cannot sign tokens without the secrets. More importantly,
unvalidated env means a production deployment with a blank `JWT_REFRESH_SECRET` starts successfully and issues
forgeable tokens.

---

Previous: [01 — Module layout](./01-module-layout.md) · Next: [03 — Database & migrations](./03-database.md)
