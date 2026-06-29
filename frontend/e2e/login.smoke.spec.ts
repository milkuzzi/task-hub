import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'UNAUTHENTICATED',
        message: 'Требуется вход в систему.',
      }),
    });
  });
  await page.route('**/api/auth/refresh', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'UNAUTHENTICATED',
        message: 'Требуется вход в систему.',
      }),
    });
  });
});

test.describe('@smoke login shell', () => {
  test('renders login form without horizontal overflow and keeps keyboard focus order', async ({
    page,
  }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading')).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.getByRole('button')).toHaveCount(2);

    const noHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(noHorizontalOverflow).toBe(true);

    await page.locator('input[name="email"]').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('input[name="password"]')).toBeFocused();
  });
});
