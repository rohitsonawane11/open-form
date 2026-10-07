import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOneBy: jest.Mock;
    softRemove: jest.Mock;
  };

  const publicUser = {
    id: 'user-id',
    firstName: 'Ada',
    lastName: 'Lovelace',
  } as User;

  beforeEach(async () => {
    repository = {
      create: jest.fn((user: User) => user),
      save: jest.fn(),
      find: jest.fn(),
      findOneBy: jest.fn(),
      softRemove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repository },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('creates a user with the provided password and returns the public record', async () => {
    repository.save.mockResolvedValue({ id: publicUser.id });
    repository.findOneBy.mockResolvedValue(publicUser);

    const result = await service.create({
      firstName: 'Ada',
      lastName: 'Lovelace',
      password: 'correct-horse-battery',
    });

    const createdUser = (repository.create.mock.calls as [User][])[0][0];
    expect(createdUser.password).toBe('correct-horse-battery');
    expect(result).toBe(publicUser);
    expect(result.password).toBeUndefined();
  });

  it('creates a user without a password', async () => {
    repository.save.mockResolvedValue({ id: publicUser.id });
    repository.findOneBy.mockResolvedValue(publicUser);

    await service.create({ firstName: 'Ada', lastName: 'Lovelace' });

    expect(repository.create).toHaveBeenCalledWith({
      firstName: 'Ada',
      lastName: 'Lovelace',
      password: null,
    });
  });

  it('lists users', async () => {
    repository.find.mockResolvedValue([publicUser]);

    await expect(service.findAll()).resolves.toEqual([publicUser]);
  });

  it('throws when a user is missing', async () => {
    repository.findOneBy.mockResolvedValue(null);

    await expect(service.findOne('missing-id')).rejects.toThrow(
      'User not found',
    );
  });

  it('updates names and saves a replacement password', async () => {
    repository.findOneBy.mockResolvedValueOnce({ ...publicUser });
    repository.findOneBy.mockResolvedValueOnce({
      ...publicUser,
      firstName: 'Augusta',
    });

    const result = await service.update(publicUser.id, {
      firstName: 'Augusta',
      password: 'new-correct-horse-battery',
    });

    const savedUser = (repository.save.mock.calls as [User][])[0][0];
    expect(savedUser.firstName).toBe('Augusta');
    expect(savedUser.lastName).toBe('Lovelace');
    expect(savedUser.password).toBe('new-correct-horse-battery');
    expect(result.password).toBeUndefined();
  });

  it('soft deletes an existing user', async () => {
    repository.findOneBy.mockResolvedValue(publicUser);

    await service.remove(publicUser.id);

    expect(repository.softRemove).toHaveBeenCalledWith(publicUser);
  });
});
