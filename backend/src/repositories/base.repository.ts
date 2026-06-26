import { Prisma } from '@prisma/client';
import { PrismaService } from '../infra';

/**
 * Делегат доступа к данным: либо корневой {@link PrismaService}, либо клиент
 * интерактивной транзакции Prisma. Позволяет одним и тем же методам репозитория
 * работать как вне, так и внутри транзакции.
 */
export type PrismaClientLike = PrismaService | Prisma.TransactionClient;

/**
 * Базовый класс репозиториев-обёрток над Prisma.
 *
 * Репозитории являются тонкой абстракцией над Prisma Client: они инкапсулируют
 * типовые запросы доменных сущностей и переиспользуются прикладными модулями
 * (Auth, Users, Tasks, Chat и др.). Каждый метод принимает необязательный
 * {@link Prisma.TransactionClient}, что позволяет включать операции репозитория
 * в общую транзакцию (например, для инварианта «ровно один администратор»,
 * Req 2.2, или переназначения осиротевших задач, Req 8.5).
 */
export abstract class BaseRepository {
  protected constructor(protected readonly prisma: PrismaService) {}

  /**
   * Возвращает активного делегата доступа к данным: переданный транзакционный
   * клиент при его наличии, иначе — корневой {@link PrismaService}.
   */
  protected client(tx?: Prisma.TransactionClient): PrismaClientLike {
    return tx ?? this.prisma;
  }

  /**
   * Выполняет переданную функцию в рамках интерактивной транзакции Prisma.
   * Тонкий проброс к {@link PrismaService.runInTransaction} для удобства вызова
   * через репозиторий.
   */
  runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.runInTransaction(fn);
  }
}
