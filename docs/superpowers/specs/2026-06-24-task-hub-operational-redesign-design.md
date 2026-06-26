# Task Hub Operational Redesign Design

Date: 2026-06-24

## Summary

Redesign Task Hub as a strict operational work system. The interface should feel
like a daily assignment console, not a marketing product. The redesign may change
frontend structure, CSS, tests, and supporting documentation, but it must not add
fake data or imply backend capabilities that do not exist.

The selected approach is an operational cockpit: a consistent app shell, dense
task registry, task-focused detail workspace, restrained report views, and
administrative tables that all share one visual language.

## Goals

- Improve speed of scanning tasks, deadlines, unread messages, and statuses.
- Make primary actions obvious without increasing visual noise.
- Replace the current loose card-heavy feel with a tighter product UI system.
- Make task detail pages feel like workspaces: context, status actions, chat,
  attachments, and audit should be visually connected.
- Bring login, profile, notifications, statistics, and user administration into
  the same design system.
- Update tests so they enforce the new design quality rules rather than the old
  color palette or previous token values.

## Non-goals

- No backend redesign.
- No new task concepts such as priority, progress, kanban columns, SLA, or owner
  labels unless they already exist in the API.
- No marketing landing page.
- No decorative animation, glassmorphism, gradient hero, or brand illustration.
- No one-off styling that only improves one screen while breaking consistency.

## Users And Primary Workflows

Administrators manage users, review statistics, and can access all task flows.
Managers create and update tasks, assign participants, follow status, and review
audit information. Executors open assigned tasks, read context, participate in
chat, attach files, and change allowed statuses.

The redesign optimizes these workflows:

1. Open the task list and identify the relevant task quickly.
2. Filter or search without leaving the list.
3. Open a task and understand title, status, deadline, description, and allowed
   actions without hunting across the page.
4. Continue task discussion in chat while keeping attachments and audit nearby.
5. Administer users and statistics through predictable dense tables.

## Information Architecture

The app remains a protected React/Vite product UI with existing routes:

- `/tasks`: primary work registry.
- `/tasks/:taskId`: task workspace with chat, attachments, and audit.
- `/notifications`: notification center.
- `/statistics`: administrator reporting.
- `/admin/users`: administrator user management.
- `/profile`: own account, avatar, password, and MAX link.
- `/login`, `/set-password`, `/auth/max/callback`: authentication surfaces.

Route responsibilities stay intact. The redesign changes layout, hierarchy,
components, tokens, and tests.

## App Shell

Use one authenticated shell across roles:

- Desktop: persistent sidebar with product name, main navigation, active state,
  and compact account block. The sidebar should be quiet, neutral, and dense.
- Mobile: collapse to a compact top bar with wrapped or horizontally scrollable
  navigation. It must not hide required destinations behind unclear affordances.
- Main content: use a wider operational canvas than the current narrow content
  max where tables and task workspaces need it, with responsive constraints.
- Public auth routes should not show the authenticated shell.

The shell should avoid role-specific layout divergence unless permissions require
different nav items. Admin, manager, and executor should feel like they are using
the same product.

## Visual System

The visual register is restrained product UI:

- Palette: neutral backgrounds, white or near-white panels, strong readable text,
  subdued borders, one primary accent for selected navigation, focus, and primary
  actions. Semantic colors handle danger, warning, success, info, and task
  statuses.
- Typography: one system sans stack, fixed rem scale, no fluid viewport-based
  sizing, no display typography. Labels, data, and controls should be readable
  in dense layouts.
- Spacing: 4px-based spacing scale. Use tighter vertical rhythm for tables,
  filters, task cards, and chat; use larger spacing only between major page
  regions.
- Radius: modest product radii. Cards and panels stay at 8-12px unless a
  pill-shaped badge is semantically appropriate.
- Motion: 150-200ms transitions for hover, focus, active, disabled, and modal
  feedback only. Respect reduced motion.
- Icons: keep icons utilitarian and consistent. Use existing inline icons where
  appropriate; do not add decorative icon systems.

## Component System

Unify these components around shared classes and tokens:

- Buttons: primary, secondary, ghost, danger, small, block, icon-capable.
  Disabled, hover, focus, active, and loading states must be explicit.
- Fields: inputs, selects, textareas, labels, hints, validation errors, disabled
  state, and responsive form rows.
- Badges: task statuses, user states, roles, unread markers, and lightweight
  counters.
- Panels: page toolbars, filter surfaces, summary blocks, task context blocks,
  and modal surfaces. Avoid nested card styling.
- Tables: compact headers, row hover, fixed action columns where practical,
  horizontal scroll on mobile, and readable empty/error states.
- Tabs: connected to the content below, not decorative floating pills.
- Feedback: loading, empty, error, success, confirm dialogs, attachment viewer,
  and notifications.

Inline styles should be removed from screens where possible and replaced with
named classes.

## Task List

`TasksPage` becomes the main operational registry.

Header:

- Page title and total count.
- Create task button for admins and managers.
- Secondary text is limited to result context, such as active filters or the
  current total. It must not become explanatory marketing copy.

Filters:

- Compact panel with search and deadline range.
- Actions grouped at the end of the panel.
- Query errors shown inline without shifting the whole page dramatically.

Task records:

- Redesign `TaskCard` as a registry-style record rather than a promotional card.
- Status, unread marker, message count, and deadline should be visible at a
  glance.
- Title is primary. Description is secondary and clamped/truncated to protect
  layout.
- Primary action is open. Edit is available for managers/admins but visually
  secondary.
- Cards should work in a responsive grid on desktop and a single-column list on
  mobile.

Pagination:

- Keep controls compact and consistently aligned with result context.

## Task Detail Workspace

`TaskDetailPage` becomes the main task workspace.

Top context:

- Back action is compact and secondary.
- Title, status badge, deadline, and description appear in a structured header.
- Status actions sit near current status and should not feel detached from the
  task metadata.

Content layout:

- Desktop uses a two-column layout: task context/actions in a side panel and
  tabbed activity in the main panel.
- Mobile stacks context above activity.
- Tabs remain chat, attachments, and audit. Audit is shown only for allowed
  users as today.

Chat:

- Chat feed should read as operational message history, not a social feed.
- Message cards need clearer author/time/action hierarchy.
- Composer remains anchored after the feed in the normal document flow.
- Attachment controls and validation errors should be visually consistent with
  other forms.

Attachments and audit:

- Attachment tiles should be compact and inspectable.
- Audit log stays table-like and chronological, with clear empty/forbidden
  states.

## Statistics

`StatisticsPage` becomes a restrained report surface.

- Period filter remains a compact panel.
- Export controls are grouped with the report context.
- KPI values use compact metric panels without decorative dashboard treatment.
- Status counts and participant breakdowns remain tables, with better spacing,
  typography, and row affordances.
- Do not add charts in this redesign. The current table-first report structure
  better fits the strict operational register.

## Admin Users

`AdminUsersPage` becomes an administrator registry.

- Invite form should be visually connected to the user management workflow, not
  styled as a separate promo card.
- Active and deleted users remain tables.
- User cells should align avatar, name, email, role/status, and actions cleanly.
- Destructive actions remain clearly dangerous and confirmation-based.
- Dialogs should use the shared modal and form vocabulary.

## Auth And Profile

Login:

- Use a focused auth panel, not a marketing split-screen.
- Keep brand mark, email/password login, MAX login, error states, and navigation
  clear.
- Remove any public-screen decorative elements that do not help authentication.

Profile:

- Replace inline styling with shared classes.
- Present identity, role, email, avatar, password, and MAX linking as clean
  account settings sections.

## Notifications

Notifications should feel like an operational inbox:

- List items need clear title/body/time/action hierarchy.
- Dismiss action should be visible but secondary.
- Empty and error states should match the rest of the product.

## Testing And Verification

Tests may be changed to match the new design system. Required coverage:

- TypeScript build or typecheck for frontend.
- Frontend tests for existing behavioral components that may be affected.
- CSS/design property tests updated for new tokens, contrast, radii, motion, and
  anti-slop rules.
- At least one browser verification pass after implementation for desktop and
  mobile layout if a dev server can run.
- Build verification before completion.

The old exact token-value tests should not freeze obsolete colors. They should
instead verify design invariants: readable contrast, token usage, modest radii,
allowed spacing scale, reduced motion, and absence of banned patterns.

## Risks

- The global CSS file is already large. A redesign can make it harder to maintain
  unless styles are reorganized or clearly sectioned.
- Existing tests assert exact palette values and may need intentional rewrites.
- A full visual pass touches many components, so regressions in form behavior,
  chat actions, and admin dialogs must be checked.
- Browser verification may require sandbox escalation for the Vite dev server.

## Acceptance Criteria

- All protected screens share one strict operational visual system.
- Task list scanning is faster: status, title, deadline, unread/message count,
  and actions have predictable positions.
- Task detail reads as a workspace with metadata, status actions, and activity
  connected.
- Tables, forms, buttons, badges, tabs, modals, loading, empty, and error states
  are visually consistent.
- Inline visual styles are removed from redesigned screens unless there is a
  specific component-level reason.
- Updated tests pass or any remaining failures are documented with concrete
  reasons.
- The final app avoids decorative SaaS/AI-slop patterns and meets WCAG AA
  contrast for normal text.
