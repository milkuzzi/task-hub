import { evaluateSlidingWindow } from './sliding-window';

describe('evaluateSlidingWindow', () => {
  const windowMs = 60_000;
  const max = 10;

  it('допускает запрос при пустой истории', () => {
    const result = evaluateSlidingWindow([], 1_000, windowMs, max);
    expect(result.allowed).toBe(true);
    expect(result.retained).toEqual([1_000]);
  });

  it('допускает ровно первые 10 запросов в окне', () => {
    let history: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const now = 1_000 + i;
      const result = evaluateSlidingWindow(history, now, windowMs, max);
      expect(result.allowed).toBe(true);
      history = result.retained;
    }
    expect(history).toHaveLength(10);
  });

  it('отклоняет 11-й запрос в пределах окна и не сохраняет его метку', () => {
    const history = Array.from({ length: 10 }, (_, i) => 1_000 + i);
    const result = evaluateSlidingWindow(history, 1_500, windowMs, max);
    expect(result.allowed).toBe(false);
    expect(result.retained).toEqual(history);
  });

  it('исключает метки, вышедшие за границу окна, и снова допускает запрос', () => {
    // 10 запросов в момент 0; новый запрос ровно через окно — старые истекли.
    const history = Array.from({ length: 10 }, () => 0);
    const result = evaluateSlidingWindow(history, windowMs, windowMs, max);
    expect(result.allowed).toBe(true);
    expect(result.retained).toEqual([windowMs]);
  });

  it('считает метку строго на границе окна истёкшей', () => {
    const now = 100_000;
    const onBoundary = now - windowMs; // ровно начало окна → истекла
    const inside = now - windowMs + 1; // внутри окна
    const history = [onBoundary, ...Array.from({ length: 9 }, () => inside)];
    const result = evaluateSlidingWindow(history, now, windowMs, max);
    // 9 действительных + 1 истёкшая → 9 < 10 → допуск, истёкшая отброшена.
    expect(result.allowed).toBe(true);
    expect(result.retained).not.toContain(onBoundary);
    expect(result.retained).toHaveLength(10);
  });

  it('при maxRequests = 0 отклоняет любой запрос', () => {
    const result = evaluateSlidingWindow([], 1_000, windowMs, 0);
    expect(result.allowed).toBe(false);
    expect(result.retained).toEqual([]);
  });
});
