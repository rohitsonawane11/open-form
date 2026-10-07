# 04 — Logger

## Why

PRD §14 states the requirement twice, from both directions:

> Never log credentials, answer bodies or OAuth codes. Basic scrubbed structured logs and optional Sentry suffice;
> no audit database/UI is required.

And §11:

> Tokens and Idempotency-Key are never logged.

"Scrubbed" is the operative word. The default Nest logger will happily print a whole request body, and the first time
a validation error logs its payload, a plaintext password lands in your log aggregator forever.

There is no logger library installed. This document subclasses Nest's built-in `ConsoleLogger` instead of adding one
— PRD §14 asks for "basic" structured logs, and the redaction logic is the part that actually matters and would have
to be written for any library anyway. An optional `nestjs-pino` swap is documented at the end.

## 1. The redaction utility

This is the security-critical file. It runs on every object before it reaches an output stream.

```ts
// src/common/logger/redact.ts

/**
 * Keys whose values are replaced with '[REDACTED]' at any depth.
 * Matching is case-insensitive and ignores -, _ and . so that
 * 'refresh_token', 'refreshToken' and 'Refresh-Token' all match.
 *
 * PRD §14: never log credentials, answer bodies or OAuth codes.
 * PRD §11: tokens and Idempotency-Key are never logged.
 */
const REDACT_KEYS = new Set([
  // Credentials
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'passwordconfirmation',
  'secret',
  'clientsecret',
  // Tokens of every kind
  'token',
  'accesstoken',
  'refreshtoken',
  'refreshtokenhash',
  'tokenhash',
  'idtoken',
  'jwt',
  'apikey',
  'keyhash',
  // OAuth (PRD §14: never log OAuth codes)
  'code',
  'state',
  'codeverifier',
  // Headers
  'authorization',
  'cookie',
  'setcookie',
  'xcsrftoken',
  'idempotencykey',
  // PRD §14: never log answer bodies. This is the one people forget.
  'answers',
  'answer',
  'draftschema',
  'publishedsnapshot',
  'schemasnapshot',
]);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

const normalizeKey = (key: string): string =>
  key.toLowerCase().replace(/[-_.\s]/g, '');

/**
 * Returns a structurally-similar copy with sensitive values removed.
 * Never mutates the input. Safe against cycles and deep nesting.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING}]`
      : value;
  }

  if (typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) return '[depth limit]';

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1, seen));
    if (value.length > MAX_ARRAY) {
      items.push(`[${value.length - MAX_ARRAY} more]`);
    }
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEYS.has(normalizeKey(key))
      ? REDACTED
      : redact(val, depth + 1, seen);
  }
  return out;
}

/** Redacts a raw bearer/cookie header value for the rare case it must appear. */
export function maskSecret(value?: string): string {
  if (!value) return '';
  return value.length <= 8 ? REDACTED : `${value.slice(0, 4)}…${value.slice(-2)}`;
}
```

Two things worth noticing. `answers` is in the list — PRD §14 forbids logging answer bodies, and the submission
pipeline passes them through error paths constantly. And the schema fields (`draftSchema`, `publishedSnapshot`,
`schemaSnapshot`) are redacted not because they are secret but because they are large; a 256 KiB JSONB blob in a log
line is its own kind of incident.

## 2. The logger

```ts
// src/common/logger/app.logger.ts
import { ConsoleLogger, Injectable, LogLevel, Scope } from '@nestjs/common';
import { redact } from './redact';
import { getRequestId } from './request-context';

interface LogRecord {
  level: LogLevel;
  time: string;
  context?: string;
  requestId?: string;
  message: unknown;
  stack?: string;
  [key: string]: unknown;
}

/**
 * JSON lines in production (one object per line, aggregator-friendly);
 * the readable Nest format in development.
 *
 * Every payload passes through redact() before it is written.
 */
@Injectable({ scope: Scope.DEFAULT })
export class AppLogger extends ConsoleLogger {
  private readonly json = process.env.NODE_ENV === 'production';

  log(message: unknown, ...rest: unknown[]) {
    this.emit('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.emit('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.emit('verbose', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]) {
    if (!this.isLevelEnabled(level)) return;

    // Nest's convention: the final string argument is the context, and for
    // error() a stack trace may precede it.
    const context =
      typeof rest[rest.length - 1] === 'string'
        ? (rest.pop() as string)
        : this.context;

    const stack = level === 'error' && typeof rest[0] === 'string'
      ? (rest.shift() as string)
      : undefined;

    if (!this.json) {
      // Development: keep Nest's familiar coloured output, but still redact.
      const extras = rest.map((r) => redact(r));
      super[level === 'log' ? 'log' : level](
        typeof message === 'string' ? message : JSON.stringify(redact(message)),
        ...(stack ? [stack] : []),
        ...(extras.length ? [JSON.stringify(extras)] : []),
        context as string,
      );
      return;
    }

    const record: LogRecord = {
      level,
      time: new Date().toISOString(),
      context,
      requestId: getRequestId(),
      message:
        typeof message === 'string' ? message : redact(message),
      ...(stack ? { stack } : {}),
      ...(rest.length ? { data: redact(rest.length === 1 ? rest[0] : rest) } : {}),
    };

    const line = JSON.stringify(record);
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}
```

`getRequestId()` comes from doc 05 — create that file first if you want this to compile in one pass, or stub it as
`export const getRequestId = () => undefined;` and replace it next document.

## 3. Wire it into `main.ts`

Two details matter. `bufferLogs: true` holds startup messages until `useLogger` is called, so module-initialization
logs get the same formatting and redaction. And the logger is set before anything else runs.

```ts
// src/main.ts — doc 07 writes the complete file; this is the logger portion
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppLogger } from './common/logger/app.logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = new AppLogger();
  logger.setLogLevels(
    process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  );
  app.useLogger(logger);

  // …rest in doc 07
}
void bootstrap();
```

Note `void bootstrap()` rather than `bootstrap()` — the ESLint config has `no-floating-promises` enabled as a
warning, and the current `main.ts` trips it.

## 4. Using it in a service

```ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class FormsService {
  private readonly logger = new Logger(FormsService.name);

  async publish(formId: string, userId: string) {
    this.logger.log({ event: 'form.published', formId, userId });
  }
}
```

Keep injecting the standard `Logger`. `app.useLogger()` redirects it to `AppLogger` globally, so services need no
knowledge of the implementation — which is what makes the pino swap below a one-file change.

Prefer object messages over interpolated strings. `{ event: 'form.published', formId }` is queryable in an
aggregator; `` `Published form ${formId}` `` is not.

## Optional: swapping in `nestjs-pino`

If you later want higher throughput and ecosystem transports:

```bash
pnpm add nestjs-pino pino pino-http pino-pretty
```

```ts
// app.module.ts
LoggerModule.forRoot({
  pinoHttp: {
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.answers'],
      censor: '[REDACTED]',
    },
    transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
  },
}),
```

and `app.useLogger(app.get(PinoLogger))` in `main.ts`. Nothing in any other document changes, because services only
ever touch the `Logger` facade. The trade-off: pino's `redact` uses path expressions, so it only scrubs paths you
enumerate — the key-based approach above catches a secret wherever it appears.

## Verify

```bash
# 1. Development output is readable
pnpm start:dev
# expected: coloured [Nest] lines as before

# 2. Production output is JSON lines
NODE_ENV=production node dist/main 2>&1 | head -3 | jq .
# expected: {"level":"log","time":"…","context":"NestApplication","message":"…"}

# 3. Redaction actually works — unit test it
cat > src/common/logger/redact.spec.ts <<'EOF'
import { redact } from './redact';

describe('redact', () => {
  it('removes credentials at any depth', () => {
    expect(redact({ user: { password: 'hunter2', name: 'Ada' } })).toEqual({
      user: { password: '[REDACTED]', name: 'Ada' },
    });
  });

  it('removes submitted answers (PRD §14)', () => {
    expect(redact({ answers: { fld_a: 'secret' } })).toEqual({
      answers: '[REDACTED]',
    });
  });

  it('matches regardless of casing or separators', () => {
    const out = redact({ 'Refresh-Token': 'x', refresh_token: 'y', refreshToken: 'z' });
    expect(Object.values(out as object)).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]']);
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it('does not mutate the input', () => {
    const input = { password: 'hunter2' };
    redact(input);
    expect(input.password).toBe('hunter2');
  });
});
EOF
pnpm test redact
# expected: 5 passing
```

## If you skip this

Doc 06's exception filter logs the exception with its context — including, on a validation failure, the request body.
Without redaction that means registration passwords in plaintext, and submission answers in every 422. This document
needs to come before anything that can log a request.

---

Previous: [03 — Database](./03-database.md) · Next: [05 — Request ID & HTTP logging](./05-request-context.md)
