import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAuthedImage } from './use-authed-image';

/**
 * Юнит-тесты хука загрузки защищённого изображения (Req 5.7, 12.6).
 *
 * Проверяют: успешная загрузка возвращает Object URL; отказ (например, 404)
 * выставляет `error` без «битой» картинки; пустой `fetcher` ничего не грузит;
 * Object URL освобождается при размонтировании (отсутствие утечек).
 *
 * `URL.createObjectURL`/`revokeObjectURL` подменены в `src/test/setup.ts`.
 */
describe('useAuthedImage', () => {
  it('возвращает Object URL после успешной загрузки', async () => {
    const blob = new Blob(['img'], { type: 'image/png' });
    const fetcher = vi.fn().mockResolvedValue(blob);

    const { result } = renderHook(() => useAuthedImage(fetcher, []));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.src).toMatch(/^blob:/);
    expect(result.current.error).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('выставляет error при отказе загрузки (например, 404)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('404'));

    const { result } = renderHook(() => useAuthedImage(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.src).toBeNull();
  });

  it('ничего не загружает, если fetcher отсутствует', () => {
    const { result } = renderHook(() => useAuthedImage(null, []));

    expect(result.current.loading).toBe(false);
    expect(result.current.src).toBeNull();
    expect(result.current.error).toBe(false);
  });

  it('освобождает Object URL при размонтировании', async () => {
    const blob = new Blob(['img'], { type: 'image/png' });
    const fetcher = vi.fn().mockResolvedValue(blob);
    const revokeSpy = vi.mocked(URL.revokeObjectURL);
    revokeSpy.mockClear();

    const { result, unmount } = renderHook(() => useAuthedImage(fetcher, []));
    await waitFor(() => expect(result.current.src).not.toBeNull());
    const createdUrl = result.current.src;

    unmount();

    expect(revokeSpy).toHaveBeenCalledWith(createdUrl);
  });
});
