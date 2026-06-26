import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from '@phosphor-icons/react';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_MESSAGE_MAX,
  MESSAGE_TEXT_BOUNDS,
  type AttachmentMeta,
  type ChatMessage,
  type MessageReader,
} from '@/lib/chat-api';
import { ChatMessageItem } from './ChatMessageItem';

/**
 * Панель Чата Задачи: лента Сообщений и форма отправки (Req 11.3–11.8).
 *
 * Лента показывает Сообщения в хронологическом порядке (старые → новые) с
 * метками «изменено»/«Сообщение удалено» (Req 11.5, 11.7), списком прочитавших
 * (Req 11.8) и Вложениями (Req 12.6, 12.7). Форма отправки валидирует длину
 * текста (1–4000, Req 11.3, 11.4) и количество прикреплённых файлов (≤10,
 * Req 11.9), а также размер каждого файла (≤25 МБ, Req 12.2) до отправки.
 *
 * Лента автоматически прокручивается к последнему Сообщению при изменении
 * количества Сообщений.
 */
export interface ChatPanelProps {
  messages: ChatMessage[];
  /** Идентификатор текущего Пользователя (для прав изменения Сообщения). */
  currentUserId: string;
  /** Является ли текущий Пользователь Менеджером Задачи или Администратором. */
  isModerator: boolean;
  /** Карта прочитавших по идентификатору Сообщения (Req 11.8). */
  readers: Record<string, MessageReader[] | undefined>;
  /**
   * Реактивный счётчик прочитавших по идентификатору Сообщения (Req 2.5,
   * Property 9). Обновляется каждым событием `chat:reads` независимо от факта
   * раскрытия полного списка прочитавших.
   */
  readCounts: Record<string, number | undefined>;
  onLoadReaders: (messageId: string) => void;
  onSend: (text: string, files: File[]) => Promise<void>;
  onEdit: (messageId: string, text: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onOpenAttachment: (attachment: AttachmentMeta) => void;
}

export function ChatPanel({
  messages,
  currentUserId,
  isModerator,
  readers,
  readCounts,
  onLoadReaders,
  onSend,
  onEdit,
  onDelete,
  onOpenAttachment,
}: ChatPanelProps): JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  /** Может ли текущий Пользователь изменять/удалять Сообщение (Req 11.6). */
  function canModify(message: ChatMessage): boolean {
    return isModerator || message.authorId === currentUserId;
  }

  function handleSelectFiles(event: React.ChangeEvent<HTMLInputElement>): void {
    event.stopPropagation();
    setError(null);
    const selected = Array.from(event.target.files ?? []);
    if (selected.length === 0) {
      return;
    }
    const tooBig = selected.find((f) => f.size > ATTACHMENT_MAX_BYTES);
    if (tooBig !== undefined) {
      setError(t('chat.errors.attachmentSize'));
      return;
    }
    const next = [...files, ...selected];
    if (next.length > ATTACHMENTS_PER_MESSAGE_MAX) {
      setError(t('chat.errors.attachmentsLimit'));
      return;
    }
    setFiles(next);
  }

  function removeFile(index: number): void {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(): Promise<void> {
    setError(null);
    const trimmed = text.trim();
    // Текст обязателен только для сообщений без вложений; длина 0/1–4000.
    if (
      trimmed.length > MESSAGE_TEXT_BOUNDS.max ||
      (trimmed.length < MESSAGE_TEXT_BOUNDS.min && files.length === 0)
    ) {
      setError(t('chat.errors.length'));
      return;
    }
    setBusy(true);
    try {
      await onSend(trimmed, files);
      setText('');
      setFiles([]);
      if (fileInputRef.current !== null) {
        fileInputRef.current.value = '';
      }
    } catch {
      setError(t('chat.errors.uploadFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-panel panel">
      <div className="chat-feed">
        {messages.length === 0 ? (
          <p className="text-muted">{t('chat.empty')}</p>
        ) : (
          messages.map((message) => (
            <ChatMessageItem
              key={message.id}
              message={message}
              canModify={canModify(message)}
              readers={readers[message.id]}
              readCount={readCounts[message.id]}
              onLoadReaders={onLoadReaders}
              onEdit={onEdit}
              onDelete={onDelete}
              onOpenAttachment={onOpenAttachment}
            />
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className="chat-composer stack">
        {error !== null && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {files.length > 0 && (
          <ul className="chat-composer__files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {f.name}
                <button
                  className="chat-msg__link chat-msg__link--danger"
                  type="button"
                  onClick={() => removeFile(i)}
                  aria-label={t('common.delete')}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          multiple
          aria-hidden="true"
          tabIndex={-1}
          onChange={handleSelectFiles}
        />
        <div className="chat-composer__form stack">
          <textarea
            className="field__input chat-composer__input"
            placeholder={t('chat.placeholder')}
            value={text}
            maxLength={MESSAGE_TEXT_BOUNDS.max}
            rows={3}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="row-actions chat-composer__actions">
          <button
            className="btn btn--sm"
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              fileInputRef.current?.click();
            }}
          >
            {t('chat.attachFile')}
          </button>
          <button
            className="btn btn--sm btn--primary"
            type="button"
            disabled={busy}
            onClick={() => void handleSubmit()}
          >
            {busy ? t('chat.sending') : t('chat.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
