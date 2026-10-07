# 08 — Health module

## Why

PRD §12 lists two operational routes alongside the 25 product endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/health/live` | Process liveness |
| GET | `/health/ready` | Database readiness |

The distinction is the whole point. **Liveness** answers "is this process wedged, should the orchestrator restart
it?" — so it must do no I/O. **Readiness** answers "can this instance serve traffic right now?" — so it must check the
database.

Getting these backwards causes outages: if liveness checks the database, a brief Postgres blip restarts every API
container simultaneously, and they all come back and hammer the recovering database.

`@nestjs/terminus` is not installed. Two routes do not justify it; an optional migration is noted at the end.

## 1. The service

```ts
// src/modules/health/health.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface ReadinessResult {
  status: 'ok' | 'error';
  db: 'up' | 'down';
  latencyMs?: number;
  error?: string;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  /** A hung connection must not hang the probe. */
  private static readonly TIMEOUT_MS = 2000;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async checkDatabase(): Promise<ReadinessResult> {
    const startedAt = process.hrtime.bigint();

    try {
      await this.withTimeout(
        this.dataSource.query('SELECT 1'),
        HealthService.TIMEOUT_MS,
      );

      return {
        status: 'ok',
        db: 'up',
        latencyMs:
          Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
      };
    } catch (error) {
      // Log the real reason; return a generic one. A readiness endpoint is
      // usually unauthenticated, and driver errors contain host names,
      // user names and sometimes the connection string.
      this.logger.error(
        { event: 'health.db.failed' },
        error instanceof Error ? error.stack : String(error),
      );

      return { status: 'error', db: 'down', error: 'Database unreachable' };
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Health check timed out after ${ms}ms`)),
        ms,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
```

## 2. The controller

```ts
// src/modules/health/health.controller.ts
import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import { HealthService, ReadinessResult } from './health.service';
import { Public } from '../../common/decorators/public.decorator';

/**
 * PRD §12: two operational routes, counted separately from the 25 product
 * endpoints. main.ts excludes these paths from the /api/v1 prefix.
 */
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness. Deliberately does NO I/O: it answers only "is this process
   * responsive?". If it checked the database, a transient Postgres failure
   * would make every container restart at once.
   */
  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok'; uptimeSeconds: number } {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /**
   * Readiness. Checks the database, because an instance that cannot reach
   * Postgres cannot serve a single product endpoint. Returns 503 so a load
   * balancer removes it from rotation without restarting it.
   */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResult> {
    const result = await this.health.checkDatabase();

    res.status(
      result.status === 'ok'
        ? HttpStatus.OK
        : HttpStatus.SERVICE_UNAVAILABLE,
    );

    // Probes must never be served from a cache.
    res.setHeader('Cache-Control', 'no-store');

    return result;
  }
}
```

The `@Public()` decorator comes from doc 10 — until then, omit it; nothing is guarding these routes yet. Once doc 13
registers a global `JwtAuthGuard`, these two routes must carry it or your probes start returning 401.

`@ApiExcludeController()` keeps health out of the product API documentation, matching PRD §12's separation.

## 3. The module

```ts
// src/modules/health/health.module.ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
```

`@InjectDataSource()` resolves from the global `TypeOrmModule.forRootAsync()` in `DatabaseModule`, so no
`forFeature` import is needed.

## 4. Wire the probes to Docker

Doc 19 covers the full compose file; the relevant part is that the API container should use these:

```yaml
services:
  api:
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 20s
```

In Kubernetes, `livenessProbe` → `/health/live`, `readinessProbe` → `/health/ready`. Keep the liveness probe's
`failureThreshold` generous; it restarts the pod.

## Optional: `@nestjs/terminus`

If you later want disk, memory and HTTP dependency checks with a standard response format:

```bash
pnpm add @nestjs/terminus
```

```ts
@Get('ready')
@HealthCheck()
check() {
  return this.health.check([
    () => this.db.pingCheck('database', { timeout: 2000 }),
    () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
  ]);
}
```

Terminus returns 503 automatically on failure and gives a richer `{status, info, error, details}` body. The reason to
start without it: the hand-rolled version above is ~40 lines, has no dependency, and returns exactly the shape the
PRD asks for.

## Verify

```bash
pnpm start:dev

# 1. Liveness
curl -s localhost:3000/health/live | jq
# expected: {"status":"ok","uptimeSeconds":12}

# 2. Readiness with the database up
curl -s -w '\nHTTP %{http_code}\n' localhost:3000/health/ready | jq
# expected: {"status":"ok","db":"up","latencyMs":1.4}  — HTTP 200

# 3. Readiness with the database DOWN — the important one
docker compose stop postgres
curl -s -w '\nHTTP %{http_code}\n' localhost:3000/health/ready | jq
# expected: {"status":"error","db":"down","error":"Database unreachable"} — HTTP 503

# 4. Liveness still passes while the database is down
curl -s -w '\nHTTP %{http_code}\n' localhost:3000/health/live
# expected: HTTP 200 — this is the whole point of splitting the two

# 5. No driver detail leaks to the caller
curl -s localhost:3000/health/ready | grep -iE 'postgres|password|5432|ECONNREFUSED'
# expected: no output (the detail is in the server log instead)

docker compose start postgres
sleep 5

# 6. It recovers without a restart
curl -s localhost:3000/health/ready | jq
# expected: {"status":"ok","db":"up",…}

# 7. The probe is not under the version prefix
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/health/live
# expected: 404

# 8. Health requests are not spamming the HTTP log (doc 05 skips them)
# expected: no [HTTP] lines for the curls above
```

Step 4 is the one to actually run. If liveness returns 503 when Postgres is down, the two checks are the same check
and you have built a restart loop.

## If you skip this

Doc 19's container has no healthcheck, so an orchestrator routes traffic to an instance that cannot reach the
database, and every request 500s until someone notices. These are also the cheapest smoke test for every later
document — `curl /health/ready` confirms config, database and bootstrap in one call.

---

Previous: [07 — Bootstrap](./07-bootstrap.md) · Next: [09 — Swagger / OpenAPI](./09-swagger.md)
