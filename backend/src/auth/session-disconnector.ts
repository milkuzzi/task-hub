import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * Имя персональной (persona) комнаты Socket.IO пользователя.
 *
 * Персональная комната объединяет все живые сокет-подключения одного
 * Пользователя и используется как для адресной доставки уведомлений, так и для
 * принудительного разрыва всех его соединений при аннулировании сессий
 * (Req 3.4, 8.6, 19.10). Имя комнаты строится по идентификатору Пользователя и
 * является единым источником истины как для {@link SocketSessionDisconnector},
 * так и для ChatGateway (задача 9.1).
 *
 * @param userId Идентификатор Пользователя.
 * @returns Имя персональной комнаты вида `user:{userId}`.
 */
export function personaRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * Имя события разрыва сессии, рассылаемого в персональную комнату перед
 * принудительным отключением сокетов. Клиент может использовать его, чтобы
 * показать сообщение о завершении сессии и инициировать повторный вход.
 */
export const SESSION_REVOKED_EVENT = 'session:revoked';

/**
 * Порт принудительного отключения живых сокет-подключений пользователя.
 *
 * Аннулирование сессии складывается из двух частей: (1) немедленное удаление
 * записей сессий из реестра Redis ({@link SessionRegistry.revokeAllForUser}) и
 * (2) немедленный разрыв уже открытых realtime-подключений пользователя, чтобы
 * активный сокет не продолжал получать события после аннулирования. Вторая
 * часть выполняется Socket.IO-Gateway (ChatGateway, задача 9.1), который
 * рассылает команду отключения в персональную комнату пользователя (`userId`).
 *
 * Чтобы {@link AuthService} не зависел от ещё не реализованного Gateway, он
 * обращается к этому порту. Реальная реализация поверх Socket.IO привязывается
 * позже через токен {@link SESSION_DISCONNECTOR}; до этого момента действует
 * безопасная no-op реализация {@link NoopSessionDisconnector} — аннулирование
 * корректно работает и без Gateway за счёт удаления сессий из Redis, а после
 * подключения Gateway добавляется мгновенный разрыв сокетов (Req 3.4, 8.6,
 * 8.7, 19.10, гарантия ≤5с).
 */
export interface SessionDisconnector {
  /**
   * Принудительно отключает все живые сокет-подключения указанного
   * пользователя.
   *
   * Реализация должна возвращать управление немедленно (без ожидания сетевых
   * подтверждений), чтобы соблюсти гарантию аннулирования ≤5с. Любые ошибки
   * транспортного слоя должны обрабатываться внутри реализации и не нарушать
   * удаление сессий из реестра.
   *
   * @param userId Идентификатор пользователя, чьи сокеты нужно отключить.
   */
  disconnectUser(userId: string): Promise<void>;
}

/**
 * Injection-токен порта {@link SessionDisconnector}.
 *
 * По умолчанию связан с {@link NoopSessionDisconnector} в {@link AuthModule}.
 * Будущий ChatGateway (задача 9.1) переопределяет привязку, предоставляя
 * реализацию поверх Socket.IO.
 */
export const SESSION_DISCONNECTOR = Symbol('SESSION_DISCONNECTOR');

/**
 * Безопасная реализация-заглушка {@link SessionDisconnector}.
 *
 * Применяется, пока Socket.IO-Gateway не реализован (задача 9.1) или когда у
 * пользователя нет активных realtime-подключений. Удаление сессий из реестра
 * Redis уже делает токены недействительными для последующих запросов и
 * socket-подключений (Req 8.7), поэтому отсутствие реального разрыва сокетов не
 * нарушает корректность аннулирования — лишь не разрывает мгновенно уже
 * открытое соединение. Сам факт вызова журналируется для диагностики.
 */
@Injectable()
export class NoopSessionDisconnector implements SessionDisconnector {
  private readonly logger = new Logger(NoopSessionDisconnector.name);

  async disconnectUser(userId: string): Promise<void> {
    this.logger.debug(
      `Принудительное отключение сокетов пользователя «${userId}» пропущено: ` +
        'Gateway ещё не подключён (no-op).',
    );
  }
}

/**
 * Реализация {@link SessionDisconnector} поверх Socket.IO (Req 3.4, 8.6, 8.7,
 * 19.10).
 *
 * Принудительно разрывает все живые сокет-подключения Пользователя, рассылая
 * команду в его персональную комнату ({@link personaRoom}) и отключая все
 * сокеты этой комнаты. Дополняет удаление сессий из реестра Redis: после
 * аннулирования уже открытое realtime-соединение немедленно разрывается, а не
 * продолжает получать события до истечения токена.
 *
 * Экземпляр является общим синглтоном: его связывает с токеном
 * {@link SESSION_DISCONNECTOR} в {@link AuthModule} (заменяя
 * {@link NoopSessionDisconnector}), а ChatGateway (задача 9.1) регистрирует в
 * нём активный сервер Socket.IO через {@link SocketSessionDisconnector.bindServer}.
 * Такая схема исключает циклическую зависимость модулей: AuthModule не зависит
 * от ChatModule, а ChatModule импортирует AuthModule и получает тот же
 * экземпляр для регистрации сервера.
 *
 * До регистрации сервера (например, при использовании AuthModule без Gateway)
 * реализация ведёт себя как безопасная заглушка — корректность аннулирования
 * обеспечивается удалением сессий из Redis (Req 8.7).
 */
@Injectable()
export class SocketSessionDisconnector implements SessionDisconnector {
  private readonly logger = new Logger(SocketSessionDisconnector.name);

  /** Активный сервер Socket.IO; `null`, пока Gateway не зарегистрировал его. */
  private server: Server | null = null;

  /**
   * Регистрирует активный сервер Socket.IO. Вызывается ChatGateway при
   * инициализации (`afterInit`). После регистрации
   * {@link SocketSessionDisconnector.disconnectUser} начинает реально
   * разрывать соединения.
   *
   * @param server Экземпляр сервера Socket.IO.
   */
  bindServer(server: Server): void {
    this.server = server;
  }

  async disconnectUser(userId: string): Promise<void> {
    if (this.server === null) {
      this.logger.debug(
        `Принудительное отключение сокетов пользователя «${userId}» пропущено: ` +
          'сервер Socket.IO ещё не зарегистрирован (no-op).',
      );
      return;
    }

    const room = personaRoom(userId);
    try {
      // Уведомляем клиентов о завершении сессии до разрыва соединения.
      this.server.to(room).emit(SESSION_REVOKED_EVENT, {
        reason: 'session_revoked',
        at: new Date().toISOString(),
      });
      // Немедленно разрываем все сокеты персональной комнаты пользователя.
      const sockets = await this.server.in(room).fetchSockets();
      for (const socket of sockets) {
        socket.disconnect(true);
      }
      this.logger.log(
        `Принудительно отключены сокеты пользователя «${userId}»: ${sockets.length} соединение(й).`,
      );
    } catch (error) {
      // Ошибка транспортного слоя не должна нарушать аннулирование сессий:
      // токены уже недействительны за счёт удаления из реестра Redis.
      this.logger.warn(
        `Не удалось принудительно отключить сокеты пользователя «${userId}»: ${String(error)}`,
      );
    }
  }
}
