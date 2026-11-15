# GhostPost by planet.X

Private publishing workspace and read-only Buffer companion, built with Next.js, Vercel Functions, Neon Postgres, and Managed Neon Auth. No AppDeploy runtime, SDK, database, authentication, or policy hosting is used.

**Candidate: v0.4.0.** The audit branch is `fix/ghostpost-full-audit-buffer-oauth`; production still serves v0.3.1. See [the audit and deployment checklist](docs/GhostPost-11.14-v0.4.0-audit-report.md) for evidence and remaining live checks. Do not merge or deploy this branch without owner authorization.

## Run and verify

Use Node 24 (verified with 24.22.1):

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Populate server values from the project secret manager; never commit them. Apply `migrations/001_records.sql` to a new dedicated database before first use. It is repeatable and preserves existing records. The existing production schema was verified read-only; this repair requires no new migration or credential rotation.

```sh
npm run typecheck
npm test
npm run build
npm audit
```

`npm test` runs the handler/security suite, OAuth lifecycle against the real SQL adapter using isolated PGlite, grouping and media transport tests, authenticated media route tests, and DOM interaction tests. No real Buffer credentials or production database are used. DOM simulation does not prove browser layout, provider consent, or OS sharing. No lint script is configured.

The optional native Postgres rollback check is intentionally skipped without a disposable `DATABASE_URL`. To run it in an approved test database:

```sh
node --env-file=.env.local --import tsx --test tests/store.test.ts
```

For local browser QA after a production build, `node tests/browser-fixture-server.mjs` serves synthetic campaign data at `http://localhost:3000`. Supply synthetic Neon Auth configuration for the build if required. This test harness never calls Buffer or deploys an API route. The cloud browser could not reach the local server in this audit; candidate interactions were verified in a DOM simulator instead.

## Infrastructure and release control

- Repository: https://github.com/xfactor21/GhostPost
- Production: https://ghostpost.planet-x.co
- Vercel project: `ghostpost`, Next.js, Node 24, `iad1`
- Neon project: `divine-fog-17162968`, dedicated `ghostpost` database, production branch `br-fancy-paper-bbcanryr`
- Authentication: same-origin `/api/auth` proxy to Managed Neon Auth; Google and email sign-in. Accounts and sessions are separate from the earlier demo.
- Persistence: owner-scoped, parameterized JSONB records with optimistic workspace revisions and compare-and-swap locks. Buffer tokens are encrypted with AES-256-GCM; credentials are excluded from exports and browser storage.
- Git auto-deployments are disabled in `vercel.json`. Only an explicitly authorized release may deploy; use `[DEPLOY]` on the authorized release commit. Preview environments intentionally have no production secrets.

## Buffer and manual publishing

Production configuration presence and the configured callback value were checked. Presence does not validate secret values or Buffer's approved callback allowlist. Expected callback:

`https://ghostpost.planet-x.co/api/auth/buffer/callback`

The v0.4.0 repair fixes a storage namespace validator that rejected `oauth_pending_v2` before Buffer authorization could begin. It also adds sanitized correlation IDs and stage diagnostics. The installed `@neon/auth` 0.8.2 supports the existing `auth.getSession()` request context; that integration was preserved.

Buffer access remains `posts:read account:read offline_access`. Sent campaigns use actual `sentAt` minute, while scheduled records use `dueAt` and stay separate by status. Documented relationship IDs supplement grouping when returned. Equal timestamps remain a grouping signal, not a guaranteed campaign identity.

The media gallery requests Buffer's documented `source` and `thumbnail` fields. Available files can be downloaded individually or in a ZIP with a caption/media manifest. Media passes through authenticated, rate-limited routes with public-DNS validation, pinned TLS connections, redirect checks, bounded streaming, and no forwarded app credentials. A bounded process-memory cache reuses up to 100 post lookups for 60 seconds and is scoped to the user and current token. It does not persist media files or source URLs in the database.

Some sources are web pages, signed links, expired files, or unavailable originals. Downloads cannot recreate files Buffer does not expose. Limits: 50 MB per original or selected ZIP, 2 MB per thumbnail; source-host timeout 25 seconds; 12 original requests and 100 thumbnail requests per user per minute. The ZIP is assembled in browser memory; use individual downloads for larger campaigns. Video seeking and all provider/browser file formats are not guaranteed.

Prepare a selected platform version, edit its caption, select/download its media, copy the caption, and open the destination. Compose intents and system Share pass text only; attach files and publish yourself. Manual completion is explicitly user-reported. Opening a page, sharing text, downloading a file, or saving a task never marks it published.

## Data migration and alpha limits

In the old demo, export workspace JSON from Settings. Import it in the new app. Imports preserve existing records, reject ID overlaps, validate every record, and commit atomically against the current revision. Credentials are excluded; accounts are never linked merely by matching email. Keep the old demo until the owner verifies migration.

The alpha supports 100 records per collection and 220 KB per workspace. Archive is recoverable; account deletion remains operator-assisted. The privacy policy is local at `/privacy`. No analytics or advertising SDK is installed. Custom production SMTP, delivery testing, and a self-service password recovery/deletion flow remain hardening work before broad signup promotion.
