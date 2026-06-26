# Task Hub Full Audit - 2026-06-24

Target: current dirty worktree at `/home/milkyzz/Музыка/123/task-hub`.

Scope: repository hygiene, backend, security, data/migrations, frontend, UI/UX/a11y, operations/deploy, local perimeter context. This audit intentionally did not change product code. Temporary machine-readable evidence and screenshots were written outside the repository under `/tmp/taskhub-audit/`.

## Executive Summary

Overall health: **not release-ready**, but the core implementation is in a relatively strong state. TypeScript checks, frontend tests, backend unit tests, Prisma migration deploy, and backend integration tests all pass. The redesign also has unusually good UI guardrails: tokenized styling, dark-mode tokens, reduced-motion handling, anti-slop property tests, and fresh browser screenshots across key screens.

Release risk: **P1 blockers remain** in security, notification correctness, dependency posture, backend lint CI, and backup/deploy readiness.

Severity count:

| Severity | Count | Summary |
| --- | ---: | --- |
| P0 | 0 | No immediate data-loss or total-startup blocker confirmed. |
| P1 | 6 | Must fix or consciously accept before release. |
| P2 | 11 | Important hardening/reproducibility/UX issues for the next pass. |
| P3 | 4 | Residual hardening and local-environment notes. |

Top blockers:

1. Production can start with an insecure JWT fallback unless configuration is explicitly hardened.
2. HTTP rate limiting exists as infrastructure but is not wired to login/password/upload routes.
3. Manual task status changes explicitly do not enqueue status-change notifications.
4. `npm audit` reports high-severity runtime dependency vulnerabilities and one critical dev-tool vulnerability.
5. Backend lint fails with 176 errors, so the release gate is not clean.
6. Backup/offsite configuration is not operationally coherent in the adjacent deploy example.

## Evidence Log

Commands run against the dirty worktree:

| Area | Command | Result | Notable output |
| --- | --- | --- | --- |
| Git baseline | `git status --short --branch` | Pass | Branch `task-hub-operational-redesign`; tracked frontend/package/lockfile changes plus untracked dogfood/screenshots/tests/scripts. |
| Git baseline | `git diff --stat` | Pass | 32 tracked files changed, 1741 insertions, 688 deletions. |
| Git baseline | `git diff --check` | Pass | No whitespace/conflict-marker failures. |
| Git baseline | `git ls-files --others --exclude-standard` | Pass | Untracked `dogfood-output/`, `frontend/dogfood-output/`, `scripts/preview-api.cjs`, `NotificationsPopover`, and several tests. |
| Backend lint | `npm --workspace backend run lint` | **Fail** | 176 errors across 50 files. Mostly `prettier/prettier`; some `@typescript-eslint/no-unused-vars`. JSON evidence: `/tmp/taskhub-audit/backend-eslint.json`. |
| Frontend lint | `npm --workspace frontend run lint` | Pass | No lint errors. |
| Backend TS | `npx tsc -p backend/tsconfig.json --noEmit --incremental false` | Pass | No type errors. |
| Frontend TS | `npx tsc -p frontend/tsconfig.app.json --noEmit --incremental false` | Pass | No type errors. |
| Prisma validate | `npx prisma validate --schema prisma/schema.prisma` | **Fail** | Fails without `DATABASE_URL` in environment. |
| Prisma validate | `DATABASE_URL=<dummy> npx prisma validate --schema prisma/schema.prisma` | Pass | Schema valid when a database URL is supplied. |
| Frontend tests | `npm --workspace frontend run test` | Pass | 37 files, 126 tests. React Router future-flag warnings and two React `act(...)` warnings in avatar-related tests. |
| Backend unit tests | `npm --workspace backend run test:unit` | Pass | 151 suites, 838 tests. Very noisy logs, but green. |
| Docker availability | `docker version --format '{{.Server.Version}}'` | Pass | Docker server available. |
| Integration stack | `docker compose -f docker-compose.integration.yml up -d --wait` | Pass | PostgreSQL/Redis test services healthy. |
| Integration DB | `DATABASE_URL=<test-db> npx prisma migrate deploy` | Pass | Applied migrations `20260615051429_init`, `20260620090000_attachment_nullable_message`. |
| Backend integration | `RUN_INTEGRATION=1 DATABASE_URL=<test-db> REDIS_PORT=6380 npm --workspace backend run test:integration` | Pass | 1 suite, 6 PostgreSQL+Redis tests. |
| Integration cleanup | `docker compose -f docker-compose.integration.yml down -v` | Pass | Test containers, network, volumes removed. |
| Dependencies | `npm audit --json` | **Fail** | 59 total: 3 low, 39 moderate, 16 high, 1 critical. |
| Dependencies | `npm audit --omit=dev --json` | **Fail** | 22 production deps: 11 moderate, 11 high. |
| Dependency tree | `npm ls --workspaces --all` | Pass | No actionable invalid/missing/extraneous dependency problem found. |
| Secret scan | `rg --files-with-matches ...` | Pass with caveat | Matches are expected code/config/test/env-example locations. No secret values were copied into this report. |
| UI context | `node /home/milkyzz/.codex/skills/impeccable/scripts/context.mjs --target ...` | Pass | Product register; no `DESIGN.md`; use product UI criteria. |
| UI runtime | `node scripts/preview-api.cjs` + `npm --workspace frontend run dev -- --host 127.0.0.1 --port 5173` | Pass | Local preview API and Vite started, then stopped. |
| UI browser smoke | Chrome headless via CDP | Pass | Fresh screenshots: login desktop/mobile, tasks desktop/mobile, notifications desktop, admin desktop/mobile. |
| UI measurement | Chrome CDP DOM measurement at 390px | Pass | Login page `scrollWidth` equals viewport width; no confirmed horizontal overflow. |
| Perimeter | `stat ../id_rsa`; `find ../server-backups -name 'taskhub*'` | Pass with caveat | Presence only recorded; key not opened, archives not decompressed. |

Skipped/limited checks:

- No production credentials, production database, or live Task Hub server were available.
- No restore drill against real backup archives was performed.
- No networked external vulnerability triage beyond `npm audit` metadata was performed.
- Playwright package was not installed, so browser smoke used system Chrome and CDP instead of Playwright tests.

## Findings By Severity

### P0

No P0 finding was confirmed.

### P1-1 - Production JWT Can Fall Back To A Shared Development Secret

Location:

- `backend/src/config/env.validation.ts:15`
- `backend/src/config/configuration.ts:42`
- `backend/.env.example:7`

Evidence:

- Environment validation gives `JWT_SECRET` a default.
- Runtime configuration also provides a fallback.
- The env example documents production guidance but still includes a concrete development fallback value.

Impact:

If production starts without an explicit strong `JWT_SECRET`, every access token is signed with a known shared fallback. That makes session forgery possible for anyone who knows the source/default.

Recommendation:

Make `JWT_SECRET` required in `NODE_ENV=production` and reject the development fallback at startup. Keep dev/test convenience only behind an explicit non-production branch. Add a unit test for production env validation.

Verification:

- Code inspection of the validation/configuration layers.
- Secret scan confirmed `JWT_SECRET` is present in expected config/example paths; values were not reproduced in this report.

### P1-2 - Sensitive HTTP Rate Limiting Is Implemented But Not Wired To Sensitive Routes

Location:

- `backend/src/security/rate-limit.guard.ts:36`
- `backend/src/auth/auth.controller.ts:54`
- `backend/src/auth/auth.controller.ts:67`
- `backend/src/auth/auth.controller.ts:77`
- `backend/src/auth/auth.controller.ts:89`
- `backend/src/attachments/attachments.controller.ts:104`
- `backend/src/chat/chat.service.ts:194`

Evidence:

- `RateLimitGuard` returns `true` for routes without `@RateLimit(...)` metadata.
- `rg '@RateLimit|RateLimitGuard|rateLimiter\.check' backend/src --glob '!**/*.spec.ts'` finds no controller route using the HTTP guard/decorator.
- Chat send uses direct `rateLimiter.check(...)`, so the limiter itself works for at least one non-HTTP source.
- Login, MAX login, password setup, password change, and attachment upload routes have no rate-limit decorator/guard.

Impact:

The system has login lockout by account, but lacks route-level request throttling for anonymous/unknown-email login attempts, password setup token guessing, password-change probing, and upload pressure. This increases brute-force and DoS risk.

Recommendation:

Attach `@UseGuards(RateLimitGuard)` and `@RateLimit(...)` to login, MAX login, password setup, password change, and upload endpoints. Add tests that assert repeated calls return 429 before domain logic runs.

Verification:

- Static search and controller inspection.
- Backend unit and integration tests pass, but they do not catch this absence.

### P1-3 - Manual Status Changes Do Not Enqueue Status-Change Notifications

Location:

- `backend/src/tasks/tasks.service.ts:397`
- `backend/src/tasks/tasks.service.ts:404`
- `backend/src/notifications/task-notification-router.ts:133`
- `backend/src/tasks/ports/task-notifier.port.ts:36`

Evidence:

- `TasksService.changeStatus(...)` explicitly documents that Req 13.6 notifications are not queued.
- `TaskNotificationRouter.notifyStatusChanged(...)` exists.
- `TaskNotifier` exposes only `enqueueTaskUpdated(...)`, so `TasksService` cannot currently call the status notifier through its port.

Impact:

Users can observe status changes in task views/audit, but the expected site/MAX notification for manual status changes is missing. That is a functional gap in a core workflow.

Recommendation:

Extend `TaskNotifier` with a status-change method or inject a status notification port. Queue status notifications inside the same success path after `setStatus` and audit entry creation. Add a test around `changeStatus(...)`.

Verification:

- Code inspection.
- Existing backend unit tests pass, which means this requirement is not covered by failing tests.

### P1-4 - Dependency Audit Contains High-Severity Runtime Vulnerabilities And Critical Dev-Tool Risk

Location:

- `package-lock.json`
- `backend/package.json`
- `frontend/package.json`

Evidence:

- `npm audit --json`: 59 total vulnerabilities: 3 low, 39 moderate, 16 high, 1 critical.
- `npm audit --omit=dev --json`: 22 production vulnerabilities: 11 moderate, 11 high.
- Direct high/runtime-relevant packages include `@nestjs/platform-express`, `bcrypt`, and `socket.io-client`; transitive runtime paths include Express/body-parser/Multer/ws/tar/lodash.
- The critical finding is in dev tooling (`vitest` path via Vite/vite-node), but still matters if dev UI/test servers are exposed.

Impact:

Some issues affect request parsing, upload middleware, WebSocket handling, and package extraction paths. Even if individual advisories need triage, the current lockfile should not be promoted without an upgrade plan.

Recommendation:

Run a focused dependency upgrade branch. Start with patch/minor upgrades for Nest/Express/Multer/ws/socket.io-client/Vite/Vitest, then rerun `npm audit --omit=dev`, `npm audit`, frontend tests, backend unit tests, and integration tests. For any major upgrade, record the accepted residual advisory and mitigation.

Verification:

- `npm audit --json`
- `npm audit --omit=dev --json`
- `npm ls --workspaces --all` found no separate dependency tree consistency problem.

### P1-5 - Backend Lint Gate Fails

Location:

- Backend workspace, representative files:
- `backend/src/attachments/attachments.controller.ts:15`
- `backend/src/auth/auth.max-login.property.spec.ts:74`
- `backend/src/backup/backup.last-successful.property.spec.ts:69`

Evidence:

- `npm --workspace backend run lint` exits non-zero.
- Captured ESLint JSON reports 176 errors across 50 files and 0 warnings.
- Most errors are `prettier/prettier`; several are real unused-variable violations.

Impact:

If lint is a CI/release gate, the branch cannot ship cleanly even though TypeScript and tests pass. The unused-variable failures are also a signal that some property-test scaffolding drifted.

Recommendation:

Run the backend formatter/lint fix path, then manually inspect the unused-variable changes in tests so no generator intent is lost. Re-run backend lint, backend unit tests, and integration tests.

Verification:

- `npm --workspace backend run lint -- --format json --output-file /tmp/taskhub-audit/backend-eslint.json`

### P1-6 - Backup/Offsite Posture Is Not Operationally Ready

Location:

- `backend/src/backup/backup.module.ts:52`
- `backend/src/backup/backup.worker.ts:35`
- `backend/src/backup/restic-backup.adapter.ts:58`
- `backend/src/backup/backup.service.ts:91`
- `backend/src/backup/s3-offsite-upload.adapter.ts:63`
- `../2090-fun-infra/env/taskhub.env.example:36`

Evidence:

- The real restic and S3 adapters are always bound in `BackupModule`.
- The worker schedules a daily job at startup.
- Missing restic repository/password causes `createDump(...)` to throw, which `BackupService` records as `FAILED`, not as an intentionally disabled backup.
- The adjacent production env example documents optional S3 keys but does not include restic repository/password/tmp-dir entries.
- The S3 adapter uploads a JSON manifest containing checksum/snapshot metadata. It does not upload the dump or restic repository data itself; actual offsite restore depends entirely on `RESTIC_REPOSITORY` being a remote/offsite repository.

Impact:

A deployment following the adjacent env example can appear to have a backup worker while producing daily failed backups. If restic is configured to a local VPS path, the S3 object is only metadata and is not sufficient to restore data offsite.

Recommendation:

Make backup mode explicit: disabled/skipped vs required/failed. Add restic configuration to the deploy env example. Require a remote/offsite restic repository for production, or upload restic repository data/snapshots to offsite storage. Add an operational restore drill and alert when no successful backup exists within the expected window.

Verification:

- Code inspection.
- Adjacent infra env inspection.
- No live restore drill was possible in this audit.

### P2-1 - `pg_dump` Receives The Database URL In Process Arguments

Location:

- `backend/src/backup/restic-backup.adapter.ts:24`
- `backend/src/backup/restic-backup.adapter.ts:108`
- `backend/src/backup/restic-backup.adapter.ts:111`

Evidence:

- Class documentation says password and connection string are passed via environment, not command line.
- Actual `pg_dump` invocation passes the database URL as a `--dbname=...` process argument.

Impact:

On hosts where process arguments are visible to other users/processes, database credentials can be exposed through process listings while backups run.

Recommendation:

Pass connection data through `PG*` environment variables, a service file, or another PostgreSQL-supported mechanism that avoids embedding credentials in argv. Update the misleading comment and add a regression test around spawn args.

Verification:

- Static code inspection.

### P2-2 - Backend Dockerfile Healthcheck Is Fragile Outside The Adjacent Compose Override

Location:

- `backend/Dockerfile:37`
- `backend/src/app.module.ts:77`
- `backend/src/http-redirect/https-redirect.middleware.ts:23`
- `../2090-fun-infra/docker-compose.yml:217`

Evidence:

- The app applies HTTPS redirect middleware to all routes.
- The Dockerfile healthcheck calls `/health` without `X-Forwarded-Proto`.
- The adjacent compose file overrides the healthcheck and explicitly adds `X-Forwarded-Proto: https`.

Impact:

The image can be unhealthy in a standalone container or any deploy path that uses the Dockerfile healthcheck directly. The current production compose knows about the redirect workaround, but the image itself is not self-contained.

Recommendation:

Either exempt `/health` from HTTPS redirect or include the same forwarded-proto header in the Dockerfile healthcheck. Add a smoke test for container health under the image default.

Verification:

- Dockerfile, middleware, and infra compose inspection.

### P2-3 - Frontend Session Tokens Persist In `localStorage`

Location:

- `frontend/src/lib/auth-context.tsx:25`
- `frontend/src/lib/auth-context.tsx:42`
- `frontend/src/lib/auth-context.tsx:51`

Evidence:

- The auth provider explicitly stores `session_token` in `localStorage`.
- API and Socket.IO use the token as a bearer credential.

Impact:

Any future XSS bug can read and exfiltrate the active session token. This does not prove an existing XSS issue, but it increases the blast radius of one.

Recommendation:

Revisit the session model. Prefer an `HttpOnly`, `Secure`, `SameSite` refresh cookie and in-memory access token, or keep the current design only with an explicit threat-model decision plus strong CSP and XSS regression coverage.

Verification:

- Static code inspection.

### P2-4 - Restoring A Deleted User Forces `isActive=true` Without Checking Password State

Location:

- `backend/src/users/users.service.ts:285`
- `backend/src/users/users.service.ts:432`
- `backend/src/repositories/user.repository.ts:46`
- `prisma/schema.prisma:95`

Evidence:

- Soft delete can target a non-deleted user; `findActiveById(...)` means not deleted, not necessarily `isActive=true`.
- Restore sets `deletedAt: null` and `isActive: true`.
- `passwordHash` is nullable for invited users before password setup.

Impact:

An invited/inactive user who was soft-deleted before setting a password can be restored as active but still have no password hash. The admin UI may show an active account that cannot log in.

Recommendation:

On restore, if `passwordHash` is null, keep `isActive=false` and issue a fresh setup flow, or require password setup before activation. Add a unit test for restoring a never-activated user.

Verification:

- Code and schema inspection.

### P2-5 - Primary Admin Creation Invariant Relies On Application-Level Count

Location:

- `backend/src/users/users.service.ts:81`
- `backend/src/repositories/user.repository.ts:124`
- `prisma/schema.prisma:91`
- `prisma/schema.prisma:116`

Evidence:

- `createPrimaryAdmin(...)` counts active admins inside a transaction, then creates an admin if count is zero.
- The schema has indexes on `role` and `deletedAt`, but no database constraint enforcing a single active admin or serializing this bootstrap operation.

Impact:

Concurrent bootstrap/admin creation attempts with different emails can both observe zero active admins under default isolation and create two admins. This is rare, but it affects a core authorization invariant.

Recommendation:

Use a database-level guard: advisory lock, serializable transaction with retry, singleton bootstrap row, or a partial unique index strategy appropriate to the exact invariant. Add a concurrency test.

Verification:

- Code and Prisma schema inspection.

### P2-6 - Frontend Runtime API Contract Validation Is Partial

Location:

- `frontend/src/lib/tasks-api.ts:167`
- `frontend/src/lib/tasks-api.ts:225`
- `frontend/src/lib/tasks-api.contract.test.ts:20`
- `frontend/src/pages/AdminUsersPage.contract.test.tsx:49`

Evidence:

- `getTask(...)` validates detail responses with `requireTaskDetail(...)`.
- `listTasks(...)`, create/update/assign responses, user lists, statistics, and notification responses mostly trust TypeScript generics or component-side checks.
- Added tests cover some contract failures, but the validation is not systematic.

Impact:

Backend/frontend contract drift can still reach UI rendering paths as malformed data, especially list and report screens. The new targeted tests are a good start, but the protection is uneven.

Recommendation:

Add lightweight runtime schemas for API boundaries or central response validators per resource. Start with task list pages, admin users, notifications, and statistics because those screens are central to the redesign.

Verification:

- Static code inspection.
- Frontend tests pass, including targeted contract tests.

### P2-7 - Preview/Dogfood Artifacts Are Not Reproducible From A Clean Checkout Unless Staged Deliberately

Location:

- `package.json:16`
- `scripts/preview-api.cjs` (untracked)
- `frontend/src/components/NotificationsPopover.tsx` (untracked)
- `frontend/src/pages/TasksPage.tsx:244`
- `frontend/src/styles/operational-layout.test.ts:81`

Evidence:

- Root `package.json` now has `preview:api`.
- The referenced script is untracked.
- `TasksPage` imports `NotificationsPopover`, but that component is untracked.
- Several tests that lock the redesign behavior are untracked.
- Dogfood screenshot directories are also untracked.

Impact:

A commit that includes tracked files but misses untracked source/tests/scripts would break the preview workflow or the frontend build. The audit evidence would also be difficult to reproduce.

Recommendation:

Decide what is source vs artifact. Stage source files and tests that are required for build/verification. Ignore or move generated dogfood screenshots to a documented artifact location. Keep the preview script staged if `package.json` references it.

Verification:

- `git status --short --branch`
- `git ls-files --others --exclude-standard`

### P2-8 - Generated TypeScript Build Info Is Tracked And Dirty

Location:

- `frontend/tsconfig.app.tsbuildinfo`
- `.gitignore:4`

Evidence:

- `frontend/tsconfig.app.tsbuildinfo` is tracked and modified.
- Its diff is generated compiler metadata listing current source/test files.
- `.gitignore` ignores build output but not `*.tsbuildinfo`.

Impact:

Compiler cache churn pollutes review diffs and can accidentally encode transient local build state in commits.

Recommendation:

Remove tracked build-info artifacts from version control and add `*.tsbuildinfo` to `.gitignore`, unless there is a deliberate reason to version this cache.

Verification:

- `git ls-files frontend/tsconfig.app.tsbuildinfo`
- `git diff -- frontend/tsconfig.app.tsbuildinfo`

### P2-9 - Bare Prisma Validation Command Fails Without Environment

Location:

- `prisma/schema.prisma`
- Root scripts do not define a dedicated validate wrapper.

Evidence:

- `npx prisma validate --schema prisma/schema.prisma` fails with missing `DATABASE_URL`.
- The same command passes when a dummy PostgreSQL URL is supplied.

Impact:

Developers/CI jobs using the obvious validation command can get a false-negative schema failure unless they know to inject a URL. This is small but annoying in release verification.

Recommendation:

Add a repo script that supplies a harmless validation URL or document the required env for validation. Use that script in CI.

Verification:

- Both validate command variants were run.

### P2-10 - Notifications Popover Uses Dialog Semantics Without Dialog Behavior

Location:

- `frontend/src/components/NotificationsPopover.tsx:111`
- `frontend/src/components/NotificationsPopover.tsx:123`
- `frontend/src/styles/global.css:1615`
- `frontend/src/styles/global.css:2416`

Evidence:

- Trigger declares `aria-haspopup="dialog"`.
- Panel renders `role="dialog"`, but there is no focus handoff, no Escape close, and no outside-click handling.
- The panel is positioned as a popover, not a modal dialog.

Impact:

Keyboard and screen-reader users can receive dialog semantics without predictable dialog behavior. Focus can remain on the trigger or move outside the open panel without a clear close path.

Recommendation:

Either implement proper popover/dialog behavior (focus management, Escape, outside click, labelled title, return focus) or use a less modal semantic pattern for a notification menu/list. Add a component test for keyboard behavior.

Verification:

- Static component inspection.
- Fresh desktop screenshot confirmed the panel renders and is not visually clipped.

### P2-11 - Compact Mobile Controls Are Below The Common 44px Touch Target Target

Location:

- `frontend/src/styles/global.css:607`
- `frontend/src/styles/global.css:674`
- `frontend/src/styles/global.css:701`
- `frontend/src/styles/global.css:2320`
- `frontend/src/styles/global.css:2397`

Evidence:

- Base `.btn` and `.btn--sm` use 36px min-height.
- Inputs use 40px min-height.
- Mobile rules make many action buttons full-width, but do not raise the minimum height.

Impact:

The interface is usable and visually dense, but touch accuracy may suffer on mobile for users with motor impairments or one-handed use.

Recommendation:

Set mobile min-heights for primary touch controls to at least 44px where density allows, especially navigation, task actions, notification actions, and destructive/admin controls.

Verification:

- CSS inspection.
- Fresh mobile screenshots for tasks/admin/users show no layout breakage, so this is a touch ergonomics issue rather than a visual blocker.

### P3-1 - Forwarded Header Trust Assumes Backend Is Never Directly Exposed

Location:

- `backend/src/security/rate-limit.guard.ts:51`
- `backend/src/http-redirect/https-redirect.util.ts:93`
- `frontend/nginx.conf`
- `../2090-fun-infra/docker-compose.yml:194`

Evidence:

- Rate-limit source prefers the first `X-Forwarded-For` entry.
- HTTPS redirect accepts first `X-Forwarded-Proto` value.
- Adjacent infra does not expose backend ports directly, which mitigates this in the intended topology.

Impact:

If the backend is ever exposed directly or a proxy appends rather than sanitizes forwarded headers, clients can spoof rate-limit source or HTTPS-origin signals.

Recommendation:

Document the trusted-proxy assumption. Configure edge proxies to overwrite/strip incoming forwarded headers, or use Express trusted proxy settings with a trusted hop count.

Verification:

- Code and infra inspection.

### P3-2 - Audit Log Append-Only Guarantee Is Application-Level, Not Database-Level

Location:

- `backend/src/audit/audit-entry.repository.ts:27`
- `backend/src/audit/audit-log.append-only.property.spec.ts:27`

Evidence:

- Repository exposes create/list only.
- Property test verifies service/repository API shape and in-memory model, and explicitly does not use the database.

Impact:

Normal application code is well constrained, but direct Prisma/database access can still update/delete audit rows unless database-level controls are added.

Recommendation:

If audit immutability is a compliance requirement, add database-level protections such as restricted DB roles, triggers, or append-only table permissions. Keep the current repository/test pattern as a useful application-level guard.

Verification:

- Code and test inspection.

### P3-3 - Workflow Directories Are Mixed Between Tracked And Ignored State

Location:

- `.gitignore:31`
- `.kiro/specs/...`
- `.superpowers/sdd/...`

Evidence:

- `.superpowers/` is ignored, but there are already tracked `.superpowers/sdd/*` files.
- `.kiro/` is present and tracked.

Impact:

This may be intentional spec history, but the ignore/tracked mismatch can confuse contributors and hide future workflow changes from `git status`.

Recommendation:

Document the intended policy. Either keep these workflow specs tracked and narrow the ignore rule to scratch subpaths, or migrate them fully out of versioned source.

Verification:

- `git ls-files .kiro .superpowers`
- `find .kiro .superpowers -maxdepth 2 -type f`

### P3-4 - Adjacent Local Backup Archives And Private Key Increase Local Exposure

Location:

- `../server-backups/taskhub*.sql.gz`
- `../server-backups/taskhub-attachments-*.tar.gz`
- `../id_rsa`

Evidence:

- Adjacent TaskHub SQL and attachment backup archives are present.
- Adjacent private key file exists with mode `600`.
- The audit did not open the key and did not decompress backup archives.

Impact:

This is not a repository code defect, but local compromise of the parent directory could expose application data or deployment access.

Recommendation:

Keep private keys and database backups outside broad workspaces where agents/tools operate. Apply encryption, retention, and access boundaries for local backup material.

Verification:

- Presence-only `find`/`stat` checks.

## Subsystem Notes

### Backend

Strengths:

- TypeScript compile passes.
- Unit suite is broad: 151 suites, 838 tests.
- Integration suite passes against PostgreSQL+Redis after migration deploy.
- Auth has JWT plus Redis-backed session registry, refresh, revocation, and socket re-auth flows.
- Attachments are served through guarded controllers; files are documented as outside web root in `backend/src/attachments/attachments.controller.ts:60`.
- Chat send has direct rate limiting in `backend/src/chat/chat.service.ts:194`.

Risks:

- P1 rate-limit wiring gap for HTTP routes.
- P1 status notification TODO in task status flow.
- P1 lint gate failure.
- Backup module starts real daily worker even when deploy env is incomplete.

### Security

Strengths:

- CORS is constrained to `PUBLIC_URL` in production at `backend/src/main.ts:25`.
- HTTPS redirect middleware exists and is property/smoke tested.
- MAX OAuth uses `sessionStorage` state verification on the frontend; webhook/OAuth files were inspected for validation paths.
- Attachment controller requires `SessionAuthGuard` at class level.
- Secret scan did not require copying any secret values into the report.

Risks:

- P1 insecure JWT fallback.
- P1 missing HTTP rate limiter wiring.
- P1 dependency audit.
- P2 localStorage token persistence.
- P2 `pg_dump` argv credential exposure.
- P3 forwarded-header trust assumptions.

### Data And Migrations

Strengths:

- Prisma schema validates with environment supplied.
- Migration deploy succeeds against the integration database.
- Schema uses `Timestamptz` for key timestamps and indexes common access fields.
- Audit log repository is intentionally append-only at application layer.

Risks:

- P2 primary admin race/invariant.
- P2 restore activation state for passwordless restored users.
- P2 validation command environment dependency.
- P3 audit immutability not enforced at DB layer.

### Frontend

Strengths:

- Frontend lint, typecheck, and test suite pass.
- API client has centralized error normalization and token refresh deduplication.
- `getTask(...)` has runtime response validation.
- New targeted tests cover invalid task deadline, avatar-fetch behavior, admin-user contract failures, and operational layout invariants.
- Fresh browser smoke confirms login, tasks, notifications, and admin users render without obvious overlap/blank states.

Risks:

- P2 runtime contract validation is partial.
- P2 localStorage session persistence.
- P2 untracked component/tests/scripts can break clean-checkout reproducibility.
- React test output still has `act(...)` warnings in avatar-related tests.

### UI/UX/A11y

Impeccable audit score:

| Dimension | Score | Key finding |
| --- | ---: | --- |
| Accessibility | 3/4 | Good labels/focus/error roles overall; notification popover semantics and mobile touch sizing need hardening. |
| Performance | 3/4 | No heavy decorative motion found; browser smoke was visual, not Lighthouse/perf-budget based. |
| Theming | 4/4 | Shared tokens, dark-mode tokens, semantic colors, focus ring, reduced-motion handling. |
| Responsive design | 3/4 | Desktop/mobile screenshots are coherent; controls remain compact on touch devices. |
| Anti-patterns | 4/4 | No obvious product UI slop; property tests reject gradient text/glass/card anti-patterns. |
| Total | 17/20 | Good; address weak dimensions before release. |

Anti-pattern verdict:

The current redesign does **not** read as a generic AI-generated product UI. It is restrained, operational, and consistent. Evidence includes tokenized colors in `frontend/src/styles/global.css:9`, dark tokens at `frontend/src/styles/global.css:110`, reduced-motion handling at `frontend/src/styles/global.css:2215`, and anti-slop property tests at `frontend/src/styles/anti-slop.property.test.ts:314`.

Observed runtime screenshots:

- `/tmp/taskhub-audit/login-fresh-desktop.png`
- `/tmp/taskhub-audit/login-fresh-mobile.png`
- `/tmp/taskhub-audit/tasks-fresh-desktop.png`
- `/tmp/taskhub-audit/tasks-fresh-mobile.png`
- `/tmp/taskhub-audit/notifications-fresh-desktop.png`
- `/tmp/taskhub-audit/admin-users-fresh-desktop.png`
- `/tmp/taskhub-audit/admin-users-fresh-mobile.png`

The repository also contains same-day dogfood screenshots under `dogfood-output/` and `frontend/dogfood-output/`; they are useful context but untracked artifacts.

### Ops And Deploy

Strengths:

- Adjacent infra keeps backend internal and routes traffic through Caddy/Nginx.
- `taskhub-backend` has `no-new-privileges`, dropped capabilities, memory/CPU limits, healthchecks, and internal networks in the adjacent compose file.
- Nginx proxies `/api` and `/socket.io` and sets forwarded headers.
- Integration compose/migrate/test path works.

Risks:

- P1 backup/offsite posture is not operationally ready.
- P2 Dockerfile healthcheck is not self-contained.
- P2 dependency audit must be triaged before image promotion.

### Repo Hygiene

Strengths:

- Dirty worktree is understandable and centered on the frontend redesign.
- Lockfile/package changes are present for the icon dependency.
- `.superpowers/` is ignored for future scratch data.

Risks:

- P2 untracked source/test/script files are required for the current redesign to reproduce.
- P2 tracked `tsconfig.app.tsbuildinfo` churn.
- P3 workflow-directory policy mismatch.
- Local adjacent backup/key exposure context.

## Positive Findings Worth Preserving

- Strong test posture: 838 backend unit tests, 126 frontend tests, and integration tests against real PostgreSQL+Redis all pass.
- Property tests cover meaningful invariants: append-only audit model, reduced motion, anti-slop CSS rules, layout invariants, role/status contrast, and task form behavior.
- Strict TypeScript checks pass in both workspaces.
- Attachment access is guarded, stored outside web root, and tested around avatar/attachment regressions.
- Auth session refresh logic deduplicates concurrent refreshes and reconnects sockets after token rotation.
- The redesign uses a restrained product UI system: shared tokens, semantic state colors, no gradient text/glass defaults, reduced motion, and responsive admin/task layouts.
- Docker integration verification is reproducible locally and cleaned up after running.

## Remediation Roadmap

1. **P1 JWT production hardening**
   - Fix: require `JWT_SECRET` in production and reject fallback.
   - Validate: production env-validation unit test; backend unit tests; `npx tsc -p backend/tsconfig.json --noEmit --incremental false`.

2. **P1 HTTP rate-limit wiring**
   - Fix: apply `@UseGuards(RateLimitGuard)` and `@RateLimit(...)` to login, MAX login, password setup/change, and upload routes.
   - Validate: route tests for 429; backend unit tests; integration smoke.

3. **P1 status-change notifications**
   - Fix: extend task notification port and call status notification after successful status transition.
   - Validate: unit test around `TasksService.changeStatus(...)`; frontend notification smoke.

4. **P1 dependency upgrade branch**
   - Fix: patch/minor upgrades for runtime high advisories and dev critical Vite/Vitest path.
   - Validate: `npm audit --omit=dev --json`; `npm audit --json`; frontend tests; backend unit/integration tests.

5. **P1 backend lint cleanup**
   - Fix: run formatter and resolve unused variables intentionally.
   - Validate: `npm --workspace backend run lint`; backend unit tests.

6. **P1 backup production posture**
   - Fix: make backup mode explicit, document restic env, require remote/offsite repository or upload data not only manifest, add no-success alert.
   - Validate: backup unit/property tests; staging backup + restore drill.

7. **P2 repo reproducibility**
   - Fix: stage required untracked source/tests/scripts; ignore generated screenshots and `*.tsbuildinfo`.
   - Validate: clean checkout build/test/lint from only tracked files.

8. **P2 frontend hardening**
   - Fix: notification popover keyboard behavior, mobile touch targets, broader runtime response validation.
   - Validate: frontend tests plus fresh Chrome/Playwright screenshots.

9. **P2 data/ops hardening**
   - Fix: restore activation rules, primary-admin database guard, Dockerfile healthcheck, backup argv credential handling, Prisma validate script.
   - Validate: targeted unit tests, container health smoke, Prisma validate script.

10. **P3 policy cleanup**
    - Fix: decide `.kiro`/`.superpowers` tracking policy; isolate local keys/backups from agent workspaces; document trusted-proxy assumptions.
    - Validate: `git status --ignored`, secret scan, infra review.
