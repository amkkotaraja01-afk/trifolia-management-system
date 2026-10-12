# Trifolia — Render + MySQL deployment guide

## Important release status

This is deployment configuration, not a production security approval. Do not import real resident, IC/passport, incident, visitor, or financial data until the release tests in `HOSTING-CHECKLIST.md` pass. The dependency install timed out in the review environment, there is no committed `package-lock.json`, and no live MySQL or end-to-end role tests have run.

## Architecture

- Public Render **Web Service**: Node.js/Express serves the built Vite frontend and `/api` endpoints.
- Private MySQL 8 service: accessible only over Render's private network; do not expose port 3306 publicly.
- Render provides HTTPS for the public web service.

## A. Put the project in a private GitHub repository

1. Download the security-hardening ZIP and extract it.
2. Create a **private** GitHub repository for the project. Do not publish `.env` files, SQL dumps, production backups, resident uploads, or secrets.
3. Upload the extracted project contents (the files inside the project folder, not a nested ZIP) and commit them.
4. Before the first production release, generate and commit `package-lock.json` from a trusted Node.js 22 environment, review it, and use `npm ci` in the Render build command. Do not use `--force` or `--legacy-peer-deps` to bypass dependency conflicts.

## B. Create MySQL on Render

Render's documented MySQL option is a self-managed MySQL 8 service, not a managed database product. Follow Render's current MySQL deployment guide:

1. Fork/use the `render-examples/mysql` template repository.
2. In Render choose **New → Private Service**, connect the MySQL repository, and choose Docker runtime.
3. Set secrets for `MYSQL_DATABASE=trifolia_management`, `MYSQL_USER=trifolia_app`, `MYSQL_PASSWORD` (unique random secret), and `MYSQL_ROOT_PASSWORD` (different unique random secret).
4. Attach a persistent disk with mount path `/var/lib/mysql`; choose capacity appropriate for the database (Render's guide gives 10 GB as its example).
5. Deploy and wait until MySQL is healthy. Record the private hostname shown by Render (for example `mysql-service-name`) and use port `3306`.
6. Never create a public database endpoint or allow public internet access to port 3306. Keep the web and database services in the same Render workspace/region.
7. Back up MySQL with `mysqldump` and test restoring a backup. Do not rely on a disk snapshot as the database backup method.

The application currently runs schema creation/alteration on startup, so its DB user needs DDL permissions scoped only to `trifolia_management`. This is broader than an ideal runtime-only account. Before production approval, move schema changes into a reviewed migration step and reduce the runtime user's privileges.

## C. Create the web service

1. In Render choose **New → Blueprint** and connect the private GitHub repository containing `render.yaml`, or create a **New → Web Service** and enter the settings below manually.
2. Set service name `trifolia-management-system`, runtime Node, and use the same region as MySQL.
3. Build command in this initial staging setup: `npm install --no-audit --no-fund && npm run build`. After committing a verified lockfile, change to `npm ci && npm run build`.
4. Start command: `npm start`.
5. Health check path: `/api/health`.
6. Set environment variables in Render's Environment screen; never commit actual secret values:

   - `NODE_ENV=production`
   - `STORAGE_MODE=mysql`
   - `TRUST_PROXY=1`
   - `DB_HOST=<MySQL private hostname only, no scheme or port>`
   - `DB_PORT=3306`
   - `DB_USER=trifolia_app`
   - `DB_PASSWORD=<the MYSQL_PASSWORD value>`
   - `DB_NAME=trifolia_management`
   - `DB_CREATE_DATABASE=false`
   - `DB_POOL_SIZE=5`
   - `DB_SSL_REJECT_UNAUTHORIZED=true`
   - `DB_SSL=<verify whether the chosen MySQL service supports TLS; use true only with valid server TLS/CA verification. If the self-managed service has no TLS configured, false is acceptable only over Render's private network and must not be paired with a public DB endpoint>`
   - `BOOTSTRAP_ADMIN_USER=<unique management login ID>`
   - `BOOTSTRAP_ADMIN_PASSWORD=<unique random password, at least 16 characters>`

7. Deploy initially as a **staging/test service** with dummy data only. Keep only one web instance while sessions are in memory; scaling/restarts invalidate in-memory sessions. A shared session store is required before horizontal scaling.

## D. Verify the deployment before public launch

1. In Render logs confirm database schema setup completes and the server remains running.
2. Open `https://<service>.onrender.com/api/health`; it must return `{"ok":true,"service":"trifolia"}`. This is necessary, not sufficient.
3. Confirm the root URL loads the frontend, sign in with the bootstrap account, and immediately create unique accounts for each required role.
4. Test unauthenticated `GET /api/state`, `PUT /api/state`, and `GET /api/database-summary`; each must return `401`.
5. Test role boundaries with two fake residents and test Guard, Technical Team, Office Staff, and Management. Attempt direct API requests, not only UI clicks.
6. Test all financial totals, fee allocation, receipts/PDF export, defaulters, installment plans, QR visitor IN/OUT, uploads, incident report confidentiality, 90-day visitor-log retention, and 30-day deletion/purge behavior.
7. Test mobile layouts on a phone and desktop.
8. Configure and test backup restoration; confirm logs contain no passwords, tokens, IC/passport numbers, or other sensitive data.
9. Add `trifolia1.com.my` only after staging tests pass. Configure the domain in Render, apply the exact DNS records Render supplies, wait for verification and TLS, then test HTTPS redirects and all API routes.
10. Import real data only after every mandatory checklist item is passed and recorded.

## Current blockers from the source review

- Dependency installation timed out in the review environment.
- No `package-lock.json` is present; reproducible dependency installation is not yet established.
- No live MySQL connection/schema startup test has been completed.
- No complete feature-by-feature authorization test or independent penetration test has been completed.
- The app uses in-memory sessions, so multiple instances and restart persistence are not supported.
- The schema is executed at app startup and requires DDL permissions; migrate schema changes to a separate migration step before production approval.

Until these blockers are closed, use only a staging deployment with synthetic data.
