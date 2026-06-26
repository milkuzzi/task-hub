import { Task } from '@prisma/client';
import { MaxBotApiPort } from './max-bot-api.port';
import { MaxBotSendMessageDto } from './max-bot.dto';
import { MaxBotService } from './max-bot.service';
import { MaxBotWebhookController } from './max-bot.webhook.controller';

interface Harness {
  controller: MaxBotWebhookController;
  listTasks: jest.Mock;
  sendMessageFromBot: jest.Mock;
  onMessageSeen: jest.Mock;
  setMuteFromBot: jest.Mock;
  unsubscribeAll: jest.Mock;
  resubscribeAll: jest.Mock;
  unsubscribeTask: jest.Mock;
  sendTaskList: jest.Mock;
  reply: jest.Mock;
  downloadAttachment: jest.Mock;
}

function createHarness(): Harness {
  const listTasks = jest
    .fn()
    .mockResolvedValue([{ id: 'task-1', title: 'T', status: 'IN_PROGRESS' } as unknown as Task]);
  const sendMessageFromBot = jest.fn().mockResolvedValue(undefined);
  const onMessageSeen = jest.fn().mockResolvedValue(undefined);
  const setMuteFromBot = jest.fn().mockResolvedValue(undefined);
  const unsubscribeAll = jest.fn().mockResolvedValue(undefined);
  const resubscribeAll = jest.fn().mockResolvedValue(undefined);
  const unsubscribeTask = jest.fn().mockResolvedValue(undefined);
  const bot = {
    listTasks,
    sendMessageFromBot,
    onMessageSeen,
    setMuteFromBot,
    unsubscribeAll,
    resubscribeAll,
    unsubscribeTask,
  } as unknown as MaxBotService;

  const sendTaskList = jest.fn().mockResolvedValue(undefined);
  const reply = jest.fn().mockResolvedValue(undefined);
  const downloadAttachment = jest.fn().mockResolvedValue({
    originalName: 'f.bin',
    mimeType: 'application/octet-stream',
    content: Buffer.from('x'),
  });
  const api = { sendTaskList, reply, downloadAttachment } as unknown as MaxBotApiPort;

  const controller = new MaxBotWebhookController(bot, api);
  return {
    controller,
    listTasks,
    sendMessageFromBot,
    onMessageSeen,
    setMuteFromBot,
    unsubscribeAll,
    resubscribeAll,
    unsubscribeTask,
    sendTaskList,
    reply,
    downloadAttachment,
  };
}

describe('MaxBotWebhookController (Req 16.4)', () => {
  it('маршрутизирует список задач и отправляет его через Bot API (Req 16.7)', async () => {
    const h = createHarness();
    const result = await h.controller.listTasks({ maxUserId: 'max-1' });
    expect(h.listTasks).toHaveBeenCalledWith('max-1');
    expect(h.sendTaskList).toHaveBeenCalledWith('max-1', [
      { id: 'task-1', title: 'T', status: 'IN_PROGRESS' },
    ]);
    expect(result).toEqual({ count: 1 });
  });

  it('загружает содержимое вложений и отправляет сообщение (Req 16.8, 16.10)', async () => {
    const h = createHarness();
    const dto: MaxBotSendMessageDto = {
      maxUserId: 'max-1',
      taskId: 'task-1',
      text: 'привет',
      attachments: [
        { originalName: 'f.bin', mimeType: 'application/octet-stream', downloadToken: 'tok-1' },
      ],
    };
    await h.controller.sendMessage(dto);
    expect(h.downloadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ downloadToken: 'tok-1' }),
    );
    expect(h.sendMessageFromBot).toHaveBeenCalledWith('max-1', 'task-1', 'привет', [
      expect.objectContaining({ originalName: 'f.bin' }),
    ]);
  });

  it('маршрутизирует отметку просмотра сообщения (Req 16.12)', async () => {
    const h = createHarness();
    await h.controller.messageSeen({ maxUserId: 'max-1', messageId: 'msg-1' });
    expect(h.onMessageSeen).toHaveBeenCalledWith('max-1', 'msg-1');
  });

  it('маршрутизирует заглушение чата (Req 16.9)', async () => {
    const h = createHarness();
    await h.controller.setMute({ maxUserId: 'max-1', taskId: 'task-1', muted: true });
    expect(h.setMuteFromBot).toHaveBeenCalledWith('max-1', 'task-1', true);
  });

  it('маршрутизирует полную отписку и её отмену (Req 16.5)', async () => {
    const h = createHarness();
    await h.controller.unsubscribeAll({ maxUserId: 'max-1' });
    await h.controller.resubscribeAll({ maxUserId: 'max-1' });
    expect(h.unsubscribeAll).toHaveBeenCalledWith('max-1');
    expect(h.resubscribeAll).toHaveBeenCalledWith('max-1');
  });

  it('маршрутизирует отписку от задачи (Req 16.6)', async () => {
    const h = createHarness();
    await h.controller.unsubscribeTask({ maxUserId: 'max-1', taskId: 'task-1' });
    expect(h.unsubscribeTask).toHaveBeenCalledWith('max-1', 'task-1');
  });
});
