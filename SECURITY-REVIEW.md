# Security Review — Trifolia V59 remediation build

Review date: 2026-10-12

## Changes implemented in this remediation pass

- Added server-side login and session validation; the browser no longer authenticates by comparing passwords against local application state.
- Protected `/api/state` and `/api/database-summary` with session authentication.
- Added HttpOnly, SameSite=Strict session cookies; Secure is enabled in production.
- Added server-side role-scoped state reads and role allowlists for writes.
- Added protections against residents changing approval-controlled fields, editing other units' records, or deleting records by omitting them from submitted state.
- Added account role protections so Office Staff cannot create/promote/remove Management accounts and users cannot change their own role or delete their own account.
- Added in-memory login throttling, same-origin checks for state-changing API calls, a 12 MB JSON body limit, no-store API responses, security headers, and generic client-facing errors.
- Added scrypt password hashes; passwords and password hashes are removed from API responses and browser local storage is no longer used for application state.
- Production login rejects accounts that still use legacy plaintext password storage. Added `scripts/reset-user-password.mjs` for secure migration.
- Removed hard-coded default account inserts from both SQL copies and removed the unused duplicate `trifolia.sql` schema. `trifolia-schema.sql` is the one used by the server and its table creation statements are idempotent.
- Production refuses the local-file storage mode and requires a dedicated non-root database user with a non-empty password.
- Added a bootstrap path for the first Management account, configured using environment variables only when the application state row does not exist.
- Removed duplicate old README files and unused duplicate image assets.

## Static checks completed

- `node --check server.js`: passed.
- `node --check scripts/reset-user-password.mjs`: passed.
- TypeScript parser/transpiler JSX syntax check for `src/App.jsx`: no parse diagnostics.
- SQL text scan: no default-account seed inserts remain; `trifolia-schema.sql` uses `CREATE TABLE IF NOT EXISTS` for its tables.
- ZIP integrity will be checked when the release archive is generated.

## Not verified — blocks production approval

- `npm install` timed out in the current environment; dependencies are not installed here.
- `npm run build`, `npm audit`, live MySQL startup, session-cookie behaviour through the actual hosting proxy, and browser end-to-end tests could not be run.
- Role-scoped shared-state authorization is a meaningful improvement, but the application still uses a legacy shared-state bridge. Every role/module/field combination must pass negative authorization tests before production approval.
- In-memory sessions and rate limiting are suitable only for a single app instance. Use a shared session store and shared rate limiter before horizontal scaling.
- Resident self-registration is disabled pending server-side unit verification.
- Backup/restore, upload handling, 90-day visitor-log retention, and 30-day deleted-record purge must be validated in a test environment.

## Release decision

**Not yet certified safe for public production hosting.** This remediation closes several high-risk paths in source code, but a complete dependency installation, production build, live integration test and independent security test remain required. Do not import real resident IC/passport, incident, visitor, or financial data until the outstanding tests pass.
