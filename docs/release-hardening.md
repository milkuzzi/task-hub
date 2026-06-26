# Release Hardening Boundaries

## Browser Sessions

Task Hub keeps bearer access tokens in `localStorage` for this release. This is
an accepted residual risk: a future XSS vulnerability could read an active
token. Production nginx mitigates the risk with a restrictive Content Security
Policy, `nosniff`, and a strict referrer policy.

An HttpOnly-cookie session/refresh design remains the preferred long-term
mitigation, but requires coordinated CSRF, CORS, Socket.IO, and backend auth
changes outside this hardening pass. Vite development mode does not reproduce
the production CSP and must not be exposed as a production server.

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
runs the configured restic/S3 path and records missing configuration or runtime
errors as `FAILED`.

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
Vite/Vitest current major releases, and a root `ws@8.21.0` override.

As of the verification run on 2026-06-24, the production audit has no critical
advisories and one residual high-risk chain:

- `@nestjs/platform-express@11.1.27` hard-pins `multer@2.1.1`.
- `multer <2.2.0` is flagged for upload-related denial of service advisories.
- npm's suggested fix downgrades Nest packages to 7.x, which is not a safe
  remediation path for this application.

Mitigations until Nest publishes an adapter release with `multer >=2.2.0`:
attachment upload requires an authenticated session, the upload route is rate
limited, multer has a 25 MB file-size limit, the backend is not supported as a
direct public edge, and dependency audit remains a release gate.

The full audit also reports dev/tooling moderate advisories in the Jest/ts-jest
chain plus non-runtime parser utilities. These are not production dependencies;
they should be revisited when upgrading the backend test stack.

## Repository Artifacts

`.kiro/specs` and already tracked `.superpowers/sdd` files are retained as
historical design records. New `.superpowers` scratch output remains ignored.
TypeScript build info and local dogfood screenshots are generated artifacts and
must remain outside routine source diffs.
