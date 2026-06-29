import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, CalendarBlank } from "@phosphor-icons/react";
import { useAuth } from "@/lib/use-auth";
import { useAppPath, useIsMaxApp } from "@/lib/app-path";
import { ApiError } from "@/lib/api";
import { formatMsk } from "@/lib/time";
import {
  connectSocket,
  joinTaskRoom,
  leaveTaskRoom,
  ChatEvents,
  type TaskRealtimeUpdate,
} from "@/lib/socket";
import {
  assignTask,
  getTask,
  listDirectory,
  TASK_STATUS_LABEL_KEYS,
  updateTask,
  type DirectoryUser,
  type TaskDetail,
  type TaskStatus,
} from "@/lib/tasks-api";
import {
  deleteMessage as apiDeleteMessage,
  editMessage as apiEditMessage,
  listAttachments,
  listMessages,
  listReaders,
  markRead,
  sendMessage as apiSendMessage,
  uploadAttachment,
  type AttachmentMeta,
  type ChatMessage,
  type MessageReader,
  type MessageReadersUpdate,
  type TaskStatusUpdate,
} from "@/lib/chat-api";
import { listAuditEntries, type AuditLogEntry } from "@/lib/audit-api";
import { resolveActor } from "@/lib/status-api";
import { ChatPanel } from "@/components/ChatPanel";
import { AttachmentsSection } from "@/components/AttachmentsSection";
import { AttachmentViewer } from "@/components/AttachmentViewer";
import { AuditLog } from "@/components/AuditLog";
import { StatusActions } from "@/components/StatusActions";
import { UserAvatar } from "@/components/UserAvatar";
import {
  TaskFormDialog,
  type TaskFormValues,
} from "@/components/TaskFormDialog";
import { LoadingState } from "@/components/LoadingState";
import { ErrorState } from "@/components/ErrorState";
import { TaskMaxNotificationsButton } from "@/components/TaskMaxNotificationsButton";
import { resolveErrorMessage } from "@/lib/error-message";

/**
 * Экран Задачи: realtime-чат, раздел «Вложения» и Журнал изменений (задача 20.5).
 *
 * Объединяет возможности ChatModule, AttachmentsModule и AuditLogModule:
 * - realtime-чат с отправкой/редактированием/удалением Сообщений и метками
 *   «изменено»/«Сообщение удалено» (Req 11.3, 11.5, 11.7), списком прочитавших
 *   (Req 11.8); живые обновления приходят по Socket.IO (`ChatEvents`),
 *   синхронизированным с серверным `chat.events.ts`;
 * - раздел «Вложения» со всеми Вложениями Чата, миниатюрами/значками (Req 11.10,
 *   12.6, 12.7) и полноэкранным просмотром с распаковкой на клиенте (Req 12.9);
 * - Журнал изменений (новые → старые), доступный Менеджеру Задачи и
 *   Администратору (Req 20.2, 20.3).
 *
 * Доступ к Задаче и право на Журнал контролируются сервером; недоступная Задача
 * не раскрывается (Req 2.12). Время отображается в MSK (Req 1.2).
 */

type Tab = "chat" | "attachments" | "audit";
type ParticipantGroup = "executors" | "managers";

interface TaskParticipant {
  id: string;
  name: string;
}

/** Сортировка Сообщений по моменту создания (старые → новые). */
function byCreatedAt(a: ChatMessage, b: ChatMessage): number {
  return a.createdAt.localeCompare(b.createdAt);
}

function ParticipantAvatarRow({
  label,
  participants,
  expanded,
  onToggle,
}: {
  label: string;
  participants: TaskParticipant[];
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const visible = participants.slice(0, 6);
  const hiddenCount = Math.max(0, participants.length - visible.length);
  const names = participants.map((participant) => participant.name).join(", ");

  return (
    <button
      className={
        expanded ? "task-participants__row is-open" : "task-participants__row"
      }
      type="button"
      aria-expanded={expanded}
      title={names === "" ? label : `${label}: ${names}`}
      onClick={onToggle}
    >
      <span className="task-participants__label">{label}</span>
      <span className="task-participants__avatars" aria-hidden="true">
        {visible.map((participant) => (
          <UserAvatar
            key={participant.id}
            userId={participant.id}
            size="sm"
            className="task-participants__avatar"
          />
        ))}
        {hiddenCount > 0 && (
          <span className="task-participants__more">+{hiddenCount}</span>
        )}
      </span>
      <span className="task-participants__count">{participants.length}</span>
    </button>
  );
}

export function TaskDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const appPath = useAppPath();
  const isMaxApp = useIsMaxApp();
  const { taskId = "" } = useParams<{ taskId: string }>();
  const { user } = useAuth();

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [readers, setReaders] = useState<
    Record<string, MessageReader[] | undefined>
  >({});
  // Реактивный счётчик прочитавших по messageId (Req 2.5, Property 9): обновляется
  // каждым событием `chat:reads` независимо от факта раскрытия полного списка.
  const [readCounts, setReadCounts] = useState<Record<string, number>>({});
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
  const [status, setStatus] = useState<TaskStatus | null>(null);

  const [tab, setTab] = useState<Tab>("chat");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditForbidden, setAuditForbidden] = useState(false);
  const [viewerAttachment, setViewerAttachment] =
    useState<AttachmentMeta | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [expandedParticipants, setExpandedParticipants] =
    useState<ParticipantGroup | null>(null);

  /** Уже отмеченные прочитанными Сообщения (защита от повторных вызовов). */
  const markedRef = useRef<Set<string>>(new Set());
  const currentUserId = user?.id ?? null;

  const isModerator = useMemo(() => {
    if (user === null) {
      return false;
    }
    if (user.role === "ADMIN") {
      return true;
    }
    return task !== null && task.managerIds.includes(user.id);
  }, [user, task]);

  /**
   * Роль действующего лица в контексте Задачи для действий смены Статуса
   * (Req 2.3, 2.4, 10). `null` — у Пользователя нет действий смены Статуса.
   */
  const actor = useMemo(() => {
    if (user === null || task === null) {
      return null;
    }
    return resolveActor(user.role, user.id, task);
  }, [user, task]);
  const hasAdminReviewControls = status === "NEEDS_ADMIN" && actor === "ADMIN";

  /** Карта «идентификатор → отображаемое имя» из справочника Пользователей. */
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of directory) {
      map.set(u.id, u.name);
    }
    return map;
  }, [directory]);

  const executorParticipants = useMemo<TaskParticipant[]>(() => {
    if (task === null) {
      return [];
    }
    return task.executorIds.map((id) => ({ id, name: nameById.get(id) ?? id }));
  }, [task, nameById]);

  const managerParticipants = useMemo<TaskParticipant[]>(() => {
    if (task === null) {
      return [];
    }
    return task.managerIds.map((id) => ({ id, name: nameById.get(id) ?? id }));
  }, [task, nameById]);

  const expandedParticipantList =
    expandedParticipants === "executors"
      ? executorParticipants
      : managerParticipants;
  const expandedParticipantLabel =
    expandedParticipants === "executors"
      ? t("taskDetail.executors")
      : t("taskDetail.managers");

  const resolveAuthor = useCallback(
    (authorId: string | null): string => {
      if (authorId === null) {
        return t("audit.unknownAuthor");
      }
      return nameById.get(authorId) ?? authorId;
    },
    [nameById, t],
  );

  const refreshTask = useCallback(async (): Promise<void> => {
    const detail = await getTask(taskId);
    setTask(detail);
    setStatus(detail.status);
    setLoadError(null);
  }, [taskId]);

  /** Вставляет или заменяет Сообщение по идентификатору, сохраняя порядок. */
  const upsertMessage = useCallback((incoming: ChatMessage): void => {
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.id === incoming.id);
      if (index === -1) {
        return [...prev, incoming].sort(byCreatedAt);
      }
      const existing = prev[index];
      const next = [...prev];
      // Сохраняем уже известные Вложения и счётчик прочитавших, если
      // realtime-нагрузка (например, при редактировании) их не несёт.
      next[index] = {
        ...existing,
        ...incoming,
        attachments: incoming.attachments ?? existing?.attachments,
        readCount: incoming.readCount ?? existing?.readCount,
      };
      return next;
    });
  }, []);

  /** Отмечает прочитанными Сообщения других авторов (best-effort, Req 11.8). */
  const markVisibleRead = useCallback(
    (items: ChatMessage[]): void => {
      if (currentUserId === null) {
        return;
      }
      for (const m of items) {
        if (
          m.deleted ||
          m.authorId === currentUserId ||
          markedRef.current.has(m.id)
        ) {
          continue;
        }
        markedRef.current.add(m.id);
        void markRead(m.id).catch(() => {
          markedRef.current.delete(m.id);
        });
      }
    },
    [currentUserId],
  );

  // Первичная загрузка Задачи, справочника, ленты Сообщений и Вложений.
  useEffect(() => {
    if (taskId === "") {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        const detail = await getTask(taskId);
        if (cancelled) {
          return;
        }
        setTask(detail);
        setStatus(detail.status);

        const [msgs, atts] = await Promise.all([
          listMessages(taskId),
          listAttachments(taskId),
        ]);
        if (cancelled) {
          return;
        }
        const sorted = [...msgs].sort(byCreatedAt);
        setMessages(sorted);
        setAttachments(atts);
        markVisibleRead(sorted);
      } catch (err) {
        if (!cancelled) {
          setLoadError(resolveErrorMessage(err, t, t("taskDetail.loadError")));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    listDirectory()
      .then((d) => {
        if (!cancelled) {
          setDirectory(d);
        }
      })
      .catch(() => {
        /* справочник best-effort */
      });

    return () => {
      cancelled = true;
    };
  }, [taskId, t, markVisibleRead]);

  // Realtime-подписка на события Чата комнаты Задачи (Req 11.3, 11.8, 10).
  useEffect(() => {
    if (taskId === "") {
      return;
    }
    const socket = connectSocket();
    joinTaskRoom(taskId);

    const onMessage = (payload: ChatMessage): void => {
      if (payload.taskId !== taskId) {
        return;
      }
      upsertMessage(payload);
      markVisibleRead([payload]);
    };
    const onReaders = (payload: MessageReadersUpdate): void => {
      if (payload.taskId !== taskId) {
        return;
      }
      // Обновляем реактивный счётчик при каждом событии независимо от того,
      // раскрыт ли полный список прочитавших (Req 2.5, Property 9).
      setReadCounts((prev) => ({
        ...prev,
        [payload.messageId]: payload.readers.length,
      }));
      setReaders((prev) => ({ ...prev, [payload.messageId]: payload.readers }));
    };
    const onStatus = (payload: TaskStatusUpdate): void => {
      if (payload.taskId === taskId) {
        setStatus(payload.status as TaskStatus);
      }
    };
    const onTaskUpdated = (payload: TaskRealtimeUpdate): void => {
      if (payload.taskId !== taskId) {
        return;
      }
      void refreshTask().catch((err) => {
        setTask(null);
        setLoadError(resolveErrorMessage(err, t, t("taskDetail.loadError")));
      });
    };

    socket.on(ChatEvents.Message, onMessage);
    socket.on(ChatEvents.MessageReaders, onReaders);
    socket.on(ChatEvents.StatusUpdate, onStatus);
    socket.on(ChatEvents.TaskUpdated, onTaskUpdated);

    return () => {
      socket.off(ChatEvents.Message, onMessage);
      socket.off(ChatEvents.MessageReaders, onReaders);
      socket.off(ChatEvents.StatusUpdate, onStatus);
      socket.off(ChatEvents.TaskUpdated, onTaskUpdated);
      leaveTaskRoom(taskId);
    };
  }, [taskId, upsertMessage, markVisibleRead, refreshTask, t]);

  /** Перезагружает раздел «Вложения» (после отправки Сообщения с файлами). */
  const reloadAttachments = useCallback(async (): Promise<void> => {
    setAttachmentsLoading(true);
    try {
      setAttachments(await listAttachments(taskId));
    } catch {
      /* раздел best-effort: ошибка не блокирует чат */
    } finally {
      setAttachmentsLoading(false);
    }
  }, [taskId]);

  /** Загружает Журнал изменений при первом открытии вкладки (Req 20.2, 20.3). */
  const loadAudit = useCallback(async (): Promise<void> => {
    setAuditLoading(true);
    setAuditForbidden(false);
    try {
      setAuditEntries(await listAuditEntries(taskId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setAuditForbidden(true);
      }
    } finally {
      setAuditLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (tab === "audit" && isModerator) {
      void loadAudit();
    }
  }, [tab, isModerator, loadAudit]);

  useEffect(() => {
    if (toastMessage === null) {
      return;
    }
    const timer = window.setTimeout(() => setToastMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  // Обработчики Чата.
  const handleSend = useCallback(
    async (text: string, files: File[]): Promise<void> => {
      // Сначала загружаем Вложения и получаем их идентификаторы (Req 12.1–12.5),
      // затем отправляем Сообщение с привязкой (Req 11.3).
      const uploaded: AttachmentMeta[] = [];
      for (const file of files) {
        try {
          uploaded.push(await uploadAttachment(taskId, file));
        } catch (err) {
          const message = resolveErrorMessage(
            err,
            t,
            t("chat.errors.uploadFailed"),
          );
          throw new Error(`${file.name}: ${message}`);
        }
      }
      const attachmentIds = uploaded.map((a) => a.id);
      const created = await apiSendMessage(taskId, text, attachmentIds);
      upsertMessage(created);
      if (files.length > 0) {
        await reloadAttachments();
      }
    },
    [taskId, t, upsertMessage, reloadAttachments],
  );

  const handleEdit = useCallback(
    async (messageId: string, text: string): Promise<void> => {
      const updated = await apiEditMessage(messageId, text);
      upsertMessage(updated);
    },
    [upsertMessage],
  );

  const handleDelete = useCallback(async (messageId: string): Promise<void> => {
    await apiDeleteMessage(messageId);
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, deleted: true } : m)),
    );
  }, []);

  const handleLoadReaders = useCallback((messageId: string): void => {
    void listReaders(messageId)
      .then((list) => {
        setReaders((prev) => ({ ...prev, [messageId]: list }));
        setReadCounts((prev) => ({ ...prev, [messageId]: list.length }));
      })
      .catch(() => setReaders((prev) => ({ ...prev, [messageId]: [] })));
  }, []);

  function openEditForm(): void {
    setFormError(null);
    setFormOpen(true);
  }

  function closeEditForm(): void {
    setFormOpen(false);
    setFormError(null);
  }

  async function handleTaskEdit(values: TaskFormValues): Promise<void> {
    if (task === null) {
      return;
    }
    setFormBusy(true);
    setFormError(null);
    try {
      await updateTask(task.id, {
        title: values.title,
        description: values.description,
        deadline: values.deadline,
      });

      const sameExecutors = sameSet(task.executorIds, values.executorIds);
      const sameManagers = sameSet(task.managerIds, values.managerIds);
      if (!sameExecutors || !sameManagers) {
        await assignTask(task.id, {
          executorIds: values.executorIds,
          managerIds: values.managerIds,
        });
      }

      const refreshed = await getTask(task.id);
      setTask(refreshed);
      setStatus(refreshed.status);
      closeEditForm();
      setToastMessage(t("task.toast.parametersUpdated"));
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t("errors.generic"));
    } finally {
      setFormBusy(false);
    }
  }

  if (loading) {
    return <LoadingState label={t("common.loading")} />;
  }

  if (loadError !== null || task === null) {
    return (
      <section className="stack page-section">
        <button
          className="btn btn--sm btn--ghost back-button"
          type="button"
          onClick={() => navigate(appPath("/tasks"))}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {t("taskDetail.back")}
        </button>
        <ErrorState message={loadError ?? t("taskDetail.loadError")} />
      </section>
    );
  }

  return (
    <section className="stack page-section">
      <button
        className="btn btn--sm btn--ghost back-button"
        type="button"
        onClick={() => navigate(appPath("/tasks"))}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        {t("taskDetail.back")}
      </button>

      <article className="panel panel--compact task-hero">
        <div className="task-hero__main">
          <h1>{task.title}</h1>
          {task.description !== null && task.description !== "" && (
            <p className="task-hero__description">{task.description}</p>
          )}
        </div>
        <div className="task-hero__side">
          <div className="task-hero__meta">
            {status !== null && (
              <span
                className={`status-badge status-badge--${status.toLowerCase()}`}
              >
                {t(TASK_STATUS_LABEL_KEYS[status])}
              </span>
            )}
            {task.isOverdue && (
              <span className="status-badge status-badge--overdue">
                {t("task.card.overdue")}
              </span>
            )}
            <p className="task-hero__deadline">
              <CalendarBlank size={16} aria-hidden="true" />
              <span>{formatMsk(task.deadline)}</span>
            </p>
          </div>
          {(status !== null || isModerator) && (
            <div
              className={
                hasAdminReviewControls
                  ? "task-hero__action-row task-hero__action-row--admin-review"
                  : "task-hero__action-row"
              }
            >
              {status !== null && (
                <StatusActions
                  taskId={taskId}
                  status={status}
                  actor={actor}
                  onChanged={(next) => setStatus(next)}
                />
              )}
              {isModerator && (
                <button
                  className="btn btn--sm task-hero__edit"
                  type="button"
                  onClick={openEditForm}
                >
                  {t("task.card.edit")}
                </button>
              )}
              {isMaxApp && user?.maxLinked === true && (
                <TaskMaxNotificationsButton taskId={taskId} />
              )}
            </div>
          )}
          <div
            className="task-participants"
            aria-label={t("taskDetail.participants")}
          >
            <div className="task-participants__rows">
              <ParticipantAvatarRow
                label={t("taskDetail.executors")}
                participants={executorParticipants}
                expanded={expandedParticipants === "executors"}
                onToggle={() =>
                  setExpandedParticipants((current) =>
                    current === "executors" ? null : "executors",
                  )
                }
              />
              <ParticipantAvatarRow
                label={t("taskDetail.managers")}
                participants={managerParticipants}
                expanded={expandedParticipants === "managers"}
                onToggle={() =>
                  setExpandedParticipants((current) =>
                    current === "managers" ? null : "managers",
                  )
                }
              />
            </div>
            {expandedParticipants !== null && (
              <div className="task-participants__panel">
                <strong>{expandedParticipantLabel}</strong>
                <ul className="task-participants__list">
                  {expandedParticipantList.map((participant) => (
                    <li
                      key={participant.id}
                      className="task-participants__item"
                    >
                      <UserAvatar userId={participant.id} size="sm" />
                      <span>{participant.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </article>

      <div className="task-activity stack">
        <div className="tabs" role="tablist">
          <button
            className={tab === "chat" ? "tab is-active" : "tab"}
            role="tab"
            aria-selected={tab === "chat"}
            type="button"
            onClick={() => setTab("chat")}
          >
            {t("chat.tabs.chat")}
          </button>
          <button
            className={tab === "attachments" ? "tab is-active" : "tab"}
            role="tab"
            aria-selected={tab === "attachments"}
            type="button"
            onClick={() => setTab("attachments")}
          >
            {t("chat.tabs.attachments")}
          </button>
          {isModerator && (
            <button
              className={tab === "audit" ? "tab is-active" : "tab"}
              role="tab"
              aria-selected={tab === "audit"}
              type="button"
              onClick={() => setTab("audit")}
            >
              {t("chat.tabs.audit")}
            </button>
          )}
        </div>

        {tab === "chat" && user !== null && (
          <ChatPanel
            surface={isMaxApp ? "max" : "site"}
            messages={messages}
            currentUserId={user.id}
            currentUserRole={user.role}
            isModerator={isModerator}
            readers={readers}
            readCounts={readCounts}
            onLoadReaders={handleLoadReaders}
            onSend={handleSend}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onOpenAttachment={setViewerAttachment}
          />
        )}

        {tab === "attachments" && (
          <AttachmentsSection
            attachments={attachments}
            loading={attachmentsLoading}
            onOpen={setViewerAttachment}
          />
        )}

        {tab === "audit" &&
          (auditForbidden ? (
            <ErrorState message={t("audit.forbidden")} />
          ) : (
            <AuditLog
              entries={auditEntries}
              loading={auditLoading}
              resolveAuthor={resolveAuthor}
            />
          ))}
      </div>

      <AttachmentViewer
        attachment={viewerAttachment}
        onClose={() => setViewerAttachment(null)}
      />
      <TaskFormDialog
        open={formOpen}
        surface={isMaxApp ? "max" : "site"}
        task={task}
        directory={directory}
        busy={formBusy}
        serverError={formError}
        confirmBeforeSubmit
        onSubmit={(values) => void handleTaskEdit(values)}
        onCancel={closeEditForm}
      />
      {toastMessage !== null && (
        <div className="local-toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}
    </section>
  );
}

/** Сравнивает два набора идентификаторов без учёта порядка и дубликатов. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  return b.every((id) => setA.has(id));
}
