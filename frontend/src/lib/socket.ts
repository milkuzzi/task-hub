import { io, type Socket } from "socket.io-client";

/**
 * Socket.IO-клиент realtime-чата «Системы поручений» (Req 11.1).
 *
 * Имена событий синхронизированы с серверным `ChatEvents` (backend
 * `src/chat/chat.events.ts`), чтобы исключить расхождение строковых литералов
 * между клиентом и сервером.
 */
export const ChatEvents = {
  /** Исходящее (клиент→сервер): вход в комнату Задачи. Нагрузка `{ taskId }`. */
  TaskJoin: "task:join",
  /** Исходящее (клиент→сервер): выход из комнаты Задачи. Нагрузка `{ taskId }`. */
  TaskLeave: "task:leave",
  /** Входящее: новое/изменённое Сообщение Чата (Req 11.3). */
  Message: "chat:message",
  /** Входящее: обновление Статуса Задачи (Req 10). */
  StatusUpdate: "task:status",
  /** Входящее: параметры/состав/статус/счётчики Задачи изменились. */
  TaskUpdated: "task:updated",
  /** Входящее: обновление счётчика Сообщений на карточке Задачи (Req 9.7). */
  MessageCounter: "task:counter",
  /** Входящее: обновлённый список прочитавших Сообщение (Req 11.8). */
  MessageReaders: "chat:reads",
  /** Входящее: адресное уведомление Пользователю (Req 13, 14). */
  Notification: "notification",
} as const;

export type ChatEvent = (typeof ChatEvents)[keyof typeof ChatEvents];

export type TaskRealtimeReason =
  | "created"
  | "updated"
  | "assigned"
  | "status"
  | "message";

export interface TaskRealtimeUpdate {
  taskId: string;
  reason: TaskRealtimeReason;
}

/** URL Socket.IO; по умолчанию — тот же источник, что и страница. */
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? window.location.origin;
const SOCKET_DISABLED =
  import.meta.env.MODE === "test" ||
  import.meta.env.VITE_SOCKET_DISABLED === "true" ||
  import.meta.env.VITE_SOCKET_URL === "disabled";

let socket: Socket | null = null;
let disabledSocket: Socket | null = null;
let socketAuthToken: string | null = null;

export function setSocketAuthToken(token: string | null): void {
  const value = token?.trim();
  socketAuthToken = value === undefined || value === "" ? null : value;
  if (socket !== null) {
    socket.auth = socketAuthToken === null ? {} : { token: socketAuthToken };
  }
}

function socketAuth(): { token?: string } {
  return socketAuthToken === null ? {} : { token: socketAuthToken };
}

function getDisabledSocket(): Socket {
  if (disabledSocket === null) {
    disabledSocket = {
      connected: false,
      connect: () => getDisabledSocket(),
      disconnect: () => getDisabledSocket(),
      emit: () => getDisabledSocket(),
      on: () => getDisabledSocket(),
      off: () => getDisabledSocket(),
    } as unknown as Socket;
  }
  return disabledSocket;
}

/**
 * Возвращает singleton-подключение Socket.IO, создавая его при первом вызове.
 * Авторизация подключения выполняется через HttpOnly-cookie сессии (Req 11.1, 5.7);
 * соединение устанавливается лениво (`autoConnect: false`) — вызовите
 * `connectSocket()` после успешного входа.
 */
export function getSocket(): Socket {
  if (SOCKET_DISABLED) {
    return getDisabledSocket();
  }
  if (socket === null) {
    socket = io(SOCKET_URL, {
      autoConnect: false,
      withCredentials: true,
      auth: socketAuth(),
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}

/** Устанавливает соединение (после успешной аутентификации). */
export function connectSocket(): Socket {
  const s = getSocket();
  s.auth = socketAuth();
  if (!s.connected) {
    s.connect();
  }
  return s;
}

/** Разрывает соединение (при выходе/аннулировании сессии, Req 19.10). */
export function disconnectSocket(): void {
  if (socket?.connected) {
    socket.disconnect();
  }
}

/**
 * Переустанавливает соединение с актуальным токеном Сессии после её продления
 * (скользящая сессия, дефект 9). Сервер аннулирует прежний `jti` при refresh,
 * поэтому живой сокет должен переподключиться, чтобы повторно пройти
 * авторизацию с обновлённой cookie. Если соединения нет — операция не нужна
 * (подключение возьмёт свежую cookie само).
 */
export function reauthSocket(): void {
  if (socket !== null) {
    socket.auth = socketAuth();
    if (socket.connected) {
      socket.disconnect();
    }
    socket.connect();
  }
}

/** Присоединяет клиент к комнате Задачи (Req 11.2). */
export function joinTaskRoom(taskId: string): void {
  getSocket().emit(ChatEvents.TaskJoin, { taskId });
}

/** Покидает комнату Задачи. */
export function leaveTaskRoom(taskId: string): void {
  getSocket().emit(ChatEvents.TaskLeave, { taskId });
}
