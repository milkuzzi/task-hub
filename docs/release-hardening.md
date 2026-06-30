# Release Hardening Boundaries

## Browser Sessions

Task Hub uses an HttpOnly `taskhub_session` cookie for browser sessions. The
frontend no longer persists bearer tokens in `localStorage`; REST and Socket.IO
requests authenticate through same-origin credentials.

The backend still accepts legacy `Authorization: Bearer` tokens and legacy
Socket.IO `auth.token` during the transition, but the browser client does not
write them to persistent storage. Production edge headers still provide CSP,
`nosniff`, and a strict referrer policy. Vite development mode does not
reproduce the production CSP and must not be exposed as a production server.

## Trusted Proxy Boundary

The supported production chain is:

`client -> Caddy -> taskhub-frontend nginx -> taskhub-backend`

Caddy is the only trusted public edge. Internal nginx forwards Caddy's
sanitized `X-Forwarded-For` value without appending client-provided values and
sets `X-Forwarded-Proto: https`. The backend validates forwarded client
addresses as IPv4/IPv6 before using them for rate limiting.

Direct public exposure of `taskhub-backend` is unsupported. A different proxy
topology must strip or overwrite inbound forwarded headers before requests
reach the backend.

## Audit Immutability

Audit entries are append-only at the application repository/service boundary.
The application exposes create/list operations and no update/delete operation.
Privileged direct database access can still mutate audit rows. Database-level
roles or triggers are deferred until deployment uses separate application and
migration roles.

## Backups

`BACKUP_MODE=disabled` prevents the built-in worker from scheduling jobs.
Manual service execution records a `SKIPPED` outcome. `BACKUP_MODE=required`
runs the configured restic path and records missing restic configuration or
runtime errors as `FAILED`. The S3 manifest upload is optional: when S3 is not
fully configured, the restic snapshot can still be recorded as `SUCCESS`, but
`verifyIntegrity()` cannot use the S3 manifest path.

For production, configure:

- `BACKUP_MODE=required`
- `RESTIC_REPOSITORY`
- `RESTIC_PASSWORD`
- `BACKUP_TMP_DIR`
- S3 manifest variables when manifest verification is used

The restic repository must itself be remote/offsite to represent offsite data.
The S3 object produced by Task Hub is a checksum/snapshot manifest, not the
database dump or restic repository. A manifest alone cannot restore the
database.

Release readiness requires an operator-run restore drill from the offsite
restic repository. This repository verification cannot substitute for that
drill.

The application exposes Prometheus gauges for release gates:

- `taskhub_backup_mode_required` must be `1` in production.
- `taskhub_backup_restic_offsite_configured` must be `1`; local filesystem
  restic repositories are not considered offsite.

Set `METRICS_TOKEN` in production so `/metrics` requires
`Authorization: Bearer <token>`. Pass the same value to release smoke through
`TASKHUB_METRICS_TOKEN`.

Run the production smoke after deployment:

```bash
TASKHUB_BASE_URL=https://your-domain.example \
TASKHUB_METRICS_TOKEN="$METRICS_TOKEN" \
npm run smoke:release
```

## Container Health

The backend image healthcheck includes `X-Forwarded-Proto: https`, matching the
HTTPS redirect middleware without relying on a compose override.

Smoke the image default healthcheck with:

```bash
docker build -f backend/Dockerfile -t taskhub-backend:health .
docker run --rm -d --name taskhub-backend-health \
  -e JWT_SECRET=replace-with-a-random-production-secret-at-least-32-characters \
  taskhub-backend:health
docker inspect --format '{{.State.Health.Status}}' taskhub-backend-health
docker stop taskhub-backend-health
```

The container also needs reachable PostgreSQL and Redis configuration for a
full startup smoke.

## Dependency Audit

Safe upgrades applied in this hardening pass include NestJS 11 packages,
`bcrypt@6`, `bullmq@5.79.1`, Socket.IO `4.8.3`, `axios@1.18.1`,
Vite/Vitest current major releases, a root `ws@8.21.0` override, and a
targeted `@istanbuljs/load-nyc-config` override to keep `js-yaml` on a patched
release in the Jest/Istanbul tooling chain.

As of the 2026-06-28 hardening pass, the backend HTTP runtime uses Fastify.
Upload parsing is handled by `@fastify/multipart` with explicit file, part,
field, header, and byte limits. `@nestjs/platform-express` and `multer` are no
longer production dependencies; `npm ls multer @nestjs/platform-express
--omit=dev --workspace backend` should return an empty tree.

`npm audit` and production-only audits for both workspaces must report zero
known vulnerabilities before release.

## Repository Artifacts

`.kiro/specs` and already tracked `.superpowers/sdd` files are retained as
historical design records. New `.superpowers` scratch output remains ignored.
TypeScript build info and local dogfood screenshots are generated artifacts and
must remain outside routine source diffs.
