# 01 — Module layout cleanup

## Why

The modules in `src/modules/` were scaffolded for an earlier, business-scoped version of the product. PRD v4.0 §2
explicitly defers businesses, tenants, API keys and templates, and §13 names the module set:

> NestJS modules: Auth, Users, Forms, Submissions, Mail and Health. Common utilities cover exception handling,
> pagination and authentication decorators.

Three existing modules model deferred features, one is misnamed, and two required ones do not exist. Fixing this now
means no later document has to work around a directory that should not be there.

## What is wrong today

| Module | PRD status | Action |
|---|---|---|
| `tenant/` | §1: "There are no businesses, tenants…" | Delete |
| `api-keys/` | §2 Deferred: "API keys" | Delete |
| `templates/` | Not in scope anywhere in v4.0 | Delete |
| `responses/` | §10: "Use Submission as the backend entity name" | Rename to `submissions/` |
| `auth/` | §13 required | Keep, rebuild in doc 13 |
| `forms/` | §13 required | Keep, rebuild in doc 15 |
| `users/` | §13 required — but has no controller, DTOs or entity | Keep, complete in doc 14 |
| `mail/` | §13 required | Create |
| `health/` | §12 required | Create |

Also note: every `entities/*.entity.ts` file is an empty, undecorated class — `export class Form {}` with no
`@Entity()` and no columns. `autoLoadEntities: true` therefore finds nothing, and `synchronize` creates zero tables.
The database looks wired but is empty. Doc 12 writes the real entities.

## 1. Delete the deferred modules

```bash
git rm -r --cached src/modules/tenant src/modules/templates src/modules/api-keys 2>/dev/null
rm -rf src/modules/tenant src/modules/templates src/modules/api-keys
```

They are in git history if you want them back.

## 2. Rename `responses` → `submissions`

PRD §10 is explicit that these are the same data, not two tables:

> Use Submission as the backend entity name; UI may say Responses. These are the same data, not separate
> submission/response tables.

```bash
git mv src/modules/responses src/modules/submissions 2>/dev/null || mv src/modules/responses src/modules/submissions

cd src/modules/submissions
mv responses.controller.ts      submissions.controller.ts
mv responses.controller.spec.ts submissions.controller.spec.ts
mv responses.service.ts         submissions.service.ts
mv responses.service.spec.ts    submissions.service.spec.ts
mv responses.module.ts          submissions.module.ts
mv dto/create-response.dto.ts   dto/create-submission.dto.ts
mv dto/update-response.dto.ts   dto/update-submission.dto.ts
mv entities/response.entity.ts  entities/submission.entity.ts
cd -
```

Then fix the identifiers inside. On macOS, `sed -i ''` needs the empty argument:

```bash
grep -rl 'Response\|response' src/modules/submissions \
  | xargs sed -i '' \
      -e 's/Responses/Submissions/g' \
      -e 's/Response/Submission/g' \
      -e 's/responses/submissions/g' \
      -e 's/response/submission/g'
```

Everything in these files is placeholder scaffolding, so a blanket replace is safe here. It will not be safe later —
do not reuse this command once real code exists.

## 3. Create the missing module directories

```bash
mkdir -p src/modules/mail src/modules/health
mkdir -p src/common/{decorators,dto,filters,interceptors,logger,middleware,guards}
mkdir -p src/config
mkdir -p src/database/migrations
```

Placeholder modules so `app.module.ts` compiles — both get real contents in later documents:

```ts
// src/modules/health/health.module.ts
import { Module } from '@nestjs/common';

@Module({})
export class HealthModule {}
```

```ts
// src/modules/mail/mail.module.ts
import { Module } from '@nestjs/common';

@Module({})
export class MailModule {}
```

## 4. Update `app.module.ts`

Replace the imports and the `imports` array. Everything else in the file stays for now — doc 02 extracts the Joi
schema.

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { FormsModule } from './modules/forms/forms.module';
import { SubmissionsModule } from './modules/submissions/submissions.module';
import { MailModule } from './modules/mail/mail.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('development'),
        DB_HOST: Joi.string().required(),
        DB_PORT: Joi.number().port().default(5432),
        DB_USERNAME: Joi.string().required(),
        DB_PASSWORD: Joi.string().required(),
        DB_NAME: Joi.string().required(),
      }),
    }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    FormsModule,
    SubmissionsModule,
    MailModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

## 5. Remove the starter controller

`app.controller.ts` serves "Hello World!" at `/`. It is not in the API catalogue. Doc 08's health routes replace its
purpose.

```bash
rm src/app.controller.ts src/app.controller.spec.ts src/app.service.ts
```

Then drop `AppController`/`AppService` from the imports, `controllers` and `providers` of `app.module.ts`, leaving:

```ts
  controllers: [],
  providers: [],
```

## Target tree

After this document:

```
src/
├── main.ts
├── app.module.ts
├── common/
│   ├── decorators/
│   ├── dto/
│   ├── filters/
│   ├── guards/
│   ├── interceptors/
│   ├── logger/
│   └── middleware/
├── config/
├── database/
│   ├── database.module.ts
│   └── migrations/
└── modules/
    ├── auth/
    ├── users/
    ├── forms/
    ├── submissions/
    ├── mail/
    └── health/
```

## Verify

```bash
# 1. The deferred modules are gone and the new ones exist
ls src/modules
# expected exactly: auth forms health mail submissions users

# 2. No stale identifier survived the rename
grep -ri 'tenant\|api-key\|apikey\|template' src/ --include='*.ts'
# expected: no output

grep -ri 'response' src/modules/submissions
# expected: no output

# 3. It compiles and boots
pnpm build && pnpm start:dev
# expected: starts clean; mapped routes are the scaffolded /auth, /forms, /submissions, /users
```

## If you skip this

Doc 12 generates the first migration from the entity set. Leaving `tenant`, `template` and `api_key` entities in place
means they land in your initial schema and every subsequent migration diff, and `responses` vs `submissions` naming
drift makes the §10 table names wrong from the first migration onward — which is painful to undo once data exists.

---

Previous: [00 — Prerequisites](./00-prerequisites.md) · Next: [02 — Config & env validation](./02-config.md)
