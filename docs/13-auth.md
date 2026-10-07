# 13 — Auth module

## Why

PRD §12 lists ten auth endpoints — the largest single module in the API — and §4 specifies their behaviour in detail.
This is also where the security requirements concentrate: Argon2id hashing, refresh rotation with replay detection,
single-use hashed tokens, generic failure messages, and the rule that a Google login must never silently merge into an
existing password account.

## The endpoints (PRD §12)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | public | Create account |
| POST | `/auth/login` | public | Email/password login |
| GET | `/auth/google` | public | Start OAuth |
| GET | `/auth/google/callback` | public | Complete OAuth |
| POST | `/auth/refresh` | refresh cookie | Rotate refresh token |
| POST | `/auth/logout` | refresh cookie | Revoke session |
| POST | `/auth/verify-email` | public | Consume verification token |
| POST | `/auth/resend-verification` | access token | Resend verification |
| POST | `/auth/forgot-password` | public | Request reset |
| POST | `/auth/reset-password` | public | Consume reset token |

## 1. Hashing

Two different algorithms for two different jobs:

```ts
// src/modules/auth/crypto.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { authConfig } from '../../config/configuration';

@Injectable()
export class CryptoService {
  constructor(
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  /** PRD §4: "Hash passwords with Argon2id and configure cost for deployment capacity." */
  hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: this.config.argon2.memoryCost,
      timeCost: this.config.argon2.timeCost,
      parallelism: this.config.argon2.parallelism,
    });
  }

  async verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed hash must read as "wrong password", not as a 500.
      return false;
    }
  }

  /**
   * A random token for email delivery, plus its hash for storage.
   * PRD §4: "Verification tokens are random, single-use and expire."
   *
   * SHA-256, not Argon2, is correct here: these tokens are 256 bits of
   * entropy, so there is nothing to brute-force, and verification happens
   * on an indexed lookup that must be fast.
   */
  generateToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashToken(token) };
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Constant-time comparison, for the rare non-indexed check. */
  safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }

  /** PRD §7: "globally unique opaque public slug" — used by doc 15. */
  generateSlug(): string {
    return randomBytes(12).toString('base64url');
  }
}
```

## 2. DTOs

```ts
// src/modules/auth/dto/register.dto.ts
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class RegisterDto {
  /** PRD §4: 2–100 characters. */
  @IsString()
  @Length(2, 100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  /**
   * PRD §4: "email normalized by trim/lowercase". The transform runs
   * before validation, so what is validated is what gets stored.
   */
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(320)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;

  /**
   * PRD §4: 12–128 characters. The upper bound is not cosmetic — Argon2
   * on an unbounded input is a denial-of-service vector.
   */
  @IsString()
  @Length(12, 128, { message: 'Password must be 12–128 characters' })
  password: string;
}
```

```ts
// src/modules/auth/dto/login.dto.ts
export class LoginDto {
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email: string;

  @IsString()
  @Length(1, 128)
  password: string;
}

// src/modules/auth/dto/verify-email.dto.ts
export class VerifyEmailDto {
  @IsString()
  @Length(10, 200)
  token: string;
}

// src/modules/auth/dto/forgot-password.dto.ts
export class ForgotPasswordDto {
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email: string;
}

// src/modules/auth/dto/reset-password.dto.ts
export class ResetPasswordDto {
  @IsString()
  @Length(10, 200)
  token: string;

  @IsString()
  @Length(12, 128)
  password: string;
}
```

## 3. Registration

PRD §4 packs four requirements into one flow:

> Create user and hashed verification-token record in a transaction. Send verification email after commit. Email
> failure preserves the account and exposes a resend option.

```ts
// src/modules/auth/auth.service.ts (registration)
async register(dto: RegisterDto, userAgent?: string): Promise<AuthResult> {
  const { user, verificationToken } = await this.dataSource.transaction(
    async (manager) => {
      const existing = await manager.findOne(User, {
        where: { normalizedEmail: dto.email },
      });

      // PRD §4 does not require a generic response here — a registration
      // form must tell the user their email is taken or it is unusable.
      // The account-enumeration protection lives on LOGIN and FORGOT
      // PASSWORD, which is where it matters.
      if (existing) {
        throw new DomainException(
          ErrorCode.ACCOUNT_EXISTS,
          HttpStatus.CONFLICT,
          'An account with that email already exists.',
        );
      }

      const user = manager.create(User, {
        name: dto.name,
        email: dto.email,
        normalizedEmail: dto.email,
        passwordHash: await this.crypto.hashPassword(dto.password),
        emailVerifiedAt: null,
        status: UserStatus.ACTIVE,
      });
      await manager.save(user);

      // Same transaction as the user (PRD §4).
      const { token, hash } = this.crypto.generateToken();
      await manager.save(
        manager.create(AuthToken, {
          userId: user.id,
          purpose: AuthTokenPurpose.EMAIL_VERIFICATION,
          tokenHash: hash,
          expiresAt: this.hoursFromNow(this.config.verificationTtlHours),
        }),
      );

      return { user, verificationToken: token };
    },
  );

  // PRD §4: "Send verification email after commit." Sending inside the
  // transaction risks an email for a user that then rolls back.
  // "Email failure preserves the account and exposes a resend option" —
  // so this is logged, never rethrown.
  try {
    await this.mail.sendVerificationEmail(user, verificationToken);
  } catch (error) {
    this.logger.error(
      { event: 'mail.verification.failed', userId: user.id },
      error instanceof Error ? error.stack : String(error),
    );
  }

  // PRD §4: "Unverified users can sign in, inspect their account, resend
  // verification and log out." So issue tokens now.
  return this.issueSession(user, userAgent);
}
```

## 4. Login

```ts
async login(dto: LoginDto, userAgent?: string): Promise<AuthResult> {
  // passwordHash is select:false (doc 12), so it must be requested.
  const user = await this.users
    .createQueryBuilder('user')
    .addSelect('user.passwordHash')
    .where('user.normalized_email = :email', { email: dto.email })
    .getOne();

  // PRD §4: "Login failures use a generic message." Identical error for
  // an unknown email, a wrong password and a Google-only account —
  // anything else is an account-enumeration oracle.
  if (!user?.passwordHash) {
    // Hash a dummy value anyway, so an unknown email does not return
    // measurably faster than a wrong password.
    await this.crypto.hashPassword(dto.password);
    throw new InvalidCredentialsError();
  }

  if (!(await this.crypto.verifyPassword(user.passwordHash, dto.password))) {
    throw new InvalidCredentialsError();
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw new InvalidCredentialsError();
  }

  return this.issueSession(user, userAgent);
}
```

The dummy hash matters. Without it, an unknown email returns in ~1 ms and a wrong password in ~50 ms, and the generic
message is defeated by a stopwatch.

## 5. Sessions: issue, rotate, detect replay

PRD §4:

> Access JWT: 15 minutes, with user ID and session ID. Refresh session: 30 days; hash stored in database. Rotate
> refresh token on use and detect replay.

```ts
private async issueSession(
  user: User,
  userAgent?: string,
  familyId?: string,
): Promise<AuthResult> {
  const { token: refreshToken, hash } = this.crypto.generateToken();

  const session = await this.sessions.save(
    this.sessions.create({
      userId: user.id,
      refreshTokenHash: hash,
      // A new login starts a family; a rotation continues one.
      familyId: familyId ?? randomUUID(),
      expiresAt: this.daysFromNow(this.config.refreshTtlDays),
      userAgent: userAgent?.slice(0, 255) ?? null,
    }),
  );

  // PRD §4: the access token carries user ID and session ID, so a
  // revoked session invalidates it before its 15 minutes elapse.
  const accessToken = await this.jwt.signAsync(
    { sub: user.id, sid: session.id, ev: user.isEmailVerified },
    { secret: this.config.accessSecret, expiresIn: this.config.accessTtl },
  );

  return { user, accessToken, refreshToken };
}

/** PRD §4: rotate on use, detect replay. */
async refresh(presentedToken: string, userAgent?: string): Promise<AuthResult> {
  const hash = this.crypto.hashToken(presentedToken);

  return this.dataSource.transaction(async (manager) => {
    const session = await manager
      .createQueryBuilder(Session, 'session')
      .addSelect('session.refreshTokenHash')
      .where('session.refresh_token_hash = :hash', { hash })
      // Lock the row: two concurrent refreshes must not both rotate.
      .setLock('pessimistic_write')
      .getOne();

    if (!session) throw new DomainException(
      ErrorCode.TOKEN_INVALID, HttpStatus.UNAUTHORIZED, 'Invalid session.',
    );

    // REPLAY DETECTION (PRD §4). This hash belongs to a session that was
    // already rotated, so two parties hold tokens from one family. We
    // cannot tell which is the attacker, so revoke the entire family and
    // force a fresh login.
    if (session.rotatedAt !== null) {
      await manager.update(
        Session,
        { familyId: session.familyId, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
      this.logger.warn({
        event: 'session.replay_detected',
        userId: session.userId,
        familyId: session.familyId,
      });
      throw new DomainException(
        ErrorCode.TOKEN_INVALID,
        HttpStatus.UNAUTHORIZED,
        'Session expired. Please sign in again.',
      );
    }

    if (!session.isActive) {
      throw new DomainException(
        ErrorCode.TOKEN_EXPIRED, HttpStatus.UNAUTHORIZED, 'Session expired.',
      );
    }

    // PRD §4: "Validate user/session active state on authenticated requests."
    const user = await manager.findOneOrFail(User, {
      where: { id: session.userId, status: UserStatus.ACTIVE },
    });

    await manager.update(Session, session.id, {
      rotatedAt: new Date(),
      revokedAt: new Date(),
      rotationCount: session.rotationCount + 1,
    });

    // Same family, so a replay of any ancestor still trips the check above.
    return this.issueSession(user, userAgent, session.familyId);
  });
}
```

The family concept is what makes replay detection work. Rotation alone means a stolen token becomes useless after the
victim's next refresh — but until then the attacker has a valid session, and neither party is alerted. Family
revocation turns a theft into an immediate forced re-login for both.

## 6. Cookies

```ts
// src/modules/auth/cookie.helper.ts
import { Response } from 'express';
import { ConfigType } from '@nestjs/config';
import { authConfig } from '../../config/configuration';

export const REFRESH_COOKIE = 'refresh_token';

/** PRD §4: "Secure, HttpOnly refresh cookie in production." */
export const setRefreshCookie = (
  res: Response,
  token: string,
  config: ConfigType<typeof authConfig>,
): void => {
  res.cookie(REFRESH_COOKIE, token, {
    // Unreadable from JavaScript, so XSS cannot exfiltrate it.
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    domain: config.cookie.domain,
    // Sent only to the two routes that consume it, never to /forms.
    path: '/api/v1/auth',
    maxAge: config.refreshTtlDays * 24 * 60 * 60 * 1000,
  });
};

export const clearRefreshCookie = (
  res: Response,
  config: ConfigType<typeof authConfig>,
): void => {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    domain: config.cookie.domain,
    path: '/api/v1/auth',
  });
};
```

The narrow `path` is deliberate: the cookie is not attached to the 23 endpoints that have no business seeing it.

PRD §4 also requires Origin validation on cookie-authenticated routes:

```ts
// src/modules/auth/guards/origin.guard.ts
/**
 * PRD §4: "Protect cookie refresh/logout with Origin validation and CSRF
 * controls matching the deployment."
 *
 * /auth/refresh and /auth/logout authenticate by cookie, so a cross-site
 * POST would carry credentials. SameSite=Lax blocks most of it; this is
 * the explicit check.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const allowed = this.config.get<string>('FRONTEND_URL')!;
    const origin = req.header('origin');

    // A same-origin request from a non-browser client has no Origin header.
    if (!origin) return true;

    if (origin !== allowed) {
      throw new DomainException(
        ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Invalid origin.',
      );
    }
    return true;
  }
}
```

## 7. Strategies and guards

```ts
// src/modules/auth/strategies/jwt.strategy.ts
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @Inject(authConfig.KEY) config: ConfigType<typeof authConfig>,
    private readonly users: UsersService,
    private readonly sessions: Repository<Session>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.accessSecret,
    });
  }

  /**
   * PRD §4: "Validate user/session active state on authenticated requests."
   * A valid signature is not enough — the session may have been revoked by
   * a logout, a password reset or replay detection since it was issued.
   */
  async validate(payload: { sub: string; sid: string }): Promise<AuthUser> {
    const session = await this.sessions.findOne({
      where: { id: payload.sid, revokedAt: IsNull() },
    });
    if (!session || !session.isActive) throw new UnauthorizedException();

    const user = await this.users.findActiveById(payload.sub);
    if (!user) throw new UnauthorizedException();

    // Makes the user ID available to the logger (doc 05).
    setContextUserId(user.id);

    return {
      id: user.id,
      email: user.email,
      sessionId: session.id,
      emailVerified: user.isEmailVerified,
    };
  }
}
```

PRD §13 specifies the guard order:

> Suggested guard flow: JWT/session validation → verified-email check → ownership-scoped service.

```ts
// src/modules/auth/guards/jwt-auth.guard.ts
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // PRD §13: "Public marker exempts authentication only, not validation
    // or abuse controls."
    return isPublic ? true : super.canActivate(context);
  }
}
```

```ts
// src/modules/auth/guards/verified-email.guard.ts
/**
 * PRD §4: "Unverified users can sign in, inspect their account, resend
 * verification and log out. Form/response management requires verified
 * email."
 *
 * So this guard goes on FormsController and SubmissionsController — not
 * on UsersController or AuthController.
 */
@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) throw new UnauthorizedException();
    // 403, distinct from 401 — the client must show "verify your email",
    // not a login screen (PRD §12).
    if (!user.emailVerified) throw new EmailNotVerifiedError();
    return true;
  }
}
```

Register `JwtAuthGuard` globally so authentication is opt-out, not opt-in:

```ts
// app.module.ts
{ provide: APP_GUARD, useClass: JwtAuthGuard },
```

A forgotten `@UseGuards` then leaves a route *protected*, which is the right failure direction. Every public route —
including the two health routes — must now carry `@Public()`.

## 8. Google OAuth

PRD §4 has two hard rules here:

> If the Google email matches an existing password account without a linked identity, ask the user to use their
> existing sign-in method. Do not silently merge accounts by email.

> Do not place access/refresh tokens in redirect URLs.

```ts
async handleGoogleCallback(profile: GoogleProfile): Promise<AuthResult> {
  // PRD §4: "Resolve an identity using provider subject" — never by email.
  const identity = await this.identities.findOne({
    where: { provider: AuthProvider.GOOGLE, providerSubject: profile.id },
    relations: ['user'],
  });

  if (identity) return this.issueSession(identity.user);

  const email = profile.email.trim().toLowerCase();
  const existing = await this.users.findOne({ where: { normalizedEmail: email } });

  if (existing) {
    // PRD §4: "Do not silently merge accounts by email." A Google account
    // asserting an address is not proof of control of the password account
    // that uses it. Explicit linking is deferred (§4).
    throw new DomainException(
      ErrorCode.ACCOUNT_EXISTS,
      HttpStatus.CONFLICT,
      'An account with this email already exists. Sign in with your password instead.',
    );
  }

  return this.dataSource.transaction(async (manager) => {
    const user = await manager.save(
      manager.create(User, {
        name: profile.displayName.slice(0, 100),
        email: profile.email,
        normalizedEmail: email,
        passwordHash: null,
        // PRD §4: "A provider-verified email may verify a newly created
        // account." Only when Google asserts email_verified.
        emailVerifiedAt: profile.emailVerified ? new Date() : null,
        status: UserStatus.ACTIVE,
      }),
    );

    await manager.save(
      manager.create(AuthIdentity, {
        userId: user.id,
        provider: AuthProvider.GOOGLE,
        providerSubject: profile.id,
      }),
    );

    return this.issueSession(user);
  });
}
```

The callback must not put tokens in the URL — they land in browser history, `Referer` headers and server logs:

```ts
@Public()
@Get('google/callback')
@UseGuards(AuthGuard('google'))
async googleCallback(@Req() req: Request, @Res() res: Response) {
  const result = await this.auth.handleGoogleCallback(req.user as GoogleProfile);

  // PRD §4: "Complete login through secure cookies or a short-lived
  // single-use exchange code and restrict redirect destinations."
  setRefreshCookie(res, result.refreshToken, this.config);

  // PRD §4: "After Google login, go directly to My Forms." A fixed
  // destination from config — never a redirect target from the request,
  // which would be an open redirect.
  return res.redirect(`${this.config.frontendUrl}/forms`);
}
```

Passport's Google strategy handles the `state` parameter when `state: true` is set, which satisfies §4's
"validated browser-bound state". Register the strategy conditionally so the app boots without Google configured:

```ts
// auth.module.ts
providers: [
  ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? [GoogleStrategy]
    : []),
],
```

## 9. Verification, reset and logout

```ts
/** PRD §4: single-use, expiring, hashed. */
async verifyEmail(token: string): Promise<void> {
  const hash = this.crypto.hashToken(token);

  await this.dataSource.transaction(async (manager) => {
    const record = await manager
      .createQueryBuilder(AuthToken, 'token')
      .addSelect('token.tokenHash')
      .where('token.token_hash = :hash', { hash })
      .andWhere('token.purpose = :purpose', {
        purpose: AuthTokenPurpose.EMAIL_VERIFICATION,
      })
      .setLock('pessimistic_write')
      .getOne();

    // Consumed, expired and unknown all give the same error: a specific
    // one would confirm a token existed.
    if (!record || record.consumedAt || record.expiresAt <= new Date()) {
      throw new DomainException(
        ErrorCode.TOKEN_INVALID,
        HttpStatus.BAD_REQUEST,
        'This verification link is invalid or has expired.',
      );
    }

    // Single-use (PRD §4). Inside the lock, so two concurrent clicks
    // cannot both succeed.
    await manager.update(AuthToken, record.id, { consumedAt: new Date() });
    await manager.update(User, record.userId, { emailVerifiedAt: new Date() });
  });
}

/** PRD §4: "Password-reset requests respond neutrally." */
async forgotPassword(email: string): Promise<void> {
  const user = await this.users.findOne({ where: { normalizedEmail: email } });

  // Send only for a password account that exists — but return void either
  // way, so the controller's response cannot distinguish the cases.
  if (user?.passwordHash) {
    const { token, hash } = this.crypto.generateToken();
    await this.authTokens.save({
      userId: user.id,
      purpose: AuthTokenPurpose.PASSWORD_RESET,
      tokenHash: hash,
      expiresAt: this.minutesFromNow(this.config.passwordResetTtlMinutes),
    });
    try {
      await this.mail.sendPasswordResetEmail(user, token);
    } catch (error) {
      this.logger.error({ event: 'mail.reset.failed', userId: user.id });
    }
  }
}

async resetPassword(dto: ResetPasswordDto): Promise<void> {
  const hash = this.crypto.hashToken(dto.token);

  await this.dataSource.transaction(async (manager) => {
    const record = await manager /* …same single-use lookup as above… */;

    const user = await manager.findOneOrFail(User, { where: { id: record.userId } });

    // PRD §4: "Google-only accounts do not gain a password through the
    // reset endpoint." Otherwise anyone able to receive mail at that
    // address could add a password to an OAuth account.
    if (user.passwordHash === null) {
      throw new DomainException(
        ErrorCode.TOKEN_INVALID, HttpStatus.BAD_REQUEST,
        'This account signs in with Google.',
      );
    }

    await manager.update(AuthToken, record.id, { consumedAt: new Date() });
    await manager.update(User, user.id, {
      passwordHash: await this.crypto.hashPassword(dto.password),
    });

    // PRD §4: "Successful password reset revokes existing sessions."
    await manager.update(
      Session,
      { userId: user.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  });
}

/** PRD §4: "Logout revokes the current session." */
async logout(refreshToken: string): Promise<void> {
  await this.sessions.update(
    { refreshTokenHash: this.crypto.hashToken(refreshToken), revokedAt: IsNull() },
    { revokedAt: new Date() },
  );
  // Silent when the token is unknown — logout is idempotent.
}
```

## 10. Response shape

PRD §11: *"Never return password/token hashes in API serialization."*

```ts
// src/modules/auth/dto/responses/auth-response.dto.ts
export class AuthResponseDto {
  accessToken: string;
  expiresIn: number;
  user: UserResponseDto;

  // The refresh token is NOT here. It goes out as an HttpOnly cookie and
  // must never be readable by JavaScript.
}
```

## Verify

```bash
pnpm start:dev
API=localhost:3000/api/v1

# 1. Register
curl -s -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ADA@Example.com ","password":"correct-horse-battery"}' | jq
# expected: 201 with accessToken and user; NO refreshToken in the body

# 2. The email was normalized (PRD §4)
docker compose exec postgres psql -U openform -d openform \
  -c "select email, normalized_email from users;"
# expected: normalized_email = 'ada@example.com'

# 3. The refresh token came back as an HttpOnly cookie, scoped to /auth
curl -si -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}' | grep -i set-cookie
# expected: refresh_token=…; Path=/api/v1/auth; HttpOnly; SameSite=Lax

# 4. Login failures are generic AND equally slow (PRD §4)
time curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"nobody@example.com","password":"correct-horse-battery"}' | jq -r .message
time curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"wrong-password-here"}' | jq -r .message
# expected: identical message, comparable timing

# 5. No hash ever appears in a response
curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}' \
  | grep -iE 'passwordHash|password_hash|\$argon2|refreshTokenHash'
# expected: no output

# 6. Refresh rotates the token
curl -s -c /tmp/c.txt -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}' > /dev/null
cp /tmp/c.txt /tmp/old.txt
curl -s -b /tmp/c.txt -c /tmp/c.txt -X POST $API/auth/refresh > /dev/null
diff /tmp/old.txt /tmp/c.txt
# expected: the cookie value changed

# 7. REPLAY DETECTION — the critical test (PRD §4)
curl -s -b /tmp/old.txt -X POST $API/auth/refresh | jq
# expected: 401 TOKEN_INVALID
curl -s -b /tmp/c.txt -X POST $API/auth/refresh | jq
# expected: ALSO 401 — the whole family was revoked, not just the old token
docker compose exec postgres psql -U openform -d openform \
  -c "select count(*) from sessions where revoked_at is not null;"
# expected: every session in that family revoked
# and in the log: {"event":"session.replay_detected",…}

# 8. Verification tokens are single-use (PRD §4)
TOKEN=$(docker compose logs api 2>&1 | grep -o 'verify-email?token=[^ "]*' | tail -1 | cut -d= -f2)
curl -s -X POST $API/auth/verify-email -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\"}" | jq   # expected: success
curl -s -X POST $API/auth/verify-email -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\"}" | jq   # expected: 400 TOKEN_INVALID

# 9. Forgot-password responds neutrally (PRD §4)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/auth/forgot-password \
  -H 'content-type: application/json' -d '{"email":"ada@example.com"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/auth/forgot-password \
  -H 'content-type: application/json' -d '{"email":"nobody@example.com"}'
# expected: the same status and body for both

# 10. Reset revokes all sessions (PRD §4)
# …consume a reset token, then:
curl -s -b /tmp/c.txt -X POST $API/auth/refresh | jq
# expected: 401

# 11. Google does not silently merge (PRD §4)
# Sign in with Google using ada@example.com:
# expected: 409 ACCOUNT_EXISTS, "Sign in with your password instead."
# and NO new row in users or auth_identities

# 12. Tokens are never logged (PRD §11, §14)
docker compose logs api 2>&1 | grep -iE 'password|refresh_token|Bearer |argon2'
# expected: no secret values — only redacted markers
```

Steps 7 and 11 are the two that distinguish a correct implementation. Rotation without family revocation passes a
casual test and fails §4.

## If you skip this

Every private endpoint in docs 14–17 needs `@CurrentUser()`, which only the JWT strategy populates. There is nothing
to build on.

---

Previous: [12 — Entities](./12-entities.md) · Next: [14 — Users & Mail](./14-users-mail.md)
