# GhostPost by planet.X

Private publishing workspace and read-only Buffer companion. v0.3.0 migrates the alpha to GitHub, Vercel Functions, Neon Postgres, and Managed Neon Auth. No AppDeploy runtime, SDK, database, authentication, or policy hosting is used.

## Run

Use Node 24, `npm ci`, and copy `.env.example` to `.env.local`. Add the server values from the project's secret manager; never commit them. Apply `migrations/001_records.sql` once to the dedicated database, then `npm run dev`. `npm run build` validates the production build. `npm test` runs the handler suite with synthetic authentication, storage and Buffer responses. `node --env-file=.env.local --import tsx --test tests/store.test.ts` also runs the real Postgres rollback test when the database is reachable.

## Infrastructure

- Repository: https://github.com/xfactor21/GhostPost
- Vercel project: `ghostpost` (planetX team)
- Domain: https://ghostpost.planet-x.co
- Neon project: `divine-fog-17162968`, dedicated `ghostpost` database, production branch `br-fancy-paper-bbcanryr`
- Authentication: same-origin `/api/auth` proxy to Managed Neon Auth. Google and email sign-in. Accounts and sessions are separate from the earlier demo.
- Storage: parameterized Postgres queries against `ghostpost.records`, owner-scoped server routes, optimistic revisions and atomic compare-and-swap locks. No secrets in browser storage or exports.
- Deployment: Git auto-deployments disabled in `vercel.json`. Deploy explicitly after review; use `[DEPLOY]` in an authorized release commit. Preview environments intentionally have no production database or authentication secrets.

## Finish cutover

1. At Spaceship DNS for `planet-x.co`, add CNAME `ghostpost` → `f18e7ce390001cd2.vercel-dns-017.com` (the existing authoritative nameservers stay unchanged). Verify DNS and TLS in Vercel.
2. In the existing Buffer developer application's approved redirect URLs, add `https://ghostpost.planet-x.co/api/auth/buffer/callback`. Retain the demo callback until migration is verified. Set `BUFFER_CLIENT_ID` and `BUFFER_CLIENT_SECRET` as sensitive Production environment variables in Vercel, then explicitly redeploy. Never paste secrets into an issue, commit, or chat.
3. Sign in to the new app, reconnect Buffer, and verify channels, queue and history. Third-party app review and OAuth availability are controlled by Buffer.
4. In the old demo, Settings → Export workspace JSON. In the new app, Settings → Import workspace JSON. Imports validate every record, preserve current records, reject ID overlaps, and commit atomically against the current revision. Credentials are excluded. An import never associates accounts by email.
5. Verify record counts, draft reload, manual tasks and Buffer activity. Keep the earlier demo live until the owner confirms the cutover. No legacy data or credentials were automatically transferred or deleted.

## Scope

Buffer reads require `posts:read account:read offline_access`. The app does not publish posts through the API. Manual completion is explicitly user-reported. New users sign into their own isolated workspaces. Archive preserves records for recovery; account deletion remains an operator-assisted action. The alpha supports 100 records per collection and 220 KB per workspace.

The privacy policy is served locally at `/privacy`. No analytics or advertising SDK is installed. The current Neon configuration uses shared authentication email delivery; custom production SMTP and delivery validation remain a production-hardening task before broad signup promotion.
