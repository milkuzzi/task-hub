import { Role } from '@prisma/client';
import { WsException } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AuthPrincipal, SessionTokenService, SocketSessionDisconnector } from '../auth';
import { SiteNotificationDispatcher } from '../notifications';
import { TasksService } from '../tasks';
import { ChatEvents } from './chat.events';
import { ChatGateway } from './chat.gateway';
import { personaRoom, taskRoom } from './chat.rooms';

/**
 * Юнит-тесты {@link ChatGateway} (Req 11.1, 11.2, 5.7, 19.10).
 *
 * Проверяются тестируемые единицы Gateway: авторизация подключения по сессии и
 * присоединение к персональной комнате, отклонение неаутентифицированных
 * сокетов, вход/выход в комнату Задачи с проверкой принадлежности к Участникам
 * чата (Req 11.2), регистрация сервера в дисконнекторе и примитивы рассылки.
 * Сокеты, сервер и зависимости подменяются заглушками.
 */
describe('ChatGateway', () => {
  const principal: AuthPrincipal = { userId: 'user-1', tokenId: 'token-1', role: Role.EXECUTOR };

  let sessionTokens: { verify: jest.Mock };
  let tasks: { getVisibleTask: jest.Mock };
  let disconnector: { bindServer: jest.Mock };
  let siteNotifications: { bind: jest.Mock };
  let gateway: ChatGateway;

  /** Создаёт заглушку клиентского сокета. */
  function makeSocket(
    overrides: Partial<{ auth: Record<string, unknown>; headers: Record<string, unknown> }> = {},
  ): {
    socket: Socket;
    join: jest.Mock;
    leave: jest.Mock;
    emit: jest.Mock;
    disconnect: jest.Mock;
  } {
    const join = jest.fn().mockResolvedValue(undefined);
    const leave = jest.fn().mockResolvedValue(undefined);
    const emit = jest.fn();
    const disconnect = jest.fn();
    const socket = {
      id: 'socket-1',
      data: {} as Record<string, unknown>,
      handshake: {
        auth: overrides.auth ?? {},
        headers: overrides.headers ?? {},
      },
      join,
      leave,
      emit,
      disconnect,
    } as unknown as Socket;
    return { socket, join, leave, emit, disconnect };
  }

  /** Подменяет приватный сервер Socket.IO Gateway-а заглушкой. */
  function attachServer(): { server: Server; to: jest.Mock; emit: jest.Mock } {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const server = { to } as unknown as Server;
    (gateway as unknown as { server: Server }).server = server;
    return { server, to, emit };
  }

  beforeEach(() => {
    sessionTokens = { verify: jest.fn() };
    tasks = { getVisibleTask: jest.fn() };
    disconnector = { bindServer: jest.fn() };
    siteNotifications = { bind: jest.fn() };
    gateway = new ChatGateway(
      sessionTokens as unknown as SessionTokenService,
      tasks as unknown as TasksService,
      disconnector as unknown as SocketSessionDisconnector,
      siteNotifications as unknown as SiteNotificationDispatcher,
    );
  });

  describe('afterInit', () => {
    it('регистрирует активный сервер в дисконнекторе сессий', () => {
      const server = {} as Server;
      gateway.afterInit(server);
      expect(disconnector.bindServer).toHaveBeenCalledWith(server);
    });

    it('привязывает realtime-доставку уведомлений на сайт к диспетчеру', () => {
      const server = {} as Server;
      gateway.afterInit(server);
      expect(siteNotifications.bind).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('handleConnection', () => {
    it('авторизует токен из auth.token и присоединяет сокет к персональной комнате', async () => {
      sessionTokens.verify.mockResolvedValue(principal);
      const { socket, join, disconnect } = makeSocket({ auth: { token: 'good-token' } });

      await gateway.handleConnection(socket);

      expect(sessionTokens.verify).toHaveBeenCalledWith('good-token');
      expect(join).toHaveBeenCalledWith(personaRoom(principal.userId));
      expect(socket.data.principal).toEqual(principal);
      expect(disconnect).not.toHaveBeenCalled();
    });

    it('принимает токен из заголовка Authorization: Bearer', async () => {
      sessionTokens.verify.mockResolvedValue(principal);
      const { socket } = makeSocket({ headers: { authorization: 'Bearer header-token' } });

      await gateway.handleConnection(socket);

      expect(sessionTokens.verify).toHaveBeenCalledWith('header-token');
    });

    it('отклоняет подключение без токена, не вызывая проверку сессии', async () => {
      const { socket, disconnect, join } = makeSocket();

      await gateway.handleConnection(socket);

      expect(sessionTokens.verify).not.toHaveBeenCalled();
      expect(join).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledWith(true);
    });

    it('отключает сокет при недействительном токене', async () => {
      sessionTokens.verify.mockRejectedValue(new Error('invalid'));
      const { socket, disconnect, join } = makeSocket({ auth: { token: 'bad-token' } });

      await gateway.handleConnection(socket);

      expect(disconnect).toHaveBeenCalledWith(true);
      expect(join).not.toHaveBeenCalled();
      expect(socket.data.principal).toBeUndefined();
    });
  });

  describe('joinTaskRoom', () => {
    it('присоединяет Участника чата к комнате задачи', async () => {
      tasks.getVisibleTask.mockResolvedValue({ id: 'task-1' });
      const { socket, join } = makeSocket();
      socket.data.principal = principal;

      const ack = await gateway.joinTaskRoom(socket, { taskId: 'task-1' });

      expect(tasks.getVisibleTask).toHaveBeenCalledWith(principal.userId, 'task-1');
      expect(join).toHaveBeenCalledWith(taskRoom('task-1'));
      expect(ack).toEqual({ status: 'ok', taskId: 'task-1' });
    });

    it('отклоняет вход в комнату задачи, недоступной Пользователю (Req 11.2)', async () => {
      tasks.getVisibleTask.mockRejectedValue(new Error('forbidden'));
      const { socket, join } = makeSocket();
      socket.data.principal = principal;

      await expect(gateway.joinTaskRoom(socket, { taskId: 'task-2' })).rejects.toBeInstanceOf(
        WsException,
      );
      expect(join).not.toHaveBeenCalled();
    });

    it('отклоняет операцию неаутентифицированного сокета', async () => {
      const { socket } = makeSocket();

      await expect(gateway.joinTaskRoom(socket, { taskId: 'task-1' })).rejects.toBeInstanceOf(
        WsException,
      );
      expect(tasks.getVisibleTask).not.toHaveBeenCalled();
    });

    it('отклоняет операцию без идентификатора задачи', async () => {
      const { socket } = makeSocket();
      socket.data.principal = principal;

      await expect(gateway.joinTaskRoom(socket, {})).rejects.toBeInstanceOf(WsException);
      expect(tasks.getVisibleTask).not.toHaveBeenCalled();
    });
  });

  describe('leaveTaskRoom', () => {
    it('покидает комнату задачи', async () => {
      const { socket, leave } = makeSocket();
      socket.data.principal = principal;

      const ack = await gateway.leaveTaskRoom(socket, { taskId: 'task-1' });

      expect(leave).toHaveBeenCalledWith(taskRoom('task-1'));
      expect(ack).toEqual({ status: 'ok', taskId: 'task-1' });
    });
  });

  describe('broadcast-хелперы', () => {
    it('рассылает Сообщение в комнату задачи', () => {
      const { to, emit } = attachServer();
      const message = { id: 'm-1', text: 'привет' };

      gateway.broadcastMessage('task-1', message);

      expect(to).toHaveBeenCalledWith(taskRoom('task-1'));
      expect(emit).toHaveBeenCalledWith(ChatEvents.Message, message);
    });

    it('рассылает обновление статуса в комнату задачи', () => {
      const { to, emit } = attachServer();

      gateway.broadcastStatus('task-1', { status: 'IN_PROGRESS' });

      expect(to).toHaveBeenCalledWith(taskRoom('task-1'));
      expect(emit).toHaveBeenCalledWith(ChatEvents.StatusUpdate, { status: 'IN_PROGRESS' });
    });

    it('рассылает счётчик сообщений в комнату задачи', () => {
      const { to, emit } = attachServer();

      gateway.broadcastMessageCounter('task-1', { count: 42 });

      expect(to).toHaveBeenCalledWith(taskRoom('task-1'));
      expect(emit).toHaveBeenCalledWith(ChatEvents.MessageCounter, { count: 42 });
    });

    it('доставляет адресное уведомление в персональную комнату Пользователя', () => {
      const { to, emit } = attachServer();

      gateway.notifyUser('user-9', { type: 'TASK_ASSIGNED' });

      expect(to).toHaveBeenCalledWith(personaRoom('user-9'));
      expect(emit).toHaveBeenCalledWith(ChatEvents.Notification, { type: 'TASK_ASSIGNED' });
    });
  });
});
