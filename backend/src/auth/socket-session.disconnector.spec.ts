import type { Server } from 'socket.io';
import {
  personaRoom,
  SESSION_REVOKED_EVENT,
  SocketSessionDisconnector,
} from './session-disconnector';

/**
 * Юнит-тесты {@link SocketSessionDisconnector} (Req 3.4, 8.6, 8.7, 19.10).
 *
 * Проверяют принудительный разрыв сокетов персональной комнаты Пользователя, а
 * также безопасное no-op-поведение до регистрации сервера Socket.IO. Сервер и
 * сокеты подменяются лёгкими заглушками, чтобы изолировать логику от
 * транспортного слоя.
 */
describe('SocketSessionDisconnector', () => {
  const userId = 'user-1';

  /** Создаёт заглушку сервера Socket.IO с управляемым набором сокетов комнаты. */
  function makeServer(socketCount: number): {
    server: Server;
    emit: jest.Mock;
    disconnects: jest.Mock[];
    to: jest.Mock;
    inFn: jest.Mock;
  } {
    const emit = jest.fn();
    const disconnects = Array.from({ length: socketCount }, () => jest.fn());
    const sockets = disconnects.map((disconnect) => ({ disconnect }));
    const to = jest.fn().mockReturnValue({ emit });
    const inFn = jest.fn().mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue(sockets) });
    const server = { to, in: inFn } as unknown as Server;
    return { server, emit, disconnects, to, inFn };
  }

  it('разрывает все сокеты персональной комнаты и шлёт событие об аннулировании', async () => {
    const { server, emit, disconnects, to, inFn } = makeServer(3);
    const disconnector = new SocketSessionDisconnector();
    disconnector.bindServer(server);

    await disconnector.disconnectUser(userId);

    expect(to).toHaveBeenCalledWith(personaRoom(userId));
    expect(emit).toHaveBeenCalledWith(SESSION_REVOKED_EVENT, expect.any(Object));
    expect(inFn).toHaveBeenCalledWith(personaRoom(userId));
    for (const disconnect of disconnects) {
      expect(disconnect).toHaveBeenCalledWith(true);
    }
  });

  it('является безопасной заглушкой, пока сервер не зарегистрирован', async () => {
    const disconnector = new SocketSessionDisconnector();
    await expect(disconnector.disconnectUser(userId)).resolves.toBeUndefined();
  });

  it('не пробрасывает ошибки транспортного слоя, чтобы не нарушить аннулирование сессий', async () => {
    const to = jest.fn().mockImplementation(() => {
      throw new Error('transport down');
    });
    const server = { to, in: jest.fn() } as unknown as Server;
    const disconnector = new SocketSessionDisconnector();
    disconnector.bindServer(server);

    await expect(disconnector.disconnectUser(userId)).resolves.toBeUndefined();
  });
});
