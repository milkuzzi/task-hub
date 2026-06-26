import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, Role, TaskStatus, User, UserEmail } from '@prisma/client';
import {
  AccessDeniedException,
  EntityNotFoundException,
  StateConflictException,
  ValidationException,
} from '../common/errors';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { MailerService } from '../mailer';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { validatePrimaryAdminEmail } from './email-validation';
import { validateAvatar } from './avatar';
import { AVATAR_STORAGE, AvatarStorage } from './avatar-storage';
import { MaxProfile, ProfilePatch, UploadedFile } from './profile.types';

/**
 * Отображаемое имя по умолчанию для первичного администратора.
 * Поле `displayName` обязательно на уровне модели данных, тогда как команда
 * создания принимает только адрес электронной почты (Req 4.1); до установки
 * пароля и активации учётной записи имя можно изменить штатными средствами.
 */
const DEFAULT_ADMIN_DISPLAY_NAME = 'Администратор';

/**
 * Прикладной сервис управления пользователями (Req 2, 3, 4, 6, 7, 8).
 *
 * На текущем этапе реализует создание первичного администратора (Req 4),
 * вызываемое из CLI-команды Консоли сервера. Остальные операции
 * ({@link UsersService} в дизайне) добавляются последующими задачами плана.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly taskRepository: TaskRepository,
    private readonly auth: AuthService,
    private readonly mailer: MailerService,
    private readonly clock: ClockService,
    private readonly config: AppConfigService,
    @Inject(AVATAR_STORAGE)
    private readonly avatarStorage: AvatarStorage,
  ) {}

  /**
   * Создаёт единственного первичного администратора (Req 4).
   *
   * Порядок:
   * 1. валидирует адрес электронной почты (длина 6–254, формат) — иначе
   *    {@link ValidationException} с причиной (Req 4.1, 4.3);
   * 2. в рамках транзакции проверяет отсутствие существующего администратора —
   *    при наличии отклоняет операцию с {@link StateConflictException} (Req 4.4);
   * 3. проверяет, что адрес не занят другой учётной записью (целостность данных);
   * 4. создаёт администратора с указанным адресом; учётная запись остаётся
   *    неактивной (`isActive = false`) до установки пароля по ссылке (Req 5.5).
   *
   * Проверка инварианта и создание выполняются в одной транзакции, чтобы
   * исключить гонку, при которой могли бы появиться два администратора
   * (Req 2.2, 4.4).
   *
   * @param email Адрес электронной почты будущего администратора.
   * @returns Созданная учётная запись администратора.
   * @throws ValidationException Если адрес отсутствует, имеет недопустимую длину
   *   или формат (Req 4.3).
   * @throws StateConflictException Если администратор уже существует (Req 4.4)
   *   либо адрес занят другой учётной записью.
   */
  async createPrimaryAdmin(email: string | undefined): Promise<User> {
    const validation = validatePrimaryAdminEmail(email);
    if (!validation.valid) {
      throw new ValidationException(validation.reason);
    }

    // Сужение типа: после успешной валидации значение гарантированно задано.
    const validEmail = email as string;

    return this.userRepository.runInTransaction(async (tx) => {
      await this.userRepository.acquirePrimaryAdminCreationLock?.(tx);
      const adminCount = await this.userRepository.countActiveAdmins(tx);
      if (adminCount > 0) {
        throw new StateConflictException('Администратор уже существует.');
      }

      const existing = await this.userRepository.findByEmail(validEmail, tx);
      if (existing !== null) {
        throw new StateConflictException(
          'Адрес электронной почты уже используется другой учётной записью.',
        );
      }

      return this.userRepository.create(
        {
          email: validEmail,
          displayName: DEFAULT_ADMIN_DISPLAY_NAME,
          role: Role.ADMIN,
          isActive: false,
        },
        tx,
      );
    });
  }

  /**
   * Изменяет роль пользователя с сохранением инварианта «ровно один активный
   * администратор» (Req 2.2, 2.3, 2.11, 3.3).
   *
   * Операция доступна только Администратору (Req 5.1; модель прав
   * администратор ⊇ менеджер — см. {@link hasManagerPrivileges}). Выполняется в
   * транзакции: проверка прав инициатора, наличие активного целевого
   * пользователя и инвариант проверяются и применяются атомарно, что исключает
   * гонки, способные оставить систему без администратора или с двумя.
   *
   * Инвариант: после операции число активных администраторов должно быть равно
   * ровно 1. Поэтому:
   * - понижение единственного администратора (ADMIN → не-ADMIN) отклоняется,
   *   так как оставит 0 администраторов (Req 2.11) — сменить администратора
   *   можно только через {@link UsersService.transferAdmin};
   * - назначение второго администратора (не-ADMIN → ADMIN) отклоняется, так как
   *   приведёт к 2 администраторам (Req 2.2);
   * - перевод между ролями Менеджер/Исполнитель сохраняет число администраторов
   *   неизменным и разрешён.
   *
   * При отклонении роли остаются без изменений (Req 2.11).
   *
   * @param actorId Идентификатор инициатора (должен быть активным Администратором).
   * @param userId Идентификатор пользователя, чья роль изменяется.
   * @param role Новая роль.
   * @returns Обновлённая учётная запись пользователя.
   * @throws AccessDeniedException Если инициатор не является активным Администратором.
   * @throws EntityNotFoundException Если целевой пользователь не найден или удалён.
   * @throws StateConflictException Если операция нарушила бы инвариант единственного
   *   администратора (0 или более одного администратора).
   */
  async updateRole(actorId: string, userId: string, role: Role): Promise<User> {
    return this.userRepository.runInTransaction(async (tx) => {
      await this.assertActiveAdmin(actorId, tx);

      const target = await this.userRepository.findActiveById(userId, tx);
      if (target === null) {
        throw new EntityNotFoundException('Пользователь не найден или удалён.');
      }

      this.assertSingleAdminPreserved(target.role, role, await this.adminCount(tx));

      if (target.role === role) {
        // Роль не меняется — возвращаем текущее состояние без записи.
        return target;
      }

      return this.userRepository.update(userId, { role }, tx);
    });
  }

  /**
   * Передаёт роль администратора существующему активному пользователю (Req 3).
   *
   * Смена ролей выполняется в одной транзакции с проверкой инварианта «ровно
   * один администратор после операции» (Req 2.2, 2.11, 3.3): целевой
   * пользователь становится единственным Администратором, а бывший
   * Администратор — Исполнителем (Req 3.1, 3.3). После фиксации транзакции
   * (роли уже сохранены) выполняются побочные эффекты, не влияющие на
   * консистентность ролей:
   * 1. аннулирование всех сессий бывшего администратора в течение ≤5с через
   *    {@link AuthService.revokeAllSessions} (Req 3.4);
   * 2. постановка email-уведомлений о передаче роли обоим участникам — новому и
   *    бывшему администратору (Req 3.5). Постановка в очередь асинхронна
   *    (фактическая доставка — воркером с ретраями). Если постановка/отправка
   *    письма завершается ошибкой, передача роли НЕ откатывается, а лишь
   *    фиксируется признак неуспеха (Req 3.6).
   *
   * Принимающий пользователь не подтверждает передачу (Req 3.1).
   *
   * @param currentAdminId Идентификатор действующего Администратора-инициатора.
   * @param targetUserId Идентификатор пользователя, которому передаётся роль.
   * @throws AccessDeniedException Если инициатор не является активным Администратором.
   * @throws StateConflictException Если целевой пользователь не существует, удалён,
   *   заблокирован, не активирован, либо совпадает с текущим Администратором
   *   (Req 3.2).
   */
  async transferAdmin(currentAdminId: string, targetUserId: string): Promise<void> {
    const { formerAdmin, newAdmin } = await this.userRepository.runInTransaction(async (tx) => {
      const admin = await this.assertActiveAdmin(currentAdminId, tx);

      if (targetUserId === currentAdminId) {
        // Передача самому себе бессмысленна и нарушила бы инвариант
        // (после понижения бывшего администратора не осталось бы ни одного).
        throw new StateConflictException('Невозможно передать роль администратора самому себе.');
      }

      const target = await this.userRepository.findActiveById(targetUserId, tx);
      if (target === null || !this.isAssignable(target)) {
        // Несуществующий, удалённый, неактивированный или заблокированный
        // пользователь не может принять роль (Req 3.2).
        throw new StateConflictException(
          'Невозможно передать роль администратора выбранному пользователю: ' +
            'пользователь не существует, заблокирован или недоступен для назначения.',
        );
      }

      // Применяем смену ролей и проверяем инвариант внутри транзакции.
      await this.userRepository.update(target.id, { role: Role.ADMIN }, tx);
      const formerAdmin = await this.userRepository.update(admin.id, { role: Role.EXECUTOR }, tx);

      const adminsAfter = await this.adminCount(tx);
      if (adminsAfter !== 1) {
        // Защитная проверка инварианта: при корректных входных данных не должна
        // срабатывать, но гарантирует откат транзакции при любой аномалии
        // (Req 2.2, 2.11, 3.3).
        throw new StateConflictException(
          'Операция нарушила бы требование наличия ровно одного администратора.',
        );
      }

      const newAdmin = await this.userRepository.findById(target.id, tx);
      return { formerAdmin, newAdmin: newAdmin ?? target };
    });

    // Побочные эффекты выполняются после фиксации транзакции: смена ролей уже
    // сохранена и не откатывается при их сбое (Req 3.6).

    // Аннулирование сессий бывшего администратора ≤5с (Req 3.4).
    await this.auth.revokeAllSessions(formerAdmin.id);

    // Постановка email-уведомлений обоим участникам (Req 3.5); сбой не
    // откатывает передачу роли, лишь фиксируется (Req 3.6).
    await this.enqueueTransferNotifications(formerAdmin, newAdmin);
  }

  /**
   * Удаляет Пользователя в одном из двух режимов (Req 8).
   *
   * Подтверждение операции (Req 8.9, 8.10) выполняется на уровне
   * контроллера/интерфейса ДО вызова этого метода: сервис реализует уже
   * подтверждённую операцию удаления. Метод доступен только Администратору
   * (Req 5.1). Все изменения данных выполняются в одной транзакции, чтобы
   * исключить частичное удаление.
   *
   * Порядок внутри транзакции:
   * 1. проверка прав инициатора (активный Администратор);
   * 2. отказ при попытке удалить собственную учётную запись Администратора до
   *    передачи роли — данные сохраняются без изменений (Req 8.8); удаление
   *    любого Администратора отклоняется ради инварианта единственного
   *    администратора (Req 2.11);
   * 3. поиск задач, в которых удаляемый Пользователь является ЕДИНСТВЕННЫМ
   *    исполнителем или ЕДИНСТВЕННЫМ менеджером, и перевод каждой такой задачи
   *    в статус «Требует администратора» ДО завершения удаления (Req 8.5);
   * 4. собственно удаление:
   *    - `soft` — запись сохраняется в БД и помечается удалённой
   *      (`deletedAt`), имя сохраняется в задачах и чатах без обезличивания
   *      (Req 8.2, 8.4);
   *    - `hard` — запись Пользователя удаляется из БД, при этом его Сообщения и
   *      Вложения сохраняются неизменными: связь `Message.authorId`
   *      обнуляется (`SetNull`), а денормализованное `authorDisplayName`
   *      хранит имя на момент создания (Req 8.3, 8.4).
   *
   * После фиксации транзакции все Сессии и токены удалённого Пользователя
   * аннулируются в течение ≤5с (Req 8.6), благодаря чему обращения с
   * аннулированным токеном отклоняются и требуют повторной аутентификации
   * (Req 8.7).
   *
   * @param adminId Идентификатор инициатора (должен быть активным Администратором).
   * @param userId Идентификатор удаляемого Пользователя.
   * @param mode Режим удаления: `soft` (с сохранением записи) или `hard`
   *   (без сохранения записи).
   * @throws AccessDeniedException Если инициатор не является активным Администратором.
   * @throws EntityNotFoundException Если Пользователь не найден или уже удалён.
   * @throws StateConflictException При попытке удалить Администратора до передачи
   *   роли (Req 8.8, 2.11).
   */
  async deleteUser(adminId: string, userId: string, mode: 'soft' | 'hard'): Promise<void> {
    const deletedUser = await this.userRepository.runInTransaction(async (tx) => {
      await this.assertActiveAdmin(adminId, tx);

      if (userId === adminId) {
        // Самоудаление Администратора запрещено до передачи роли (Req 8.8).
        throw new StateConflictException(
          'Невозможно удалить собственную учётную запись администратора. ' +
            'Сначала передайте роль администратора другому пользователю.',
        );
      }

      const target = await this.userRepository.findActiveById(userId, tx);
      if (target === null) {
        throw new EntityNotFoundException('Пользователь не найден или уже удалён.');
      }

      if (target.role === Role.ADMIN) {
        // Удаление администратора оставило бы систему без него (Req 2.11, 8.8).
        throw new StateConflictException(
          'Невозможно удалить администратора: сначала передайте роль администратора ' +
            'другому пользователю.',
        );
      }

      // Переназначение осиротевших задач в «Требует администратора» ДО удаления
      // (Req 8.5): задачи, где пользователь — единственный исполнитель или
      // единственный менеджер.
      const orphanTaskIds = await this.taskRepository.findTaskIdsWhereUserIsSoleAssignee(
        userId,
        tx,
      );
      for (const taskId of orphanTaskIds) {
        await this.taskRepository.setStatus(taskId, TaskStatus.NEEDS_ADMIN, tx);
      }

      if (mode === 'soft') {
        // Запись сохраняется и помечается удалённой; имя сохраняется в задачах и
        // чатах без обезличивания (Req 8.2, 8.4).
        await this.userRepository.update(
          userId,
          { deletedAt: this.clock.now(), isActive: false },
          tx,
        );
      } else {
        // Запись удаляется; Сообщения/Вложения сохраняются за счёт SetNull и
        // денормализованного authorDisplayName (Req 8.3, 8.4).
        await this.userRepository.delete(userId, tx);
      }

      return target;
    });

    // Аннулирование всех сессий и токенов удалённого пользователя ≤5с (Req 8.6,
    // 8.7). Выполняется после фиксации транзакции.
    await this.auth.revokeAllSessions(deletedUser.id);

    this.logger.log(
      `Пользователь «${deletedUser.id}» удалён (режим «${mode}») инициатором «${adminId}»; ` +
        'сессии аннулированы.',
    );
  }

  /**
   * Возвращает сохранённые адреса электронной почты удалённого Пользователя для
   * выбора Администратором при восстановлении (Req 7.3).
   *
   * Доступно только Администратору. Адреса берутся из истории `UserEmail`
   * (Req 7.1) и отсортированы новые → старые. Пустой список означает
   * невозможность восстановления по адресу (Req 7.6).
   *
   * @param adminId Идентификатор инициатора (должен быть активным Администратором).
   * @param deletedUserId Идентификатор удалённого Пользователя.
   * @returns Список сохранённых адресов электронной почты (без повторов).
   * @throws AccessDeniedException Если инициатор не является активным Администратором.
   * @throws EntityNotFoundException Если Пользователь не найден.
   */
  async listDeletedUserEmails(adminId: string, deletedUserId: string): Promise<string[]> {
    return this.userRepository.runInTransaction(async (tx) => {
      await this.assertActiveAdmin(adminId, tx);

      const target = await this.userRepository.findById(deletedUserId, tx);
      if (target === null) {
        throw new EntityNotFoundException('Пользователь не найден.');
      }

      const emails = await this.userRepository.listEmails(deletedUserId, tx);
      return emails.map((e: UserEmail) => e.email);
    });
  }

  /**
   * Восстанавливает удалённого Пользователя повторной регистрацией по выбранному
   * сохранённому адресу электронной почты (Req 7.2–7.6).
   *
   * Доступно только Администратору. Восстановление применимо к Пользователю в
   * состоянии «удалён» (soft-delete): запись сохранена и активируется заново.
   * Hard-удалённые Пользователи не подлежат восстановлению — их запись и история
   * адресов удалены безвозвратно (Req 8.3).
   *
   * Порядок внутри транзакции:
   * 1. проверка прав инициатора (активный Администратор);
   * 2. наличие удалённого Пользователя; иначе {@link EntityNotFoundException};
   * 3. отказ, если у Пользователя отсутствуют сохранённые адреса (Req 7.6);
   * 4. выбранный адрес должен присутствовать среди сохранённых (Req 7.3);
   * 5. отказ, если выбранный адрес уже используется другой учётной записью —
   *    данные удалённого Пользователя сохраняются без изменений (Req 7.5);
   * 6. создание активной учётной записи по выбранному адресу: снятие пометки
   *    удаления (`deletedAt = null`), активация (`isActive = true`), сброс
   *    счётчика неудач и блокировки; подтверждение восстановления —
   *    немедленный возврат (Req 7.2, 7.4).
   *
   * @param adminId Идентификатор инициатора (должен быть активным Администратором).
   * @param deletedUserId Идентификатор восстанавливаемого Пользователя.
   * @param email Выбранный сохранённый адрес электронной почты для регистрации.
   * @returns Восстановленная активная учётная запись.
   * @throws AccessDeniedException Если инициатор не является активным Администратором.
   * @throws EntityNotFoundException Если Пользователь не найден.
   * @throws ValidationException Если у Пользователя нет сохранённых адресов (Req 7.6)
   *   либо выбранный адрес отсутствует среди сохранённых.
   * @throws StateConflictException Если выбранный адрес занят другой учётной
   *   записью (Req 7.5).
   */
  async restoreUser(adminId: string, deletedUserId: string, email: string): Promise<User> {
    return this.userRepository.runInTransaction(async (tx) => {
      await this.assertActiveAdmin(adminId, tx);

      const target = await this.userRepository.findById(deletedUserId, tx);
      if (target === null) {
        throw new EntityNotFoundException('Удалённый пользователь не найден.');
      }
      if (target.deletedAt === null) {
        throw new StateConflictException('Пользователь не удалён; восстановление не требуется.');
      }

      // Восстановление выполняется по сохранённому адресу из истории (Req 7.2, 7.3).
      const savedEmails = await this.userRepository.listEmails(deletedUserId, tx);
      if (savedEmails.length === 0) {
        // Нет ни одного сохранённого адреса — восстановление невозможно (Req 7.6).
        throw new ValidationException(
          'У удалённого пользователя отсутствуют сохранённые адреса электронной почты.',
        );
      }
      if (!savedEmails.some((e: UserEmail) => e.email === email)) {
        throw new ValidationException(
          'Выбранный адрес электронной почты отсутствует среди сохранённых адресов пользователя.',
        );
      }

      // Конфликт адреса с другой учётной записью отклоняет восстановление, не
      // изменяя данные удалённого пользователя (Req 7.5). Проверяется любая
      // другая запись, чтобы исключить нарушение уникальности адреса.
      const existing = await this.userRepository.findByEmail(email, tx);
      if (existing !== null && existing.id !== deletedUserId) {
        throw new StateConflictException(
          'Выбранный адрес электронной почты уже используется другой учётной записью.',
        );
      }

      // Пользователь без установленного пароля возвращается в setup-pending,
      // а не становится формально активным без возможности входа.
      const restored = await this.userRepository.update(
        deletedUserId,
        {
          email,
          deletedAt: null,
          isActive: target.passwordHash !== null,
          failedLoginCount: 0,
          lockedUntil: null,
        },
        tx,
      );

      // Сохранённый адрес остаётся в истории (идемпотентно, Req 7.1).
      await this.userRepository.addEmailToHistory(deletedUserId, email, tx);

      this.logger.log(
        `Удалённый пользователь «${deletedUserId}» восстановлен по адресу «${email}» ` +
          `инициатором «${adminId}».`,
      );
      return restored;
    });
  }

  /**
   * Изменяет учётные данные профиля (адрес электронной почты и/или
   * отображаемое имя) (Req 6.2, 6.3, 6.8, 7.1).
   *
   * Изменение адреса электронной почты и имени разрешено только Администратору
   * (Req 6.2, 6.3): инициатор обязан быть активным Администратором, иначе
   * операция отклоняется {@link AccessDeniedException}, а данные остаются без
   * изменений (Req 6.8). Выполняется в транзакции:
   * 1. проверка прав инициатора и наличия активного целевого пользователя;
   * 2. при изменении адреса — валидация формата/длины и проверка, что адрес не
   *    занят другой учётной записью; иначе {@link ValidationException} либо
   *    {@link StateConflictException}, данные не меняются;
   * 3. при изменении адреса — пополнение истории адресов: прежний и новый
   *    адреса сохраняются в `UserEmail`, прежние адреса не удаляются (Req 7.1);
   * 4. при изменении имени — валидация непустого значения.
   *
   * Поля, отсутствующие в `patch`, не изменяются. Если изменять нечего,
   * возвращается текущее состояние без записи.
   *
   * @param actorId Идентификатор инициатора (должен быть активным Администратором).
   * @param userId Идентификатор пользователя, чей профиль изменяется.
   * @param patch Изменяемые поля профиля.
   * @returns Обновлённая учётная запись пользователя.
   * @throws AccessDeniedException Если инициатор не является активным Администратором (Req 6.8).
   * @throws EntityNotFoundException Если целевой пользователь не найден или удалён.
   * @throws ValidationException При недопустимом адресе электронной почты или имени.
   * @throws StateConflictException Если адрес занят другой учётной записью.
   */
  async updateProfile(actorId: string, userId: string, patch: ProfilePatch): Promise<User> {
    return this.userRepository.runInTransaction(async (tx) => {
      // Изменение email/имени доступно только Администратору (Req 6.2, 6.3, 6.8).
      await this.assertActiveAdmin(actorId, tx);

      const target = await this.userRepository.findActiveById(userId, tx);
      if (target === null) {
        throw new EntityNotFoundException('Пользователь не найден или удалён.');
      }

      const data: Prisma.UserUpdateInput = {};
      let emailChanged = false;
      let newEmail: string | null = null;

      if (patch.email !== undefined && patch.email !== target.email) {
        const validation = validatePrimaryAdminEmail(patch.email);
        if (!validation.valid) {
          throw new ValidationException(validation.reason);
        }
        const existing = await this.userRepository.findByEmail(patch.email, tx);
        if (existing !== null && existing.id !== target.id) {
          throw new StateConflictException(
            'Адрес электронной почты уже используется другой учётной записью.',
          );
        }
        data.email = patch.email;
        newEmail = patch.email;
        emailChanged = true;
      }

      if (patch.displayName !== undefined) {
        const displayName = this.validateDisplayName(patch.displayName);
        data.displayName = displayName;
      }

      if (Object.keys(data).length === 0) {
        // Изменять нечего — возвращаем текущее состояние без записи.
        return target;
      }

      // История адресов только растёт: сохраняем прежний и новый адреса (Req 7.1).
      if (emailChanged && newEmail !== null) {
        await this.userRepository.addEmailToHistory(target.id, target.email, tx);
        await this.userRepository.addEmailToHistory(target.id, newEmail, tx);
      }

      return this.userRepository.update(target.id, data, tx);
    });
  }

  /**
   * Устанавливает аватар пользователя (Req 6.4, 6.5, 6.9).
   *
   * Права: Менеджер и Исполнитель могут изменять собственный аватар
   * (`actorId === userId`), Администратор — аватар любого пользователя
   * (Req 6.4, 6.5). Попытка изменить чужой аватар без прав Администратора
   * отклоняется {@link AccessDeniedException}, данные не меняются (Req 6.8).
   *
   * Принимается только растровое изображение поддерживаемого формата размером
   * не более 5 МБ; файл, превышающий лимит или имеющий неподдерживаемый формат,
   * немедленно отклоняется {@link ValidationException} с указанием причины, а
   * ранее сохранённые данные профиля остаются без изменений (Req 6.9).
   *
   * При успехе файл передаётся в хранилище ({@link AvatarStorage}), а путь
   * сохранённого объекта записывается в `User.avatarPath`.
   *
   * @param actorId Идентификатор инициатора.
   * @param userId Идентификатор пользователя, чей аватар изменяется.
   * @param file Загружаемый файл аватара.
   * @throws AccessDeniedException Если инициатор не вправе менять данный аватар (Req 6.8).
   * @throws EntityNotFoundException Если инициатор или целевой пользователь не найдены.
   * @throws ValidationException Если аватар превышает лимит или имеет неподдерживаемый формат (Req 6.9).
   */
  async setAvatar(actorId: string, userId: string, file: UploadedFile): Promise<void> {
    const actor = await this.userRepository.findActiveById(actorId);
    if (actor === null) {
      throw new EntityNotFoundException('Учётная запись инициатора не найдена.');
    }

    // Свой аватар может менять любой Пользователь; чужой — только Администратор
    // (Req 6.4, 6.5, 6.8).
    if (actorId !== userId && actor.role !== Role.ADMIN) {
      throw new AccessDeniedException(
        'Изменять аватар другого пользователя может только Администратор.',
      );
    }

    const target = actorId === userId ? actor : await this.userRepository.findActiveById(userId);
    if (target === null) {
      throw new EntityNotFoundException('Пользователь не найден или удалён.');
    }

    const validation = validateAvatar(file, this.config.limits.avatarMaxBytes);
    if (!validation.valid) {
      // Оригинальные данные профиля сохраняются без изменений (Req 6.9).
      throw new ValidationException(validation.reason);
    }

    const avatarPath = await this.avatarStorage.store(target.id, file);
    await this.userRepository.update(target.id, { avatarPath });
    this.logger.log(`Обновлён аватар пользователя «${target.id}» инициатором «${actorId}».`);
  }

  /**
   * Привязывает профиль MAX к собственной учётной записи Пользователя
   * (Req 6.6, 6.9, 16.2).
   *
   * Привязка MAX является дополнением и не заменяет регистрацию Администратором
   * (Req 16.2). Пользователь привязывает только собственный профиль MAX.
   * Операция отклоняется с указанием причины, а ранее сохранённые данные
   * профиля остаются без изменений (Req 6.9), если:
   * - верификация профиля на стороне MAX не удалась (`verified = false`);
   * - профиль принадлежит другому пользователю (`ownerUserId` не совпадает с
   *   `userId`) — попытка привязать чужой профиль;
   * - данный `maxUserId` уже привязан к другой учётной записи.
   *
   * Повторная привязка того же профиля к тому же пользователю идемпотентна.
   *
   * @param userId Идентификатор Пользователя, привязывающего собственный профиль.
   * @param maxProfile Профиль MAX, прошедший верификацию OAuth.
   * @throws EntityNotFoundException Если учётная запись не найдена или удалена.
   * @throws ValidationException Если привязка на стороне MAX не удалась (Req 6.9).
   * @throws AccessDeniedException Если профиль принадлежит другому пользователю (Req 6.9).
   * @throws StateConflictException Если профиль MAX уже привязан к другой учётной записи (Req 6.9).
   */
  async linkMax(userId: string, maxProfile: MaxProfile): Promise<void> {
    const user = await this.userRepository.findActiveById(userId);
    if (user === null) {
      throw new EntityNotFoundException('Учётная запись не найдена или удалена.');
    }

    if (!maxProfile.verified || maxProfile.maxUserId.length === 0) {
      // Привязка на стороне MAX не удалась (Req 6.9).
      throw new ValidationException(
        'Не удалось привязать профиль MAX: верификация на стороне MAX не пройдена.',
      );
    }

    if (maxProfile.ownerUserId !== undefined && maxProfile.ownerUserId !== userId) {
      // Попытка привязать чужой профиль MAX (Req 6.9).
      throw new AccessDeniedException(
        'Нельзя привязать чужой профиль MAX: профиль принадлежит другому пользователю.',
      );
    }

    await this.userRepository.runInTransaction(async (tx) => {
      const existing = await this.userRepository.findMaxLinkByMaxUserId(maxProfile.maxUserId, tx);
      if (existing !== null && existing.userId !== userId) {
        // Профиль MAX уже занят другой учётной записью (Req 6.9).
        throw new StateConflictException('Этот профиль MAX уже привязан к другой учётной записи.');
      }
      await this.userRepository.upsertMaxLink(userId, maxProfile.maxUserId, tx);
    });

    this.logger.log(`Пользователь «${userId}» привязал профиль MAX «${maxProfile.maxUserId}».`);
  }

  /**
   * Проверяет и нормализует отображаемое имя пользователя (Req 6.3).
   *
   * Имя должно быть непустым после удаления краевых пробелов и не превышать
   * 200 символов. Возвращает нормализованное (обрезанное по краям) значение.
   *
   * @throws ValidationException При пустом или слишком длинном имени.
   */
  private validateDisplayName(displayName: string): string {
    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
      throw new ValidationException('Имя пользователя не может быть пустым.');
    }
    if (trimmed.length > 200) {
      throw new ValidationException('Имя пользователя не должно превышать 200 символов.');
    }
    return trimmed;
  }

  /**
   * Проверяет, что пользователь является активным Администратором, и возвращает
   * его запись; иначе бросает {@link AccessDeniedException} (Req 5.1, модель
   * прав администратор ⊇ менеджер).
   */
  private async assertActiveAdmin(actorId: string, tx: Prisma.TransactionClient): Promise<User> {
    const actor = await this.userRepository.findActiveById(actorId, tx);
    if (actor === null || actor.role !== Role.ADMIN) {
      throw new AccessDeniedException('Операция доступна только Администратору.');
    }
    return actor;
  }

  /**
   * Проверяет, что смена роли с `from` на `to` сохранит ровно одного активного
   * администратора, исходя из текущего их числа `currentAdmins` (Req 2.2,
   * 2.11). Бросает {@link StateConflictException}, если результат отличался бы
   * от 1.
   */
  private assertSingleAdminPreserved(from: Role, to: Role, currentAdmins: number): void {
    const wasAdmin = from === Role.ADMIN;
    const willBeAdmin = to === Role.ADMIN;
    let resulting = currentAdmins;
    if (wasAdmin && !willBeAdmin) {
      resulting -= 1;
    } else if (!wasAdmin && willBeAdmin) {
      resulting += 1;
    }

    if (resulting !== 1) {
      throw new StateConflictException(
        'Операция нарушила бы требование наличия ровно одного администратора. ' +
          'Для смены администратора используйте передачу роли.',
      );
    }
  }

  /** Возвращает число активных администраторов в рамках транзакции. */
  private adminCount(tx: Prisma.TransactionClient): Promise<number> {
    return this.userRepository.countActiveAdmins(tx);
  }

  /**
   * Определяет, доступен ли пользователь для назначения администратором:
   * активирован и не заблокирован на текущий момент (Req 3.2). Запись уже
   * проверена на отсутствие soft-delete вызывающим кодом.
   */
  private isAssignable(user: User): boolean {
    if (!user.isActive) {
      return false;
    }
    const now = this.clock.now();
    return user.lockedUntil === null || user.lockedUntil.getTime() <= now.getTime();
  }

  /**
   * Ставит в очередь email-уведомления о передаче роли новому и бывшему
   * администратору (Req 3.5). Сбой постановки/отправки не откатывает передачу
   * роли — фиксируется признак неуспеха (Req 3.6).
   */
  private async enqueueTransferNotifications(formerAdmin: User, newAdmin: User): Promise<void> {
    try {
      await this.mailer.enqueue({
        to: newAdmin.email,
        subject: 'Система поручений: вам передана роль администратора',
        html:
          `<p>Здравствуйте!</p>` +
          `<p>Вам передана роль Администратора «Системы поручений». ` +
          `Теперь вы обладаете полными правами управления системой.</p>`,
        text: 'Вам передана роль Администратора «Системы поручений».',
      });

      await this.mailer.enqueue({
        to: formerAdmin.email,
        subject: 'Система поручений: роль администратора передана',
        html:
          `<p>Здравствуйте!</p>` +
          `<p>Роль Администратора «Системы поручений» передана другому пользователю. ` +
          `Ваша текущая роль — Исполнитель.</p>`,
        text: 'Роль Администратора «Системы поручений» передана другому пользователю.',
      });
    } catch (error) {
      // Передача роли уже зафиксирована в БД и сохраняется (Req 3.6).
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Не удалось поставить в очередь уведомления о передаче роли администратора ` +
          `(новый: «${newAdmin.id}», бывший: «${formerAdmin.id}»): ${reason}. ` +
          'Передача роли сохранена; зафиксирован признак неуспешной отправки уведомления.',
      );
    }
  }
}
