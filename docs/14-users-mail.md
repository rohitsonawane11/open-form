# 14 — Users & Mail modules

## Why

Two small modules that doc 13 already depends on.

**Users** — PRD §12 lists two endpoints, and §5 scopes them tightly:

> Profile supports current account retrieval and display-name update. Email changes and account deletion are deferred
> to avoid expanding identity workflows.

The `users` module currently has a service with no body, and no controller, DTOs or entity registration.

**Mail** — PRD §13 names it as a required module. §4 constrains it in a way that shapes the design:

> Email failure preserves the account and exposes a resend option.

So mail delivery must never be on the critical path of a transaction, and local development must not require a
reachable SMTP server.

## Part 1 — Users

### The entity-to-DTO boundary

PRD §11: *"API response DTOs omit all secrets."* The `User` entity has `passwordHash`. It must never be returned,
and the cleanest guarantee is that the controller's return type simply cannot express it.

```ts
// src/modules/users/dto/responses/user-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../entities/user.entity';

/**
 * The public shape of an account.
 *
 * PRD §11: "Never return password/token hashes in API serialization" and
 * "API response DTOs omit all secrets." This class is the enforcement
 * point — a controller returning a User entity would serialize
 * password_hash, so controllers return this instead.
 */
export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  name: string;

  @ApiProperty({ example: 'ada@example.com' })
  email: string;

  /** PRD §4: drives the "verify your email" prompt in the UI. */
  @ApiProperty({ example: true })
  emailVerified: boolean;

  @ApiProperty()
  createdAt: Date;

  static from(user: User): UserResponseDto {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      createdAt: user.createdAt,
    };
  }
}
```

Note what is absent: `passwordHash`, `normalizedEmail`, `status`, `emailVerifiedAt` as a timestamp. A boolean is all
the client needs; the exact verification time is internal.

### The update DTO

```ts
// src/modules/users/dto/update-user.dto.ts
import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * PRD §11: UpdateUserDto takes `name` — and only `name`.
 *
 * §5 defers email changes and account deletion. With
 * forbidNonWhitelisted: true (doc 07), a request including `email` or
 * `emailVerified` is rejected outright rather than silently ignored.
 */
export class UpdateUserDto {
  /** Display name. PRD §4: 2–100 characters. */
  @IsString()
  @Length(2, 100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;
}
```

### The service

```ts
// src/modules/users/users.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus } from './entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { NotFoundError } from '../../common/errors/domain.exception';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /** Used by the JWT strategy on every authenticated request (doc 13). */
  findActiveById(id: string): Promise<User | null> {
    return this.users.findOne({
      where: { id, status: UserStatus.ACTIVE },
    });
  }

  async findByIdOrFail(id: string): Promise<User> {
    const user = await this.findActiveById(id);
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  /** PRD §5: display-name update only. */
  async updateProfile(id: string, dto: UpdateUserDto): Promise<User> {
    // The user ID comes from the access token, never the request body
    // (PRD §11: "Derive userId from authentication"), so there is no
    // ownership check to make here — the scope IS the authenticated user.
    const result = await this.users.update(
      { id, status: UserStatus.ACTIVE },
      { name: dto.name },
    );
    if (result.affected === 0) throw new NotFoundError('User not found');

    return this.findByIdOrFail(id);
  }
}
```

### The controller

```ts
// src/modules/users/users.controller.ts
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/responses/user-response.dto';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiAuthErrors } from '../../common/decorators/api-standard-responses.decorator';

/**
 * PRD §12 — User: 2 endpoints.
 *
 * Note there is NO VerifiedEmailGuard here. PRD §4: "Unverified users can
 * sign in, INSPECT THEIR ACCOUNT, resend verification and log out."
 * Blocking /users/me behind verification would make the "verify your
 * email" screen unable to show whose email needs verifying.
 */
@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Current profile' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiAuthErrors()
  async me(@CurrentUser() user: AuthUser): Promise<UserResponseDto> {
    return UserResponseDto.from(await this.users.findByIdOrFail(user.id));
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update display name' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiAuthErrors()
  async update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return UserResponseDto.from(await this.users.updateProfile(user.id, dto));
  }
}
```

There is no `:userId` parameter on either route. The only addressable user is the authenticated one, so there is no
ownership check to get wrong.

### The module

```ts
// src/modules/users/users.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService],
  // Doc 13's JwtStrategy and AuthService both need it.
  exports: [UsersService],
})
export class UsersModule {}
```

## Part 2 — Mail

### The transport interface

```ts
// src/modules/mail/mail.types.ts
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}
```

### The console transport

This is the default in development, and it is a correctness feature rather than a convenience. PRD §4 requires that a
failed send still leaves a usable account; the surest way to never accidentally depend on SMTP during development is
to not have SMTP during development.

```ts
// src/modules/mail/transports/console.transport.ts
import { Injectable, Logger } from '@nestjs/common';
import { MailMessage, MailTransport } from '../mail.types';

/**
 * Writes the email to the log instead of sending it.
 *
 * The token link IS printed — it is the only way to complete the
 * verification flow locally, and this transport is never enabled in
 * production (the Joi schema defaults MAIL_TRANSPORT to 'console', and
 * doc 19's deploy config sets it to 'smtp').
 */
@Injectable()
export class ConsoleMailTransport implements MailTransport {
  private readonly logger = new Logger('Mail');

  send(message: MailMessage): Promise<void> {
    this.logger.log(
      [
        '',
        '─── email (not sent) ───────────────────────────────',
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        '',
        message.text,
        '────────────────────────────────────────────────────',
      ].join('\n'),
    );
    return Promise.resolve();
  }
}
```

### The SMTP transport

```ts
// src/modules/mail/transports/smtp.transport.ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { mailConfig } from '../../../config/configuration';
import { MailMessage, MailTransport } from '../mail.types';

@Injectable()
export class SmtpMailTransport implements MailTransport {
  private readonly transporter: nodemailer.Transporter;

  constructor(
    @Inject(mailConfig.KEY) private readonly config: ConfigType<typeof mailConfig>,
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.password }
        : undefined,
      // Bound the wait: a hanging SMTP connection must not hold a request
      // open, even though the caller already ignores the outcome.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
```

### The service

```ts
// src/modules/mail/mail.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { appConfig } from '../../config/configuration';
import { MAIL_TRANSPORT } from './mail.constants';
import { MailTransport } from './mail.types';
import { User } from '../users/entities/user.entity';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(appConfig.KEY) private readonly app: ConfigType<typeof appConfig>,
  ) {}

  async sendVerificationEmail(user: User, token: string): Promise<void> {
    // The link points at the FRONTEND, which then POSTs the token to
    // /auth/verify-email. A link straight to the API would verify the
    // account from an email scanner's prefetch.
    const link = `${this.app.frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;

    await this.transport.send({
      to: user.email,
      subject: 'Verify your OpenForms email address',
      text: [
        `Hi ${user.name},`,
        '',
        'Confirm your email address to start building forms:',
        link,
        '',
        'This link expires in 24 hours and can be used once.',
        "If you didn't create an account, you can ignore this email.",
      ].join('\n'),
      html: this.wrap(
        `<p>Hi ${escapeHtml(user.name)},</p>
         <p>Confirm your email address to start building forms.</p>
         <p><a href="${link}">Verify email address</a></p>
         <p>This link expires in 24 hours and can be used once.</p>`,
      ),
    });

    // Log that it was sent — never the token (PRD §11).
    this.logger.log({ event: 'mail.verification.sent', userId: user.id });
  }

  async sendPasswordResetEmail(user: User, token: string): Promise<void> {
    const link = `${this.app.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;

    await this.transport.send({
      to: user.email,
      subject: 'Reset your OpenForms password',
      text: [
        `Hi ${user.name},`,
        '',
        'Use this link to choose a new password:',
        link,
        '',
        'This link expires in 30 minutes and can be used once.',
        "If you didn't request this, no action is needed — your password is unchanged.",
      ].join('\n'),
      html: this.wrap(
        `<p>Hi ${escapeHtml(user.name)},</p>
         <p>Use this link to choose a new password.</p>
         <p><a href="${link}">Reset password</a></p>
         <p>This link expires in 30 minutes and can be used once.</p>`,
      ),
    });

    this.logger.log({ event: 'mail.reset.sent', userId: user.id });
  }

  private wrap(body: string): string {
    return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">
      ${body}
      <hr><p style="color:#666;font-size:12px">OpenForms</p>
    </body></html>`;
  }
}

/** The user's name is user-supplied and goes into HTML. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
```

`escapeHtml` is not optional. `name` is accepted from registration with only a length check, so it reaches the email
body as raw user input — PRD §14: *"Render labels/descriptions as text."* The same rule applies to mail.

### The module

```ts
// src/modules/mail/mail.constants.ts
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
```

```ts
// src/modules/mail/mail.module.ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { MAIL_TRANSPORT } from './mail.constants';
import { ConsoleMailTransport } from './transports/console.transport';
import { SmtpMailTransport } from './transports/smtp.transport';

@Global()
@Module({
  providers: [
    ConsoleMailTransport,
    SmtpMailTransport,
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService, ConsoleMailTransport, SmtpMailTransport],
      useFactory: (
        config: ConfigService,
        console: ConsoleMailTransport,
        smtp: SmtpMailTransport,
      ) =>
        config.get<string>('MAIL_TRANSPORT') === 'smtp' ? smtp : console,
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
```

### Optional: Mailpit for local development

If you prefer a real inbox UI over log output, add to `docker-compose.yml`:

```yaml
  mailpit:
    image: axllent/mailpit:latest
    container_name: openform-mailpit
    restart: unless-stopped
    ports:
      - "8025:8025"   # web UI
      - "1025:1025"   # SMTP
```

Then set `MAIL_TRANSPORT=smtp`, `SMTP_HOST=localhost`, `SMTP_PORT=1025` and open http://localhost:8025. This also
lets you test the HTML rendering, which the console transport cannot.

## Verify

```bash
pnpm start:dev
API=localhost:3000/api/v1
TOKEN=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}' | jq -r .accessToken)

# 1. Profile retrieval
curl -s $API/users/me -H "authorization: Bearer $TOKEN" | jq
# expected: {id, name, email, emailVerified, createdAt}

# 2. NO secret fields leak (PRD §11) — the important assertion
curl -s $API/users/me -H "authorization: Bearer $TOKEN" \
  | jq 'keys'
# expected exactly: ["createdAt","email","emailVerified","id","name"]
# NOT: passwordHash, password_hash, normalizedEmail, status

# 3. Name update works
curl -s -X PATCH $API/users/me -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Ada L"}' | jq -r .name
# expected: "Ada L"

# 4. Deferred fields are REJECTED, not ignored (PRD §5, §11)
curl -s -X PATCH $API/users/me -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"attacker@evil.com"}' | jq
# expected: 422 VALIDATION_FAILED naming the `email` property
docker compose exec postgres psql -U openform -d openform -c "select email from users;"
# expected: unchanged

# 5. Privilege escalation through the body is rejected
curl -s -X PATCH $API/users/me -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","emailVerified":true,"status":"active"}' | jq -r .code
# expected: VALIDATION_FAILED

# 6. An unverified user CAN read their profile (PRD §4)
#    Register a fresh account, do not verify it, then:
curl -s -o /dev/null -w '%{http_code}\n' $API/users/me -H "authorization: Bearer $NEW_TOKEN"
# expected: 200 — NOT 403. Unverified users may inspect their account.

# 7. Unauthenticated access
curl -s -o /dev/null -w '%{http_code}\n' $API/users/me
# expected: 401

# 8. The verification email reaches the log with a usable link
# expected in the server output:
#   ─── email (not sent) ───
#   To: ada@example.com
#   Subject: Verify your OpenForms email address
#   …/verify-email?token=…

# 9. A send failure does NOT lose the account (PRD §4)
MAIL_TRANSPORT=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=9 pnpm start:dev
curl -s -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"name":"Bob","email":"bob@example.com","password":"correct-horse-battery"}' | jq
# expected: 201 with an access token — the registration SUCCEEDS
docker compose exec postgres psql -U openform -d openform \
  -c "select email from users where email='bob@example.com';"
# expected: one row — the account survived
# and in the log: {"event":"mail.verification.failed","userId":"…"}

# 10. HTML escaping in the name
curl -s -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"name":"<img src=x onerror=alert(1)>","email":"x@e.com","password":"correct-horse-battery"}'
# expected in the logged email HTML: &lt;img src=x … — not a live tag
```

Steps 2 and 9 are the ones to run deliberately. Step 2 is the §11 secret-leak check; step 9 is the §4 requirement that
is easy to violate by awaiting the send inside the registration transaction.

## If you skip this

Doc 13's `JwtStrategy` calls `UsersService.findActiveById()` and `AuthService` calls
`MailService.sendVerificationEmail()` — neither exists yet, so auth does not compile. And without the console
transport, no verification token is ever visible locally, which makes the entire verified-email flow untestable.

---

Previous: [13 — Auth](./13-auth.md) · Next: [15 — Forms module](./15-forms.md)
