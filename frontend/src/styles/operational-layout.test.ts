import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), "utf8");
}

describe("Operational layout source invariants", () => {
  it("uses a focused auth shell on every authentication surface", () => {
    for (const file of [
      "pages/LoginPage.tsx",
      "pages/SetPasswordPage.tsx",
      "pages/MaxCallbackPage.tsx",
    ]) {
      const content = source(file);
      expect(content, file).toContain("auth-shell");
      expect(content, file).toContain("auth-panel");
      expect(content, file).not.toContain("center-screen");
      expect(content, file).not.toContain("auth-card");
    }
  });

  it("uses the provided logo on login without a home shortcut", () => {
    const content = source("pages/LoginPage.tsx");
    expect(content).toContain('src="/logo2090.png"');
    expect(content).toContain("auth-logo");
    expect(content).not.toContain("notFound.home");
    expect(content).not.toContain('to="/tasks"');
  });

  it("uses a single horizontal account workbench instead of fragmented settings cards", () => {
    const content = source("pages/ProfilePage.tsx");
    expect(content).toContain("account-workbench");
    expect(content).toContain("account-summary");
    expect(content).not.toContain("settings-grid");
    expect(content).not.toContain("style={{");
  });

  it("keeps task filters in one automatic inline bar without redundant labels or submit buttons", () => {
    const content = source("pages/TasksPage.tsx");
    expect(content).toContain("task-filterbar");
    expect(content).toContain("useDebouncedValue");
    expect(content).not.toContain("t('task.search.label')");
    expect(content).not.toContain("t('task.search.deadlineFrom')");
    expect(content).not.toContain("t('task.search.deadlineTo')");
    expect(content).not.toContain("t('task.search.apply')");
    expect(content).not.toContain("t('task.search.reset')");
  });

  it("uses searchable checkbox participant pickers in the task form", () => {
    const content = source("components/TaskFormDialog.tsx");
    expect(content).toContain("task-form-dialog__grid");
    expect(content).toContain("participant-picker");
    expect(content).toContain("participantSearch");
    expect(content).toContain('type="checkbox"');
    expect(content).not.toContain("<select");
  });

  it("renders the task list as registry records", () => {
    expect(source("pages/TasksPage.tsx")).toContain("task-registry");
    const card = source("components/TaskCard.tsx");
    expect(card).toContain("task-record");
    expect(card).not.toContain("task-card");
    expect(card).not.toContain("style={{");
  });

  it("renders task detail with full-width context and a compact status strip", () => {
    const content = source("pages/TaskDetailPage.tsx");
    expect(content).toContain("task-hero");
    expect(content).toContain("task-activity");
    expect(content).not.toContain("task-workspace__aside");
    expect(content).not.toContain("task-workspace__main");
    expect(source("components/StatusActions.tsx")).toContain("status-strip");
    expect(source("components/StatusActions.tsx")).not.toContain(
      "t('task.statusActions.heading')",
    );
    expect(content).not.toContain("style={{");
  });

  it("uses shared operational surfaces for reports, admin and inbox", () => {
    expect(source("pages/StatisticsPage.tsx")).toContain("metric-strip");
    expect(source("pages/StatisticsPage.tsx")).toContain("report-toolbar");
    expect(source("pages/StatisticsPage.tsx")).toContain("status-donut");
    expect(source("pages/StatisticsPage.tsx")).toContain("participant-bars");
    const admin = source("pages/AdminUsersPage.tsx");
    expect(admin).toContain("admin-directory");
    expect(admin).not.toContain("<table");
    expect(admin).not.toContain("table-scroll");
    expect(source("components/NotificationItem.tsx")).toContain(
      "notif-item__actions",
    );
  });

  it("keeps statistics reports balanced across desktop, tablet and phone widths", () => {
    const css = source("styles/global.css");
    const tabletBlock = css.slice(
      css.indexOf("@media (max-width: 900px)"),
      css.indexOf("@media (max-width: 768px)"),
    );
    const phoneBlock = css.slice(css.indexOf("@media (max-width: 560px)"));

    expect(css).toContain("minmax(min(100%, 456px), 1.25fr)");
    expect(css).toContain("repeat(2, minmax(min(100%, 260px), 1fr))");
    expect(css).toContain("@media (max-width: 1320px)");
    expect(tabletBlock).toContain(".metric-strip");
    expect(tabletBlock).toContain("repeat(2, minmax(0, 1fr))");
    expect(tabletBlock).toContain(".report-toolbar__controls");
    expect(tabletBlock).toContain("minmax(0, 1fr) minmax(0, 1fr)");
    expect(phoneBlock).toContain(".report-toolbar__controls");
    expect(phoneBlock).toContain(".metric-strip");
    expect(phoneBlock).toContain("grid-template-columns: minmax(0, 1fr);");
  });

  it("keeps notifications in the non-admin topbar and admin tasks workspace", () => {
    const layout = source("components/Layout.tsx");
    const tasks = source("pages/TasksPage.tsx");
    expect(layout).not.toContain('to="/notifications"');
    expect(layout).toContain("NotificationsPopover");
    expect(layout).toContain(
      "showStandaloneHeader && <NotificationsPopover />",
    );
    expect(tasks).toContain("NotificationsPopover");
    expect(tasks).toContain("showPageNotifications");
    expect(source("components/NotificationsPopover.tsx")).toContain(
      "notifications-popover",
    );
    expect(source("components/NotificationsPopover.tsx")).toContain(
      "t('notifications.hideAll')",
    );
  });

  it("uses the styled sidebar logout control", () => {
    const content = source("components/Layout.tsx");
    expect(content).toContain("app-sidebar__logout");
    expect(content).not.toContain("app-sidebar__nav-button");
  });

  it("keeps user avatars square when sidebar text is constrained", () => {
    const css = source("styles/global.css");
    expect(css).toContain("aspect-ratio: 1 / 1");
    expect(css).toContain("object-fit: cover");
    expect(css).toContain("flex-basis: 24px");
    expect(css).toContain("min-width: 24px");
  });

  it("keeps mobile navigation visible without horizontal scrolling", () => {
    const css = source("styles/global.css");
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));
    expect(mobileBlock).toContain(".app-nav");
    expect(mobileBlock).toContain("grid-template-columns");
    expect(mobileBlock).not.toContain("overflow-x: auto");
    expect(mobileBlock).not.toContain("flex-wrap: nowrap");
  });

  it("raises primary mobile touch targets to 44px", () => {
    const css = source("styles/global.css");
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));
    expect(mobileBlock).toContain(".notification-dismiss");
    expect(mobileBlock).toContain(".admin-directory__actions button");
    expect(mobileBlock).toContain(".page-head__actions .btn");
    expect(mobileBlock).toContain(".status-strip__buttons .btn");
    expect(mobileBlock).toContain(".chat-composer__actions .btn");
    expect(mobileBlock).toContain("min-height: 44px");
  });

  it("hardens dense controls against mobile overflow", () => {
    const css = source("styles/global.css");
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));
    expect(css).toContain("repeat(2, minmax(160px, 210px))");
    expect(css).toContain("minmax(144px, auto)");
    expect(css).toContain(".task-filterbar__controls--admin");
    expect(css).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr))",
    );
    expect(mobileBlock).toContain(".participant-picker__columns");
    expect(mobileBlock).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("scopes task form bottom-sheet layout to MAX only", () => {
    const css = source("styles/global.css");
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));

    expect(css).toContain(".modal-overlay--task-form-site");
    expect(css).toContain(".task-form-dialog--site");
    expect(mobileBlock).toContain(".modal-overlay--task-form-max");
    expect(mobileBlock).toContain(".task-form-dialog--max");
    expect(mobileBlock).toContain("align-items: flex-end");
    expect(mobileBlock).toContain("border-radius: var(--radius-md) var(--radius-md) 0 0");
  });

  it("keeps task form dialogs padded with visible gaps", () => {
    const css = source("styles/global.css");

    expect(css).toMatch(
      /\.task-form-dialog\s*{[^}]*gap: var\(--space-4\);[^}]*padding: var\(--space-5\);/s,
    );
    expect(css).toMatch(
      /\.task-form-dialog__form,\s*\.task-form-dialog__content\s*{[^}]*gap: var\(--space-4\);/s,
    );
    expect(css).not.toMatch(
      /\.task-form-dialog\s*{[^}]*gap: 0;[^}]*padding: 0;/s,
    );
  });

  it("aligns the user directory columns and keeps mobile actions compact", () => {
    const css = source("styles/global.css");
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));

    expect(css).toContain("grid-template-columns: subgrid");
    expect(css).toContain(".admin-directory__list");
    expect(css).toContain("display: contents");
    expect(css).toContain(".admin-directory__action-label--compact");
    expect(mobileBlock).toContain(
      ".admin-directory__row--admin .admin-directory__action-label--full",
    );
    expect(mobileBlock).toContain(
      ".admin-directory__row--admin .admin-directory__action-label--compact",
    );
    expect(mobileBlock).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
  });
});
