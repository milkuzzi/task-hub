import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessageItem, type ChatMessageItemProps } from './ChatMessageItem';
import type { ChatMessage } from '@/lib/chat-api';

/**
 * Exploratory-тест условия дефекта 5 (реактивный счётчик «Прочитали») — задача 13.
 *
 * **Property 9: Bug Condition** — Реактивный счётчик «Прочитали».
 *
 * --- Что воспроизводим ---
 *
 * `isBugCondition_5`: другой Участник прочитал Сообщение, сервер транслировал
 * `chat:reads`, при этом список прочитавших у получателя НЕ раскрыт вручную.
 * Ожидаемое корректное поведение (Req 2.5 / Property 9): счётчик «Прочитали»
 * обновляется в реальном времени БЕЗ ручного раскрытия списка.
 *
 * --- Локализация причины (design.md, Hypothesized Root Cause #5) ---
 *
 * `ChatMessageItem` вычисляет счётчик исключительно как `readers?.length ?? 0`,
 * где `readers` — это ПОЛНЫЙ список прочитавших. Для свёрнутого Сообщения полный
 * список не загружен (`readers === undefined`), поэтому счётчик жёстко равен 0 и
 * не имеет отдельного реактивного источника, обновляемого событием `chat:reads`
 * независимо от факта загрузки полного списка. Корректная архитектура (фикс,
 * задача 15) даёт компоненту устойчивый счётчик прочитавших по `messageId`,
 * обновляемый каждым `chat:reads`.
 *
 * --- Моделирование события `chat:reads` ---
 *
 * Сообщение свёрнуто (полный список НЕ раскрыт: `readers={undefined}`). Событие
 * `chat:reads` сообщает, что Сообщение прочитали 2 Участника, и это значение
 * подаётся компоненту через реактивный источник счётчика (`readCount`). Property 9
 * требует, чтобы счётчик отразил 2 без ручного раскрытия списка.
 *
 * **CRITICAL**: тест запускается на НЕИСПРАВЛЕННОМ коде и ДОЛЖЕН ПАДАТЬ —
 * у `ChatMessageItem` нет реактивного источника счётчика, поэтому счётчик
 * остаётся «Прочитали: 0». Падение подтверждает дефект 5. Чинить тест/код на
 * этом этапе НЕЛЬЗЯ.
 */

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    taskId: 'task-1',
    chatId: 'chat-1',
    authorId: 'author-1',
    authorDisplayName: 'Иван Петров',
    text: 'Сообщение для проверки счётчика',
    createdAt: '2024-01-01T00:00:00.000Z',
    editedAt: null,
    deleted: false,
    ...overrides,
  };
}

/**
 * Пропсы свёрнутого Сообщения: полный список прочитавших НЕ загружен
 * (`readers === undefined`). `readCount` — реактивный источник счётчика, который
 * фикс должен учитывать; на неисправленном коде компонент его игнорирует.
 */
function collapsedProps(readCount: number): ChatMessageItemProps & { readCount: number } {
  return {
    message: message(),
    canModify: false,
    readers: undefined,
    readCount,
    onLoadReaders: vi.fn(),
    onEdit: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onOpenAttachment: vi.fn(),
  };
}

describe('ChatMessageItem — дефект 5 (реактивный счётчик «Прочитали»)', () => {
  it('Property 9: счётчик свёрнутого Сообщения обновляется по chat:reads без ручного раскрытия', () => {
    // До события chat:reads: Сообщение свёрнуто, никто не отмечен прочитавшим.
    const { rerender } = render(<ChatMessageItem {...collapsedProps(0)} />);
    expect(screen.getByText('Прочитали: 0')).toBeInTheDocument();

    // Событие chat:reads: 2 Участника прочитали Сообщение. Список НЕ раскрывается
    // вручную — обновление приходит через реактивный источник счётчика.
    rerender(<ChatMessageItem {...collapsedProps(2)} />);

    // Property 9: счётчик отражает новое значение в реальном времени без
    // ручного раскрытия. На НЕИСПРАВЛЕННОМ коде счётчик берётся из
    // `readers?.length ?? 0` (readers === undefined) и остаётся «Прочитали: 0»,
    // поэтому это утверждение ПАДАЕТ — падение подтверждает дефект 5.
    expect(screen.getByText('Прочитали: 2')).toBeInTheDocument();
    expect(screen.queryByText('Прочитали: 0')).not.toBeInTheDocument();
  });
});
