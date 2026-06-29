import { Inject, Injectable, Logger } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import {
  AccessDeniedException,
  AuthenticationException,
  EntityNotFoundException,
  StateConflictException,
  UnprocessableException,
  ValidationException,
} from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { SessionRegistry } from '../infra';
import { MailerService } from '../mailer';
import { MAX_OAUTH_PORT, MaxOAuthExchangeError, type MaxOAuthPort } from '../max/oauth';
import { UserRepository } from '../repositories';
import { validatePrimaryAdminEmail } from '../users/email-validation';
import { PasswordSetupTokenService } from './password-setup-token.service';
import { PasswordService } from './password.service';
import { SessionTokenService } from './session-token.service';
import { SESSION_DISCONNECTOR, SessionDisconnector } from './session-disconnector';
import { AuthSession } from './auth.types';
import { validatePasswordLength } from './password';

/**
 * Прикладной сервис аутентификации и регистрации по приглашению (Req 5).
 *
 * На данном этапе реализует регистрацию Пользователя по приглашению
 * Администратора с одноразовой ссылкой установки пароля, установку пароля с
 * активацией учётной записи и вход по email/паролю с блокировкой после
 * неудачных попыток и выпуском сессии в реестре Redis, а также аннулирование
 * всех сессий пользователя ≤5с ({@link AuthService.revokeAllSessions}). OAuth
 * MAX и смена пароля добавляются последующими задачами плана (3.15, 13.1).
 *
 * Публичная самостоятельная регистрация отсутствует намеренно: создать учётную
 * запись можно только через {@link AuthService.invite}, доступный
 * исключительно Администратору (Req 5.1, 5.2).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly passwords: PasswordService,
    private readonly setupTokens: PasswordSetupTokenService,
    private readonly mailer: MailerService,
    private readonly config: AppConfigService,
    private readonly sessionTokens: SessionTokenService,
    private readonly clock: ClockService,
    private readonly sessions: SessionRegistry,
    @Inject(SESSION_DISCONNECTOR)
    private readonly disconnector: SessionDisconnector,
    @Inject(MAX_OAUTH_PORT)
    private readonly maxOAuth: MaxOAuthPort,
  ) {}

  /**
   * Аннулирует все Сессии и токены пользователя в течение ≤5с (Req 3.4, 8.6,
   * 8.7, 19.10).
   *
   * Аннулирование выполняется в два немедленных шага без ожидания истечения
   * токенов:
   * 1. удаление всех записей сессий пользователя из реестра Redis
   *    ({@link SessionRegistry.revokeAllForUser}). После этого
   *    {@link SessionTokenService.verify} перестаёт признавать токены
   *    действительными, и {@link SessionAuthGuard} (а также авторизация
   *    socket-подключений) отклоняет любые последующие запросы с этими
   *    токенами с требованием повторной аутентификации (Req 8.7);
   * 2. принудительный разрыв уже открытых realtime-подключений пользователя
   *    через порт {@link SessionDisconnector}. Будущий ChatGateway (задача 9.1)
   *    рассылает команду отключения в персональную комнату пользователя
   *    (`userId`); до его подключения действует безопасная no-op реализация,
   *    при которой корректность обеспечивается уже выполненным удалением сессий.
   *
   * Метод идемпотентен: повторный вызов для пользователя без активных сессий
   * безопасен и просто ничего не аннулирует. Применяется при передаче роли
   * администратора, блокировке и удалении пользователя.
   *
   * @param userId Идентификатор пользователя, чьи сессии аннулируются.
   * @returns Число аннулированных токенов (для журналирования/диагностики).
   */
  async revokeAllSessions(userId: string): Promise<number> {
    const revoked = await this.sessions.revokeAllForUser(userId);
    await this.disconnector.disconnectUser(userId);
    this.logger.log(
      `Аннулированы сессии пользователя «${userId}»: удалено токенов ${revoked}, ` +
        'отправлен сигнал отключения сокетов.',
    );
    return revoked;
  }

  /**
   * Приглашает нового Пользователя (Req 5.1–5.4, 15.1, 15.2).
   *
   * Порядок:
   * 1. проверяет, что инициатор — активный Администратор; иначе
   *    {@link AccessDeniedException} (Req 5.1, запрет публичной регистрации 5.2);
   * 2. валидирует адрес электронной почты (длина 6–254, формат) —
   *    {@link ValidationException} при нарушении;
   * 3. в транзакции проверяет, что адрес не занят, и создаёт неактивную учётную
   *    запись Исполнителя (`isActive = false`, без `passwordHash`);
   * 4. выпускает одноразовый токен установки пароля с TTL 24 ч и ставит в
   *    очередь регистрационное письмо со ссылкой (Req 15.1, 15.2).
   *
   * Учётная запись остаётся неактивной до установки пароля по ссылке. Если
   * письмо в итоге не будет доставлено (после ретраев воркера), учётная запись
   * так и останется неактивной — активация происходит исключительно в
   * {@link AuthService.setPassword} (Req 5.4, 15.4).
   *
   * @param adminId Идентификатор Администратора-инициатора.
   * @param email Адрес электронной почты приглашаемого Пользователя.
   * @returns Созданная неактивная учётная запись.
   * @throws AccessDeniedException Если инициатор не является активным Администратором.
   * @throws ValidationException При недопустимом адресе электронной почты.
   * @throws StateConflictException Если адрес уже занят другой учётной записью.
   */
  async invite(adminId: string, email: string): Promise<User> {
    const admin = await this.userRepository.findActiveById(adminId);
    if (admin === null || admin.role !== Role.ADMIN) {
      throw new AccessDeniedException('Приглашать Пользователей может только Администратор.');
    }

    const validation = validatePrimaryAdminEmail(email);
    if (!validation.valid) {
      throw new ValidationException(validation.reason);
    }

    const user = await this.userRepository.runInTransaction(async (tx) => {
      const existing = await this.userRepository.findByEmail(email, tx);
      if (existing !== null) {
        throw new StateConflictException(
          'Адрес электронной почты уже используется другой учётной записью.',
        );
      }

      return this.userRepository.create(
        {
          email,
          displayName: email,
          role: Role.EXECUTOR,
          isActive: false,
        },
        tx,
      );
    });

    const token = await this.setupTokens.issue(user.id);
    await this.sendInvitationEmail(user, token);

    return user;
  }

  /**
   * Повторно выпускает ссылку установки пароля и ставит регистрационное письмо
   * в очередь отправки для существующего Пользователя (Req 5.4, 15.1, 15.2).
   *
   * Используется CLI-командой Консоли сервера ({@link import('../cli/send-setup')})
   * для отправки ссылки активации первичному администратору, созданному без
   * письма ({@link import('../users').UsersService.createPrimaryAdmin}), а также
   * для повторной выдачи ссылки любому ещё не активированному Пользователю.
   *
   * Порядок:
   * 1. находит не удалённую учётную запись по адресу; при отсутствии —
   *    {@link EntityNotFoundException};
   * 2. выпускает одноразовый токен установки пароля с TTL 24 ч;
   * 3. ставит в очередь регистрационное письмо со ссылкой (фактическая доставка
   *    с ретраями — воркером очереди email).
   *
   * Активация учётной записи происходит исключительно при установке пароля по
   * ссылке ({@link AuthService.setPassword}); сам по себе вызов метода учётную
   * запись не активирует (Req 5.4, 15.4).
   *
   * @param email Адрес электронной почты Пользователя.
   * @throws EntityNotFoundException Если не удалённая учётная запись с таким
   *   адресом не найдена.
   */
  async sendPasswordSetup(email: string): Promise<void> {
    const user = await this.userRepository.findActiveByEmail(email);
    if (user === null) {
      throw new EntityNotFoundException(
        'Учётная запись с указанным адресом электронной почты не найдена.',
      );
    }

    const token = await this.setupTokens.issue(user.id);
    await this.sendInvitationEmail(user, token);
  }

  /**
   * Устанавливает пароль по одноразовой ссылке и активирует учётную запись
   * (Req 5.5, 5.6, 6.7, 19.5–19.7).
   *
   * Порядок:
   * 1. валидирует длину пароля (8–128) до обращения к токену, чтобы не
   *    «сжигать» действующую ссылку из-за некорректного ввода (Req 6.7);
   * 2. атомарно потребляет токен; недействительный (просроченный либо уже
   *    использованный) токен отклоняется {@link UnprocessableException}
   *    (Req 5.6, 15.3, 19.6, 19.7);
   * 3. вычисляет хеш пароля и в одной операции сохраняет его и активирует
   *    учётную запись (`isActive = true`), обнуляя счётчик неудачных входов и
   *    снимая возможную блокировку (Req 5.5).
   *
   * @param token Открытый секрет токена из ссылки письма.
   * @param password Новый пароль (8–128 символов).
   * @throws ValidationException При недопустимой длине пароля.
   * @throws UnprocessableException Если ссылка недействительна (просрочена или
   *   уже использована).
   */
  async setPassword(token: string, password: string): Promise<void> {
    const { passwordMinLength, passwordMaxLength } = this.config.limits;
    const validation = validatePasswordLength(password, passwordMinLength, passwordMaxLength);
    if (!validation.valid) {
      throw new ValidationException(validation.reason);
    }

    const userId = await this.setupTokens.consume(token);
    if (userId === null) {
      throw new UnprocessableException(
        'Ссылка на установку пароля недействительна или срок её действия истёк. ' +
          'Запросите новую ссылку.',
      );
    }

    const user = await this.userRepository.findById(userId);
    if (user === null || user.deletedAt !== null) {
      // Учётная запись была удалена после выпуска ссылки — установка невозможна.
      throw new UnprocessableException(
        'Учётная запись недоступна. Обратитесь к Администратору за новым приглашением.',
      );
    }

    const passwordHash = await this.passwords.hash(password);
    await this.userRepository.update(userId, {
      passwordHash,
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
    });
  }

  /**
   * Выполняет вход по адресу электронной почты и паролю (Req 5.7–5.10, 19.3,
   * 19.4).
   *
   * Порядок:
   * 1. находит активную учётную запись по адресу; отсутствие записи трактуется
   *    как неверная комбинация (единый ответ, без раскрытия поля — Req 5.8);
   * 2. при действующей блокировке (`lockedUntil` в будущем) отклоняет вход даже
   *    при верных учётных данных с сообщением о временной блокировке
   *    (Req 5.10, 19.4);
   * 3. проверяет, что учётная запись активирована и имеет пароль; иначе —
   *    единый ответ о неверной комбинации (Req 5.8);
   * 4. проверяет пароль; при несоответствии увеличивает счётчик неудач и при
   *    достижении порога (5) блокирует учётную запись на 15 минут
   *    (Req 5.9, 19.3);
   * 5. при успехе сбрасывает счётчик и блокировку, выпускает JWT и регистрирует
   *    сессию в реестре Redis (Req 5.7).
   *
   * Единое сообщение об ошибке намеренно не указывает, какое именно из полей
   * некорректно (Req 5.8).
   *
   * @param email Адрес электронной почты.
   * @param password Пароль в открытом виде.
   * @param ip Источник запроса (для журналирования попыток входа).
   * @returns Выпущенный access-токен и метаданные сессии.
   * @throws AuthenticationException При неверной комбинации либо временной
   *   блокировке учётной записи.
   */
  async login(email: string, password: string, ip: string): Promise<AuthSession> {
    const user = await this.authenticateCredentials(email, password, ip);
    return this.sessionTokens.issue(user);
  }

  /**
   * Проверяет пароль с теми же счётчиками и блокировками, что обычный вход,
   * но не выпускает сессию. Нужен доверенным составным сценариям, где перед
   * выпуском сессии требуется атомарно завершить дополнительную привязку.
   */
  async authenticateCredentials(email: string, password: string, ip: string): Promise<User> {
    const now = this.clock.now();
    const user = await this.userRepository.findActiveByEmail(email);

    if (user === null) {
      // Неизвестный адрес: единый ответ без раскрытия существования учётной
      // записи (Req 5.8). Счётчик неудач ведётся только по существующим записям.
      throw this.invalidCredentials();
    }

    if (this.isLocked(user, now)) {
      this.logger.warn(`Вход в заблокированную учётную запись «${user.email}» отклонён (ip=${ip})`);
      throw this.temporarilyLocked();
    }

    const passwordOk =
      user.isActive &&
      user.passwordHash !== null &&
      (await this.passwords.verify(password, user.passwordHash));

    if (!passwordOk) {
      await this.registerFailedAttempt(user, now, ip);
      throw this.invalidCredentials();
    }

    // Успешный вход: снимаем счётчик неудач и возможную истёкшую блокировку.
    if (user.failedLoginCount !== 0 || user.lockedUntil !== null) {
      await this.userRepository.update(user.id, { failedLoginCount: 0, lockedUntil: null });
    }

    return user;
  }

  /**
   * Продлевает действующую Сессию активного Пользователя (скользящая сессия,
   * Req 2.9). Исправляет дефект 9: активная работа дольше TTL без механизма
   * продления приводила к преждевременному 401.
   *
   * Вызывается из {@link AuthController.refresh} под {@link SessionAuthGuard},
   * поэтому на входе уже подтверждена действующая Сессия (валидная подпись и
   * не аннулированный `jti`). Порядок намеренно «issue-then-revoke», чтобы
   * Сессия ни на мгновение не отсутствовала:
   * 1. загружает активную (не удалённую и активированную) учётную запись; если
   *    Пользователь более не активен — {@link AuthenticationException} (Сессия
   *    не продлевается);
   * 2. выпускает НОВУЮ короткоживущую Сессию (новый `jti` + запись в реестре)
   *    через {@link SessionTokenService.issue};
   * 3. аннулирует ПРЕЖНИЙ `jti` через {@link SessionRegistry.revoke}, сохраняя
   *    мгновенную отзываемость (старый токен сразу отклоняется `verify`,
   *    Property 18, Req 3.9).
   *
   * @param principal Аутентифицированный субъект текущей Сессии (из guard).
   * @returns Новый access-токен и метаданные продлённой Сессии.
   * @throws AuthenticationException Если учётная запись более не активна.
   */
  async refreshSession(principal: {
    userId: string;
    tokenId: string;
    role: Role;
  }): Promise<AuthSession> {
    const user = await this.userRepository.findActiveById(principal.userId);
    if (user === null) {
      // Учётная запись деактивирована/удалена после выпуска токена — Сессия
      // не продлевается, требуется повторная аутентификация (Req 3.9).
      throw new AuthenticationException('Сессия недействительна. Выполните вход повторно.');
    }

    // Выпускаем новую Сессию ДО аннулирования прежней, чтобы действующая
    // Сессия не отсутствовала ни на мгновение (Property 17, Req 2.9).
    const session = await this.sessionTokens.issue(user);
    await this.sessions.revoke(principal.tokenId);
    this.logger.log(`Сессия пользователя «${user.id}» продлена (новый токен выпущен).`);
    return session;
  }

  /**
   * Выполняет вход через OAuth MAX (Req 5.11, 16.1, 16.2, 16.3).
   *
   * Вход через MAX — дополнительный способ аутентификации, не заменяющий
   * регистрацию Пользователя Администратором: метод лишь аутентифицирует уже
   * существующую учётную запись с привязанным профилем MAX и никогда не создаёт
   * новых учётных записей и привязок (Req 5.11, 16.2). Порядок:
   * 1. обменивает код авторизации на идентификатор профиля MAX через порт
   *    {@link MaxOAuthPort}; любая ошибка обмена (отклонённая авторизация,
   *    недействительный код, недоступность сервиса) трактуется как отказ во
   *    входе — Пользователь остаётся неаутентифицированным (Req 16.3);
   * 2. находит активную (не удалённую и активированную) учётную запись,
   *    привязанную к этому профилю MAX; при отсутствии привязки или связанной
   *    активной учётной записи вход отклоняется (Req 16.3);
   * 3. при успехе выпускает Сессию так же, как при входе по паролю (Req 16.1).
   *
   * Во всех случаях отказа возвращается единое исключение
   * {@link AuthenticationException} (401) без раскрытия причины (Req 16.3).
   *
   * @param maxAuthCode Одноразовый код авторизации, полученный после редиректа
   *   со стороны MAX.
   * @returns Выпущенный access-токен и метаданные сессии (Req 16.1).
   * @throws AuthenticationException Если авторизация на стороне MAX отклонена,
   *   профиль MAX не привязан к учётной записи либо связанная учётная запись
   *   недоступна (удалена/не активирована) (Req 16.3).
   */
  async loginWithMax(maxAuthCode: string, redirectUri?: string): Promise<AuthSession> {
    let maxUserId: string;
    try {
      maxUserId =
        redirectUri === undefined
          ? await this.maxOAuth.exchangeAuthCode(maxAuthCode)
          : await this.maxOAuth.exchangeAuthCode(maxAuthCode, redirectUri);
    } catch (error) {
      // Любой неуспех обмена на стороне MAX — отказ во входе без раскрытия
      // деталей (Req 16.3). Подробности фиксируем только в журнале.
      const reason = error instanceof MaxOAuthExchangeError ? error.message : String(error);
      this.logger.warn(
        `Вход через OAuth MAX отклонён: ошибка обмена кода авторизации (${reason}).`,
      );
      throw this.maxLoginFailed();
    }

    const user = await this.userRepository.findActiveUserByMaxUserId(maxUserId);
    if (user === null) {
      // Профиль MAX не привязан к активной учётной записи: вход отклоняется,
      // Пользователь остаётся неаутентифицированным (Req 16.1, 16.3). Привязка
      // MAX не заменяет регистрацию Администратором (Req 5.11, 16.2).
      this.logger.warn(
        `Вход через OAuth MAX отклонён: профиль MAX «${maxUserId}» ` +
          'не привязан к активной учётной записи.',
      );
      throw this.maxLoginFailed();
    }

    this.logger.log(`Успешный вход через OAuth MAX для пользователя «${user.id}».`);
    return this.sessionTokens.issue(user);
  }

  /**
   * Изменяет пароль аутентифицированного Пользователя (Req 6.1, 6.7).
   *
   * Пользователь может изменить только собственный пароль (идентификатор берётся
   * из аутентифицированной Сессии) и только при указании корректного текущего
   * пароля (Req 6.1). Порядок:
   * 1. валидирует длину нового пароля (8–128) до обращения к БД — при нарушении
   *    {@link ValidationException}, действующий пароль не меняется (Req 6.7);
   * 2. находит активную учётную запись с установленным паролем; иначе операция
   *    невозможна;
   * 3. проверяет корректность текущего пароля; при несоответствии —
   *    {@link ValidationException}, пароль сохраняется без изменений (Req 6.1);
   * 4. отклоняет новый пароль, совпадающий с текущим (Req 6.7);
   * 5. при успехе сохраняет необратимый хеш нового пароля.
   *
   * При любом отклонении действующий пароль остаётся неизменным (Req 6.7).
   *
   * @param userId Идентификатор аутентифицированного Пользователя (собственный).
   * @param current Текущий пароль в открытом виде.
   * @param next Новый пароль (8–128 символов, отличный от текущего).
   * @throws ValidationException При недопустимой длине нового пароля, неверном
   *   текущем пароле либо совпадении нового пароля с текущим.
   * @throws EntityNotFoundException Если учётная запись не найдена или удалена.
   * @throws UnprocessableException Если у учётной записи не установлен пароль.
   */
  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const { passwordMinLength, passwordMaxLength } = this.config.limits;
    const validation = validatePasswordLength(next, passwordMinLength, passwordMaxLength);
    if (!validation.valid) {
      throw new ValidationException(validation.reason);
    }

    const user = await this.userRepository.findActiveById(userId);
    if (user === null) {
      throw new EntityNotFoundException('Учётная запись не найдена.');
    }
    if (!user.isActive || user.passwordHash === null) {
      throw new UnprocessableException(
        'Изменение пароля недоступно: учётная запись не активирована.',
      );
    }

    const currentOk = await this.passwords.verify(current, user.passwordHash);
    if (!currentOk) {
      // Неверный текущий пароль: действующий пароль не меняется (Req 6.1, 6.7).
      throw new ValidationException('Указан неверный текущий пароль.');
    }

    if (next === current) {
      // Новый пароль не должен совпадать с текущим (Req 6.7).
      throw new ValidationException('Новый пароль не должен совпадать с текущим.');
    }

    const passwordHash = await this.passwords.hash(next);
    await this.userRepository.update(user.id, { passwordHash });
    this.logger.log(`Пользователь «${user.id}» изменил собственный пароль.`);
  }

  /**
   * Учитывает неудачную попытку входа и при достижении порога блокирует
   * учётную запись (Req 5.9, 19.3).
   *
   * Если предыдущая блокировка уже истекла, счётчик отсчитывается заново — это
   * исключает мгновенную повторную блокировку после окончания срока.
   */
  private async registerFailedAttempt(user: User, now: Date, ip: string): Promise<void> {
    const { loginMaxFailedAttempts, loginLockoutSeconds } = this.config.limits;
    const lockExpired = user.lockedUntil !== null && user.lockedUntil.getTime() <= now.getTime();
    const baseCount = lockExpired ? 0 : user.failedLoginCount;
    const nextCount = baseCount + 1;

    if (nextCount >= loginMaxFailedAttempts) {
      const lockedUntil = new Date(now.getTime() + loginLockoutSeconds * 1000);
      await this.userRepository.update(user.id, {
        failedLoginCount: nextCount,
        lockedUntil,
      });
      this.logger.warn(
        `Учётная запись «${user.email}» заблокирована до ${lockedUntil.toISOString()} ` +
          `после ${nextCount} неудачных попыток (ip=${ip})`,
      );
      return;
    }

    await this.userRepository.update(user.id, {
      failedLoginCount: nextCount,
      lockedUntil: null,
    });
  }

  /** Проверяет, действует ли блокировка учётной записи на момент `now`. */
  private isLocked(user: User, now: Date): boolean {
    return user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
  }

  /**
   * Единое исключение «неверная комбинация» без указания поля (Req 5.8).
   */
  private invalidCredentials(): AuthenticationException {
    return new AuthenticationException('Неверный адрес электронной почты или пароль.');
  }

  /**
   * Исключение временной блокировки учётной записи (Req 5.10, 19.4).
   */
  private temporarilyLocked(): AuthenticationException {
    return new AuthenticationException(
      'Учётная запись временно заблокирована из-за нескольких неудачных попыток входа. ' +
        'Повторите попытку позже.',
    );
  }

  /**
   * Единое исключение отказа во входе через OAuth MAX без раскрытия причины
   * (Req 16.3). Применяется как при ошибке обмена кода авторизации, так и при
   * отсутствии привязки профиля MAX к активной учётной записи.
   */
  private maxLoginFailed(): AuthenticationException {
    return new AuthenticationException(
      'Не удалось выполнить вход через MAX. Убедитесь, что ваш профиль MAX ' +
        'привязан к учётной записи, и повторите попытку.',
    );
  }

  /**
   * Формирует ссылку установки пароля и ставит регистрационное письмо в очередь
   * отправки (Req 15.1). Фактическая доставка с ретраями выполняется воркером
   * очены email; учётная запись остаётся неактивной независимо от исхода
   * доставки (Req 5.4, 15.4).
   */
  private async sendInvitationEmail(user: User, token: string): Promise<void> {
    const baseUrl = this.config.app.publicUrl.replace(/\/+$/, '');
    const link = `${baseUrl}/set-password?token=${encodeURIComponent(token)}`;
    const ttlHours = Math.round(this.config.limits.passwordSetupTtlSeconds / 3600);

    await this.mailer.enqueue({
      to: user.email,
      subject: 'Приглашение в Систему поручений: установка пароля',
      html:
        `<p>Здравствуйте!</p>` +
        `<p>Вас пригласили в «Систему поручений». Чтобы активировать учётную запись, ` +
        `установите пароль по ссылке ниже. Ссылка действительна ${ttlHours} ч.</p>` +
        `<p><a href="${link}">Установить пароль</a></p>` +
        `<p>Если вы не ожидали это письмо, просто проигнорируйте его.</p>`,
      text:
        `Вас пригласили в «Систему поручений». ` +
        `Установите пароль по ссылке (действительна ${ttlHours} ч): ${link}`,
    });

    this.logger.log(`Приглашение для «${user.email}» поставлено в очередь отправки`);
  }
}
