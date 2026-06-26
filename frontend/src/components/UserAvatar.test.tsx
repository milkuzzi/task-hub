import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAvatarBlob } from '@/lib/avatar';
import { UserAvatar } from './UserAvatar';

vi.mock('@/lib/avatar', async () => {
  const actual = await vi.importActual<typeof import('@/lib/avatar')>('@/lib/avatar');
  return { ...actual, fetchAvatarBlob: vi.fn() };
});

const mockedFetchAvatar = vi.mocked(fetchAvatarBlob);

beforeEach(() => {
  mockedFetchAvatar.mockResolvedValue(new Blob(['avatar'], { type: 'image/png' }));
});

afterEach(() => {
  mockedFetchAvatar.mockReset();
});

describe('UserAvatar', () => {
  it('does not request avatar bytes when the API reports no avatar', () => {
    const { container } = render(<UserAvatar userId="user-1" hasAvatar={false} />);

    expect(mockedFetchAvatar).not.toHaveBeenCalled();
    expect(container.querySelector('.user-avatar--placeholder')).toBeInTheDocument();
  });

  it('keeps server-probed loading when avatar presence is unknown', async () => {
    render(<UserAvatar userId="user-1" />);

    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('user-1'));
    expect(await screen.findByRole('img', { name: 'Аватар пользователя' })).toBeInTheDocument();
  });
});
