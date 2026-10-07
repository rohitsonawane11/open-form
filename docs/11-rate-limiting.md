# 11 — Rate limiting & abuse controls

## Why

PRD §8 is specific about the public submission endpoint:

> Apply payload limits, honeypot and initial rate limit of ten submissions/minute/IP/form plus configurable form-wide
> abuse ceiling. A single API instance may use an in-memory limiter; shared limiting is required before horizontal
> scaling. Configure trusted reverse proxy IP handling. Honeypot matches produce no stored response and a generic
> success-like reply. CORS is not spam protection.

And §4, on login:

> Login failures use a generic message and rate limiting.

`@nestjs/throttler` is installed and unused. Note what §8 rules out: CORS does not stop a script, and the limit is
**per IP per form** — a global per-IP limit would let one script spray every form on the instance.

## 1. Global configuration

Three named buckets. Named throttlers let a route opt into one without inheriting the others:

```ts
// src/app.module.ts
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { seconds } from '@nestjs/throttler';

ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    throttlers: [
      {
        // Baseline for every authenticated route.
        name: 'default',
        ttl: seconds(config.get<number>('THROTTLE_TTL_SECONDS') ?? 60),
        limit: config.get<number>('THROTTLE_LIMIT') ?? 100,
      },
      {
        // PRD §4: "Login failures use a generic message and rate limiting."
        // Tight, because this is the credential-stuffing surface.
        name: 'auth',
        ttl: seconds(60),
        limit: 10,
      },
      {
        // PRD §8: ten submissions/minute/IP/form.
        name: 'submission',
        ttl: seconds(60),
        limit: config.get<number>('SUBMISSION_THROTTLE_LIMIT') ?? 10,
      },
    ],
    // Health probes fire every few seconds and must never be throttled —
    // a throttled readiness probe takes the instance out of rotation.
    skipIf: (ctx) =>
      ctx.switchToHttp().getRequest<{ path: string }>().path.startsWith('/health'),
  }),
}),
```

Register the guard globally:

```ts
providers: [
  { provide: APP_FILTER, useClass: AllExceptionsFilter },
  { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  { provide: APP_GUARD, useClass: ThrottlerGuard },
],
```

Doc 06's filter already maps `ThrottlerException` to the 429 `RATE_LIMITED` envelope, so no extra work is needed
there.

## 2. The per-form submission throttler

The default guard keys on IP alone. PRD §8 needs IP **and** form, so one form being hammered does not lock a
respondent out of a different form:

```ts
// src/common/guards/submission-throttler.guard.ts
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request } from 'express';
import { createHash } from 'node:crypto';

/**
 * PRD §8: "initial rate limit of ten submissions/minute/IP/form".
 *
 * Keying on IP alone would let a flood against one form block every other
 * form's respondents from the same NAT. Keying on form alone would let a
 * single script exhaust the budget for everyone.
 */
@Injectable()
export class SubmissionThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    // req.ip is only the real client when Express trusts the proxy.
    // main.ts sets 'trust proxy' from TRUST_PROXY (PRD §8); without it,
    // every request behind a load balancer shares one tracker.
    const ip = req.ip ?? 'unknown';
    const slug = (req.params as Record<string, string>).slug ?? 'unknown';

    // Hashed so raw IPs do not end up in the limiter's key store.
    return createHash('sha256').update(`${ip}:${slug}`).digest('hex');
  }

  protected async throwThrottlingException(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // Let the base class throw; doc 06's filter shapes the envelope.
    return super.throwThrottlingException(_context, _detail);
  }
}
```

Applied in doc 17:

```ts
@Public()
@Post('forms/:slug/submissions')
@UseGuards(SubmissionThrottlerGuard)
@Throttle({ submission: { limit: 10, ttl: 60000 } })
async submit() {}
```

And on auth routes in doc 13:

```ts
@Public()
@Post('login')
@Throttle({ auth: { limit: 10, ttl: 60000 } })
async login() {}
```

## 3. The form-wide ceiling

§8 also requires a "configurable form-wide abuse ceiling" — a cap across *all* IPs, which catches a distributed
flood that per-IP limits cannot see.

```ts
// src/modules/submissions/form-ceiling.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * PRD §8: "plus configurable form-wide abuse ceiling".
 *
 * A fixed window per form across all IPs. Catches a distributed flood that
 * per-IP limits miss by definition.
 *
 * In-memory, which PRD §8 explicitly permits for a single instance:
 * "A single API instance may use an in-memory limiter; shared limiting is
 * required before horizontal scaling." Two instances each enforce their own
 * ceiling, so the effective limit doubles. Before scaling out, move this to
 * Redis — see the note at the end of this document.
 */
@Injectable()
export class FormCeilingService {
  private readonly logger = new Logger(FormCeilingService.name);
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs = 60_000;

  constructor(config: ConfigService) {
    this.limit = config.get<number>('FORM_SUBMISSION_CEILING') ?? 300;
  }

  /** Returns false when the form is over its ceiling for this minute. */
  consume(formId: string): boolean {
    const now = Date.now();
    const window = this.windows.get(formId);

    if (!window || window.resetAt <= now) {
      this.windows.set(formId, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return true;
    }

    window.count += 1;

    if (window.count > this.limit) {
      // Log once per window, not once per request, or the flood becomes a
      // log flood too.
      if (window.count === this.limit + 1) {
        this.logger.warn({
          event: 'form.ceiling.exceeded',
          formId,
          limit: this.limit,
        });
      }
      return false;
    }

    return true;
  }

  /** Drops expired windows so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (this.windows.size < 1000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
```

The `sweep` is not incidental. Without it, a map keyed by form ID grows forever, which is a slow memory leak that an
attacker can drive by submitting to many forms.

## 4. The honeypot

PRD §8:

> Honeypot matches produce no stored response and a generic success-like reply.

"Success-like" is the requirement. Returning an error tells the bot its submission was detected, so it adapts. A
normal-looking 201 teaches it nothing.

```ts
// src/modules/submissions/honeypot.ts
import { Logger } from '@nestjs/common';

const logger = new Logger('Honeypot');

/**
 * PRD §8. The field is rendered hidden; a human never fills it, a naive
 * bot fills every input it finds.
 */
export const isHoneypotTriggered = (
  honeypot: string | undefined,
  formId: string,
): boolean => {
  const triggered = typeof honeypot === 'string' && honeypot.trim().length > 0;

  if (triggered) {
    // Log that it fired, never the value — it is attacker-controlled input.
    logger.warn({ event: 'submission.honeypot', formId });
  }

  return triggered;
};
```

Doc 17 uses it like this — note that the response is indistinguishable from a real success:

```ts
if (isHoneypotTriggered(dto.honeypot, form.id)) {
  return {
    id: randomUUID(),            // a plausible ID that references nothing
    submittedAt: new Date().toISOString(),
    message: form.publishedSnapshot.successMessage,
  };
}
```

## 5. What throttling does not cover

PRD §13 is worth restating, because it is easy to get wrong:

> Public marker exempts authentication only, not validation or abuse controls.

A `@Public()` route still runs the global `ValidationPipe`, the 256 KiB body limit, the throttler guard and the
honeypot check. `@Public()` removes exactly one thing: the requirement for a valid access token.

And from §8: **"CORS is not spam protection."** CORS is a browser policy. `curl` ignores it entirely. The controls in
this document are the ones that actually apply to a script.

## Before horizontal scaling

PRD §8 flags this explicitly. Both limiters here are per-process:

| Limiter | Storage | Behaviour with N instances |
|---|---|---|
| `SubmissionThrottlerGuard` | `ThrottlerModule` memory store | Effective limit becomes 10 × N per minute |
| `FormCeilingService` | In-process `Map` | Effective ceiling becomes 300 × N per minute |

The fix when you scale out:

```bash
pnpm add @nest-lab/throttler-storage-redis ioredis
```

```ts
ThrottlerModule.forRootAsync({
  useFactory: () => ({
    throttlers: [ /* …as above… */ ],
    storage: new ThrottlerStorageRedisService(process.env.REDIS_URL),
  }),
}),
```

and move `FormCeilingService` to a Redis `INCR` with `EXPIRE`. PRD §2 defers Redis for the MVP, so this is
documented rather than built — but it is a correctness issue the moment a second instance starts, not an
optimisation.

## Verify

```bash
pnpm start:dev

# 1. The global limit returns the standard 429 envelope
for i in $(seq 1 105); do
  curl -s -o /dev/null -w '%{http_code} ' localhost:3000/api/v1/forms
done; echo
# expected: 401s (unauthenticated), then 429s once past THROTTLE_LIMIT

curl -s localhost:3000/api/v1/forms | jq
# expected while limited:
# {"statusCode":429,"code":"RATE_LIMITED","message":"Too many requests…","requestId":"…"}

# 2. Rate-limit headers are present
curl -sI localhost:3000/api/v1/forms | grep -i ratelimit
# expected: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset

# 3. Health is never throttled (skipIf)
for i in $(seq 1 200); do curl -s -o /dev/null localhost:3000/health/live; done
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health/live
# expected: 200

# 4. After doc 17 — the submission limit is per IP PER FORM (PRD §8)
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST \
    localhost:3000/api/v1/public/forms/SLUG_A/submissions \
    -H 'content-type: application/json' \
    -d '{"publicationVersion":1,"answers":{}}'
done; echo
# expected: ten non-429 responses, then 429

# The SAME IP on a DIFFERENT form must still be accepted — this is the
# assertion that distinguishes a correct implementation from a global limit.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  localhost:3000/api/v1/public/forms/SLUG_B/submissions \
  -H 'content-type: application/json' \
  -d '{"publicationVersion":1,"answers":{}}'
# expected: NOT 429

# 5. The honeypot returns a success-like reply and stores nothing
curl -s -X POST localhost:3000/api/v1/public/forms/SLUG_A/submissions \
  -H 'content-type: application/json' \
  -d '{"publicationVersion":1,"answers":{},"honeypot":"bot was here"}' | jq
# expected: a 201 that looks exactly like a real success

docker compose exec postgres psql -U openform -d openform \
  -c 'select count(*) from submissions;'
# expected: unchanged from before the honeypot request

# 6. The honeypot VALUE is not in the logs
# expected: {"event":"submission.honeypot","formId":"…"} — and no "bot was here"
```

Step 4's second half is the one that matters. A global per-IP limiter passes the first half and fails the PRD.

## If you skip this

The public submission endpoint is an open write endpoint on the internet with no authentication — PRD §8 exists
because that is exactly what it is. Login has no brute-force protection, which §4 requires alongside the generic
failure message.

---

Previous: [10 — Shared utilities](./10-common.md) · Next: [12 — Entities & first migration](./12-entities.md)
