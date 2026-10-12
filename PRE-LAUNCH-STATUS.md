# Trifolia public-launch gate

Status: **NOT APPROVED for real resident or financial data**.

## Verified in this review
- Security-hardening ZIP passes archive integrity verification.
- `node --check server.js` passes.
- `node --check scripts/reset-user-password.mjs` passes.
- The server binds to `0.0.0.0` and uses `process.env.PORT`, compatible with Render's web-service port model.
- The project defines `/api/health`, and production static serving expects a Vite `dist` build.
- `render.yaml` declares a Node web service, build/start commands, health check, and secret placeholders without embedding real credentials.

## Not verified / blocking
- Dependency installation timed out in the review environment.
- No `package-lock.json`; `npm ci` cannot be used until a lockfile is generated and committed.
- Vite production build not verified.
- MySQL schema application, database TLS, bootstrap account creation, and persistence not verified against a live MySQL service.
- All negative authorization tests and complete module regression tests remain outstanding.
- Independent penetration testing and backup restoration remain outstanding.

## Decision
Do not direct real residents to this service yet. Deploy only to a private test workflow/staging URL with synthetic data until every required test passes.
