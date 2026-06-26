import { QueueName, QueueService } from '../infra';
import { EMAIL_JOB_NAME, EMAIL_JOB_OPTIONS, MAX_EMAIL_ATTEMPTS } from './mailer.constants';
import { MailerService } from './mailer.service';
import { EmailMessage } from './mailer.types';

describe('MailerService', () => {
  const message: EmailMessage = {
    to: 'user@example.com',
    subject: 'Тема',
    html: '<p>Привет</p>',
  };

  function createService(): { service: MailerService; add: jest.Mock } {
    const add = jest.fn().mockResolvedValue(undefined);
    const queue = { add } as unknown as QueueService;
    return { service: new MailerService(queue), add };
  }

  it('ставит письмо в очередь email с политикой ретраев ≤3 попыток', async () => {
    const { service, add } = createService();

    await service.enqueue(message);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(QueueName.Email, EMAIL_JOB_NAME, message, EMAIL_JOB_OPTIONS);
    expect(EMAIL_JOB_OPTIONS.attempts).toBe(MAX_EMAIL_ATTEMPTS);
    expect(EMAIL_JOB_OPTIONS.attempts).toBeLessThanOrEqual(3);
  });

  it('сохраняет неуспешные задания в очереди (removeOnFail: false)', () => {
    expect(EMAIL_JOB_OPTIONS.removeOnFail).toBe(false);
  });

  it('фиксирует факт окончательно неуспешной доставки без выброса исключения', () => {
    const { service } = createService();
    const errorSpy = jest
      .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation(() => undefined);

    expect(() =>
      service.recordFailedDelivery(message, MAX_EMAIL_ATTEMPTS, 'сервис недоступен'),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0]?.[0] ?? '';
    expect(logged).toContain(message.to);
    expect(logged).toContain('сохранено в очереди');
  });
});
