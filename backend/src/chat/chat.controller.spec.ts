import { Role } from '@prisma/client';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { ChatController } from './chat.controller';
import { ChatMessageView, ChatService, MessageReaderView } from './chat.service';
import { MessageWithAttachments } from '../repositories';

/**
 * Контроллерные тесты {@link ChatController} (задача 5.2).
 *
 * Проверяют тонкую маршрутизацию HTTP → {@link ChatService}: проброс
 * идентификатора инициатора и параметров, формирование представлений контракта
 * `frontend/src/lib/chat-api.ts` (`ChatMessage`, `MessageReader`), проброс
 * доменных ошибок прав на правку/удаление и коды 204. Сами доменные правила,
 * права, валидация длины и live-рассылка проверяются в тестах
 * {@link ChatService}; здесь моделируется только поведение контроллера.
 */
describe('ChatController', () => {
  const TASK_ID = 'task-1';
  const MESSAGE_ID = 'message-1';
  const NOW = new Date('2026-06-19T10:00:00.000Z');
  const EDITED = new Date('2026-06-19T11:00:00.000Z');

  function makeStoredMessage(): MessageWithAttachments {
    return {
      id: MESSAGE_ID,
      chatId: 'chat-1',
      authorId: 'executor-1',
      authorDisplayName: 'Исполнитель',
      text: 'Привет',
      createdAt: NOW,
      editedAt: null,
      deleted: false,
      attachments: [
        {
          id: 'att-1',
          messageId: MESSAGE_ID,
          originalName: 'photo.png',
          mimeType: 'image/png',
          sizeBytes: BigInt(2048),
          storagePath: '/secure/att-1.zst',
          thumbnailPath: '/secure/att-1.thumb',
          compression: 'zstd',
          checksum: 'abc123',
        },
      ],
    } as unknown as MessageWithAttachments;
  }

  function makeMessageView(overrides: Partial<ChatMessageView> = {}): ChatMessageView {
    return {
      id: MESSAGE_ID,
      taskId: TASK_ID,
      chatId: 'chat-1',
      authorId: 'executor-1',
      authorDisplayName: 'Исполнитель',
      text: 'Изменённый текст',
      createdAt: NOW,
      editedAt: EDITED,
      deleted: false,
      ...overrides,
    };
  }

  function buildController(opts: { userId?: string; role?: Role } = {}): {
    controller: ChatController;
    chatService: jest.Mocked<
      Pick<
        ChatService,
        | 'listMessages'
        | 'sendMessage'
        | 'editMessage'
        | 'deleteMessage'
        | 'markRead'
        | 'listReaders'
        | 'isMuted'
        | 'setMute'
      >
    >;
    req: AuthenticatedRequest;
  } {
    const chatService = {
      listMessages: jest.fn().mockResolvedValue([makeStoredMessage()]),
      sendMessage: jest.fn().mockResolvedValue({
        id: 'message-new',
        taskId: TASK_ID,
        chatId: 'chat-1',
        authorId: opts.userId ?? 'executor-1',
        authorDisplayName: 'Исполнитель',
        text: 'Новое сообщение',
        createdAt: NOW.toISOString(),
        editedAt: null,
        deleted: false,
      }),
      editMessage: jest.fn().mockResolvedValue(makeMessageView()),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      markRead: jest.fn().mockResolvedValue(undefined),
      listReaders: jest
        .fn()
        .mockResolvedValue([
          { userId: 'manager-1', displayName: 'Менеджер', readAt: NOW } as MessageReaderView,
        ]),
      isMuted: jest.fn().mockResolvedValue(false),
      setMute: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<
      Pick<
        ChatService,
        | 'listMessages'
        | 'sendMessage'
        | 'editMessage'
        | 'deleteMessage'
        | 'markRead'
        | 'listReaders'
        | 'isMuted'
        | 'setMute'
      >
    >;

    const controller = new ChatController(chatService as unknown as ChatService);
    const req = {
      user: {
        userId: opts.userId ?? 'executor-1',
        tokenId: 't1',
        role: opts.role ?? Role.EXECUTOR,
      },
    } as AuthenticatedRequest;

    return { controller, chatService, req };
  }

  it('возвращает историю Сообщений с вложениями в форме контракта (Req 5.1, 11.10)', async () => {
    const { controller, chatService, req } = buildController();
    const list = await controller.listMessages(TASK_ID, req);
    expect(chatService.listMessages).toHaveBeenCalledWith('executor-1', TASK_ID);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: MESSAGE_ID,
      taskId: TASK_ID,
      chatId: 'chat-1',
      createdAt: NOW.toISOString(),
      editedAt: null,
      deleted: false,
    });
    expect(list[0]?.attachments?.[0]).toEqual({
      id: 'att-1',
      messageId: MESSAGE_ID,
      originalName: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      hasThumbnail: true,
      compression: 'zstd',
      checksum: 'abc123',
      createdAt: NOW.toISOString(),
    });
  });

  it('отправляет Сообщение, пробрасывая отправителя, taskId и вложения (Req 5.2)', async () => {
    const { controller, chatService, req } = buildController();
    const view = await controller.send(
      TASK_ID,
      { text: 'Новое сообщение', attachmentIds: ['a1'] },
      req,
    );
    expect(chatService.sendMessage).toHaveBeenCalledWith('executor-1', TASK_ID, 'Новое сообщение', [
      'a1',
    ]);
    expect(view).toMatchObject({ id: 'message-new', taskId: TASK_ID, text: 'Новое сообщение' });
  });

  it('подставляет пустой список вложений, когда он не передан (Req 5.2)', async () => {
    const { controller, chatService, req } = buildController();
    await controller.send(TASK_ID, { text: 'Без вложений' }, req);
    expect(chatService.sendMessage).toHaveBeenCalledWith('executor-1', TASK_ID, 'Без вложений', []);
  });

  it('читает и обновляет настройку MAX-уведомлений задачи', async () => {
    const { controller, chatService, req } = buildController();

    await expect(controller.getMaxNotifications(TASK_ID, req)).resolves.toEqual({ muted: false });
    await expect(controller.updateMaxNotifications(TASK_ID, { muted: true }, req)).resolves.toEqual(
      { muted: true },
    );

    expect(chatService.isMuted).toHaveBeenCalledWith('executor-1', TASK_ID);
    expect(chatService.setMute).toHaveBeenCalledWith('executor-1', TASK_ID, true);
  });

  it('редактирует Сообщение и возвращает представление с меткой «изменено» (Req 5.3, 11.5)', async () => {
    const { controller, chatService, req } = buildController();
    const view = await controller.edit(MESSAGE_ID, { text: 'Изменённый текст' }, req);
    expect(chatService.editMessage).toHaveBeenCalledWith(
      'executor-1',
      MESSAGE_ID,
      'Изменённый текст',
    );
    expect(view).toMatchObject({
      id: MESSAGE_ID,
      taskId: TASK_ID,
      text: 'Изменённый текст',
      editedAt: EDITED.toISOString(),
    });
  });

  it('пробрасывает отказ прав при редактировании без раскрытия (Req 5.3, 11.6)', async () => {
    const { controller, chatService, req } = buildController({ userId: 'outsider-1' });
    chatService.editMessage.mockRejectedValueOnce(new AccessDeniedException('нет прав'));
    await expect(controller.edit(MESSAGE_ID, { text: 'Чужая правка' }, req)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });

  it('пробрасывает отказ прав при удалении (Req 5.4, 11.6)', async () => {
    const { controller, chatService, req } = buildController({ userId: 'outsider-1' });
    chatService.deleteMessage.mockRejectedValueOnce(new AccessDeniedException('нет прав'));
    await expect(controller.remove(MESSAGE_ID, req)).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('пробрасывает ошибку валидации длины из сервиса (Req 5.2, 11.4)', async () => {
    const { controller, chatService, req } = buildController();
    chatService.sendMessage.mockRejectedValueOnce(new ValidationException('слишком длинно'));
    await expect(controller.send(TASK_ID, { text: 'x' }, req)).rejects.toBeInstanceOf(
      ValidationException,
    );
  });

  it('удаляет Сообщение через сервис (Req 5.4)', async () => {
    const { controller, chatService, req } = buildController();
    await controller.remove(MESSAGE_ID, req);
    expect(chatService.deleteMessage).toHaveBeenCalledWith('executor-1', MESSAGE_ID);
  });

  it('отмечает Сообщение прочитанным через сервис (Req 5.5)', async () => {
    const { controller, chatService, req } = buildController();
    await controller.markRead(MESSAGE_ID, req);
    expect(chatService.markRead).toHaveBeenCalledWith('executor-1', MESSAGE_ID);
  });

  it('возвращает список прочитавших в форме контракта (Req 5.6, 11.8)', async () => {
    const { controller, chatService, req } = buildController();
    const readers = await controller.readers(MESSAGE_ID, req);
    expect(chatService.listReaders).toHaveBeenCalledWith('executor-1', MESSAGE_ID);
    expect(readers).toEqual([
      { userId: 'manager-1', displayName: 'Менеджер', readAt: NOW.toISOString() },
    ]);
  });

  it('возвращает 204 на удаление и отметку прочтения (Req 5.4, 5.5)', () => {
    const deleteCode = Reflect.getMetadata('__httpCode__', ChatController.prototype.remove);
    const readCode = Reflect.getMetadata('__httpCode__', ChatController.prototype.markRead);
    expect(deleteCode).toBe(204);
    expect(readCode).toBe(204);
  });

  it('SessionAuthGuard объявлен на контроллере (Req 1.5)', () => {
    const guards = Reflect.getMetadata('__guards__', ChatController) as unknown[];
    expect(guards).toContain(SessionAuthGuard);
  });
});
