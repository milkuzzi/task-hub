import { expect, test, type Page } from '@playwright/test';

const DEEP_LINK_TASK_ID = '22222222-2222-4222-8222-222222222222';
const MINI_APP_TOKEN = 'mini-app-session-token';
const directory = Array.from({ length: 8 }, (_, index) => ({
  id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
  email: `user${index + 1}@example.com`,
  name: `Участник ${index + 1}`,
  role: index % 2 === 0 ? 'EXECUTOR' : 'MANAGER',
}));

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
        path === `/api/tasks/${DEEP_LINK_TASK_ID}/messages` ||
        path === `/api/tasks/${DEEP_LINK_TASK_ID}/attachments`
      ) {
        expectMiniAppAuthorization();
        await route.fulfill({ json: [] });
        return;
      }
      if (path === `/api/tasks/${DEEP_LINK_TASK_ID}/max-notifications`) {
        expectMiniAppAuthorization();
        await route.fulfill({ json: { muted: false } });
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
