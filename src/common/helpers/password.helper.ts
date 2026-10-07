import * as argon2 from 'argon2';

export interface PasswordHashOptions {
  memoryCost?: number;
  timeCost?: number;
  parallelism?: number;
}

export class PasswordHelper {
  static hashPassword(
    password: string,
    options: PasswordHashOptions = {},
  ): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: options.memoryCost ?? 19456,
      timeCost: options.timeCost ?? 2,
      parallelism: options.parallelism ?? 1,
    });
  }

  static async comparePassword(
    password: string,
    hash: string,
  ): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
