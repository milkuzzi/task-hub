import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, http } from './api';
import { listNotifications } from './notifications-api';
import { computeStatistics } from './statistics-api';
import { listDeletedUsers, listUsers } from './users-api';

vi.mock('./api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  http: {
    get: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('central API runtime contracts', () => {
  it('rejects malformed active and deleted user lists', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce([{ id: 'u1', email: 42 }])
      .mockResolvedValueOnce([{ id: 'u2', emails: 'not-an-array' }]);

    await expect(listUsers()).rejects.toThrow('Некорректный ответ API');
    await expect(listDeletedUsers()).rejects.toThrow('Некорректный ответ API');
  });

  it('rejects malformed notifications', async () => {
    vi.mocked(api.get).mockResolvedValue([{ id: 'n1', createdAt: 'not-a-date' }]);

    await expect(listNotifications()).rejects.toThrow('Некорректный ответ API');
  });

  it('rejects malformed statistics', async () => {
    vi.mocked(http.get).mockResolvedValue({
      data: { totalTasks: 10, statusCounts: {} },
    });

    await expect(computeStatistics()).rejects.toThrow('Некорректный ответ API');
  });
});
