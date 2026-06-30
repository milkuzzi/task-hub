import { expect, test, type Page } from '@playwright/test';

const DEEP_LINK_TASK_ID = '22222222-2222-4222-8222-222222222222';
const MINI_APP_TOKEN = 'mini-app-session-token';
const OFFICE_ATTACHMENT_ID = '44444444-4444-4444-8444-444444444444';
const directory = Array.from({ length: 8 }, (_, index) => ({
  id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
  email: `user${index + 1}@example.com`,
  name: `Участник ${index + 1}`,
  role: index % 2 === 0 ? 'EXECUTOR' : 'MANAGER',
}));
const officeAttachment = {
  id: OFFICE_ATTACHMENT_ID,
  messageId: '55555555-5555-4555-8555-555555555555',
  originalName: 'report.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  sizeBytes: 8192,
  hasThumbnail: false,
  compression: 'zstd',
  checksum: 'abc123',
  createdAt: '2026-06-29T09:00:00.000Z',
};

async function installMaxBridge(page: Page, startParam?: string): Promise<void> {
  const initData = new URLSearchParams({
    auth_date: '1',
    hash: 'test',
    ...(startParam === undefined ? {} : { start_param: startParam }),
  }).toString();
  await page.addInitScript((data: string) => {
    (window as typeof window & { WebApp?: unknown }).WebApp = {
      initData: data,
      platform: 'android',
      BackButton: {
        show() {},
        hide() {},
        onClick() {},
        offClick() {},
      },
      openLink(url: string) {
        (window as typeof window & { __maxOpenLink?: string }).__maxOpenLink = url;
      },
      downloadFile(url: string, file_name: string) {
        const target = window as typeof window & {
          __maxDownloads?: Array<{ url: string; fileName: string }>;
        };
        target.__maxDownloads = [
          ...(target.__maxDownloads ?? []),
          { url, fileName: file_name },
        ];
        return Promise.resolve({});
      },
    };
  }, initData);
}

test.describe('@smoke MAX mini-app', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const expectMiniAppAuthorization = (): void => {
        expect(route.request().headers().authorization).toBe(`Bearer ${MINI_APP_TOKEN}`);
      };
      if (path.endsWith('/auth/max/mini-app')) {
        await route.fulfill({
          json: {
            token: MINI_APP_TOKEN,
            user: {
              id: '11111111-1111-4111-8111-111111111111',
              email: 'admin@example.com',
              name: 'Администратор',
              role: 'ADMIN',
              avatarPath: null,
              maxLinked: true,
            },
          },
        });
        return;
      }
      if (path.endsWith('/users/directory')) {
        expectMiniAppAuthorization();
        await route.fulfill({ json: directory });
        return;
      }
      if (path === `/api/tasks/${DEEP_LINK_TASK_ID}`) {
        expectMiniAppAuthorization();
        await route.fulfill({
          json: {
            id: DEEP_LINK_TASK_ID,
            title: 'Задача по ссылке',
            description: 'Открыта напрямую из уведомления MAX.',
            deadline: '2026-07-01T12:00:00.000Z',
            status: 'IN_PROGRESS',
            messageCount: 0,
            hasUnread: false,
            isOverdue: false,
            executorIds: [directory[0]?.id],
            managerIds: [directory[1]?.id],
          },
        });
        return;
      }
      if (
        path === `/api/tasks/${DEEP_LINK_TASK_ID}/messages`
      ) {
        expectMiniAppAuthorization();
        await route.fulfill({ json: [] });
        return;
      }
      if (path === `/api/tasks/${DEEP_LINK_TASK_ID}/attachments`) {
        expectMiniAppAuthorization();
        await route.fulfill({ json: [officeAttachment] });
        return;
      }
      if (path === `/api/tasks/${DEEP_LINK_TASK_ID}/max-notifications`) {
        expectMiniAppAuthorization();
        await route.fulfill({ json: { muted: false } });
        return;
      }
      if (path === `/api/attachments/${OFFICE_ATTACHMENT_ID}/document-links`) {
        expectMiniAppAuthorization();
        await route.fulfill({
          json: {
            preview: {
              url: '/api/attachment-tickets/preview-token',
              fileName: 'report.pdf',
            },
            original: {
              url: '/api/attachment-tickets/original-token',
              fileName: 'report.xlsx',
            },
            expiresAt: '2026-06-30T10:05:00.000Z',
          },
        });
        return;
      }
      if (path.endsWith('/tasks')) {
        expectMiniAppAuthorization();
        await route.fulfill({
          json: {
            items: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                title: 'Подготовить документы',
                description: 'Проверить итоговую версию.',
                deadline: '2026-07-01T12:00:00.000Z',
                status: 'IN_PROGRESS',
                messageCount: 3,
                hasUnread: true,
                isOverdue: false,
                executorIds: [],
                managerIds: [],
              },
            ],
            meta: {
              page: 1,
              pageSize: 20,
              total: 1,
              totalPages: 1,
              hasNext: false,
              hasPrevious: false,
            },
          },
        });
        return;
      }
      await route.fulfill({ status: 404, json: { code: 'NOT_FOUND', message: 'Не найдено.' } });
    });
  });

  test('authenticates, renders task list and keeps mobile navigation stable', async ({ page }) => {
    await installMaxBridge(page);
    await page.goto('/max');

    await expect(page).toHaveURL(/\/max\/tasks$/);
    await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
    await expect(page.getByText('Подготовить документы')).toBeVisible();

    const navItems = page.locator('.max-nav__item');
    await expect(navItems).toHaveCount(4);
    await expect(navItems).toContainText(['Задачи', 'Уведомления', 'Управление', 'Профиль']);

    const geometry = await page.evaluate(() => ({
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      navBottom: document.querySelector('.max-nav')?.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    }));
    expect(geometry.noHorizontalOverflow).toBe(true);
    expect(geometry.navBottom).toBe(geometry.viewportHeight);
  });

  test('opens a concrete task from WebAppStartParam', async ({ page }) => {
    await installMaxBridge(page, `task_${DEEP_LINK_TASK_ID}`);
    await page.goto(`/max?WebAppStartParam=task_${DEEP_LINK_TASK_ID}`);

    await expect(page).toHaveURL(new RegExp(`/max/tasks/${DEEP_LINK_TASK_ID}$`));
    await expect(page.getByRole('heading', { name: 'Задача по ссылке' })).toBeVisible();
  });

  test('renders LibreOffice-supported attachments in MAX as external actions', async ({ page }) => {
    await installMaxBridge(page, `task_${DEEP_LINK_TASK_ID}`);
    await page.goto(`/max?WebAppStartParam=task_${DEEP_LINK_TASK_ID}`);

    await page.getByRole('tab', { name: 'Вложения' }).click();
    await expect(page.getByText('report.xlsx')).toBeVisible();
    await expect(page.getByText('8.0 КБ')).toBeVisible();
    await page.getByRole('button', { name: 'Открыть: report.xlsx' }).click();

    const dialog = page.getByRole('dialog', { name: 'Просмотр вложения' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('iframe')).toHaveCount(0);
    await expect(dialog.locator('.pdf-document-viewer__canvas')).toHaveCount(0);
    await expect(dialog.getByText('Документ готов к просмотру')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Предпросмотр' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Скачать PDF' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Скачать оригинал' })).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Предпросмотр' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as typeof window & { __maxOpenLink?: string }).__maxOpenLink),
      )
      .toContain('/api/attachment-tickets/preview-token');

    const geometry = await page.evaluate(() => ({
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    }));
    expect(geometry.noHorizontalOverflow).toBe(true);
  });

  test('keeps the create-task dialog inside the viewport with stable actions', async ({ page }) => {
    await installMaxBridge(page);
    await page.goto('/max');
    await page.getByRole('button', { name: 'Создать задачу' }).click();

    const dialog = page.getByRole('dialog', { name: 'Создание задачи' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Закрыть' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeVisible();

    const geometry = await page.evaluate(() => {
      const modal = document.querySelector('.task-form-dialog');
      const body = document.querySelector('.task-form-dialog .modal__body');
      const actions = document.querySelector('.task-form-dialog .modal__actions');
      if (modal === null || body === null || actions === null) {
        return null;
      }
      const modalRect = modal.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      return {
        modalTop: modalRect.top,
        modalBottom: modalRect.bottom,
        actionsBottom: actionsRect.bottom,
        viewportHeight: window.innerHeight,
        bodyOverflowY: getComputedStyle(body).overflowY,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry?.modalTop).toBeGreaterThanOrEqual(0);
    expect(geometry?.modalBottom).toBeLessThanOrEqual(geometry?.viewportHeight ?? 0);
    expect(geometry?.actionsBottom).toBeLessThanOrEqual(geometry?.modalBottom ?? 0);
    expect(geometry?.bodyOverflowY).toBe('auto');
    expect(geometry?.noHorizontalOverflow).toBe(true);
  });
});
