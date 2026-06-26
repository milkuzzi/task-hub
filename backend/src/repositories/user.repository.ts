import { Injectable } from '@nestjs/common';
import { MaxLink, Prisma, Role, User, UserEmail } from '@prisma/client';
import { PrismaService } from '../infra';
import { Page, PaginationQueryDto, buildPage } from '../common/dto';
import { BaseRepository } from './base.repository';

/**
 * Пользователь вместе с подгруженной привязкой профиля MAX.
 *
 * Используется HTTP-слоем (контроллеры Auth/Users) для формирования
 * представлений `CurrentUser`/`AdminUser`, где требуется признак привязки MAX
 * (`maxLinked`) без дополнительного запроса на каждого пользователя.
 */
export type UserWithMaxLink = User & { maxLink: MaxLink | null };

/**
 * Пользователь вместе с сохранённой историей адресов электронной почты.
 *
 * Используется разделом администрирования для списка удалённых Пользователей
 * (`GET /users/deleted`), где Администратору предлагается выбрать адрес для
 * восстановления (Req 7.1, 7.3).
 */
export type UserWithEmails = User & { emails: UserEmail[] };

/**
 * Репозиторий-обёртка над сущностью {@link User}.
 *
 * Инкапсулирует типовые запросы пользователей, используемые модулями Auth и
 * Users: поиск по идентификатору и адресу электронной почты, подсчёт активных
 * администраторов (для инварианта единственного администратора, Req 2.2),
 * создание/обновление и постраничный список. Все методы поддерживают выполнение
 * внутри транзакции.
 */
@Injectable()
export class UserRepository extends BaseRepository {
  private static readonly PRIMARY_ADMIN_LOCK_KEY = 'task-hub:create-primary-admin';

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** Находит пользователя по идентификатору (включая удалённых). */
  findById(id: string, tx?: Prisma.TransactionClient): Promise<User | null> {
    return this.client(tx).user.findUnique({ where: { id } });
  }

  /** Находит активного (не удалённого) пользователя по идентификатору. */
  findActiveById(id: string, tx?: Prisma.TransactionClient): Promise<User | null> {
    return this.client(tx).user.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * Находит пользователя по идентификатору вместе с привязкой профиля MAX
   * (включая удалённых).
   *
   * Используется HTTP-слоем для формирования представления профиля
   * (`CurrentUser`/`AdminUser`) с признаком `maxLinked` без отдельного запроса
   * привязки.
   */
  findByIdWithMaxLink(id: string, tx?: Prisma.TransactionClient): Promise<UserWithMaxLink | null> {
    return this.client(tx).user.findUnique({ where: { id }, include: { maxLink: true } });
  }

  /**
   * Возвращает активных (не удалённых) пользователей вместе с привязкой профиля
   * MAX, отсортированных по дате создания (новые → старые).
   *
   * Используется разделом администрирования Пользователей (Req 5.1) для вывода
   * списка `AdminUser[]`. Привязка MAX подгружается одним запросом, чтобы
   * избежать N+1 обращений при вычислении признака `maxLinked`.
   */
  listActiveWithMaxLink(tx?: Prisma.TransactionClient): Promise<UserWithMaxLink[]> {
    return this.client(tx).user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { maxLink: true },
    });
  }

  /**
   * Возвращает активных (не удалённых) пользователей по множеству
   * идентификаторов.
   *
   * Используется {@link TasksService.assign} для проверки ролей кандидатов в
   * Исполнители: назначение Менеджера Исполнителем разрешено только
   * Администратору (Req 2.5, 2.6).
   */
  findManyActiveByIds(ids: string[], tx?: Prisma.TransactionClient): Promise<User[]> {
    return this.client(tx).user.findMany({ where: { id: { in: ids }, deletedAt: null } });
  }

  /**
   * Возвращает удалённых (soft-delete) Пользователей вместе с историей адресов
   * электронной почты, отсортированных по моменту удаления (новые → старые).
   *
   * Используется разделом администрирования (`GET /users/deleted`) для выбора
   * адреса при восстановлении (Req 7.1, 7.3). Hard-удалённые Пользователи в
   * выборку не попадают — их запись отсутствует в БД (Req 8.3).
   */
  listDeletedWithEmails(tx?: Prisma.TransactionClient): Promise<UserWithEmails[]> {
    return this.client(tx).user.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      include: { emails: { orderBy: { usedFrom: 'desc' } } },
    });
  }

  /** Находит пользователя по адресу электронной почты. */
  findByEmail(email: string, tx?: Prisma.TransactionClient): Promise<User | null> {
    return this.client(tx).user.findUnique({ where: { email } });
  }

  /** Находит активного пользователя по адресу электронной почты. */
  findActiveByEmail(email: string, tx?: Prisma.TransactionClient): Promise<User | null> {
    return this.client(tx).user.findFirst({ where: { email, deletedAt: null } });
  }

  /**
   * Подсчитывает число активных администраторов.
   * Используется для проверки инварианта «ровно один администратор» (Req 2.2,
   * 2.11, 3.3, 8.8) — как правило, внутри транзакции.
   */
  countActiveAdmins(tx?: Prisma.TransactionClient): Promise<number> {
    return this.client(tx).user.count({
      where: { role: Role.ADMIN, deletedAt: null },
    });
  }

  /**
   * Сериализует конкурирующие операции bootstrap в пределах транзакции
   * PostgreSQL. Блокировка освобождается автоматически при commit/rollback.
   */
  async acquirePrimaryAdminCreationLock(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      UserRepository.PRIMARY_ADMIN_LOCK_KEY,
    );
  }

  /** Создаёт пользователя. */
  create(data: Prisma.UserCreateInput, tx?: Prisma.TransactionClient): Promise<User> {
    return this.client(tx).user.create({ data });
  }

  /** Обновляет пользователя по идентификатору. */
  update(id: string, data: Prisma.UserUpdateInput, tx?: Prisma.TransactionClient): Promise<User> {
    return this.client(tx).user.update({ where: { id }, data });
  }

  /** Удаляет запись пользователя (hard-delete) (Req 8.3). */
  delete(id: string, tx?: Prisma.TransactionClient): Promise<User> {
    return this.client(tx).user.delete({ where: { id } });
  }

  // =========================================================================
  // История адресов электронной почты (Req 7.1)
  // =========================================================================

  /**
   * Добавляет адрес электронной почты в историю пользователя без потери
   * прежних адресов (Req 7.1).
   *
   * Использует идемпотентный upsert по уникальному ключу `[userId, email]`:
   * повторное добавление уже сохранённого адреса не создаёт дубликат и не
   * удаляет существующие записи. История адресов только растёт — прежние
   * адреса никогда не удаляются (свойство 18).
   *
   * @param userId Идентификатор пользователя-владельца истории.
   * @param email Адрес электронной почты для сохранения в истории.
   */
  addEmailToHistory(
    userId: string,
    email: string,
    tx?: Prisma.TransactionClient,
  ): Promise<UserEmail> {
    return this.client(tx).userEmail.upsert({
      where: { userId_email: { userId, email } },
      create: { userId, email },
      update: {},
    });
  }

  /** Подсчитывает число сохранённых адресов электронной почты пользователя (Req 7.1). */
  countEmails(userId: string, tx?: Prisma.TransactionClient): Promise<number> {
    return this.client(tx).userEmail.count({ where: { userId } });
  }

  /**
   * Возвращает сохранённые адреса электронной почты пользователя, новые → старые
   * (Req 7.3).
   *
   * Используется при восстановлении удалённого пользователя для выбора
   * Администратором адреса из истории (Req 7.2, 7.3). Если история пуста,
   * восстановление по адресу невозможно (Req 7.6).
   */
  listEmails(userId: string, tx?: Prisma.TransactionClient): Promise<UserEmail[]> {
    return this.client(tx).userEmail.findMany({
      where: { userId },
      orderBy: { usedFrom: 'desc' },
    });
  }

  // =========================================================================
  // Привязка профиля MAX (Req 6.6, 16.1, 16.2)
  // =========================================================================

  /** Находит привязку MAX по идентификатору профиля MAX. */
  findMaxLinkByMaxUserId(
    maxUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MaxLink | null> {
    return this.client(tx).maxLink.findUnique({ where: { maxUserId } });
  }

  /** Находит привязку MAX, принадлежащую пользователю. */
  findMaxLinkByUserId(userId: string, tx?: Prisma.TransactionClient): Promise<MaxLink | null> {
    return this.client(tx).maxLink.findUnique({ where: { userId } });
  }

  /**
   * Находит активную (не удалённую и активированную) учётную запись по
   * идентификатору профиля MAX (Req 16.1).
   *
   * Используется при входе через OAuth MAX ({@link import('../auth').AuthService.loginWithMax}):
   * Сессия выдаётся только если профиль MAX привязан к активному Пользователю.
   * Возвращает `null`, если привязки нет либо связанная учётная запись удалена
   * (`deletedAt`) или не активирована (`isActive = false`) — в этих случаях вход
   * отклоняется (Req 16.1, 16.3). Привязка MAX является дополнительным способом
   * входа и не заменяет регистрацию Администратором (Req 5.11, 16.2).
   */
  async findActiveUserByMaxUserId(
    maxUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<User | null> {
    const link = await this.client(tx).maxLink.findUnique({
      where: { maxUserId },
      include: { user: true },
    });
    if (link === null) {
      return null;
    }
    const { user } = link;
    if (user.deletedAt !== null || !user.isActive) {
      return null;
    }
    return user;
  }

  /**
   * Создаёт или обновляет привязку профиля MAX к пользователю (Req 6.6, 16.2).
   *
   * Upsert по уникальному ключу `userId`: у пользователя может быть не более
   * одной привязки. Вызывающий код предварительно гарантирует, что `maxUserId`
   * не принадлежит другому пользователю (уникальность `maxUserId`).
   */
  upsertMaxLink(
    userId: string,
    maxUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MaxLink> {
    return this.client(tx).maxLink.upsert({
      where: { userId },
      create: { userId, maxUserId },
      update: { maxUserId },
    });
  }

  /**
   * Устанавливает признак полной отписки Пользователя от Уведомлений через Бот
   * MAX по идентификатору профиля MAX (Req 16.5).
   *
   * При `mutedAll = true` канал MAX прекращает доставку всех последующих
   * Уведомлений этому Пользователю до повторного включения (`mutedAll = false`);
   * Уведомления на сайте при этом сохраняются (Req 16.13). Операция
   * идемпотентна. Возвращает обновлённую привязку MAX.
   *
   * @param maxUserId Идентификатор профиля MAX.
   * @param mutedAll Желаемое состояние полной отписки.
   * @returns Обновлённая привязка MAX.
   */
  setMaxMutedAllByMaxUserId(
    maxUserId: string,
    mutedAll: boolean,
    tx?: Prisma.TransactionClient,
  ): Promise<MaxLink> {
    return this.client(tx).maxLink.update({ where: { maxUserId }, data: { mutedAll } });
  }

  /**
   * Возвращает постраничный список пользователей по необязательному фильтру,
   * отсортированный по дате создания (новые → старые).
   */
  async list(
    pagination: PaginationQueryDto,
    where: Prisma.UserWhereInput = {},
    tx?: Prisma.TransactionClient,
  ): Promise<Page<User>> {
    const client = this.client(tx);
    const [items, total] = await Promise.all([
      client.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      client.user.count({ where }),
    ]);
    return buildPage(items, total, pagination.page, pagination.pageSize);
  }
}
