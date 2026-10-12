# Trifolia Management System — Unified Hosting Package

This is the unified project package for the Trifolia React/Vite frontend and Node.js/Express/MySQL backend, combining the security-hardening source, latest responsive stylesheet, and Render deployment configuration.

## Local verification

Requirements: Node.js 22 and npm.

```bash
npm install
npm run check:server
npm run build
npm start
```

Configure a local `.env` from `.env.example` before starting with MySQL. Do not commit `.env`, production credentials, backups, or real resident data.

## Render deployment

See `RENDER-DEPLOYMENT.md`. Set every required secret/environment variable in Render. Keep MySQL on a private network, with a persistent disk and verified backups. Use synthetic data during staging.

## Important release status

This package is a deployment candidate, not a production safety certification. The production build, live MySQL behavior, all role/ownership restrictions, backup restoration, and full mobile/device regression tests must pass before real resident or financial data is used. Do not expose the application publicly with real data until the launch checklist is complete.
