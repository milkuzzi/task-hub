import { Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { UserRepository } from './user.repository';

describe('UserRepository.acquirePrimaryAdminCreationLock', () => {
  it('uses a transaction-scoped PostgreSQL advisory lock', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]);
    const repository = new UserRepository({} as PrismaService);

    await repository.acquirePrimaryAdminCreationLock({
      $queryRawUnsafe: queryRawUnsafe,
    } as unknown as Prisma.TransactionClient);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'task-hub:create-primary-admin',
    );
  });
});
