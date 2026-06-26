import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), 'utf8');
}

describe('Operational layout source invariants', () => {
  it('uses a focused auth shell on every authentication surface', () => {
    for (const file of ['pages/LoginPage.tsx', 'pages/SetPasswordPage.tsx', 'pages/MaxCallbackPage.tsx']) {
      const content = source(file);
      expect(content, file).toContain('auth-shell');
      expect(content, file).toContain('auth-panel');
      expect(content, file).not.toContain('center-screen');
      expect(content, file).not.toContain('auth-card');
    }
  });

  it('uses a single horizontal account workbench instead of fragmented settings cards', () => {
    const content = source('pages/ProfilePage.tsx');
    expect(content).toContain('account-workbench');
    expect(content).toContain('account-summary');
    expect(content).not.toContain('settings-grid');
    expect(content).not.toContain('style={{');
  });

  it('keeps task filters in one automatic inline bar without redundant labels or submit buttons', () => {
    const content = source('pages/TasksPage.tsx');
    expect(content).toContain('task-filterbar');
    expect(content).toContain('useDebouncedValue');
    expect(content).not.toContain("t('task.search.label')");
    expect(content).not.toContain("t('task.search.deadlineFrom')");
    expect(content).not.toContain("t('task.search.deadlineTo')");
    expect(content).not.toContain("t('task.search.apply')");
    expect(content).not.toContain("t('task.search.reset')");
  });

  it('uses searchable checkbox participant pickers in the task form', () => {
    const content = source('components/TaskFormDialog.tsx');
    expect(content).toContain('participant-picker');
    expect(content).toContain('participantSearch');
    expect(content).toContain('type="checkbox"');
    expect(content).not.toContain('<select');
  });

  it('renders the task list as registry records', () => {
    expect(source('pages/TasksPage.tsx')).toContain('task-registry');
    const card = source('components/TaskCard.tsx');
    expect(card).toContain('task-record');
    expect(card).not.toContain('task-card');
    expect(card).not.toContain('style={{');
  });

  it('renders task detail with full-width context and a compact status strip', () => {
    const content = source('pages/TaskDetailPage.tsx');
    expect(content).toContain('task-hero');
    expect(content).toContain('task-activity');
    expect(content).not.toContain('task-workspace__aside');
    expect(content).not.toContain('task-workspace__main');
    expect(source('components/StatusActions.tsx')).toContain('status-strip');
    expect(source('components/StatusActions.tsx')).not.toContain("t('task.statusActions.heading')");
    expect(content).not.toContain('style={{');
  });

  it('uses shared operational surfaces for reports, admin and inbox', () => {
    expect(source('pages/StatisticsPage.tsx')).toContain('metric-strip');
    expect(source('pages/StatisticsPage.tsx')).toContain('report-toolbar');
    expect(source('pages/StatisticsPage.tsx')).toContain('status-donut');
    expect(source('pages/StatisticsPage.tsx')).toContain('participant-bars');
    const admin = source('pages/AdminUsersPage.tsx');
    expect(admin).toContain('admin-directory');
    expect(admin).not.toContain('<table');
    expect(admin).not.toContain('table-scroll');
    expect(source('components/NotificationItem.tsx')).toContain('notif-item__actions');
  });

  it('keeps notifications in the non-admin topbar and admin tasks workspace', () => {
    const layout = source('components/Layout.tsx');
    const tasks = source('pages/TasksPage.tsx');
    expect(layout).not.toContain('to="/notifications"');
    expect(layout).toContain('NotificationsPopover');
    expect(layout).toContain('showStandaloneHeader && <NotificationsPopover />');
    expect(tasks).toContain('NotificationsPopover');
    expect(tasks).toContain('showPageNotifications');
    expect(source('components/NotificationsPopover.tsx')).toContain('notifications-popover');
    expect(source('components/NotificationsPopover.tsx')).toContain("t('notifications.hideAll')");
  });

  it('uses the styled sidebar logout control', () => {
    const content = source('components/Layout.tsx');
    expect(content).toContain('app-sidebar__logout');
    expect(content).not.toContain('app-sidebar__nav-button');
  });

  it('keeps mobile navigation visible without horizontal scrolling', () => {
    const css = source('styles/global.css');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('.app-nav');
    expect(mobileBlock).toContain('grid-template-columns');
    expect(mobileBlock).not.toContain('overflow-x: auto');
    expect(mobileBlock).not.toContain('flex-wrap: nowrap');
  });

  it('raises primary mobile touch targets to 44px', () => {
    const css = source('styles/global.css');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('.notification-dismiss');
    expect(mobileBlock).toContain('.admin-directory__actions button');
    expect(mobileBlock).toContain('.page-head__actions .btn');
    expect(mobileBlock).toContain('.status-strip__buttons .btn');
    expect(mobileBlock).toContain('.chat-composer__actions .btn');
    expect(mobileBlock).toContain('min-height: 44px');
  });

  it('hardens dense controls against mobile overflow', () => {
    const css = source('styles/global.css');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) repeat(2, minmax(0, 220px))');
    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr))');
    expect(mobileBlock).toContain('.participant-picker__columns');
    expect(mobileBlock).toContain('grid-template-columns: minmax(0, 1fr)');
  });
});
