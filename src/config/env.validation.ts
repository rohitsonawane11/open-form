// src/config/env.validation.ts
import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // --- Runtime ---------------------------------------------------------
  NODE_ENV: Joi.string().valid('development', 'production', 'test'),
  PORT: Joi.number().port().required(),

  // Public base URL of this API. Used to build verification and
  // password-reset links, and the Google OAuth callback.
  APP_URL: Joi.string().uri().required(),

  // The single allowed browser origin. PRD §14 requires restrictive CORS.
  // FRONTEND_URL: Joi.string().uri().default('http://localhost:3001'),

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
});
