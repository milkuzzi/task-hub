# Task Hub Density Redesign Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the user-identified layout failures by making task filters, task detail, profile, statistics, and notifications denser, more horizontal, and less card-fragmented.

**Architecture:** Keep the existing React/Vite route structure and API contracts. Move notification interaction into a reusable popover on `/tasks`, restructure page markup with new operational classes, and update CSS/tests to enforce density instead of preserving the previous card-heavy iteration.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, React Testing Library, Phosphor icons, existing REST API wrappers.

## Global Constraints

- Do not preserve the initial design if it conflicts with better product UI.
- Avoid duplicate labels when placeholders already carry the interaction meaning.
- Use horizontal composition where the data belongs to one workflow.
- Avoid empty panel space and unstable responsive grids.
- Keep all text in Russian and keep existing backend contracts.
- Write failing tests before production code changes.

---

### Task 1: Lock The New Design Invariants

**Files:**
- Modify: `frontend/src/styles/operational-layout.test.ts`
- Test: `frontend/src/styles/operational-layout.test.ts`

**Interfaces:**
- Consumes: source files read by the existing `source(relativePath)` helper.
- Produces: RED tests that reject the current layout anti-patterns.

- [ ] **Step 1: Write failing source-invariant tests**

Add tests that assert:
- `/tasks` uses an inline filter bar with no visible field labels and no apply/reset buttons.
- `TaskFormDialog` uses searchable checkbox participant pickers instead of multi-select boxes.
- `TaskDetailPage` uses full-width task context and a status strip instead of an aside context.
- `ProfilePage` uses one account workbench instead of `settings-grid`.
- `StatisticsPage` has chart classes and a stable metric strip.
- `Layout` no longer links to `/notifications`.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run src/styles/operational-layout.test.ts`

Expected: fail on current source.

### Task 2: Task List Filters And Task Form

**Files:**
- Modify: `frontend/src/pages/TasksPage.tsx`
- Modify: `frontend/src/components/TaskFormDialog.tsx`
- Modify: `frontend/src/i18n/ru.ts`
- Modify: `frontend/src/styles/global.css`

**Interfaces:**
- Consumes: `listTasks(query)`, `TaskFormValues`.
- Produces: debounced task filtering and checkbox participant selection.

- [ ] **Step 1: Implement inline filters**

Replace the labelled filter form with one `.task-filterbar` row:
- search input placeholder only;
- deadline-from and deadline-to inputs placeholder/title only;
- no submit/reset buttons;
- debounce text by 400 ms;
- date changes apply immediately;
- empty fields clear their matching filter.

- [ ] **Step 2: Implement participant checkbox pickers**

In `TaskFormDialog`, replace directory multi-select controls with one search field and grouped checkbox lists for executors and managers. Keep raw ID fallback when directory is unavailable.

- [ ] **Step 3: Run targeted tests**

Run: `npm test -- --run src/styles/operational-layout.test.ts src/components/TaskFormDialog.busy.property.test.tsx`

Expected: pass.

### Task 3: Detail, Profile, Statistics, Notifications

**Files:**
- Modify: `frontend/src/pages/TaskDetailPage.tsx`
- Modify: `frontend/src/components/StatusActions.tsx`
- Modify: `frontend/src/pages/ProfilePage.tsx`
- Modify: `frontend/src/pages/StatisticsPage.tsx`
- Modify: `frontend/src/components/Layout.tsx`
- Create: `frontend/src/components/NotificationsPopover.tsx`
- Modify: `frontend/src/pages/TasksPage.tsx`
- Modify: `frontend/src/i18n/ru.ts`
- Modify: `frontend/src/styles/global.css`

**Interfaces:**
- Consumes: `listNotifications`, `dismissNotification`, `markNotificationSeen`, `Statistics`.
- Produces: full-width task header, one-window profile, visual statistics charts, and task-page notification popover.

- [ ] **Step 1: Restructure task detail**

Make task metadata full-width `.task-hero`, status actions `.status-strip`, and keep tabs/activity below.

- [ ] **Step 2: Restructure profile**

Replace four independent panels with one `.account-workbench` containing identity/avatar/actions in a compact horizontal layout.

- [ ] **Step 3: Add statistics visuals**

Add metric strip with stable equal-height panels, a status bar/donut visual, and participant bar charts before tables.

- [ ] **Step 4: Move notifications into task page**

Remove notifications from sidebar/mobile nav. Add bell button with unread count and popover on `/tasks`, with item click navigation and `Скрыть все`.

- [ ] **Step 5: Run targeted tests**

Run: `npm test -- --run src/styles/operational-layout.test.ts src/pages/TaskDetailPage.tabs.property.test.tsx`

Expected: pass.

### Task 4: Verification

**Files:**
- No new production files expected.

**Interfaces:**
- Consumes: completed UI changes.
- Produces: verified build and browser QA evidence.

- [ ] **Step 1: Run full automated verification**

Run:
- `npm test`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

- [ ] **Step 2: Browser QA**

Use local Vite and mock backend to check `/tasks`, `/tasks/task-1`, `/profile`, and `/statistics` on desktop and mobile. Confirm no document-level horizontal overflow and no obvious empty-space regressions.
