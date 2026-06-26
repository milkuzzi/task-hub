# Task Hub Operational Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Task Hub's frontend as a strict operational work system with a consistent app shell, dense task registry, task workspace, restrained admin/reporting screens, and updated design-quality tests.

**Architecture:** Keep the existing React/Vite routes and backend API contracts. Redesign through component markup, shared CSS tokens/classes, and tests that enforce product UI invariants rather than old exact palette values. Do not add fake concepts such as priority, progress, SLA, charts, kanban, or ownership labels.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, React Testing Library, i18next, CSS custom properties in `frontend/src/styles/global.css`.

## Global Constraints

- PRODUCT register is `product`; design serves daily operational workflows.
- Visual personality is strict, calm, operational.
- Do not add backend features or fake data.
- Do not add charts in this redesign.
- Use one restrained product UI system across protected screens.
- Keep Russian UI copy and existing route responsibilities.
- Target WCAG AA contrast, keyboard navigation, visible focus, reduced motion, and responsive layouts.
- Avoid SaaS landing-page aesthetics, glassmorphism, decorative gradients, playful rounded cards, display typography, and decorative animation.
- `task-hub` is not currently inside a git repository. For every task, run the checkpoint commands. If a git repository is initialized later, also run the listed optional commit command.

---

## File Structure Map

- `PRODUCT.md`: already created product context. Do not rewrite unless product strategy changes.
- `docs/superpowers/specs/2026-06-24-task-hub-operational-redesign-design.md`: approved design spec. Use as source of truth.
- `frontend/src/styles/global.css`: main design system implementation: tokens, shell, layout, controls, tables, task records, task workspace, chat, auth/profile, responsive behavior, themes, reduced motion.
- `frontend/src/styles/*.test.ts`: design invariant tests. Replace exact old-token assertions with invariant checks for token presence, contrast, radius limits, motion limits, reduced motion, and anti-slop patterns.
- `frontend/src/components/Layout.tsx`: authenticated shell, nav, account block, logout button class consistency.
- `frontend/src/pages/LoginPage.tsx`: focused auth panel, no marketing split-screen.
- `frontend/src/pages/TasksPage.tsx`: task registry page header, filter panel, result context, pagination classes.
- `frontend/src/components/TaskCard.tsx`: registry-style task record.
- `frontend/src/pages/TaskDetailPage.tsx`: two-column workspace structure and structured header.
- `frontend/src/components/ChatPanel.tsx`: operational chat feed/composer class hooks.
- `frontend/src/components/ChatMessageItem.tsx`: message hierarchy class hooks.
- `frontend/src/components/AttachmentsSection.tsx`, `AttachmentThumbnail.tsx`, `AuditLog.tsx`, `StatusActions.tsx`: align workspace support components with shared classes.
- `frontend/src/pages/StatisticsPage.tsx`: restrained report layout, compact KPI panels, no charts.
- `frontend/src/pages/AdminUsersPage.tsx`: admin registry layout, remove one-off card feel.
- `frontend/src/pages/ProfilePage.tsx`: remove inline styles, account settings layout.
- `frontend/src/pages/NotificationsPage.tsx`, `frontend/src/components/NotificationItem.tsx`: operational inbox hierarchy.
- Existing behavioral tests under `frontend/src/**/*.test.tsx`: preserve behavior assertions; update only selectors/text assumptions affected by markup changes.

---

### Task 1: Design Invariant Test Baseline

**Files:**
- Modify: `frontend/src/styles/tokens.test.ts`
- Modify: `frontend/src/styles/dark-tokens.test.ts`
- Modify: `frontend/src/styles/role-contrast.property.test.ts`
- Modify: `frontend/src/styles/badge-contrast.property.test.ts`
- Modify: `frontend/src/styles/tokens-only.property.test.ts`
- Modify: `frontend/src/styles/anti-slop.property.test.ts`
- Test: `frontend/src/styles/*.test.ts`
- Test: `frontend/src/styles/*.property.test.ts`

**Interfaces:**
- Consumes: `frontend/src/styles/global.css` as plain text.
- Produces: test expectations that allow a new restrained palette while enforcing invariants.

- [ ] **Step 1: Replace exact old palette assertions with token role assertions**

Edit `frontend/src/styles/tokens.test.ts` so it no longer freezes `#6366f1`, `#f9fafb`, or `#ef4444`. Keep the existing `extractRootBlock` and `tokenValue` helpers. Replace the first test with:

```ts
it('defines required operational color roles', () => {
  const required = [
    '--color-bg',
    '--color-surface',
    '--color-surface-2',
    '--color-border',
    '--color-border-strong',
    '--color-text',
    '--color-muted',
    '--color-muted-strong',
    '--color-primary',
    '--color-primary-contrast',
    '--color-danger',
    '--color-success',
    '--color-warning',
    '--focus-ring',
  ];

  for (const token of required) {
    expect(tokenValue(root, token), token).not.toBeNull();
  }
});
```

Keep the font stack, shadow, focus, motion, tint, and type-scale tests, but update names/comments from "brand" to "operational".

- [ ] **Step 2: Update dark token tests to invariants**

In `frontend/src/styles/dark-tokens.test.ts`, keep the extraction helpers. Replace exact color tests with role and separation assertions:

```ts
it('dark theme overrides the same operational roles as light theme', () => {
  const roles = [
    '--color-bg',
    '--color-surface',
    '--color-surface-2',
    '--color-border',
    '--color-text',
    '--color-muted',
    '--color-primary',
  ];

  for (const token of roles) {
    expect(tokenValue(darkRoot, token), token).not.toBeNull();
  }
});

it('base light theme and dark theme are materially different', () => {
  expect(tokenValue(baseRoot, '--color-bg')).not.toBe(tokenValue(darkRoot, '--color-bg'));
  expect(tokenValue(baseRoot, '--color-surface')).not.toBe(tokenValue(darkRoot, '--color-surface'));
  expect(tokenValue(baseRoot, '--color-text')).not.toBe(tokenValue(darkRoot, '--color-text'));
});
```

Keep the badge-token presence test, but assert presence and hex shape rather than exact old values.

- [ ] **Step 3: Expand token-only test polished selectors**

In `frontend/src/styles/tokens-only.property.test.ts`, update `POLISHED_SPACING_SELECTORS` to include new operational classes that will be introduced in later tasks:

```ts
const POLISHED_SPACING_SELECTORS = new Set([
  '.app-main',
  '.app-sidebar',
  '.app-sidebar__brand',
  '.app-sidebar__nav',
  '.app-sidebar__nav a',
  '.app-sidebar__user',
  '.app-header',
  '.app-header__inner',
  '.page-head',
  '.page-toolbar',
  '.panel',
  '.panel--compact',
  '.btn',
  '.btn--sm',
  '.field__input',
  '.form-error',
  '.form-success',
  '.task-filters',
  '.task-filters__row',
  '.task-registry',
  '.task-record',
  '.task-record__body',
  '.task-record__meta',
  '.task-workspace',
  '.task-workspace__aside',
  '.task-workspace__main',
  '.tabs',
  '.tab',
  '.data-table th, .data-table td',
  '.modal-overlay',
  '.modal',
  '.modal__actions',
]);
```

If the parser flags legitimate CSS functions like `minmax()` or `calc()`, extend `checkSpacingDeclaration` only for the specific function and only when all raw lengths inside that function are tokenized.

- [ ] **Step 4: Keep anti-slop bans aligned with new class names**

In `frontend/src/styles/anti-slop.property.test.ts`, update `SURFACE_NAME_RE` to cover the new names:

```ts
const SURFACE_NAME_RE =
  /(?:\bcard\b|\bpanel\b|task-record|task-workspace|auth-panel|chat-msg|chat-composer|attachment-tile|notif-item|metric-panel|\bmodal\b|\bviewer\b|app-header|status-badge)/;
```

Do not weaken the bans on gradient text, glass blur, side accent bars, or ghost cards.

- [ ] **Step 5: Run design tests and capture expected failures**

Run:

```bash
npm test -- --run src/styles/tokens.test.ts src/styles/dark-tokens.test.ts src/styles/tokens-only.property.test.ts src/styles/anti-slop.property.test.ts src/styles/role-contrast.property.test.ts src/styles/badge-contrast.property.test.ts
```

Expected before CSS implementation: failures are allowed only where tests now require new tokens/classes not yet implemented. Existing parser crashes are not acceptable; fix parser/test setup before continuing.

- [ ] **Step 6: Checkpoint**

Run:

```bash
npm run typecheck
```

Expected: TypeScript passes or reports only existing unrelated issues. If a git repository exists, commit:

```bash
git add frontend/src/styles/*.test.ts
git commit -m "test: update operational design invariants"
```

---

### Task 2: Operational CSS System

**Files:**
- Modify: `frontend/src/styles/global.css`
- Test: style tests updated in Task 1

**Interfaces:**
- Consumes: existing class names plus new classes from later tasks.
- Produces: shared tokens and classes used by all redesigned components.

- [ ] **Step 1: Replace the top comment and root tokens**

Update the file header to describe "operational redesign" rather than "редизайн v3". In `:root`, use a restrained palette with roles like:

```css
:root {
  --color-bg: #f6f7f9;
  --color-surface: #ffffff;
  --color-surface-2: #f0f2f5;
  --color-surface-3: #e4e7ec;
  --color-border: #d9dee7;
  --color-border-strong: #b8c0cc;
  --color-text: #151922;
  --color-muted: #5f6978;
  --color-muted-strong: #343b47;
  --color-primary: #2557a7;
  --color-primary-contrast: #ffffff;
  --color-link: #1f4f99;
  --color-danger: #b42318;
  --color-danger-contrast: #ffffff;
  --color-success: #067647;
  --color-success-contrast: #ffffff;
  --color-warning: #b54708;
  --color-warning-contrast: #ffffff;
  --color-info: #175cd3;
  --color-info-contrast: #ffffff;
}
```

Keep spacing values in `{4,8,12,16,24,32,48}`, radii in `8-12px` except `--radius-pill`, fixed font sizes, focus ring, and motion durations within 150-200ms.

- [ ] **Step 2: Normalize base layout**

Implement these class responsibilities in `global.css`:

```css
.app-shell { display: flex; min-height: 100vh; background: var(--color-bg); }
.app-main { flex: 1; width: 100%; max-width: 1280px; margin: 0 auto; margin-left: var(--sidebar-w); padding: var(--space-6); }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.page-head h1 { margin: 0; font-size: var(--fs-2xl); line-height: var(--lh-tight); letter-spacing: 0; }
.page-toolbar { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: var(--space-3); }
.panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.panel--compact { padding: var(--space-4); }
```

Use token values only for component colors, radii, spacing, and font sizes.

- [ ] **Step 3: Rebuild controls**

Ensure `.btn`, `.field`, `.field__input`, `.status-badge`, `.msg-counter`, `.unread-dot`, `.tabs`, `.tab`, `.data-table`, `.modal`, `.loading-state`, `.empty-state`, and `.error-state` share one product vocabulary:

```css
.btn {
  min-height: 36px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
}
.btn--primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-primary-contrast);
}
.btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--color-muted-strong);
}
```

Do not pair a 1px border with a wide soft shadow on surfaces. Use borders first; reserve `--shadow-popover` for modals/viewers.

- [ ] **Step 4: Add task registry and workspace classes**

Add classes required by Tasks and Task Detail:

```css
.task-registry { display: grid; gap: var(--space-3); grid-template-columns: minmax(0, 1fr); }
.task-record { display: grid; gap: var(--space-3); padding: var(--space-4); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.task-record__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.task-record__title { margin: 0; font-size: var(--fs-lg); line-height: var(--lh-snug); }
.task-record__desc { margin: 0; color: var(--color-muted); font-size: var(--fs-sm); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.task-workspace { display: grid; gap: var(--space-4); grid-template-columns: minmax(0, 320px) minmax(0, 1fr); align-items: start; }
.task-workspace__aside { position: sticky; top: var(--space-6); display: flex; flex-direction: column; gap: var(--space-3); }
.task-workspace__main { min-width: 0; }
```

Add mobile media rules so `.task-workspace` becomes one column below `900px`, `.app-sidebar` hides below `768px`, and `.app-main` loses left margin on mobile.

- [ ] **Step 5: Add auth/profile/admin/report classes**

Add focused product classes:

```css
.auth-shell { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: var(--space-6); }
.auth-panel { width: min(100%, 420px); padding: var(--space-6); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.settings-grid { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.metric-grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.metric-panel { padding: var(--space-4); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
```

- [ ] **Step 6: Run style verification**

Run:

```bash
npm test -- --run src/styles/tokens.test.ts src/styles/dark-tokens.test.ts src/styles/tokens-only.property.test.ts src/styles/anti-slop.property.test.ts src/styles/role-contrast.property.test.ts src/styles/badge-contrast.property.test.ts src/styles/radius.property.test.ts src/styles/spacing.property.test.ts src/styles/motion-duration.property.test.ts
```

Expected: all listed style tests pass.

- [ ] **Step 7: Checkpoint**

Run:

```bash
npm run typecheck
```

If a git repository exists, commit:

```bash
git add frontend/src/styles/global.css frontend/src/styles/*.test.ts
git commit -m "style: introduce operational design system"
```

---

### Task 3: App Shell And Authentication Surfaces

**Files:**
- Modify: `frontend/src/components/Layout.tsx`
- Modify: `frontend/src/pages/LoginPage.tsx`
- Modify: `frontend/src/pages/ProfilePage.tsx`
- Test: existing auth/profile/layout tests if present

**Interfaces:**
- Consumes: `.app-shell`, `.app-sidebar`, `.app-header`, `.auth-shell`, `.auth-panel`, `.settings-grid`, `.panel`.
- Produces: consistent shell used by all authenticated routes and focused auth/profile screens.

- [ ] **Step 1: Fix sidebar logout class and shell hierarchy**

In `Layout.tsx`, keep nav behavior and role checks. Change the logout button class from the unstyled `app-sidebar__nav-button` to the CSS-backed class:

```tsx
<button
  className="app-sidebar__logout"
  type="button"
  onClick={handleLogout}
  aria-label={t('nav.logout')}
>
  <IconLogout />
</button>
```

Keep `NavLink` routes unchanged. Use the same shell for admin, manager, and executor; only nav items remain permission-based.

- [ ] **Step 2: Convert login page to focused auth panel**

In `LoginPage.tsx`, replace `center-screen` and `auth-card` with:

```tsx
return (
  <section className="auth-shell">
    <form className="auth-panel stack" onSubmit={handleSubmit} noValidate>
      <div className="auth-panel__brand">...</div>
      <div className="auth-panel__head">
        <h1>{t('login.heading')}</h1>
      </div>
      ...
    </form>
  </section>
);
```

Do not add marketing copy. Preserve email/password login, MAX login, error behavior, and the existing link.

- [ ] **Step 3: Remove profile inline styles**

In `ProfilePage.tsx`, replace inline `style={{ margin: 0 }}` and `style={{ alignSelf: 'flex-start' }}` with classes:

```tsx
<div className="settings-grid">
  <article className="panel panel--compact stack account-summary">
    <h2 className="account-summary__name">{user.name}</h2>
    <span className="status-badge status-badge--info account-summary__role">
      {roleLabel}
    </span>
    <p className="account-summary__line">
      <span className="text-muted">{t('login.email')}: </span>
      {user.email}
    </p>
  </article>
  ...
</div>
```

Use `panel panel--compact stack` for avatar, password, and MAX sections.

- [ ] **Step 4: Run shell/auth tests**

Run:

```bash
npm test -- --run src/pages/ProfilePage.avatar.preservation.test.tsx src/pages/ProfilePage.avatar.bug.test.tsx
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 5: Checkpoint**

If a git repository exists, commit:

```bash
git add frontend/src/components/Layout.tsx frontend/src/pages/LoginPage.tsx frontend/src/pages/ProfilePage.tsx frontend/src/styles/global.css
git commit -m "refactor: align shell and auth surfaces"
```

---

### Task 4: Task Registry

**Files:**
- Modify: `frontend/src/pages/TasksPage.tsx`
- Modify: `frontend/src/components/TaskCard.tsx`
- Modify: `frontend/src/components/TaskCard.test.tsx`
- Test: `frontend/src/components/TaskCard.test.tsx`

**Interfaces:**
- Consumes: existing `TaskCardModel`, `formatMsk`, `TASK_STATUS_LABEL_KEYS`, task list API.
- Produces: registry-style task records with stable accessible controls.

- [ ] **Step 1: Update TasksPage layout classes**

In `TasksPage.tsx`, change the top-level structure to:

```tsx
<section className="stack page-section">
  <div className="page-head">
    <div className="page-head__content">
      <h1>{t('nav.tasks')}</h1>
      <p className="page-head__meta">{t('task.list.total', { count: meta.total })}</p>
    </div>
    {canManage && (
      <button className="btn btn--primary" type="button" onClick={openCreate}>
        {t('task.actions.create')}
      </button>
    )}
  </div>
  ...
</section>
```

Move the existing total count out of the loose paragraph at result level.

- [ ] **Step 2: Convert filters to compact toolbar panel**

Change the filter form class from `card stack task-filters` to:

```tsx
<form className="panel panel--compact task-filters" onSubmit={handleApply}>
```

Keep all validation and state code unchanged. Use existing `.task-filters__row` and `.row-actions`.

- [ ] **Step 3: Use registry container**

Change the result container from `.grid` to:

```tsx
<div className="task-registry">
  {tasks.map(...)}
</div>
```

Keep loading, error, empty, and pagination behavior unchanged.

- [ ] **Step 4: Rewrite TaskCard markup as a record**

In `TaskCard.tsx`, keep props and callbacks unchanged. Replace root and class names with:

```tsx
<article className={`task-record task-record--${task.status.toLowerCase()}`}>
  <header className="task-record__head">
    <div className="task-record__statusline">
      <span className={`status-badge status-badge--${task.status.toLowerCase()}`}>
        {t(statusKey(task.status))}
      </span>
      {task.hasUnread && (
        <span className="unread-dot" role="status" aria-label={t('task.card.unread')} title={t('task.card.unread')} />
      )}
    </div>
    <span className="msg-counter" title={t('task.card.messages')} aria-label={`${t('task.card.messages')}: ${task.messageCount}`}>
      ...
      {task.messageCount}
    </span>
  </header>
  <div className="task-record__body">
    <h3 className="task-record__title">{task.title}</h3>
    {task.description !== null && task.description !== '' && (
      <p className="task-record__desc">{task.description}</p>
    )}
  </div>
  <footer className="task-record__foot">
    <p className="task-record__deadline">...</p>
    <div className="row-actions task-record__actions">...</div>
  </footer>
</article>
```

Button labels and callbacks remain unchanged so existing behavior tests still pass.

- [ ] **Step 5: Update TaskCard tests only if necessary**

Run:

```bash
npm test -- --run src/components/TaskCard.test.tsx
```

Expected: tests pass. If text matching for the deadline changes because the label is added, update the assertion to:

```ts
expect(screen.getByText(/02\.01\.2024 12:30/)).toBeInTheDocument();
```

Do not weaken callback or permission assertions.

- [ ] **Step 6: Checkpoint**

Run:

```bash
npm run typecheck
npm test -- --run src/components/TaskCard.test.tsx
```

If a git repository exists, commit:

```bash
git add frontend/src/pages/TasksPage.tsx frontend/src/components/TaskCard.tsx frontend/src/components/TaskCard.test.tsx frontend/src/styles/global.css
git commit -m "feat: redesign task registry"
```

---

### Task 5: Task Detail Workspace And Activity Components

**Files:**
- Modify: `frontend/src/pages/TaskDetailPage.tsx`
- Modify: `frontend/src/components/StatusActions.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/components/ChatMessageItem.tsx`
- Modify: `frontend/src/components/AttachmentsSection.tsx`
- Modify: `frontend/src/components/AuditLog.tsx`
- Modify: `frontend/src/pages/TaskDetailPage.tabs.property.test.tsx` only if markup changes break role queries.
- Test: `frontend/src/pages/TaskDetailPage.tabs.property.test.tsx`
- Test: chat message tests under `frontend/src/components/ChatMessageItem*.test.tsx`

**Interfaces:**
- Consumes: current task detail API, chat API, audit API, status API, socket events.
- Produces: two-column task workspace with metadata/actions side panel and tabbed activity main panel.

- [ ] **Step 1: Restructure TaskDetailPage header**

Keep loading/error branches. In the success branch, replace the loose sequence of back button, page head, deadline paragraph, description, status actions, tabs, and panel with:

```tsx
<section className="stack page-section">
  <button className="btn btn--sm btn--ghost" type="button" onClick={() => navigate('/tasks')}>
    ...
    {t('taskDetail.back')}
  </button>

  <div className="task-workspace">
    <aside className="task-workspace__aside">
      <article className="panel panel--compact stack task-context">
        <div className="task-context__head">
          <h1>{task.title}</h1>
          {status !== null && (...status badge...)}
        </div>
        <p className="task-context__deadline">...</p>
        {task.description !== null && task.description !== '' && (
          <p className="task-context__description">{task.description}</p>
        )}
      </article>

      {status !== null && (
        <StatusActions ... />
      )}
    </aside>

    <div className="task-workspace__main">
      ...tabs and selected content...
    </div>
  </div>
</section>
```

Do not change socket, loading, tab state, message, attachment, or audit logic.

- [ ] **Step 2: Align StatusActions with panel vocabulary**

In `StatusActions.tsx`, keep behavior. Ensure root class can be styled as a panel:

```tsx
<section className="panel panel--compact status-actions">
```

Keep heading, buttons, error messages, and callbacks unchanged.

- [ ] **Step 3: Tighten ChatPanel class hooks**

In `ChatPanel.tsx`, keep validation logic. Change the feed/composer wrappers to support operational styling:

```tsx
<div className="chat-panel panel">
  <div className="chat-feed">
    ...
  </div>
  <form className="chat-composer stack" ...>
    ...
  </form>
</div>
```

Keep input, file, and send behavior unchanged.

- [ ] **Step 4: Preserve chat message behavior while updating hierarchy**

In `ChatMessageItem.tsx`, do not change edit/delete/readers logic. Only ensure class hooks match CSS:

```tsx
<article className={message.deleted ? 'chat-msg chat-msg--deleted' : 'chat-msg'}>
  <header className="chat-msg__head">...</header>
  <p className="chat-msg__text">...</p>
  <footer className="chat-msg__foot">...</footer>
</article>
```

If current markup already uses these names, only adjust CSS.

- [ ] **Step 5: Keep attachments and audit table-like**

In `AttachmentsSection.tsx` and `AuditLog.tsx`, prefer existing markup. Add `panel panel--compact` wrappers only when the component lacks a stable surface:

```tsx
<section className="panel panel--compact stack">
```

Do not change attachment open/download callbacks or audit authorization behavior.

- [ ] **Step 6: Run task detail and chat tests**

Run:

```bash
npm test -- --run src/pages/TaskDetailPage.tabs.property.test.tsx src/components/ChatMessageItem.readers.preserve.test.tsx src/components/ChatMessageItem.avatar.bug.test.tsx src/components/ChatMessageItem.readcount.bug.test.tsx
npm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Checkpoint**

If a git repository exists, commit:

```bash
git add frontend/src/pages/TaskDetailPage.tsx frontend/src/components/StatusActions.tsx frontend/src/components/ChatPanel.tsx frontend/src/components/ChatMessageItem.tsx frontend/src/components/AttachmentsSection.tsx frontend/src/components/AuditLog.tsx frontend/src/styles/global.css
git commit -m "feat: redesign task workspace"
```

---

### Task 6: Admin, Statistics, Notifications, And Supporting Screens

**Files:**
- Modify: `frontend/src/pages/StatisticsPage.tsx`
- Modify: `frontend/src/pages/AdminUsersPage.tsx`
- Modify: `frontend/src/pages/NotificationsPage.tsx`
- Modify: `frontend/src/components/NotificationItem.tsx`
- Modify: `frontend/src/pages/NotFoundPage.tsx` if it visually conflicts.
- Test: avatar/admin/notification tests affected by markup.

**Interfaces:**
- Consumes: existing statistics, users, notifications APIs.
- Produces: operational report/admin/inbox surfaces aligned with shared CSS.

- [ ] **Step 1: Redesign StatisticsPage without charts**

In `StatisticsPage.tsx`, keep all period/export/data logic. Change form class:

```tsx
<form className="panel panel--compact stack report-toolbar" onSubmit={handleApply} aria-label={t('statistics.period.label')}>
```

Change KPI grid from `.grid` and `.card` to:

```tsx
<div className="metric-grid">
  <div className="metric-panel">
    <h2 className="metric-panel__title">{t('statistics.summary.total')}</h2>
    <p className="metric-panel__value">{stats.totalTasks}</p>
  </div>
  ...
</div>
```

Keep tables for status/manager/executor sections.

- [ ] **Step 2: Redesign AdminUsersPage as registry**

In `AdminUsersPage.tsx`, keep authorization and action logic. Replace `article className="card stack"` with `article className="panel panel--compact stack admin-section"`. Keep `InviteUserForm`, active table, deleted table, and all `ConfirmDialog` flows.

For user status cells, wrap text in a badge class:

```tsx
<span className={u.locked ? 'status-badge status-badge--needs_admin' : !u.active ? 'status-badge status-badge--waiting' : 'status-badge status-badge--done'}>
  {...existing label logic...}
</span>
```

Do not change destructive operation behavior.

- [ ] **Step 3: Align NotificationsPage with inbox layout**

In `NotificationsPage.tsx`, add result context classes:

```tsx
<section className="stack page-section">
  <div className="page-head">
    <div className="page-head__content">
      <h1>{t('notifications.heading')}</h1>
    </div>
  </div>
  ...
</section>
```

In `NotificationItem.tsx`, keep seen/dismiss logic and update class hierarchy only:

```tsx
<li className="notif-item">
  <div className="notif-item__main">...</div>
  <div className="notif-item__actions">...</div>
</li>
```

- [ ] **Step 4: Run supporting screen tests**

Run:

```bash
npm test -- --run src/pages/AdminUsersPage.avatar.bug.test.tsx src/components/EmptyState.property.test.tsx src/components/ErrorState.property.test.tsx src/components/LoadingState.property.test.tsx
npm run typecheck
```

Expected: all pass.

- [ ] **Step 5: Checkpoint**

If a git repository exists, commit:

```bash
git add frontend/src/pages/StatisticsPage.tsx frontend/src/pages/AdminUsersPage.tsx frontend/src/pages/NotificationsPage.tsx frontend/src/components/NotificationItem.tsx frontend/src/styles/global.css
git commit -m "feat: align admin reports and notifications"
```

---

### Task 7: Full Verification And Browser Pass

**Files:**
- Modify: only files required by test failures discovered here.
- Test: full frontend suite.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified redesigned frontend.

- [ ] **Step 1: Run full frontend test suite**

Run:

```bash
npm test
```

Expected: all frontend tests pass. If failures are visual-test expectation mismatches, update the test to preserve the invariant. If failures are behavioral, fix the component.

- [ ] **Step 2: Run typecheck and build**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both pass.

- [ ] **Step 3: Start Vite dev server**

Run:

```bash
npm run dev -- --host 127.0.0.1
```

Expected: Vite serves on `http://127.0.0.1:5173/` or the next available port. Keep the session running for browser verification.

- [ ] **Step 4: Browser-check key screens**

Use Playwright or the available browser automation tool to inspect:

- `/login` at desktop width and mobile width.
- `/tasks` with mocked or available backend state if login/session is possible.
- `/tasks/:taskId` if a test account/task exists.
- `/profile`, `/notifications`, `/statistics`, `/admin/users` where the role allows access.

Check:

- no text overflow at 375px width;
- sidebar/mobile nav does not overlap content;
- focus states are visible;
- task record metadata is scannable;
- task detail side panel and activity area stack correctly;
- tables scroll horizontally on mobile rather than breaking layout.

- [ ] **Step 5: Run final style grep**

Run:

```bash
rg -n "background-clip:\\s*text|backdrop-filter|linear-gradient|border-left:\\s*[2-9]|border-radius:\\s*(2[4-9]|[3-9][0-9])px|style=\\{\\{" frontend/src
```

Expected: no matches except allowed inline style false positives in non-visual tests. If `style={{` appears in redesigned page/component files, replace it with classes.

- [ ] **Step 6: Final checkpoint**

Run:

```bash
npm test
npm run build
```

Expected: both pass. If a git repository exists, commit:

```bash
git add frontend/src docs/superpowers PRODUCT.md
git commit -m "feat: complete operational redesign"
```

---

## Self-Review

Spec coverage:

- App shell: Tasks 2 and 3.
- Visual system and component vocabulary: Tasks 1 and 2.
- Task list registry: Task 4.
- Task detail workspace, chat, attachments, audit: Task 5.
- Statistics, admin users, notifications, profile, login: Tasks 3 and 6.
- Updated tests and verification: Tasks 1, 2, and 7.
- No fake backend data and no charts: Global Constraints and Task 6.

Placeholder scan:

- No banned placeholder patterns remain.
- Each task has exact files, commands, expected results, and concrete markup/CSS snippets.

Type consistency:

- Existing public TypeScript interfaces are preserved: `TaskCardProps`, `TaskCardModel`, `TaskDetail`, API functions, and route paths remain unchanged.
- New class names are introduced first in Task 2 and then consumed by later tasks.
