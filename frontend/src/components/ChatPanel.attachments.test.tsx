import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPanel } from './ChatPanel';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function renderPanel(onSend = vi.fn().mockResolvedValue(undefined)): HTMLElement {
  const { container } = render(
    <ChatPanel
      messages={[]}
      currentUserId="user-1"
      isModerator={false}
      readers={{}}
      readCounts={{}}
      onLoadReaders={vi.fn()}
      onSend={onSend}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onOpenAttachment={vi.fn()}
    />,
  );
  return container;
}

describe('ChatPanel — отправка вложений', () => {
  it('не делает кнопку выбора файла submit-кнопкой формы', () => {
    const container = renderPanel();

    const attachButton = screen.getByRole('button', { name: 'Прикрепить файл' });
    const sendButton = screen.getByRole('button', { name: 'Отправить' });
    expect(container.querySelector('form')).toBeNull();
    expect(attachButton).toHaveAttribute('type', 'button');
    expect(sendButton).toHaveAttribute('type', 'button');
    expect((attachButton as HTMLButtonElement).form).toBeNull();
    expect((sendButton as HTMLButtonElement).form).toBeNull();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    expect(fileInput?.form).toBeNull();
    expect(fileInput).toHaveAttribute('aria-hidden', 'true');
  });

  it('позволяет отправить выбранный файл без текста сообщения', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);
    const container = renderPanel(onSend);

    const file = new File(['content'], 'report.pdf', { type: 'application/pdf' });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith('', [file]);
    expect(
      screen.queryByText('Текст сообщения должен содержать от 1 до 4000 символов.'),
    ).not.toBeInTheDocument();
  });
});
