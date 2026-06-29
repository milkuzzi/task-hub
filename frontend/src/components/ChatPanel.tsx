import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, X } from "@phosphor-icons/react";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_MESSAGE_MAX,
  MESSAGE_TEXT_BOUNDS,
  type AttachmentMeta,
  type ChatAuthorRole,
  type ChatMessage,
  type MessageReader,
} from "@/lib/chat-api";
import { ChatMessageItem } from "./ChatMessageItem";

const MAX_FILE_ACCEPT = [
  "*/*",
  "application/*",
  "text/*",
  "image/*",
  "audio/*",
  "video/*",
  ".json",
  ".sig",
  ".pub",
  ".key",
  ".pem",
  ".cer",
  ".crt",
  ".p7s",
  ".xml",
  ".yaml",
  ".yml",
  ".txt",
  ".csv",
  ".log",
  ".md",
  ".bin",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".pdf",
].join(",");

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
  /** Визуальная среда: обычный сайт или MAX mini-app. */
  surface?: "site" | "max";
  messages: ChatMessage[];
  /** Идентификатор текущего Пользователя (для прав изменения Сообщения). */
  currentUserId: string;
  /** Глобальная роль текущего Пользователя. */
  currentUserRole: ChatAuthorRole;
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
  surface = "site",
  messages,
  currentUserId,
  currentUserRole,
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
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const lastFileSelectionRef = useRef<{
    key: string;
    handledAt: number;
  } | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  /** Может ли текущий Пользователь изменять/удалять Сообщение (Req 11.6). */
  function canModify(message: ChatMessage): boolean {
    if (message.authorId === currentUserId) {
      return true;
    }
    if (currentUserRole === "ADMIN") {
      return true;
    }
    return isModerator && message.authorRole !== "ADMIN";
  }

  function addFiles(selected: File[]): void {
    setError(null);
    if (selected.length === 0) {
      return;
    }
    if (busy) {
      return;
    }
    const tooBig = selected.find((f) => f.size > ATTACHMENT_MAX_BYTES);
    if (tooBig !== undefined) {
      setError(t("chat.errors.attachmentSize"));
      return;
    }
    setFiles((prev) => {
      const next = [...prev, ...selected];
      if (next.length > ATTACHMENTS_PER_MESSAGE_MAX) {
        setError(t("chat.errors.attachmentsLimit"));
        return prev;
      }
      return next;
    });
  }

  function fileSelectionKey(selected: File[]): string {
    return selected
      .map((file) =>
        [file.name, file.size, file.lastModified, file.type].join(":"),
      )
      .join("|");
  }

  function clearFileInputSoon(input: HTMLInputElement): void {
    window.setTimeout(() => {
      input.value = "";
    }, 0);
  }

  function handleSelectFiles(event: FormEvent<HTMLInputElement>): void {
    event.stopPropagation();
    const input = event.currentTarget;
    const selected = Array.from(input.files ?? []);
    const now = Date.now();
    const lastSelection = lastFileSelectionRef.current;

    if (selected.length === 0) {
      if (
        lastSelection !== null &&
        now - lastSelection.handledAt < 700
      ) {
        return;
      }
      if (surface === "max") {
        setError(t("chat.errors.fileSelectionEmpty"));
      }
      return;
    }

    const key = fileSelectionKey(selected);
    if (
      lastSelection !== null &&
      lastSelection.key === key &&
      now - lastSelection.handledAt < 700
    ) {
      clearFileInputSoon(input);
      return;
    }

    lastFileSelectionRef.current = { key, handledAt: now };
    addFiles(selected);
    clearFileInputSoon(input);
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>): void {
    const selected = Array.from(event.clipboardData.files ?? []);
    if (selected.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    addFiles(selected);
  }

  function isFileTransfer(dataTransfer: DataTransfer): boolean {
    if (dataTransfer.files.length > 0) {
      return true;
    }
    const types = dataTransfer.types as unknown as {
      readonly length: number;
      readonly [index: number]: string | undefined;
      includes?: (value: string) => boolean;
      contains?: (value: string) => boolean;
      item?: (index: number) => string | null;
    };
    if (typeof types.includes === "function" && types.includes("Files")) {
      return true;
    }
    if (typeof types.contains === "function" && types.contains("Files")) {
      return true;
    }
    for (let i = 0; i < types.length; i += 1) {
      if ((types[i] ?? types.item?.(i)) === "Files") {
        return true;
      }
    }
    return false;
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>): void {
    if (!isFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (!busy) {
      setDraggingFiles(true);
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>): void {
    if (!isFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = busy ? "none" : "copy";
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>): void {
    if (!isFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDraggingFiles(false);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>): void {
    if (!isFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    addFiles(Array.from(event.dataTransfer.files));
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
      setError(t("chat.errors.length"));
      return;
    }
    setBusy(true);
    try {
      await onSend(trimmed, files);
      setText("");
      setFiles([]);
      if (fileInputRef.current !== null) {
        fileInputRef.current.value = "";
      }
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message.trim() !== ""
          ? caught.message
          : t("chat.errors.uploadFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={
        draggingFiles
          ? "chat-panel chat-panel--dragging panel"
          : "chat-panel panel"
      }
      onDragEnterCapture={handleDragEnter}
      onDragOverCapture={handleDragOver}
      onDragLeaveCapture={handleDragLeave}
      onDropCapture={handleDrop}
      onPasteCapture={handlePaste}
    >
      {draggingFiles && (
        <div
          className="chat-panel__drop-target"
          role="status"
          aria-live="polite"
        >
          <span>{t("chat.dropFiles")}</span>
        </div>
      )}
      <div className="chat-feed">
        {messages.length === 0 ? (
          <p className="text-muted">{t("chat.empty")}</p>
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
                  aria-label={t("common.delete")}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="chat-composer__form stack">
          <textarea
            className="field__input chat-composer__input"
            placeholder={t("chat.placeholder")}
            value={text}
            maxLength={MESSAGE_TEXT_BOUNDS.max}
            rows={3}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="row-actions chat-composer__actions">
          <label
            className={
              busy
                ? "btn btn--sm chat-composer__file-picker is-disabled"
                : "btn btn--sm chat-composer__file-picker"
            }
          >
            <Paperclip size={17} aria-hidden="true" />
            <span>{t("chat.attachFile")}</span>
            <input
              ref={fileInputRef}
              className="chat-composer__file-input"
              type="file"
              multiple
              accept={surface === "max" ? MAX_FILE_ACCEPT : undefined}
              disabled={busy}
              aria-label={t("chat.attachFile")}
              onClick={(event) => {
                event.currentTarget.value = "";
              }}
              onInput={handleSelectFiles}
              onChange={handleSelectFiles}
            />
          </label>
          <button
            className="btn btn--sm btn--primary"
            type="button"
            disabled={busy}
            onClick={() => void handleSubmit()}
          >
            {busy ? t("chat.sending") : t("chat.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
