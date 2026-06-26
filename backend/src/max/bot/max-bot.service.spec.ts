import { Task, User } from '@prisma/client';
import { AttachmentsService, UploadFile } from '../../attachments';
import { ChatService } from '../../chat';
import { AccessDeniedException, ValidationException } from '../../common/errors';
import { AppConfigService } from '../../config';
import { UserRepository } from '../../repositories';
import { TasksService } from '../../tasks';
import { MaxBotService } from './max-bot.service';

const ACTIVE_USER = { id: 'user-1', role: 'EXECUTOR' } as unknown as User;

interface Harness {
  service: MaxBotService;
  findActiveUserByMaxUserId: jest.Mock;
  setMaxMutedAllByMaxUserId: jest.Mock;
  listVisible: jest.Mock;
  sendMessage: jest.Mock;
  setMute: jest.Mock;
  markRead: jest.Mock;
  uploadToTask: jest.Mock;
}

function createHarness(options?: { user?: User | null }): Harness {
  const findActiveUserByMaxUserId = jest
    .fn()
    .mockResolvedValue(options !== undefined && 'user' in options ? options.user : ACTIVE_USER);
  const setMaxMutedAllByMaxUserId = jest.fn().mockResolvedValue(undefined);
  const userRepository = {
    findActiveUserByMaxUserId,
    setMaxMutedAllByMaxUserId,
  } as unknown as UserRepository;

  const listVisible = jest.fn().mockResolvedValue({
    items: [{ id: 'task-1', title: 'T1', status: 'IN_PROGRESS' } as unknown as Task],
    meta: {},
  });
  const tasks = { listVisible } as unknown as TasksService;

  const sendMessage = jest.fn().mockResolvedValue({ id: 'msg-1' });
  const setMute = jest.fn().mockResolvedValue(undefined);
  const markRead = jest.fn().mockResolvedValue(undefined);
  const chat = { sendMessage, setMute, markRead } as unknown as ChatService;

  const upload = jest
    .fn()
    .mockResolvedValue({ attachment: { id: 'att-1' }, createdAt: new Date() });
  const attachments = { uploadToTask: upload } as unknown as AttachmentsService;

  const config = {
    limits: { maxAttachmentsPerMessage: 10, attachmentMaxBytes: 26214400 },
  } as unknown as AppConfigService;

  const service = new MaxBotService(userRepository, tasks, chat, attachments, config);
  return {
    service,
    findActiveUserByMaxUserId,
    setMaxMutedAllByMaxUserId,
    listVisible,
    sendMessage,
    setMute,
    markRead,
    uploadToTask: upload,
  };
}

const file = (overrides: Partial<UploadFile> = {}): UploadFile => ({
  originalName: 'f.bin',
  mimeType: 'application/octet-stream',
  content: Buffer.from('x'),
  ...overrides,
});

describe('MaxBotService', () => {
  describe('идентификация по профилю MAX (Req 16.1, 16.2)', () => {
    it('отклоняет команду непривязанного профиля MAX', async () => {
      const h = createHarness({ user: null });
      await expect(h.service.listTasks('max-x')).rejects.toBeInstanceOf(AccessDeniedException);
      expect(h.listVisible).not.toHaveBeenCalled();
    });
  });

  describe('listTasks (Req 16.7)', () => {
    it('делегирует видимость TasksService.listVisible и возвращает элементы страницы', async () => {
      const h = createHarness();
      const result = await h.service.listTasks('max-1');
      expect(h.findActiveUserByMaxUserId).toHaveBeenCalledWith('max-1');
      expect(h.listVisible).toHaveBeenCalledWith('user-1', expect.anything());
      expect(result).toEqual([{ id: 'task-1', title: 'T1', status: 'IN_PROGRESS' }]);
    });
  });

  describe('sendMessageFromBot (Req 16.8, 16.10, 16.11)', () => {
    it('отправляет сообщение и прикрепляет вложения через существующие сервисы', async () => {
      const h = createHarness();
      await h.service.sendMessageFromBot('max-1', 'task-1', 'привет', [file(), file()]);
      // Вложения загружаются как «висящие» в Задачу, затем привязываются при
      // отправке Сообщения по их идентификаторам (Req 12.1–12.5).
      expect(h.uploadToTask).toHaveBeenCalledTimes(2);
      expect(h.uploadToTask).toHaveBeenCalledWith('user-1', 'task-1', expect.anything());
      expect(h.sendMessage).toHaveBeenCalledWith('user-1', 'task-1', 'привет', ['att-1', 'att-1']);
    });

    it('отклоняет при превышении лимита количества вложений ДО отправки (Req 16.10)', async () => {
      const h = createHarness();
      const files = Array.from({ length: 11 }, () => file());
      await expect(
        h.service.sendMessageFromBot('max-1', 'task-1', 'текст', files),
      ).rejects.toBeInstanceOf(ValidationException);
      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.uploadToTask).not.toHaveBeenCalled();
    });

    it('отклоняет при превышении заявленного размера вложения ДО отправки (Req 16.11)', async () => {
      const h = createHarness();
      await expect(
        h.service.sendMessageFromBot('max-1', 'task-1', 'текст', [
          file({ declaredSize: 26214401 }),
        ]),
      ).rejects.toBeInstanceOf(ValidationException);
      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.uploadToTask).not.toHaveBeenCalled();
    });
  });

  describe('setMuteFromBot (Req 16.9)', () => {
    it('делегирует ChatService.setMute', async () => {
      const h = createHarness();
      await h.service.setMuteFromBot('max-1', 'task-1', true);
      expect(h.setMute).toHaveBeenCalledWith('user-1', 'task-1', true);
    });
  });

  describe('unsubscribeAll / resubscribeAll (Req 16.5)', () => {
    it('включает полную отписку (mutedAll=true)', async () => {
      const h = createHarness();
      await h.service.unsubscribeAll('max-1');
      expect(h.setMaxMutedAllByMaxUserId).toHaveBeenCalledWith('max-1', true);
    });

    it('снимает полную отписку (mutedAll=false)', async () => {
      const h = createHarness();
      await h.service.resubscribeAll('max-1');
      expect(h.setMaxMutedAllByMaxUserId).toHaveBeenCalledWith('max-1', false);
    });
  });

  describe('unsubscribeTask (Req 16.6)', () => {
    it('заглушает уведомления конкретной задачи', async () => {
      const h = createHarness();
      await h.service.unsubscribeTask('max-1', 'task-1');
      expect(h.setMute).toHaveBeenCalledWith('user-1', 'task-1', true);
    });
  });

  describe('onMessageSeen (Req 16.12)', () => {
    it('делегирует ChatService.markRead для очистки уведомления о сообщении', async () => {
      const h = createHarness();
      await h.service.onMessageSeen('max-1', 'msg-1');
      expect(h.markRead).toHaveBeenCalledWith('user-1', 'msg-1');
    });
  });
});
