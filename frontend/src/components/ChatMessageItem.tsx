import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMsk } from '@/lib/time';
import { MESSAGE_TEXT_BOUNDS, type ChatMessage, type MessageReader } from '@/lib/chat-api';
import { AttachmentThumbnail } from './AttachmentThumbnail';
import { UserAvatar } from './UserAvatar';
import type { AttachmentMeta } from '@/lib/chat-api';

/**
 * Одно Сообщение Чата в ленте (Req 11.3, 11.5, 11.7, 11.8).
 *
 * Отображает автора, текст и время в MSK; для изменённого Сообщения — метку
 * «изменено {дата/время}» (Req 11.5), для удалённого — метку «Сообщение
 * удалено» на месте текста (Req 11.7). Автор Сообщения, Менеджер Задачи и
 * Администратор видят действия «Изменить»/«Удалить» (право проверяется и на
 * сервере, Req 11.6). Список прочитавших раскрывается по запросу и виден всем
 * Участникам чата (Req 11.8). Вложения Сообщения показываются миниатюрами или
 * значками (Req 12.6, 12.7).
 */
export interface ChatMessageItemProps {
  message: ChatMessage;
  /** Может ли текущий Пользователь изменять/удалять это Сообщение (Req 11.6). */
  canModify: boolean;
  /** Прочитавшие Сообщение (Req 11.8); `undefined` — ещё не загружены. */
  readers?: MessageReader[] | undefined;
  /**
   * Реактивный счётчик прочитавших по `messageId` (Req 2.5, Property 9).
   *
   * Обновляется каждым событием `chat:reads` независимо от факта раскрытия
   * полного списка прочитавших, поэтому счётчик в шапке переключателя
   * отражает число прочитавших в реальном времени даже для свёрнутого
   * Сообщения, у которого `readers === undefined`.
   */
  readCount?: number | undefined;
  /** Запросить список прочитавших для Сообщения (ленивая загрузка, Req 11.8). */
  onLoadReaders: (messageId: string) => void;
  /** Сохранить отредактированный текст (Req 11.5). */
  onEdit: (messageId: string, text: string) => Promise<void>;
  /** Удалить Сообщение (Req 11.7). */
  onDelete: (messageId: string) => Promise<void>;
  /** Открыть Вложение в полноэкранном просмотре (Req 12.9). */
  onOpenAttachment: (attachment: AttachmentMeta) => void;
}

export function ChatMessageItem({
  message,
  canModify,
  readers,
  readCount,
  onLoadReaders,
  onEdit,
  onDelete,
  onOpenAttachment,
}: ChatMessageItemProps): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReaders, setShowReaders] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(message.text);
      setError(null);
      textareaRef.current?.focus();
    }
  }, [editing, message.text]);

  async function handleSave(): Promise<void> {
    const text = draft.trim();
    if (text.length < MESSAGE_TEXT_BOUNDS.min || text.length > MESSAGE_TEXT_BOUNDS.max) {
      setError(t('chat.errors.length'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onEdit(message.id, text);
      setEditing(false);
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setBusy(true);
    try {
      await onDelete(message.id);
    } finally {
      setBusy(false);
    }
  }

  function toggleReaders(): void {
    const next = !showReaders;
    setShowReaders(next);
    if (next && readers === undefined) {
      onLoadReaders(message.id);
    }
  }

  const attachments = message.attachments ?? [];
  const hasAuthorAvatar =
    message.authorAvatarPath === undefined ? undefined : message.authorAvatarPath !== null;

  // Отображаемый счётчик прочитавших — лучшая из известных оценок: реактивный
  // `readCount` (обновляется по `chat:reads` без раскрытия списка, Property 9),
  // начальный счётчик из контракта Сообщения (`message.readCount`, приходит при
  // загрузке ленты — чтобы счётчик не был 0 до первого `chat:reads`/раскрытия) и
  // длина уже загруженного полного списка `readers` (после ручного раскрытия,
  // Property 10). Максимум корректно покрывает все случаи.
  const readersCount = Math.max(
    readCount ?? 0,
    message.readCount ?? 0,
    readers?.length ?? 0,
  );

  return (
    <article className={message.deleted ? 'chat-msg chat-msg--deleted' : 'chat-msg'}>
      <header className="chat-msg__head">
        <span className="chat-msg__identity">
          <UserAvatar
            userId={message.authorId}
            hasAvatar={hasAuthorAvatar}
            size="sm"
            className="chat-msg__avatar"
          />
          <span className="chat-msg__author">{message.authorDisplayName}</span>
        </span>
        <time className="chat-msg__time" dateTime={message.createdAt}>
          {formatMsk(message.createdAt)}
        </time>
      </header>

      {message.deleted ? (
        <p className="chat-msg__deleted">{t('chat.deleted')}</p>
      ) : editing ? (
        <div className="stack">
          {error !== null && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <textarea
            ref={textareaRef}
            className="field__input chat-composer__input"
            value={draft}
            maxLength={MESSAGE_TEXT_BOUNDS.max}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="row-actions">
            <button
              className="btn btn--sm btn--primary"
              type="button"
              disabled={busy}
              onClick={() => void handleSave()}
            >
              {busy ? t('common.saving') : t('chat.save')}
            </button>
            <button
              className="btn btn--sm"
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {t('chat.cancelEdit')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {message.text.trim() !== '' && <p className="chat-msg__text">{message.text}</p>}
          {message.editedAt !== null && (
            <span className="chat-msg__edited">
              {t('chat.editedMark', { at: formatMsk(message.editedAt) })}
            </span>
          )}
          {attachments.length > 0 && (
            <div className="chat-msg__attachments">
              {attachments.map((a) => (
                <AttachmentThumbnail
                  key={a.id}
                  attachment={a}
                  onOpen={() => onOpenAttachment(a)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {!message.deleted && (
        <footer className="chat-msg__foot">
          <button className="chat-msg__link" type="button" onClick={toggleReaders}>
            {t('chat.readers.toggle', { count: readersCount })}
          </button>
          {canModify && !editing && (
            <span className="row-actions">
              <button
                className="chat-msg__link"
                type="button"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                {t('chat.edit')}
              </button>
              <button
                className="chat-msg__link chat-msg__link--danger"
                type="button"
                disabled={busy}
                onClick={() => void handleDelete()}
              >
                {t('chat.delete')}
              </button>
            </span>
          )}
        </footer>
      )}

      {showReaders && (
        <div className="chat-msg__readers">
          <strong>{t('chat.readers.heading')}</strong>
          {readers === undefined ? (
            <p className="text-muted">{t('common.loading')}</p>
          ) : readers.length === 0 ? (
            <p className="text-muted">{t('chat.readers.none')}</p>
          ) : (
            <ul className="chat-readers__list">
              {readers.map((r) => (
                <li key={r.userId}>
                  {r.displayName}{' '}
                  <span className="text-muted">
                    ({t('chat.readers.at', { at: formatMsk(r.readAt) })})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
