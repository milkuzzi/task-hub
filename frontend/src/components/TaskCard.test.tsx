import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskCard } from './TaskCard';
import type { TaskCard as TaskCardModel } from '@/lib/tasks-api';

/**
 * Компонентные тесты карточки Задачи (Req 1.2, 2.8, 9.7, 9.8).
 *
 * Проверяют отображение Дедлайна в MSK (`ДД.ММ.ГГГГ ЧЧ:ММ`), насыщенный
 * счётчик Сообщений, маркер непрочитанного, видимость кнопки редактирования
 * и вызов колбэка открытия с самой карточки.
 */
function task(overrides: Partial<TaskCardModel> = {}): TaskCardModel {
  return {
    id: 'task-1',
    title: 'Подготовить отчёт',
    description: 'Краткое описание',
    deadline: '2024-01-02T09:30:00.000Z', // 12:30 MSK
    status: 'IN_PROGRESS',
    messageCount: 5,
    hasUnread: false,
    isOverdue: false,
    ...overrides,
  };
}

describe('TaskCard', () => {
  it('отображает Название и Дедлайн в формате MSK ДД.ММ.ГГГГ ЧЧ:ММ', () => {
    const { container } = render(<TaskCard task={task()} />);
    expect(screen.getByText('Подготовить отчёт')).toBeInTheDocument();
    expect(screen.getByText(/02\.01\.2024 12:30/)).toBeInTheDocument();
    expect(container.querySelector('article.task-record')).not.toBeNull();
  });

  it('показывает счётчик Сообщений', () => {
    render(<TaskCard task={task({ messageCount: 9999 })} />);
    expect(screen.getByText(/9999/)).toBeInTheDocument();
  });

  it('показывает маркер непрочитанного только при наличии непрочитанных', () => {
    const { rerender } = render(<TaskCard task={task({ hasUnread: true })} />);
    expect(screen.getByRole('status')).toBeInTheDocument();

    rerender(<TaskCard task={task({ hasUnread: false })} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('показывает индикатор «Просрочено» только для просроченной Задачи', () => {
    const { rerender } = render(<TaskCard task={task({ isOverdue: true })} />);
    expect(screen.getByText('Просрочено')).toBeInTheDocument();

    rerender(<TaskCard task={task({ isOverdue: false })} />);
    expect(screen.queryByText('Просрочено')).not.toBeInTheDocument();
  });

  it('не рендерит отдельные кнопки «Открыть» и «Изменить»', () => {
    render(<TaskCard task={task()} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Открыть' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Изменить' })).not.toBeInTheDocument();
  });

  it('вызывает onOpen с идентификатором Задачи при клике и с клавиатуры', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<TaskCard task={task()} onOpen={onOpen} />);

    const card = screen.getByRole('button', { name: 'Открыть: Подготовить отчёт' });

    await user.click(card);
    expect(onOpen).toHaveBeenCalledWith('task-1');

    card.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(3);
  });
});
