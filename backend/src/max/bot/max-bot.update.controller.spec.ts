import { MaxBotApiPort } from './max-bot-api.port';
import { MaxBotAuthService } from './max-bot-auth.service';
import { MaxBotUpdateController } from './max-bot.update.controller';

describe('MaxBotUpdateController mini-app launcher', () => {
  const reply = jest.fn();
  const handleBotStarted = jest.fn();
  const auth = { handleBotStarted } as unknown as MaxBotAuthService;
  const api = { reply } as unknown as MaxBotApiPort;
  let controller: MaxBotUpdateController;

  beforeEach(() => {
    reply.mockReset().mockResolvedValue(undefined);
    handleBotStarted.mockReset().mockResolvedValue({ handled: false });
    controller = new MaxBotUpdateController(auth, api);
  });

  it('отвечает единственной кнопкой запуска mini-app на bot_started', async () => {
    await expect(
      controller.receive({ update_type: 'bot_started', user: { user_id: 'max-1' } }),
    ).resolves.toEqual({ ok: true });

    expect(reply).toHaveBeenCalledWith('max-1', 'Откройте Систему поручений в mini-app.', [
      [{ type: 'open_app', text: 'Открыть' }],
    ]);
  });

  it('сохраняет подтверждение существующей привязки через payload', async () => {
    handleBotStarted.mockResolvedValueOnce({ handled: true, message: 'Профиль MAX привязан.' });
    await controller.receive({
      update_type: 'bot_started',
      user: { user_id: 'max-1' },
      payload: 'th_link_state',
    });

    expect(handleBotStarted).toHaveBeenCalledWith('max-1', 'th_link_state');
    expect(reply).toHaveBeenCalledWith('max-1', 'Профиль MAX привязан.', [
      [{ type: 'open_app', text: 'Открыть' }],
    ]);
  });

  it('перенаправляет любые текстовые команды в mini-app', async () => {
    await controller.receive({
      update_type: 'message_created',
      message: { sender: { user_id: 'max-1' }, body: { text: '/tasks' } },
    });

    expect(reply).toHaveBeenCalledWith('max-1', 'Работа с задачами доступна в mini-app.', [
      [{ type: 'open_app', text: 'Открыть' }],
    ]);
  });

  it('игнорирует устаревшие callback-события', async () => {
    await controller.receive({ update_type: 'message_callback', user: { user_id: 'max-1' } });
    expect(reply).not.toHaveBeenCalled();
  });
});
