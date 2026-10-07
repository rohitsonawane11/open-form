# 03 — Database, DataSource & migrations

## Why

PRD §10 ends with a one-line requirement that the current setup violates:

> Production uses migrations, not automatic schema synchronization.

`database.module.ts` today has `synchronize: !isProduction`. That is better than always-on, but it means your
development schema is produced by a different mechanism than production's — so migrations are written blind and only
tested on deploy. The schema should come from migrations everywhere.

§10 also requires `snake_case` columns and UUID primary keys, neither of which TypeORM does by default.

## 1. Turn off `synchronize` and add a naming strategy

TypeORM's default naming turns a `passwordHash` property into a `passwordHash` column. PRD §10 wants
`password_hash`. The built-in `SnakeNamingStrategy` is not bundled, so define one — it is small and avoids a
dependency:

```ts
// src/database/snake-naming.strategy.ts
import { DefaultNamingStrategy, NamingStrategyInterface, Table } from 'typeorm';

const snake = (s: string): string =>
  s
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

/**
 * PRD §10: snake_case columns. Table names come from the explicit `name`
 * on each @Entity(), so only columns, joins and constraints are derived.
 */
export class SnakeNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  tableName(className: string, customName?: string): string {
    return customName ?? snake(className);
  }

  columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    const prefix = embeddedPrefixes.map(snake).join('_');
    return (prefix ? `${prefix}_` : '') + (customName ?? snake(propertyName));
  }

  relationName(propertyName: string): string {
    return snake(propertyName);
  }

  joinColumnName(relationName: string, referencedColumnName: string): string {
    return snake(`${relationName}_${referencedColumnName}`);
  }

  joinTableName(first: string, second: string, firstProperty: string): string {
    return snake(`${first}_${firstProperty.replace(/\./gi, '_')}_${second}`);
  }

  joinTableColumnName(
    tableName: string,
    propertyName: string,
    columnName?: string,
  ): string {
    return snake(`${tableName}_${columnName ?? propertyName}`);
  }

  classTableInheritanceParentColumnName(
    parentTableName: unknown,
    parentTableIdPropertyName: unknown,
  ): string {
    return snake(`${parentTableName as string}_${parentTableIdPropertyName as string}`);
  }

  eagerJoinRelationAlias(alias: string, propertyPath: string): string {
    return `${alias}__${propertyPath.replace('.', '_')}`;
  }

  indexName(tableOrName: Table | string, columns: string[]): string {
    const table = typeof tableOrName === 'string' ? tableOrName : tableOrName.name;
    return `idx_${table}_${columns.map(snake).join('_')}`;
  }
}
```

Now a single options object shared by the Nest module and the CLI — this matters, because a DataSource that drifts
from the runtime config generates migrations against the wrong schema:

```ts
// src/database/data-source.options.ts
import { DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';

export const buildDataSourceOptions = (env: NodeJS.ProcessEnv): DataSourceOptions => ({
  type: 'postgres',
  host: env.DB_HOST,
  port: parseInt(env.DB_PORT ?? '5432', 10),
  username: env.DB_USERNAME,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,

  // PRD §10: production uses migrations. Keeping this false in EVERY
  // environment means the schema you develop against is the schema
  // migrations produce — the only way migrations get tested before deploy.
  synchronize: false,

  logging: env.DB_LOGGING === 'true' ? ['query', 'error'] : ['error'],
  namingStrategy: new SnakeNamingStrategy(),

  entities: [__dirname + '/../modules/**/entities/*.entity.{ts,js}'],
  migrations: [__dirname + '/migrations/*.{ts,js}'],

  // Never auto-run on boot. Migrations are a deploy step (doc 19), so a
  // crash-looping container cannot half-apply one.
  migrationsRun: false,
});
```

## 2. The Nest module

```ts
// src/database/database.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { buildDataSourceOptions } from './data-source.options';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: () => ({
        ...buildDataSourceOptions(process.env),
        // Nest discovers entities from the modules that register them with
        // TypeOrmModule.forFeature(), so the glob above is only used by the CLI.
        autoLoadEntities: true,
        // Fail fast rather than hanging if Postgres is unreachable.
        retryAttempts: 3,
        retryDelay: 2000,
      }),
    }),
  ],
})
export class DatabaseModule {}
```

## 3. The CLI DataSource

The TypeORM CLI runs outside Nest, so it cannot use `ConfigService`. It loads `.env` itself:

```ts
// src/database/data-source.ts
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './data-source.options';

loadEnv();

/**
 * Used only by the TypeORM CLI (`pnpm migration:generate|run|revert`).
 * The running application builds its options through DatabaseModule.
 * Both call buildDataSourceOptions, so they cannot drift apart.
 */
export default new DataSource(buildDataSourceOptions(process.env));
```

`dotenv` is already present as a transitive dependency of `@nestjs/config`. If `pnpm` strict-resolution complains,
add it explicitly: `pnpm add -D dotenv`.

## 4. Migration scripts

Add to `package.json` `scripts`:

```json
"typeorm": "ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli.js -d src/database/data-source.ts",
"migration:generate": "pnpm typeorm migration:generate",
"migration:create": "pnpm typeorm migration:create",
"migration:run": "pnpm typeorm migration:run",
"migration:revert": "pnpm typeorm migration:revert",
"migration:show": "pnpm typeorm migration:show",
"schema:drop": "pnpm typeorm schema:drop"
```

Usage — note `migration:generate` takes a **path**, not just a name:

```bash
pnpm migration:generate src/database/migrations/AddFormsTable
pnpm migration:run
pnpm migration:revert   # undoes the last one only
```

## 5. The bootstrap migration

Postgres needs `pgcrypto` for `gen_random_uuid()`. Create this one by hand — there is no entity to generate it from:

```bash
pnpm migration:create src/database/migrations/InitExtensions
```

Fill in the generated file:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitExtensions1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // gen_random_uuid() for UUID primary keys (PRD §10).
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    // Case-insensitive text, used for the unique normalized_email index.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "citext"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Extensions are left in place deliberately: dropping them would break
    // any other schema in the same database that depends on them.
  }
}
```

> On `citext`: PRD §4 already requires emails to be normalized by trim and lowercase before storage, so a plain
> `text` column with a unique index is sufficient. `citext` is installed as a belt-and-braces measure in case a code
> path ever misses the normalization. If you would rather not depend on the extension, drop that line — nothing in
> doc 12 requires it.

## 6. A base entity

Every table in §10 has `id`, and most have `created_at`/`updated_at`. Define it once:

```ts
// src/database/base.entity.ts
import {
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';

/** PRD §10: UUID IDs, UTC timestamptz. */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
```

`submissions` has `created_at` but no `updated_at` (§10) — doc 12 declares its columns directly rather than
extending this.

## Verify

```bash
# 1. The CLI can reach the database
pnpm migration:show
# expected: a list (empty at first) and no connection error

# 2. The bootstrap migration applies
pnpm migration:run
# expected: "Migration InitExtensions... has been executed successfully."

# 3. It is recorded
docker compose exec postgres psql -U openform -d openform -c 'select * from migrations;'
# expected: one row

# 4. The extensions exist
docker compose exec postgres psql -U openform -d openform \
  -c "select extname from pg_extension where extname in ('pgcrypto','citext');"
# expected: two rows

# 5. Revert works
pnpm migration:revert && pnpm migration:run

# 6. The app still boots, and no longer creates tables by itself
pnpm start:dev
```

## If you skip this

Doc 12 has nothing to generate migrations with, and with `synchronize` still on, TypeORM silently rewrites your
schema on every boot — including dropping columns when you rename a property. The snake_case strategy in particular
must be in place **before** the first entity migration, or every column name in your initial schema is wrong and
renaming them later means a data migration.

---

Previous: [02 — Config](./02-config.md) · Next: [04 — Logger](./04-logger.md)
