const http = require('node:http');

const PORT = Number(process.env.PORT ?? 3000);

const currentUser = {
  id: 'u-admin',
  email: 'admin@example.com',
  name: 'Ирина Волкова',
  role: 'ADMIN',
  avatarPath: null,
  maxLinked: true,
};

const directory = [
  { id: 'u-admin', name: 'Ирина Волкова', role: 'ADMIN' },
  { id: 'u-manager', name: 'Алексей Орлов', role: 'MANAGER' },
  { id: 'u-exec', name: 'Мария Соколова', role: 'EXECUTOR' },
  { id: 'u-exec-2', name: 'Дмитрий Ким', role: 'EXECUTOR' },
];

let users = [
  { ...currentUser, active: true, locked: false },
  {
    id: 'u-manager',
    email: 'manager@example.com',
    name: 'Алексей Орлов',
    role: 'MANAGER',
    avatarPath: null,
    active: true,
    locked: false,
    maxLinked: false,
  },
  {
    id: 'u-exec',
    email: 'executor@example.com',
    name: 'Мария Соколова',
    role: 'EXECUTOR',
    avatarPath: null,
    active: true,
    locked: false,
    maxLinked: false,
  },
];

let deletedUsers = [
  {
    id: 'u-old',
    name: 'Сергей Лебедев',
    emails: ['sergey@example.com', 's.lebedev@example.com'],
    deletedAt: '2026-06-10T09:15:00.000Z',
  },
];

let tasks = [
  {
    id: 'task-1',
    title: 'Согласовать договор поставки оборудования',
    description:
      'Проверить финальную редакцию договора, сверить приложения и отправить комментарии участникам до конца рабочего дня.',
    deadline: '2026-06-25T15:00:00.000Z',
    status: 'IN_PROGRESS',
    messageCount: 12,
    hasUnread: true,
    executorIds: ['u-exec', 'u-exec-2'],
    managerIds: ['u-manager', 'u-admin'],
  },
  {
    id: 'task-2',
    title: 'Подготовить отчёт по просроченным задачам',
    description: 'Собрать список рисков для утреннего штаба.',
    deadline: '2026-06-24T12:00:00.000Z',
    status: 'NEEDS_ADMIN',
    messageCount: 4,
    hasUnread: false,
    executorIds: ['u-exec'],
    managerIds: ['u-admin'],
  },
  {
    id: 'task-3',
    title: 'Обновить регламент передачи роли администратора',
    description: null,
    deadline: '2026-06-27T09:00:00.000Z',
    status: 'WAITING',
    messageCount: 0,
    hasUnread: false,
    executorIds: ['u-exec-2'],
    managerIds: ['u-manager'],
  },
];

const messages = [
  {
    id: 'msg-1',
    taskId: 'task-1',
    chatId: 'chat-1',
    authorId: 'u-manager',
    authorDisplayName: 'Алексей Орлов',
    authorAvatarPath: null,
    text: 'Проверил вводные. Нужна финальная сверка по договору и вложениям.',
    createdAt: '2026-06-24T06:15:00.000Z',
    editedAt: null,
    deleted: false,
    readCount: 3,
    attachments: [],
  },
  {
    id: 'msg-2',
    taskId: 'task-1',
    chatId: 'chat-1',
    authorId: 'u-admin',
    authorDisplayName: 'Ирина Волкова',
    authorAvatarPath: null,
    text: 'Сверка завершена. Зафиксируйте статус после ответа исполнителя.',
    createdAt: '2026-06-24T07:20:00.000Z',
    editedAt: '2026-06-24T07:34:00.000Z',
    deleted: false,
    readCount: 2,
    attachments: [],
  },
];

const attachments = [
  {
    id: 'att-1',
    messageId: 'msg-2',
    originalName: 'brief.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 184320,
    hasThumbnail: false,
    compression: 'zstd',
    checksum: 'abc123',
    createdAt: '2026-06-24T07:21:00.000Z',
  },
];

const auditEntries = [
  {
    id: 'audit-1',
    taskId: 'task-1',
    authorId: 'u-admin',
    field: 'status',
    oldValue: 'WAITING',
    newValue: 'IN_PROGRESS',
    changedAt: '2026-06-24T08:00:00.000Z',
    changedAtMsk: '24.06.2026 11:00',
  },
  {
    id: 'audit-2',
    taskId: 'task-1',
    authorId: 'u-manager',
    field: 'deadline',
    oldValue: '23.06.2026 18:00',
    newValue: '25.06.2026 18:00',
    changedAt: '2026-06-24T05:30:00.000Z',
    changedAtMsk: '24.06.2026 08:30',
  },
];

let notifications = [
  {
    id: 'n-1',
    type: 'NEW_MESSAGE',
    isMessageNotification: true,
    taskId: 'task-1',
    messageId: 'msg-1',
    title: 'Новое сообщение',
    body: 'Алексей Орлов написал в задаче по договору.',
    createdAt: '2026-06-24T08:10:00.000Z',
    siteStatus: 'DELIVERED',
    maxStatus: 'DELIVERED',
  },
  {
    id: 'n-2',
    type: 'DEADLINE_REMINDER',
    isMessageNotification: false,
    taskId: 'task-2',
    messageId: null,
    title: 'Срок сегодня',
    body: 'Отчёт по просроченным задачам требует внимания администратора.',
    createdAt: '2026-06-24T07:45:00.000Z',
    siteStatus: 'DELIVERED',
    maxStatus: 'PENDING',
  },
];

const statistics = {
  statusCounts: {
    IN_PROGRESS: 8,
    WAITING: 5,
    DONE: 19,
    NEEDS_ADMIN: 3,
    CANCELLED: 1,
  },
  totalTasks: 36,
  overdueCount: 4,
  overduePercent: 11.1,
  avgCompletionHours: 17.4,
  byManager: [
    { userId: 'u-admin', name: 'Ирина Волкова', taskCount: 14 },
    { userId: 'u-manager', name: 'Алексей Орлов', taskCount: 11 },
  ],
  byExecutor: [
    { userId: 'u-exec', name: 'Мария Соколова', taskCount: 16 },
    { userId: 'u-exec-2', name: 'Дмитрий Ким', taskCount: 9 },
  ],
  chatActivity: { messageCount: 128, activeChats: 23 },
  hasData: true,
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function taskCard(task) {
  const {
    executorIds: _executorIds,
    managerIds: _managerIds,
    ...card
  } = task;
  return card;
}

function nextStatus(current, action) {
  switch (action?.type) {
    case 'COMPLETE':
      return 'DONE';
    case 'REOPEN':
    case 'RETURN':
    case 'CLEAR_ADMIN':
      return 'IN_PROGRESS';
    case 'CANCEL':
      return 'CANCELLED';
    case 'REQUEST_ADMIN':
      return 'NEEDS_ADMIN';
    case 'ADMIN_SET':
      return action.target;
    default:
      return current;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (method === 'GET' && path === '/health') {
    return sendJson(response, 200, { ok: true });
  }
  if (method === 'POST' && (path === '/auth/login' || path === '/auth/refresh')) {
    return sendJson(response, 200, { token: 'preview-token', user: currentUser });
  }
  if (method === 'GET' && path === '/auth/me') {
    return sendJson(response, 200, currentUser);
  }
  if (method === 'POST' && path === '/auth/logout') {
    return sendJson(response, 200, {});
  }
  if (method === 'POST' && path === '/auth/change-password') {
    return sendJson(response, 200, {});
  }

  if (method === 'GET' && path === '/users/directory') {
    return sendJson(response, 200, directory);
  }
  if (method === 'GET' && path === '/users/deleted') {
    return sendJson(response, 200, deletedUsers);
  }
  if (method === 'GET' && path === '/users') {
    return sendJson(response, 200, users);
  }
  if (method === 'POST' && path === '/users/invite') {
    const body = await readBody(request);
    const created = {
      id: `u-${Date.now()}`,
      email: String(body.email ?? ''),
      name: String(body.email ?? '').split('@')[0] || 'Новый пользователь',
      role: 'EXECUTOR',
      avatarPath: null,
      active: false,
      locked: false,
      maxLinked: false,
    };
    users = [...users, created];
    return sendJson(response, 201, created);
  }

  const userMatch = /^\/users\/([^/]+)$/.exec(path);
  if (userMatch && method === 'PATCH') {
    const body = await readBody(request);
    const index = users.findIndex((user) => user.id === userMatch[1]);
    if (index === -1) {
      return sendJson(response, 404, { code: 'NOT_FOUND', message: 'Пользователь не найден.' });
    }
    users[index] = { ...users[index], ...body };
    return sendJson(response, 200, users[index]);
  }
  if (userMatch && method === 'DELETE') {
    const index = users.findIndex((user) => user.id === userMatch[1]);
    if (index !== -1) {
      const [removed] = users.splice(index, 1);
      if (url.searchParams.get('mode') !== 'hard') {
        deletedUsers = [
          ...deletedUsers,
          {
            id: removed.id,
            name: removed.name,
            emails: [removed.email],
            deletedAt: new Date().toISOString(),
          },
        ];
      }
    }
    return sendJson(response, 200, {});
  }

  const restoreMatch = /^\/users\/([^/]+)\/restore$/.exec(path);
  if (restoreMatch && method === 'POST') {
    const body = await readBody(request);
    const removed = deletedUsers.find((user) => user.id === restoreMatch[1]);
    if (!removed) {
      return sendJson(response, 404, { code: 'NOT_FOUND', message: 'Пользователь не найден.' });
    }
    const restored = {
      id: removed.id,
      email: String(body.email ?? removed.emails[0] ?? ''),
      name: removed.name,
      role: 'EXECUTOR',
      avatarPath: null,
      active: false,
      locked: false,
      maxLinked: false,
    };
    deletedUsers = deletedUsers.filter((user) => user.id !== removed.id);
    users = [...users, restored];
    return sendJson(response, 200, restored);
  }
  if (/^\/users\/[^/]+\/transfer-admin$/.test(path) && method === 'POST') {
    return sendJson(response, 200, {});
  }

  if (method === 'GET' && path === '/tasks') {
    const text = (url.searchParams.get('text') ?? '').toLowerCase();
    const visible = text
      ? tasks.filter((task) =>
          `${task.title} ${task.description ?? ''}`.toLowerCase().includes(text),
        )
      : tasks;
    return sendJson(response, 200, {
      items: visible.map(taskCard),
      meta: {
        page: 1,
        pageSize: 20,
        total: visible.length,
        totalPages: visible.length === 0 ? 0 : 1,
        hasNext: false,
        hasPrevious: false,
      },
    });
  }
  if (method === 'POST' && path === '/tasks') {
    const body = await readBody(request);
    const created = {
      id: `task-${Date.now()}`,
      title: body.title,
      description: body.description ?? null,
      deadline: body.deadline,
      status: 'IN_PROGRESS',
      messageCount: 0,
      hasUnread: false,
      executorIds: body.executorIds ?? [],
      managerIds: body.managerIds ?? [],
    };
    tasks = [created, ...tasks];
    return sendJson(response, 201, created);
  }

  const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch) {
    const taskIndex = tasks.findIndex((task) => task.id === taskMatch[1]);
    if (taskIndex === -1) {
      return sendJson(response, 404, { code: 'NOT_FOUND', message: 'Задача не найдена.' });
    }
    if (method === 'GET') {
      return sendJson(response, 200, tasks[taskIndex]);
    }
    if (method === 'PATCH') {
      const body = await readBody(request);
      tasks[taskIndex] = { ...tasks[taskIndex], ...body };
      return sendJson(response, 200, tasks[taskIndex]);
    }
  }

  const assignMatch = /^\/tasks\/([^/]+)\/assign$/.exec(path);
  if (assignMatch && method === 'POST') {
    const body = await readBody(request);
    const index = tasks.findIndex((task) => task.id === assignMatch[1]);
    tasks[index] = {
      ...tasks[index],
      executorIds: body.executorIds ?? [],
      managerIds: body.managerIds ?? [],
    };
    return sendJson(response, 200, tasks[index]);
  }

  const statusMatch = /^\/tasks\/([^/]+)\/status$/.exec(path);
  if (statusMatch && method === 'POST') {
    const body = await readBody(request);
    const index = tasks.findIndex((task) => task.id === statusMatch[1]);
    tasks[index] = {
      ...tasks[index],
      status: nextStatus(tasks[index].status, body.action),
    };
    return sendJson(response, 200, tasks[index]);
  }

  const taskMessagesMatch = /^\/tasks\/([^/]+)\/messages$/.exec(path);
  if (taskMessagesMatch && method === 'GET') {
    return sendJson(
      response,
      200,
      taskMessagesMatch[1] === 'task-1' ? messages : [],
    );
  }
  if (taskMessagesMatch && method === 'POST') {
    const body = await readBody(request);
    const created = {
      id: `msg-${Date.now()}`,
      taskId: taskMessagesMatch[1],
      chatId: `chat-${taskMessagesMatch[1]}`,
      authorId: currentUser.id,
      authorDisplayName: currentUser.name,
      authorAvatarPath: null,
      text: String(body.text ?? ''),
      createdAt: new Date().toISOString(),
      editedAt: null,
      deleted: false,
      readCount: 1,
      attachments: [],
    };
    messages.push(created);
    return sendJson(response, 201, created);
  }

  const taskAttachmentsMatch = /^\/tasks\/([^/]+)\/attachments$/.exec(path);
  if (taskAttachmentsMatch && method === 'GET') {
    return sendJson(
      response,
      200,
      taskAttachmentsMatch[1] === 'task-1' ? attachments : [],
    );
  }
  const auditMatch = /^\/tasks\/([^/]+)\/audit$/.exec(path);
  if (auditMatch && method === 'GET') {
    return sendJson(response, 200, auditMatch[1] === 'task-1' ? auditEntries : []);
  }
  if (/^\/messages\/[^/]+\/read$/.test(path) && method === 'POST') {
    return sendJson(response, 200, {});
  }
  if (/^\/messages\/[^/]+\/readers$/.test(path) && method === 'GET') {
    return sendJson(response, 200, []);
  }

  if (method === 'GET' && path === '/statistics') {
    return sendJson(response, 200, statistics);
  }
  if (method === 'GET' && path === '/statistics/export') {
    const format = url.searchParams.get('format');
    const contentType =
      format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv; charset=utf-8';
    return sendText(response, 200, 'metric,value\nTotal tasks,36\nOverdue,4\n', contentType);
  }

  if (method === 'GET' && path === '/notifications') {
    return sendJson(response, 200, notifications);
  }
  if (method === 'POST' && path === '/notifications/messages/seen') {
    const body = await readBody(request);
    notifications = notifications.filter((item) => item.messageId !== body.messageId);
    return sendJson(response, 200, {});
  }
  const notificationMatch = /^\/notifications\/([^/]+)$/.exec(path);
  if (notificationMatch && method === 'DELETE') {
    notifications = notifications.filter((item) => item.id !== notificationMatch[1]);
    return sendJson(response, 200, {});
  }

  if (/^\/avatars\/[^/]+$/.test(path)) {
    return sendJson(response, 404, { code: 'NOT_FOUND', message: 'Аватар отсутствует.' });
  }

  return sendJson(response, 404, {
    code: 'PREVIEW_ROUTE_NOT_FOUND',
    message: `Preview API: маршрут ${method} ${path} не настроен.`,
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Task Hub preview API: http://127.0.0.1:${PORT}`);
});
