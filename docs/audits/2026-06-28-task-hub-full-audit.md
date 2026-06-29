# Task Hub Full Audit - 2026-06-28

Target: local workspace `/home/milkyzz/Музыка/123/task-hub` and live deployment `https://tasks.2090.fun/`.

Server source of truth checked during the audit: `root@77.222.55.38:/opt/2090-fun-infra/apps/task-hub`.

Scope: performance, business logic, security, UI/UX, code quality, error handling, API/network/database, authorization and user data protection, responsiveness, tests and edge cases, dependencies/configuration/CI/CD, analytics/logging/monitoring, scalability and maintainability.

This audit did not modify product code. Evidence files and screenshots were written outside the repository under `/tmp/taskhub-audit-20260628/`.

## Executive Summary

Overall health: **not release-ready** until three P1 items are resolved or explicitly accepted.

The application is in a much stronger state than the 2026-06-24 audit in several areas: backend lint now passes, production JWT validation is hardened, HTTP rate limiting is wired to sensitive routes, manual task status notifications are implemented, containers are healthy, and production migrations are applied. The remaining release blockers are concentrated in frontend test regressions, production backup posture, and dependency advisories.

Release posture:

| Severity | Count | Summary |
| --- | ---: | --- |
| P0 | 0 | No confirmed total outage, public data leak, or immediate data-loss event. |
| P1 | 3 | Must fix or consciously accept before release. |
| P2 | 10 | Important hardening, operability, UX, and scalability work. |
| P3 | 5 | Cleanup and local-development noise. |

Top blockers:

1. Frontend test suite is red: avatar behavior regression plus style guard failures.
2. Production backup worker is effectively disabled because actual server env lacks backup/restic keys.
3. Production `npm audit --omit=dev` still reports high-severity advisories in the Nest/Multer chain.

## Evidence Log

| Area | Command/check | Result | Notes |
| --- | --- | --- | --- |
| Local/server sync | `rsync -avnc --delete ...` against `/opt/2090-fun-infra/apps/task-hub` | Pass | No application file differences after excluding `.git`, `node_modules`, build outputs, coverage, and tsbuildinfo. |
| Local git baseline | `git status --short` | Dirty | Many existing tracked and untracked product changes. Audit did not revert or edit them. |
| Local commit | `git rev-parse HEAD` | Pass | Local `main` at `ba5827f7b7f453a10ad2849dae06b63890609a29`. |
| Server commit | remote `git rev-parse HEAD` | Pass | Server app `main` at `193822326b849f8fac35ddc96dac7b1bb9378821`; parent infra has dirty `caddy/Caddyfile`. |
| Containers | remote `docker compose ps`/health checks | Pass | Backend, frontend, PostgreSQL, and Redis healthy; migration container exited 0. |
| DB migrations | remote `_prisma_migrations` query | Pass | All five local migrations are applied in production. |
| Backend lint | `npm --workspace backend run lint` | Pass | Clean. |
| Frontend lint | `npm --workspace frontend run lint` | Pass | Clean. |
| Backend typecheck | `npx tsc -p backend/tsconfig.json --noEmit --incremental false` | Pass | Clean. |
| Frontend typecheck | `npm --workspace frontend run typecheck` | Pass | Clean. |
| Prisma schema | `DATABASE_URL=postgresql://validate:validate@localhost:5432/task_hub_validate npx prisma validate --schema prisma/schema.prisma` | Pass | Schema valid. |
| Backend unit tests | `npm --workspace backend run test:unit` | Pass | 161 suites, 952 tests. |
| Frontend tests | `npm --workspace frontend run test` | **Fail** | 48 files passed, 4 failed; 205 tests passed, 4 failed. |
| Backend build | `npm --workspace backend run build` | Pass | Clean. |
| Frontend build | `npm --workspace frontend run build` | Pass with warning | Main JS chunk `510.94 kB`, above Vite's 500 kB warning threshold. |
| Production dependency audit | `npm audit --omit=dev --json` | **Fail** | 5 high vulnerabilities, all in production dependency graph. |
| Full dependency audit | `npm audit --json` | **Fail** | 27 total: 21 moderate, 6 high. |
| Dependency tree | `npm ls --workspaces --depth=0` | Pass | No missing/extraneous top-level dependency issue. |
| UI static detector | `node .../impeccable/scripts/detect.mjs --json frontend/src frontend/index.html` | Warn | Real style guard concern around play triangle; several detector false positives in tests/comments. |
| UI smoke | Chrome/Playwright-style headless smoke on Vite preview | Pass with caveats | Login, tasks, task detail, admin users, and statistics opened on desktop/mobile; no horizontal overflow or page errors. |
| Live root | `curl -I https://tasks.2090.fun/` | Pass with caveat | 200, HSTS/nosniff/referrer/permissions/frame headers present; duplicate CSP observed. |
| Live health | `curl https://tasks.2090.fun/api/health` | Pass with caveat | 200 JSON health; API exposes `X-Powered-By: Express`. |
| Live auth guard | `curl https://tasks.2090.fun/api/tasks` unauthenticated | Pass | 401 `UNAUTHENTICATED`. |
| Live dot-env probe | `curl https://tasks.2090.fun/.env` | Pass | 404 empty body. |
| Server logs | remote backend log tail | Warn | MAX notification delivery retries and skipped missing records observed. |

## What Improved Since 2026-06-24

Resolved or materially improved:

- Production JWT validation now rejects weak/missing production secrets in `backend/src/config/env.validation.ts`.
- Login, MAX auth, password setup/change, and upload routes are protected by `RateLimitGuard`/`@RateLimit`.
- Manual task status changes now enqueue status-change notifications through the task notifier path.
- Backend lint is clean.
- Backend unit coverage grew from 151 suites/838 tests to 161 suites/952 tests.
- Production containers are healthy and the deployed DB has all local migrations.

Still open:

- Dependency audit remains a release concern, although the current residual production chain is narrower than before.
- Backup readiness is still not proven and, on the checked server, backup env is missing.

## UI/UX Health Score

Impeccable-style scoring:

| Criterion | Score | Notes |
| --- | ---: | --- |
| Accessibility | 3/4 | Core pages are navigable and responsive, but desktop/mobile controls include 36-42 px hit targets below the common 44 px touch target. |
| Performance | 2/4 | UI builds, but the main chunk exceeds 500 kB and attachment/preview flows can block or multiply expensive work. |
| Responsive behavior | 3/4 | Smoke checks at 1440x900 and 390x844 found no horizontal overflow on key routes. |
| Theming/design tokens | 2/4 | Token discipline is mostly good, but CSS tests catch hard-coded `#111827` in media surfaces. |
| Visual anti-patterns | 3/4 | Product UI is restrained and operational; the anti-slop property test flags the play icon triangle as a side-tab pattern. |

Total: **13/20, acceptable but not clean enough for release** because automated UI guardrails are currently red.

## P1 Findings

### P1-1 - Frontend Test Gate Fails

Location:

- `frontend/src/pages/AdminUsersPage.tsx:384`
- `frontend/src/components/UserAvatar.tsx:44`
- `frontend/src/styles/global.css:1551`
- `frontend/src/styles/global.css:1575`
- `frontend/src/styles/global.css:1751`
- `frontend/src/pages/AdminUsersPage.avatar.bug.test.tsx`
- `frontend/src/integration/avatar-flow.integration.test.tsx`
- `frontend/src/styles/anti-slop.property.test.ts`
- `frontend/src/styles/tokens-only.property.test.ts`

Evidence:

- `npm --workspace frontend run test` fails.
- 4 frontend tests fail:
  - `AdminUsersPage.avatar.bug.test.tsx` expected `fetchAvatarBlob('user-1')`, got 0 calls.
  - `avatar-flow.integration.test.tsx` expected avatar fetches for users with and without avatars, got 0 calls.
  - `anti-slop.property.test.ts` flags `.chat-msg__attachments .attachment-tile__play::before { border-left-width: 7px; }`.
  - `tokens-only.property.test.ts` flags hard-coded `#111827` backgrounds.

Root cause/risk:

- `AdminUsersPage` passes `avatarPath={u.avatarPath ?? null}`. `UserAvatar` treats `undefined` as "unknown, may fetch" and `null` as "known absent, do not fetch". Collapsing `undefined` to `null` suppresses fallback avatar fetching for responses where `avatarPath` is omitted.
- CSS guardrails are intentionally preventing hard-coded theme values and suspicious decorative patterns. Even if the play-triangle warning is a false positive, the release gate is red.

Impact:

Admin user avatars can fail to load under a valid client-contract edge case, and the frontend release gate is not clean.

Recommendation:

- Pass `avatarPath={u.avatarPath}` so `undefined` keeps its "unknown" meaning.
- Replace hard-coded video backgrounds with an existing token or add a dedicated token.
- Rework the play icon CSS so the anti-slop test can distinguish it from a side-tab accent, or tighten the test selector if this is an accepted false positive.
- Re-run `npm --workspace frontend run test`.

### P1-2 - Production Backup Is Disabled/Misconfigured

Location:

- `backend/src/config/env.validation.ts:60`
- `backend/src/config/configuration.ts:70`
- `backend/src/backup/backup.worker.ts:35`
- `backend/src/backup/backup.service.ts:75`
- remote `env/taskhub.env.example`
- remote runtime env for `taskhub-backend`

Evidence:

- Actual server env key list did not include `BACKUP_MODE`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, or `BACKUP_TMP_DIR`.
- The code defaults `BACKUP_MODE` to `disabled`.
- `backup.worker` logs and returns without scheduling when mode is disabled.
- `backup.service` records manual execution as `SKIPPED` when disabled.
- Server example env documents `BACKUP_MODE=required` and restic variables, but production runtime is not configured that way.

Impact:

The checked production deployment has no confirmed scheduled/offsite application backup path. PostgreSQL data, attachments metadata, audit logs, and task history rely on external infrastructure that was not demonstrated in this audit.

Recommendation:

- Configure production with `BACKUP_MODE=required`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, and `BACKUP_TMP_DIR`.
- Ensure the restic repository is remote/offsite.
- Add an alert on backup failure/staleness.
- Run and document a restore drill from the offsite repository.

### P1-3 - Production Dependency Audit Has High-Severity Runtime Advisories

Location:

- `package-lock.json`
- `backend/package.json`

Evidence:

- `npm audit --omit=dev --json` reports 5 high vulnerabilities in production dependencies.
- The active high chain is through Nest packages and transitive `multer`:
  - `@nestjs/core`
  - `@nestjs/platform-express`
  - `@nestjs/platform-socket.io`
  - `@nestjs/websockets`
  - `multer`
- `npm audit fix` suggests an unsafe semver-major/downgrade path for Nest rather than a clean compatible fix.

Impact:

The application has authenticated upload limits and rate limiting, but release posture is still dependent on accepting an upload-related DoS advisory in the runtime graph.

Recommendation:

- Track the Nest/Multer adapter release path until `multer >= 2.2.0` is available through a compatible Nest version.
- Keep route rate limiting and 25 MB upload limits as compensating controls.
- Document the residual advisory in the release decision if shipping before the upstream fix.
- Re-run `npm audit --omit=dev --json` as a release gate.

## P2 Findings

### P2-1 - Browser Sessions Still Store Bearer Tokens In `localStorage`

Location:

- `frontend/src/lib/auth-context.tsx:72`
- `frontend/src/lib/api.ts:105`
- `docs/release-hardening.md:3`

Evidence:

- The frontend persists bearer tokens in `localStorage` and attaches them as `Authorization: Bearer ...`.
- `docs/release-hardening.md` explicitly records this as an accepted residual risk for the release.

Impact:

Any future XSS vulnerability can read active tokens. The current CSP reduces risk but does not remove the browser-storage exposure.

Recommendation:

Move toward HttpOnly cookie/refresh-token sessions with CSRF and Socket.IO/CORS changes planned together.

### P2-2 - No CI/CD Configuration Was Found In The Repository

Location:

- repository root
- `docker-compose.integration.yml`
- `package.json` scripts

Evidence:

- No `.github`, `.gitlab`, Jenkinsfile, or equivalent CI config was found.
- Quality checks are runnable manually, but the repository does not show an automated gate for lint, typecheck, test, build, Prisma validation, or audit.

Impact:

The current red frontend test and dependency audit could be missed during manual release, especially with an already-dirty worktree.

Recommendation:

Add CI with backend/frontend lint, typecheck, unit tests, build, Prisma validate, `npm audit --omit=dev`, and optional integration tests behind services.

### P2-3 - Environment Documentation Is Split And Locally Incomplete

Location:

- `README.md:21`
- remote `env/taskhub.env.example`
- missing local `backend/.env.example`

Evidence:

- The root README points readers to `backend/.env.example`.
- The local file is absent.
- The server-side infra contains `env/taskhub.env.example`, including backup keys, but that is not the local documented path.

Impact:

New operators can miss required production variables, including backup configuration.

Recommendation:

Add a local env example or update README to the actual source of truth. Include production-only requirements and dangerous defaults clearly.

### P2-4 - Health, Logging, And Monitoring Are Too Shallow

Location:

- `backend/src/app.service.ts:11`
- Docker log rotation settings in server compose
- backend notification delivery logs

Evidence:

- `/api/health` returns static service health and does not verify PostgreSQL, Redis, queues, backup freshness, or notification delivery health.
- No repository evidence of metrics, tracing, Sentry/OpenTelemetry, Prometheus, or alert rules.
- Server logs show MAX notification delivery failures after retries and skipped delivery records, but no alerting path was confirmed.

Impact:

The deployment can look healthy while dependencies, queues, backup jobs, or notification delivery are degraded.

Recommendation:

Add readiness/dependency health, metrics for queue depth/failures, backup freshness, delivery failure counters, and alerting for repeated notification failures.

### P2-5 - Live API Exposes `X-Powered-By: Express`

Location:

- `backend/src/main.ts:20`
- live `https://tasks.2090.fun/api/health`

Evidence:

- Live API response includes `X-Powered-By: Express`.
- `main.ts` does not disable the header.

Impact:

This is minor information disclosure and easy hardening.

Recommendation:

Call `app.disable('x-powered-by')` during bootstrap and verify the live header disappears.

### P2-6 - Attachment Upload/Compression Uses Full Buffers And Synchronous Work

Location:

- `backend/src/attachments/attachments.controller.ts:109`
- `backend/src/storage/storage.service.ts:32`

Evidence:

- Uploads use Multer memory buffering.
- Storage reads full buffers/read streams into memory and calls synchronous zstd compression.

Impact:

Authenticated users can tie up memory and event-loop time with large or concurrent uploads. The 25 MB limit and rate limiting help, but the work still happens in-process.

Recommendation:

Move heavy compression to streaming/backpressure or a worker queue, and add concurrency/resource limits around expensive attachment operations.

### P2-7 - Document Preview Conversion Needs Concurrency And Cache Controls

Location:

- `backend/src/attachments/attachments.service.ts:462`
- `backend/src/attachments/document-preview.service.ts:82`
- `backend/src/attachments/document-preview.service.ts:131`

Evidence:

- Document preview loads/decompresses the original and spawns LibreOffice with a timeout.
- The implementation uses temp directories and avoids shell interpolation, which is good, but no preview cache or conversion semaphore was confirmed.

Impact:

Multiple preview requests can spawn many expensive conversion processes.

Recommendation:

Add preview result caching and a process-level semaphore/queue for LibreOffice conversions.

### P2-8 - Statistics And Search Will Not Scale Cleanly With Large History

Location:

- `backend/src/statistics/statistics.repository.ts:30`
- `backend/src/search/search-query.ts:240`
- `prisma/schema.prisma`

Evidence:

- Statistics repository loads broad task/message sets and computes aggregates in application memory.
- Search uses `contains`/case-insensitive filters over title/description.
- Useful indexes exist for many relational lookups, but no text/trigram/full-text index was confirmed for broad task search.

Impact:

As task and message history grows, statistics and text search can become slow and memory-heavy.

Recommendation:

Move high-cardinality statistics to DB aggregates/materialized summaries and add a search index strategy appropriate for PostgreSQL.

### P2-9 - Several Controls Are Below Common Touch Target Size

Location:

- `frontend/src/styles/global.css`
- routes `/tasks`, `/tasks/task-1`, `/admin/users`, `/statistics`

Evidence:

- Desktop/mobile smoke found many controls around 36-42 px high.
- Mobile nav links measured around 39 px high; some icon buttons measured 36 px.

Impact:

The UI is usable, but less comfortable on touch devices and less forgiving for accessibility.

Recommendation:

Set interactive controls to at least 44 px on touch/mobile surfaces and verify compact desktop controls still have accessible labels/focus.

### P2-10 - CSP Is Duplicated Between Edge And Frontend Nginx

Location:

- `frontend/nginx.conf:7`
- remote `caddy/Caddyfile`
- live `https://tasks.2090.fun/`

Evidence:

- Live responses include duplicate Content-Security-Policy headers.
- The internal nginx and edge Caddy both appear to set CSP.

Impact:

Duplicate CSP is usually enforceable, but it makes policy maintenance and debugging harder. Divergent values can create subtle browser-specific failures.

Recommendation:

Choose one CSP source of truth or add deployment tests that assert the duplicated policies remain identical.

## P3 Findings

### P3-1 - Local Preview Smoke Emits Socket.IO 404/Connection Noise

Evidence:

- The preview API used for smoke testing does not implement the Socket.IO endpoint.
- Browser console showed repeated failed `ws://127.0.0.1:5173/socket.io/...` attempts.

Recommendation:

Either mock Socket.IO in the preview API or disable realtime connection attempts in static smoke tests.

### P3-2 - React Router Future-Flag Warnings Add Test Noise

Evidence:

- Frontend tests and browser smoke emit React Router future-flag warnings.

Recommendation:

Opt into the relevant future flags or suppress known warnings in test setup after validating behavior.

### P3-3 - Main Frontend Chunk Crosses Vite Warning Threshold

Evidence:

- Frontend build produced `dist/assets/index-QYkFC47H.js` at `510.94 kB` before gzip.

Recommendation:

Consider route-level code splitting for admin/statistics/attachment viewer surfaces.

### P3-4 - UI Detector Reports Several False Positives In Tests/Comments

Evidence:

- `impeccable` detector flagged broken-image patterns in test/comment strings, not only runtime UI.

Recommendation:

Adjust detector inputs or exclusions so CI warnings are closer to actionable runtime issues.

### P3-5 - Server Infra Has Uncommitted Parent-Level Caddy Changes

Evidence:

- Server app source matched local files, but server git status in the parent infra showed modified `../../caddy/Caddyfile`.

Recommendation:

Commit, document, or intentionally track the Caddy change so deployment state is reproducible.

## Category Review

| Category | Status | Key points |
| --- | --- | --- |
| Performance | P2 | Frontend bundle warning, sync compression, expensive document conversion, and app-memory statistics/search are the main risks. |
| Logic and business processes | Mostly good | Status workflow and notifications are now wired; avatar fallback regression remains in admin users. |
| Security | P1/P2 | Rate limiting, validation, CSP, HSTS, webhook secret comparison, and auth guards are good; dependency audit, backups, localStorage tokens, and Express header remain. |
| UI/UX | P1/P2 | Layout smoke is healthy with no overflow; automated UI tests fail on avatar/style guardrails; touch targets need work. |
| Architecture and code quality | Good with gaps | Backend lint/typecheck/tests pass; clear ports/adapters exist; heavy media work and missing CI are architecture/process gaps. |
| Error handling and stability | Mostly good | Exception filter normalizes errors and hides stack traces; health checks and notification failure visibility are too shallow. |
| API, network, database | Mostly good | Authenticated API behavior and migrations are healthy; DB/search/statistics scaling needs planned improvements. |
| Authorization and user data protection | Mostly good | Protected routes return 401 unauthenticated; bearer token storage remains the accepted browser-session risk. |
| Adaptiveness and compatibility | Good with P2 UX | Key routes render on desktop/mobile without horizontal overflow; hit targets should be increased. |
| Testing and edge cases | Mixed | Backend suite is strong; frontend suite is currently red; preview WebSocket noise should be cleaned up. |
| Dependencies, configuration, CI/CD | P1/P2 | Production audit high advisories, missing local env example, and no CI config found. |
| Analytics, logging, monitoring | P2 | Docker logs and health exist; metrics, alerting, queue/backup/delivery observability are not enough. |
| Scalability and maintainability | P2 | Current code is maintainable for moderate scale; media processing, stats/search, and CI need hardening before growth. |

## Positive Findings

- Production application files are synchronized with the checked local workspace.
- Backend lint, backend typecheck, backend unit tests, backend build, frontend lint, frontend typecheck, frontend build, and Prisma validation pass.
- Production containers are healthy and database migrations are applied.
- PostgreSQL and Redis are not publicly exposed in the checked compose topology.
- Live unauthenticated task access returns a structured 401.
- Live `.env` probing returns 404.
- Strict validation pipe uses whitelist and rejects unknown DTO properties.
- Exception filter returns generic 500 responses while logging server details.
- Rate limiting is now applied to sensitive HTTP routes.
- MAX webhook guard requires a configured secret and uses timing-safe comparison.
- Attachment/avatar storage contains path traversal guards.
- LibreOffice conversion uses spawn without shell string interpolation.
- UI smoke found no horizontal overflow on the checked desktop/mobile routes.

## Recommended Next Actions

1. Fix the frontend avatar/style regressions and make `npm --workspace frontend run test` green.
2. Configure production backups with `BACKUP_MODE=required`, restic remote storage, alerting, and a restore drill.
3. Record a release decision for the Nest/Multer advisory or wait for a compatible upstream fix.
4. Add CI so lint, typecheck, tests, build, Prisma validation, and production audit run automatically.
5. Harden observability: dependency health, backup freshness, queue metrics, MAX delivery failure alerts, and `X-Powered-By` removal.
6. Plan performance/scalability work for attachment compression, document previews, statistics, and text search.'


То есть, теперь это самая производительна и отказоустойчивая версия программы без ошибок в логике и коде, без лишнего кода, без уязвимостей, с лучшим UX?UI, дизайном?


snoopyseller | !gpt | uhayote008@gmail.com | 2312597ChatGPT | 21:43
gloxotnik | !код | ethics-valor6r+3r64lt@icloud.com | Chatgptplus123@ | 23:44
roomer_aquas_1b+rly6pipbb7j6o49mssyr@icloud.com ChatgptPlus99999@@ | 01:34


1. Добавь логотип на https://tasks.2090.fun/login. Убери кнопку "На главную".
2. Аватар в сайдбаре администратора ужат по ширине, имеет овальную форму

Добавь уведомление "В чате новое сообщение". Это уведомление приходит на сайт и в MAX. Это уведомление приходит, если в чате новое сообщение. Если статус задачи меняется из-за сообщения в чате, уведомление "Статус задачи изменен" не присылать, присылать только "В чате новое сообщение".

При добавлении пользователей в систему, добавь обязательное поле "Имя". Добавь импорт и экспорт пользователей системы используя таблицы Excel.

Переделай бота в MAX из кнопочного интерфейса в mini-app.

1. Когда в MAX приходит уведомление (не в mini-app), у него есть кнопка "Открыть задачу". Сейчас эта кнопка открывает список всех задач, надо чтобы открывало конкретную задачу. 
2. Верстка окна "Создание задачи" некорректна.
3. Не могу прикрепить некоторые виды файлов через mini-app



1. Убрать надпись "Войдите в Task Hub, чтобы привязать этот профиль MAX." при входе в mini-app.
2. При входе в mini-app через web-версию MAX на компьютере, пишет "Требуется вход в систему.". На телефоне работает.

1. Добавить поддержку PDF через Libre Office.
2. Для файлов Libre Office-support заменить эмозди на реальные иконки приложений (Пример: файл Word - иконка Word, файл PDF - иконка PDF, файл Excel - иконка Excel)
3. Проверь реактивность чата и "Прочитали".
4. Верстка окон "Создание задачи" и "Изменение задачи" стала плохая на сайте после моей просьбы исправить эти окна в MAX mini-app. Изменения в MAX mini-app не должны касаться сайта.
5. На сайте в карточке задачи появилась кнопка включения/отключения уведомлений в MAX. Убери. Изменения в MAX mini-app не должны касаться сайта.
6. Провел тестирование MAX mini-app у трех разных людей. Тесты проводились в web-версии MAX и телефоне. У них ошибки при предпросмотре вложений для файлов Libre Office-support на компьютере: This page has been blocked by Chrome, T
сессия недействительна
