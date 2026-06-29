import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeStatistics, exportStatistics } from '@/lib/statistics-api';
import { StatisticsPage } from './StatisticsPage';

vi.mock('@/lib/statistics-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/statistics-api')>(
    '@/lib/statistics-api',
  );
  return {
    ...actual,
    computeStatistics: vi.fn(),
    exportStatistics: vi.fn(),
    downloadBlob: vi.fn(),
  };
});

const emptyStatistics = {
  statusCounts: {
    IN_PROGRESS: 0,
    WAITING: 0,
    DONE: 0,
    NEEDS_ADMIN: 0,
    CANCELLED: 0,
  },
  totalTasks: 0,
  overdueCount: 0,
  overduePercent: 0,
  avgCompletionHours: 0,
  byManager: [],
  byExecutor: [],
  chatActivity: {
    messageCount: 0,
    activeChats: 0,
  },
  hasData: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeStatistics).mockResolvedValue(emptyStatistics);
  vi.mocked(exportStatistics).mockResolvedValue(new Blob(['ok'], { type: 'text/csv' }));
});

describe('StatisticsPage export validation', () => {
  it('explains that export requires both dates before sending the request', async () => {
    const user = userEvent.setup();

    render(<StatisticsPage />);
    expect(await screen.findByText('За выбранный период данные отсутствуют.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Скачать CSV' }));

    expect(exportStatistics).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Для выгрузки статистики выберите дату начала и дату окончания.',
    );
  });
});
