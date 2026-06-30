import { Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { UserRepository } from './user.repository';

describe('UserRepository.acquirePrimaryAdminCreationLock', () => {
  it('uses a transaction-scoped PostgreSQL advisory lock', async () => {
    const executeRawUnsafe = jest.fn().mockResolvedValue(1);
    const repository = new UserRepository({} as PrismaService);

    await repository.acquirePrimaryAdminCreationLock({
      $executeRawUnsafe: executeRawUnsafe,
    } as unknown as Prisma.TransactionClient);

    expect(executeRawUnsafe).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'task-hub:create-primary-admin',
    );
  });
});
