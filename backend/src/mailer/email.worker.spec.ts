import { Job } from 'bullmq';
import { AppConfigService } from '../config';
import { EmailWorker } from './email.worker';
import { MailerService } from './mailer.service';
import { EmailMessage, MailerProvider } from './mailer.types';

/** Доступ к приватному обработчику неудач для целевого юнит-теста. */
type FailureHandler = (job: Job<EmailMessage> | undefined, error: Error) => void;

describe('EmailWorker.handleFailure', () => {
  const message: EmailMessage = {
    to: 'user@example.com',
    subject: 'Тема',
    html: '<p>Привет</p>',
  };

  function build(): {
    worker: EmailWorker;
    recordFailedDelivery: jest.Mock;
    invoke: FailureHandler;
  } {
    const config = {} as unknown as AppConfigService;
    const recordFailedDelivery = jest.fn();
    const mailer = { recordFailedDelivery } as unknown as MailerService;
    const provider = { send: jest.fn() } as unknown as MailerProvider;
    const worker = new EmailWorker(config, mailer, provider);
    const invoke = (worker as unknown as { handleFailure: FailureHandler }).handleFailure.bind(
      worker,
    );
    return { worker, recordFailedDelivery, invoke };
  }

  function jobWith(attemptsMade: number, attempts = 3): Job<EmailMessage> {
    return {
      data: message,
      attemptsMade,
      opts: { attempts },
    } as unknown as Job<EmailMessage>;
  }

  it('фиксирует неуспешную доставку после исчерпания всех попыток', () => {
    const { recordFailedDelivery, invoke } = build();

    invoke(jobWith(3, 3), new Error('сервис недоступен'));

    expect(recordFailedDelivery).toHaveBeenCalledTimes(1);
    expect(recordFailedDelivery).toHaveBeenCalledWith(message, 3, 'сервис недоступен');
  });

  it('не фиксирует окончательную неудачу, пока остаются попытки', () => {
    const { recordFailedDelivery, invoke } = build();

    invoke(jobWith(1, 3), new Error('временная ошибка'));

    expect(recordFailedDelivery).not.toHaveBeenCalled();
  });

  it('не падает при отсутствии данных задания', () => {
    const { recordFailedDelivery, invoke } = build();

    expect(() => invoke(undefined, new Error('нет задания'))).not.toThrow();
    expect(recordFailedDelivery).not.toHaveBeenCalled();
  });
});
