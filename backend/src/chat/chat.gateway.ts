import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  AuthPrincipal,
  readSessionCookie,
  SessionTokenService,
  SocketSessionDisconnector,
} from '../auth';
import { SiteNotificationDispatcher } from '../notifications';
import { TaskRealtimeDispatcher, TaskRealtimeUpdate, TasksService } from '../tasks';
import { ChatEvents } from './chat.events';
import { personaRoom, taskRoom } from './chat.rooms';

/** Полезная нагрузка входящих событий входа/выхода из комнаты Задачи. */
interface TaskRoomPayload {
  /** Идентификатор Задачи. */
  taskId?: unknown;
}

/** Положительный ответ (ack) на запрос входа/выхода из комнаты Задачи. */
interface TaskRoomAck {
  status: 'ok';
  taskId: string;
}

/**
 * Socket.IO-Gateway realtime-чата (Req 11.1, 11.2, 3.4, 8.6, 19.10).
 *
 * Зона ответственности (задача 9.1):
 * - авторизация подключения через сессию: при `connection` извлекает
 *   access-токен из рукопожатия и проверяет его через
 *   {@link SessionTokenService.verify}; неаутентифицированные сокеты
 *   немедленно отключаются (Req 5.7, 19.10);
 * - комнаты по `userId` и `taskId`: при успешной авторизации сокет
 *   присоединяется к персональной комнате Пользователя ({@link personaRoom})
 *   для адресных уведомлений и аннулирования сессий; вход в комнату Задачи
 *   ({@link taskRoom}) разрешён только Участникам чата — Исполнителю/Менеджеру
 *   Задачи или Администратору (Req 11.2), проверка прав делегируется
 *   {@link TasksService.getVisibleTask} (Req 2.12);
 * - broadcast-хелперы: рассылка Сообщений, обновлений Статуса и счётчиков в
 *   комнату Задачи, а также адресных уведомлений в персональную комнату
 *   Пользователя — используются ChatService и NotificationsService в
 *   последующих задачах (9.2+, 12.x).
 *
 * Отправка/редактирование/удаление Сообщений (задача 9.2) и список прочитавших
 * (задача 9.6) реализуются отдельно; здесь предоставляются только транспорт,
 * авторизация подключения, управление комнатами и примитивы рассылки.
 *
 * При инициализации Gateway регистрирует активный сервер Socket.IO в общем
 * {@link SocketSessionDisconnector} (привязан к токену `SESSION_DISCONNECTOR` в
 * AuthModule). Благодаря этому {@link AuthService.revokeAllSessions} мгновенно
 * разрывает живые подключения Пользователя (≤5с), не создавая циклической
 * зависимости модулей.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  /** Активный сервер Socket.IO (инъецируется NestJS после инициализации). */
  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly sessionTokens: SessionTokenService,
    private readonly tasks: TasksService,
    private readonly disconnector: SocketSessionDisconnector,
    private readonly siteNotifications: SiteNotificationDispatcher,
    private readonly taskRealtime: TaskRealtimeDispatcher,
  ) {}

  /**
   * Регистрирует активный сервер Socket.IO в {@link SocketSessionDisconnector},
   * чтобы аннулирование сессий немедленно разрывало живые подключения
   * Пользователя (Req 3.4, 8.6, 19.10), и привязывает realtime-доставку
   * уведомлений на сайт к {@link SiteNotificationDispatcher}, чтобы воркер
   * доставки (задача 12.10) адресно доставлял уведомления без циклической
   * зависимости модулей (Req 13, 14.6, 15.7).
   */
  afterInit(server: Server): void {
    this.disconnector.bindServer(server);
    this.siteNotifications.bind((userId, payload) => this.notifyUser(userId, payload));
    this.taskRealtime.bind((taskId, payload, recipientUserIds) =>
      this.broadcastTaskUpdated(taskId, payload, recipientUserIds),
    );
    this.logger.log('ChatGateway инициализирован; сервер Socket.IO зарегистрирован.');
  }

  /**
   * Авторизует новое подключение по сессии и присоединяет сокет к персональной
   * комнате Пользователя (Req 5.7, 11.1, 19.10).
   *
   * Токен извлекается из рукопожатия (`handshake.auth.token`, заголовка
   * `Authorization: Bearer <token>` или cookie). При отсутствии или недействительности
   * токена сокет немедленно отключается без раскрытия причины — аннулированные
   * сессии перестают проходить проверку сразу же (Req 19.10).
   */
  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (token === null) {
      this.rejectConnection(client, 'Требуется вход в систему.');
      return;
    }

    let principal: AuthPrincipal;
    try {
      principal = await this.sessionTokens.verify(token);
    } catch {
      this.rejectConnection(client, 'Сессия недействительна. Выполните вход повторно.');
      return;
    }

    client.data.principal = principal;
    await client.join(personaRoom(principal.userId));
    this.logger.debug(
      `Сокет «${client.id}» авторизован: пользователь «${principal.userId}», ` +
        'присоединён к персональной комнате.',
    );
  }

  /** Журналирует отключение сокета. Очистка комнат выполняется Socket.IO автоматически. */
  handleDisconnect(client: Socket): void {
    const principal = client.data.principal as AuthPrincipal | undefined;
    this.logger.debug(
      `Сокет «${client.id}» отключён${
        principal !== undefined ? ` (пользователь «${principal.userId}»)` : ''
      }.`,
    );
  }

  /**
   * Присоединяет сокет к комнате Задачи только для Участников чата (Req 11.2).
   *
   * Проверка прав делегируется {@link TasksService.getVisibleTask}: метод
   * возвращает Задачу лишь Исполнителю/Менеджеру Задачи или Администратору,
   * иначе отказывает в доступе, не раскрывая содержимое (Req 2.12). При отказе
   * сокет не присоединяется к комнате, а клиент получает {@link WsException}.
   */
  @SubscribeMessage(ChatEvents.TaskJoin)
  async joinTaskRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TaskRoomPayload,
  ): Promise<TaskRoomAck> {
    const principal = this.requirePrincipal(client);
    const taskId = this.requireTaskId(payload);

    try {
      // Участник чата ⇔ Задача видима Пользователю (Req 11.2, 2.12).
      await this.tasks.getVisibleTask(principal.userId, taskId);
    } catch {
      throw new WsException('Нет доступа к чату задачи.');
    }

    await client.join(taskRoom(taskId));
    this.logger.debug(`Пользователь «${principal.userId}» вошёл в комнату задачи «${taskId}».`);
    return { status: 'ok', taskId };
  }

  /** Покидает комнату Задачи. Доступно любому аутентифицированному сокету. */
  @SubscribeMessage(ChatEvents.TaskLeave)
  async leaveTaskRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TaskRoomPayload,
  ): Promise<TaskRoomAck> {
    const principal = this.requirePrincipal(client);
    const taskId = this.requireTaskId(payload);
    await client.leave(taskRoom(taskId));
    this.logger.debug(`Пользователь «${principal.userId}» покинул комнату задачи «${taskId}».`);
    return { status: 'ok', taskId };
  }

  /**
   * Рассылает Сообщение всем подключённым Участникам комнаты Задачи (Req 11.3).
   * Используется ChatService после сохранения Сообщения (задача 9.2).
   */
  broadcastMessage(taskId: string, message: unknown): void {
    this.server.to(taskRoom(taskId)).emit(ChatEvents.Message, message);
  }

  /**
   * Рассылает обновление Статуса Задачи в её комнату (live-обновление, Req 10).
   */
  broadcastStatus(taskId: string, status: unknown): void {
    this.server.to(taskRoom(taskId)).emit(ChatEvents.StatusUpdate, status);
  }

  /**
   * Рассылает лёгкое событие изменения Задачи в её комнату и персональные
   * комнаты затронутых Пользователей. Клиент по событию перечитывает Задачу или
   * текущую страницу списка через REST, чтобы получить представление с учётом
   * своих прав и `hasUnread`.
   */
  broadcastTaskUpdated(
    taskId: string,
    payload: TaskRealtimeUpdate,
    recipientUserIds: readonly string[] = [],
  ): void {
    const rooms = [
      taskRoom(taskId),
      ...[...new Set(recipientUserIds)].map((userId) => personaRoom(userId)),
    ];
    this.server.to(rooms).emit(ChatEvents.TaskUpdated, payload);
  }

  /**
   * Рассылает обновлённое значение счётчика Сообщений в комнату Задачи
   * (Req 9.7).
   */
  broadcastMessageCounter(taskId: string, counter: unknown): void {
    this.server.to(taskRoom(taskId)).emit(ChatEvents.MessageCounter, counter);
  }

  /**
   * Рассылает обновлённый список прочитавших Сообщение Участников в комнату
   * Задачи, чтобы он был виден всем Участникам чата (Req 11.8). Используется
   * ChatService при отметке Сообщения прочитанным (задача 9.6).
   */
  broadcastMessageReaders(taskId: string, readers: unknown): void {
    this.server.to(taskRoom(taskId)).emit(ChatEvents.MessageReaders, readers);
  }

  /**
   * Доставляет адресное уведомление Пользователю в его персональную комнату
   * (Req 13, 14). Используется NotificationsService (задачи 12.x).
   */
  notifyUser(userId: string, payload: unknown): void {
    this.server.to(personaRoom(userId)).emit(ChatEvents.Notification, payload);
  }

  /**
   * Извлекает access-токен из рукопожатия Socket.IO.
   *
   * Поддерживаются legacy поле `auth.token`, legacy заголовок
   * `Authorization: Bearer <token>` и HttpOnly cookie `taskhub_session`.
   * Явные токены mini-app имеют приоритет над cookie браузера.
   *
   * @returns Токен либо `null`, если он отсутствует.
   */
  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    if (auth !== undefined && typeof auth.token === 'string' && auth.token.trim() !== '') {
      return auth.token.trim();
    }

    const header = client.handshake.headers.authorization;
    if (typeof header === 'string') {
      const [scheme, value] = header.split(' ');
      if (scheme === 'Bearer' && value !== undefined && value.trim() !== '') {
        return value.trim();
      }
    }

    return readSessionCookie(client.handshake.headers.cookie);
  }

  /** Отклоняет подключение: уведомляет клиента и немедленно разрывает сокет. */
  private rejectConnection(client: Socket, message: string): void {
    client.emit('connection:error', { message });
    client.disconnect(true);
    this.logger.debug(`Подключение сокета «${client.id}» отклонено: ${message}`);
  }

  /**
   * Возвращает аутентифицированный субъект сокета либо отклоняет операцию.
   * Защищает обработчики событий на случай вызова до завершения авторизации.
   */
  private requirePrincipal(client: Socket): AuthPrincipal {
    const principal = client.data.principal as AuthPrincipal | undefined;
    if (principal === undefined) {
      throw new WsException('Требуется вход в систему.');
    }
    return principal;
  }

  /** Проверяет и нормализует идентификатор Задачи из полезной нагрузки. */
  private requireTaskId(payload: TaskRoomPayload): string {
    if (
      payload === undefined ||
      typeof payload.taskId !== 'string' ||
      payload.taskId.trim() === ''
    ) {
      throw new WsException('Не указан идентификатор задачи.');
    }
    return payload.taskId;
  }
}
