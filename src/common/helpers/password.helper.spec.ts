import { PasswordHelper } from './password.helper';

describe('PasswordHelper', () => {
  it('creates a verifiable Argon2id hash', async () => {
    const password = 'correct-horse-battery';
    const hash = await PasswordHelper.hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toBe(password);
    await expect(PasswordHelper.comparePassword(password, hash)).resolves.toBe(
      true,
    );
    await expect(
      PasswordHelper.comparePassword('wrong-password', hash),
    ).resolves.toBe(false);
    await expect(
      PasswordHelper.comparePassword(password, 'invalid-hash'),
    ).resolves.toBe(false);
  });
});
