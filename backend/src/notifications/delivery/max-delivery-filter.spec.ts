import { MaxLink } from '@prisma/client';
import { ChatMuteRepository, UserRepository } from '../../repositories';
import { MaxDeliveryFilter, MaxDeliveryTarget } from './max-delivery-filter';

/** Создаёт фильтр с замоканными репозиториями. */
function createFilter(options?: { link?: Pick<MaxLink, 'mutedAll'> | null; muted?: boolean }): {
  filter: MaxDeliveryFilter;
  findMaxLinkByUserId: jest.Mock;
  isMuted: jest.Mock;
} {
  const findMaxLinkByUserId = jest
    .fn()
    .mockResolvedValue(options !== undefined && 'link' in options ? options.link : null);
  const userRepository = { findMaxLinkByUserId } as unknown as UserRepository;

  const isMuted = jest.fn().mockResolvedValue(options?.muted ?? false);
  const chatMuteRepository = { isMuted } as unknown as ChatMuteRepository;

  const filter = new MaxDeliveryFilter(userRepository, chatMuteRepository);
  return { filter, findMaxLinkByUserId, isMuted };
}

const target = (overrides: Partial<MaxDeliveryTarget> = {}): MaxDeliveryTarget => ({
  recipientId: 'user-1',
  taskId: 'task-1',
  ...overrides,
});

describe('MaxDeliveryFilter.isSuppressed', () => {
  it('подавляет доставку при полной отписке (mutedAll) — Req 16.5', async () => {
    const { filter, isMuted } = createFilter({ link: { mutedAll: true } });

    await expect(filter.isSuppressed(target())).resolves.toBe(true);
    // При полной отписке проверка заглушения отдельной задачи не требуется.
    expect(isMuted).not.toHaveBeenCalled();
  });

  it('подавляет доставку при заглушении/отписке от задачи — Req 16.6, 16.9', async () => {
    const { filter, isMuted } = createFilter({ link: { mutedAll: false }, muted: true });

    await expect(filter.isSuppressed(target())).resolves.toBe(true);
    expect(isMuted).toHaveBeenCalledWith('user-1', 'task-1');
  });

  it('не подавляет доставку без отписки и без заглушения', async () => {
    const { filter } = createFilter({ link: { mutedAll: false }, muted: false });

    await expect(filter.isSuppressed(target())).resolves.toBe(false);
  });

  it('не подавляет доставку при отсутствии привязки MAX', async () => {
    const { filter, isMuted } = createFilter({ link: null });

    await expect(filter.isSuppressed(target())).resolves.toBe(false);
    // Без привязки проверять заглушение задачи также допустимо, но решение — не подавлять.
    expect(isMuted).toHaveBeenCalledWith('user-1', 'task-1');
  });

  it('не проверяет заглушение задачи для уведомления без taskId', async () => {
    const { filter, isMuted } = createFilter({ link: { mutedAll: false } });

    await expect(filter.isSuppressed(target({ taskId: null }))).resolves.toBe(false);
    expect(isMuted).not.toHaveBeenCalled();
  });
});
