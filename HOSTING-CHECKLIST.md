# Trifolia Hosting and Security Checklist

## Before deployment
- [ ] Build on Node.js 20.19+ / 22 LTS with a reviewed lockfile.
- [ ] `npm ci`, `npm run build`, and `node --check server.js` all pass.
- [ ] `npm audit` has been reviewed; critical/high issues are resolved or documented.
- [ ] Configure a dedicated non-root MySQL account with least privilege.
- [ ] Keep MySQL private; only the application host can reach it.
- [ ] Set production environment variables using the host's secret store.
- [ ] Use a unique bootstrap admin ID and random password of at least 16 characters.
- [ ] Confirm no `.env`, SQL dumps, backups, logs, or resident uploads are committed or publicly served.
- [ ] Back up any existing database before schema changes or password migration.

## Required security tests
- [ ] Unauthenticated `GET /api/state` returns 401.
- [ ] Unauthenticated `PUT /api/state` returns 401.
- [ ] Unauthenticated `GET /api/database-summary` returns 401.
- [ ] Invalid login attempts are throttled; known default passwords are rejected in production.
- [ ] Responses never include `password` or password hashes.
- [ ] Resident A cannot read or modify Resident B's records.
- [ ] Residents cannot approve their own payments, applications, installment plans, or visitor passes by editing API payloads.
- [ ] Guard cannot access financial-accounting or resident IC/email data.
- [ ] Technical Team cannot access financial-accounting or resident IC/email data.
- [ ] Office Staff cannot create, demote, or remove a Management account.
- [ ] Oversized payloads and malformed JSON are rejected safely.
- [ ] CSRF / cross-origin mutation attempts are rejected.
- [ ] Password reset script works against a disposable test database.
- [ ] Logout invalidates the session; expired sessions are rejected.
- [ ] Error responses contain no SQL, stack trace, filesystem path, or secret.
- [ ] Visitor log 90-day retention and 30-day deleted-record purge are tested.
- [ ] All modules pass role-based functional tests using dummy data.

## After deployment
- [ ] HTTPS is active and HTTP redirects to HTTPS at the proxy/host.
- [ ] `/api/health` reports healthy without exposing infrastructure details.
- [ ] Restore a backup into a separate test database and verify recovery.
- [ ] Confirm application logs and database backups are private and retained appropriately.
- [ ] Perform an independent penetration test before storing real resident, identity, incident, or financial data.

**Do not mark this system production-ready until every required security test above passes.**
