# Upload this project to GitHub

## Recommended: GitHub Desktop

1. Extract this ZIP to a folder such as `C:\Projects\trifolia-management-system`.
2. Install GitHub Desktop from https://desktop.github.com/ and sign in.
3. In GitHub Desktop choose **File → Add Local Repository** and select the extracted folder.
4. If asked to create a repository, create it in the same folder (do not create an extra nested folder).
5. Review the files. Confirm `.env`, `.env.*` secrets, `node_modules/`, `dist/`, database dumps, logs, backups, and real resident records are not included. The supplied `.gitignore` excludes common local secrets and generated files, but manually verify before publishing.
6. Commit the files locally.
7. Click **Publish repository**, name it `trifolia-management-system`, and enable **Keep this code private**.
8. Open the repository on GitHub and confirm `package.json`, `server.js`, `render.yaml`, `src/`, and `trifolia-schema.sql` appear at the repository root.

## Before deployment

- Run `npm install` in the project folder to install dependencies and generate `package-lock.json`.
- Run `npm run check:server` and `npm run build`; both must pass locally.
- Commit `package-lock.json` after reviewing it. You can then change the Render build command to `npm ci && npm run build`.
- Set all secrets in Render's Environment settings, not in GitHub.
- Do not commit real resident data, uploaded documents, database dumps, `.env` files, passwords, tokens, or private keys.
- Use a staging deployment and synthetic data until authentication, authorization, MySQL startup, backups/restoration, and module workflows are verified.

This package has not been certified safe for production. Static syntax and archive checks do not replace a complete build, live database test, or security assessment.
