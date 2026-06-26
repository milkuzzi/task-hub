import { EMAIL_JOB_OPTIONS, MAX_EMAIL_ATTEMPTS, hasExhaustedAttempts } from './mailer.constants';

describe('mailer constants', () => {
  it('ограничивает число попыток отправки тремя', () => {
    expect(MAX_EMAIL_ATTEMPTS).toBe(3);
    expect(EMAIL_JOB_OPTIONS.attempts).toBe(3);
  });

  it('использует экспоненциальный backoff между попытками', () => {
    expect(EMAIL_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });
});

describe('hasExhaustedAttempts', () => {
  it('возвращает false, пока попытки не исчерпаны', () => {
    expect(hasExhaustedAttempts(1, 3)).toBe(false);
    expect(hasExhaustedAttempts(2, 3)).toBe(false);
  });

  it('возвращает true при достижении лимита попыток', () => {
    expect(hasExhaustedAttempts(3, 3)).toBe(true);
    expect(hasExhaustedAttempts(4, 3)).toBe(true);
  });
});
