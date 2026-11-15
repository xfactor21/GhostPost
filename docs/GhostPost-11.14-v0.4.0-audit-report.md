# GhostPost — v0.4.0 audit and repair

Audit started November 14, 2026; completed November 15 UTC. This report describes a candidate on `fix/ghostpost-full-audit-buffer-oauth`, based on current main `b6fb8cf`. It does not describe an already deployed repair.

## Executive outcome

The reported connection-start failure has a confirmed local root cause in the deployed source: the database namespace validator rejects the digit in `oauth_pending_v2`. The handler fails before executing SQL or contacting Buffer. This is repaired, with regression coverage that executes the real SQL adapter.

The candidate preserves the latest ghost mascot, campaign cards, hot pink/violet/cyan styling, page navigation, animations, and manual workflow. It strengthens diagnostics, source/media associations, original-file handling, campaign selection, and task reliability. Source checks and automated integration checks pass. Real owner consent and production synchronization remain release acceptance steps.

**No deployment, main merge, production database mutation, credential rotation, permission change, or social post was performed during this audit.**

## Baseline and read-only production evidence

| Check | Observed result |
| --- | --- |
| Remote main | `b6fb8cf`, timestamp-grouping work; fetched again before publication |
| Production commit | `dced694f4e131201b2b443279a7db43ee41477f8` |
| Production deployment | `dpl_3DPXvzh9ZaWDu1qxSoiSvxm5uxr3`, READY, rechecked after implementation |
| Source drift | Main was five commits ahead of production; intervening work was frontend work, not an OAuth backend repair |
| Public health | HTTP 200, version 0.3.1, encryptionReady true, databaseReady true |
| Buffer status | HTTP 200, configured true, expected custom-domain callback, read-only mode |
| Neon metadata | `ghostpost.records` exists; current role has SELECT/INSERT/UPDATE/DELETE permission |
| Namespace aggregates | One connection row, one workspace row and one request-limit row; no pending OAuth v2 rows at inspection |
| Vercel configuration | Next.js, Node 24.x, custom domain attached; production deployment matches intended repository |
| Release control | `git.deploymentEnabled: false` preserved; no deployment API was called |
| Recent runtime logs | 30-minute window returned no useful OAuth failure detail; health exposed a pg sslmode compatibility warning |
| Browser reference | Public signed-out Home/History rendered v0.3.1; this was a reference check, not candidate OAuth proof |

Configuration presence does not prove valid secret values, registered redirect allowlists, Buffer app approval, or owner consent. Production namespace counts support the diagnosis but are not themselves a captured failure trace. No private captions, token values, signed source URLs, or account email are included here.

## Confirmed connection root cause

Old `backend/store.ts` validation:

```ts
/^[a-z_]{1,64}$/
```

`POST /api/buffer/start` writes PKCE/state metadata to `oauth_pending_v2`. The namespace includes `2`, so the original adapter throws `Invalid namespace.` before the SQL executor is invoked. The old secured wrapper returned a generic 503, hiding the cause.

The unchanged deployed adapter was reproduced with a query spy: updating `oauth_pending_v2` rejected with that exact error and **zero SQL calls**. Backend code at production and the audit base was otherwise unchanged. This establishes a defect sufficient to explain the observed failure before any Buffer screen opens; there is no evidence that Buffer rejected the original request.

Repair: validate namespaces with `/^[a-z][a-z0-9_]{0,63}$/`. It allows the application's versioned namespaces, keeps length and character restrictions, and continues parameterizing every SQL value. The repeatable existing migration already provides the required schema. No production migration was necessary.

### Authentication context verified, not guessed

The installed `@neon/auth` version is **0.8.2**. Its Next server implementation constructs context from Next `cookies()` and `headers()` lazily. Official API-only Next.js guidance supports `await auth.getSession()` in route handlers. `lib/auth.ts` and both Next API adapters were inspected. This supported integration was retained; service errors now produce an actionable 503, and signed-out requests produce 401.

### Connection flow traced

Connect button → same-origin JSON POST → origin/content-type/body validation → Neon session → configuration/key check → per-user cooldown → owner-scoped connection → random state and PKCE S256 → persisted pending claim → Buffer authorization URL → validated client navigation → dedicated callback route → local query cleanup → owner/browser/state/age validation → atomic single claim → code exchange → AES-GCM envelope → versioned connection persistence → connection status → account/channels/posts reads.

The browser cookie remains host-only, HttpOnly, Secure, SameSite=Lax, Path=/ with bounded expiry. State and verifier are never logged. Denial does not erase a working connection. Replayed callbacks cannot exchange twice. Single-use refresh-token safety and durable refresh locks remain intact; unknown refresh outcomes require reconnect rather than replaying a token exchange.

## Changes and systematic audit coverage

| Area / files | Findings and final behavior |
| --- | --- |
| `backend/store.ts`, migration, `.env.example` | Namespace root cause fixed; real SQL CAS/upsert/null/removal behavior tested; SQL errors safely classified; pooled pg errors handled; legacy sslmode=require/prefer/verify-ca normalized to verify-full, retaining certificate validation. Existing repeatable migration preserved. |
| `backend/platform.ts`, `backend/diagnostics.ts` | Dynamic routes accept camelCase `postId`/`assetKey`; origin/JSON/body-size protections retained; correlation ID, static route, stage, category, status and safe SQLSTATE logs; no raw exceptions, secrets, bodies, cookies, URLs or identifiers logged. API responses no-store/nosniff/no-referrer. |
| `backend/index.ts`, `backend/security.ts`, `lib/auth.ts`, API adapters | Entire OAuth, encrypted persistence, refresh locks, owner checks, workspaces, synchronization, import/export and archive paths reviewed. Preserved safe token architecture; added stage-specific actionable errors, corrupt-envelope reconnect status and media/source routes. |
| `shared/campaigns.ts`, `src/main.ts` | Extracted pure grouping; sentAt minute for published posts, dueAt for other statuses, no createdAt fallback for published grouping. contentItemId/ideaId supplement timestamps. Repeated-channel ambiguity remains separate. Deduplicated pages, stable keys/IDs, newest-first history, and selection handlers use the same filtered groups as cards. |
| `backend/media.ts`, `shared/media.ts`, `src/downloads.ts` | Documented source/thumbnail fields; stable keys even when Buffer IDs are null. Private authenticated downloads, public DNS/IP checks, DNS pinning and TLS verification, redirect revalidation, bounded byte/time limits, MIME restrictions and streaming. Available individual/selected/campaign downloads include an exact source-caption manifest. |
| `backend/index.ts` media cache | Bounded process-memory cache: max 100 source posts, 60-second reuse, user and token scoped. Every hit requires an accessible current connection. No source-cache rows or media files persisted to Postgres. Reconnecting with a different token invalidates prior hits. |
| `shared/handoff.ts`, task validation, `src/main.ts` | Caption preserved rather than silently truncated/stripped; exact host boundaries, encoded intents, corrected Reddit text/selftext parameters, long-URL manual fallback. Tasks store source post/channel/selected keys. Pending batch retries reuse tasks; existing archived destinations remain usable for historical tasks. |
| UI state / `src/main.ts` | Selected platform media/gallery, downloads, source refresh and recoverable errors. Destination edits survive source refresh. Confirm unsaved batch close; no stale Buffer gallery on a fresh draft. Private state clears on sign-out/account change/disconnect. Clipboard/popup/system-share limits are explained. Completion remains explicit and user-reported. |
| `src/client.ts`, `app/workspace.tsx` | Bounded requests, useful correlation references; chunk-load failure gives a reload message rather than an endless spinner. No automatic OAuth/write retries. |
| `src/styles.css`, layout/sign-in/privacy/pages | Existing planet.X styling and responsive/reduced-motion rules preserved; responsive galleries added. Platform controls have labels/pressed state/focus restoration; native dialogs used. Privacy text describes ephemeral media processing. Server/client boundaries, React effect and auth forms reviewed. |
| Tests / dependencies / release config | PGlite exercises actual SQL instead of merely mocking storage; DOM interactions and injected network transport cover boundary behavior. fflate loads only for ZIP creation; PGlite/linkedom are dev-only. Old unused AppDeploy test shims removed. Lockfile pinned; no deploy configuration relaxed. |

No broad framework rewrite was needed. The existing imperative UI remains; pure grouping, handoff, download and media logic now have separate modules. Full UI rerenders can still restart a video, and a component-level UI refactor is a future performance task rather than a requirement for OAuth recovery.

## Actual Buffer schema and data findings

Primary documentation confirms `sentAt` is publication time, `dueAt` is scheduled time, and `createdAt` is record creation. Post supports nullable `contentItemId`/`ideaId`; `post(input:{id})` accepts the post ID. Assets expose nullable `id`, `mimeType`, `source` and `thumbnail`.

Read-only connected Buffer tools returned the latest 30 sent records from the owner's organization. Asset IDs were often null. Some video sources were YouTube watch pages; others were CDN, S3, Instagram CDN or planet.X URLs. A web-page source cannot be honestly downloaded as an original video file. The candidate rejects unsupported pages, offers source links and refresh, and never scrapes private accounts.

The sample did **not** substantiate that all nine intended versions have identical actual publication minutes. One three-version set had the same scheduled minute but sentAt times in two different minutes. Another set did share its actual publication minute. The implementation therefore does not force three groups by substituting scheduled timestamps or fuzzy caption similarity. The synthetic nine-record test proves three exact-minute groups; it is not presented as a transformation of the owner's entire live history. Relationship fields were verified against the schema; the connected list wrapper did not return their live values. Candidate direct queries still need a real post-deployment sync.

Reliable IDs constrain accidental merges when available. Without them, coincident minutes are a heuristic; duplicate channels deliberately prevent an ambiguous merge. Missing actual publication time stays as a single record.

## Quality gates and evidence limits

Node **24.22.1**, Next.js **16.4.6** (installed lockfile), Neon Auth **0.8.2**.

| Gate | Result |
| --- | --- |
| Clean dependency install | `npm ci` passed; existing Neon Auth peer-range warning remains |
| TypeScript | `npm run typecheck` passed |
| Existing handler/security + crypto | 13 passed; one optional native Postgres test skipped without disposable DATABASE_URL |
| Real SQL OAuth lifecycle | 7 passed, using PGlite + actual production store SQL; auth/provider exchange boundaries synthetic |
| Domain + media network transport | 15 passed, including grouping, URL boundaries, namespaces, private IPs, redirect checks, DNS deadlines, MIME and streamed size limits |
| Authenticated media route integration | 5 passed; real router/SQL/encryption, synthetic GraphQL and file transport; cache, account isolation, token change, quotas, stale keys and corrupt envelopes |
| DOM interaction | 4 passed; selected caption/media, navigation/reordered refresh, ZIP manifest, edited captions, source provenance, confirmation guard, Connect URL navigation and logout cleanup |
| Total | **44 passed, 1 skipped, 0 failed** |
| Production build | `npm run build` passed, including generated auth/callback/workspace/privacy routes |
| Dependency vulnerability audit | `npm audit` and production-only audit reported zero vulnerabilities at inspection; not a guarantee against future advisories |
| Diff hygiene | `git diff --check` passed; changed code formatted with Prettier 3.7.4 |
| Lint | Not configured; no lint pass claimed |
| Real browser candidate | Blocked: localhost connection refused from cloud browser; no substitute preview deployment made |
| Real production browser | Public signed-out reference only; v0.3.1 rendered. Not a signed-in/candidate/consent test |
| Native Neon write integration | Not run; production metadata/permissions read only. PGlite is not a Neon network/TLS test |

The pre-existing SDK dependency warning is `@better-auth/oauth-provider` expecting `@better-fetch/fetch` 1.3.3 while Neon Auth 0.8.2 pins 1.3.2. It did not fail installation, typechecks, tests or build; no arbitrary SDK override was introduced. Node's test-loader experimental warning is test-only.

### OAuth acceptance A–G

| Criterion | Independently verified | Still needs owner live verification |
| --- | --- | --- |
| A — Click initiates authorization | DOM click calls correct POST then validates/navigates to Buffer URL; real SQL start persists state/verifier and returns URL | Click on deployed candidate while signed in |
| B — Buffer authorization screen | Endpoint, scopes, redirect and PKCE S256 match official docs; URL assertions pass | Actual browser reaches Buffer consent; provider values/allowlist/approval |
| C — Return to GhostPost | Callback redirect and finish success tested through real route/SQL | Real provider callback and cookie round trip |
| D — Secure connection persistence | AES-GCM envelope persisted; plaintext token absent; replay/denial/failure/reconnect tested | Real token stored successfully in Neon |
| E — Connected status | Real SQL route returns connected on good envelope and reconnect on corrupt envelope | Reload deployed workspace and observe connected status |
| F — Channels/posts synchronization | Existing handler fixtures validate read scopes, owner organization and response rendering; separate connected Buffer read succeeds | Candidate OAuth token performs live channels/queue/history and new media fields |
| G — Useful failure diagnostics | DB down/schema/permission/config/key/session/state/exchange failures produce safe correlated responses/logs | Observe actual Vercel request references if any live failure occurs |

## Security findings

- **Confirmed availability defect:** namespace rejection blocked OAuth before SQL; repaired and SQL regression-tested.
- **Confirmed observability defect:** generic error handling hid the stage; sanitized, allowlisted request diagnostics added without leaking OAuth values.
- **Confirmed reliability defects:** mismatched filtered campaign selection, fragile/null media identifiers, lost task-source references, silent caption adaptation and stale draft galleries are repaired.
- **New media attack surface:** protected against server-side request forgery via HTTPS-only destinations, no credentials/default ports, public-address policy, all-address DNS checks, pinned lookup, per-redirect validation, no app-token forwarding, bounded fetch/streaming, rate limits, MIME checks and authenticated owner source resolution. Clients cannot submit arbitrary download URLs.
- **Preserved protections:** owner-scoped reads/writes and optimistic revisions; parameterized SQL; escaped rendered text; secure cookies/state/PKCE; encrypted server-only tokens; no exported credentials; no automated publishing or completion.
- Certificate validation remains enabled. No external account scopes, credentials, domains, firewall policy or auth permissions were changed.

## Remaining limits and owner actions

1. **Release blocker for claiming live recovery:** owner must deploy the reviewed branch manually, then complete a genuine Buffer consent and sync. No claim of live A–G completion is made.
2. **Candidate browser QA:** desktop/mobile visual layout, keyboard focus/dialog behavior, real video playback, clipboard, popup handling, ZIP downloads and OS sharing need a real browser pass. DOM simulation does not assess contrast/rendering or platform sharing.
3. **Provider limits:** Buffer controls app approval, consent, redirect allowlists, API permissions, retention and file availability. Documented media retention is finite; old/signed/third-party originals may be unavailable. No alternative private scraping is attempted.
4. **Media limits:** 50 MB per original/ZIP, 2 MB per thumbnail, 25-second host deadline, three redirects; 12 original and 100 thumbnail requests per user/minute. Large or unsupported sources open externally. Video seeking/range support is not promised. Streaming failures after headers can interrupt a download instead of returning JSON; the UI lets the user retry/open source.
5. **Organization/timestamp ambiguity:** verify intended campaign grouping against actual source records after live sync. Reliable relationship IDs help when returned; coincident minutes cannot prove a campaign by themselves.
6. **Alpha operations:** 100 records per collection, 220 KB workspace; self-service password recovery/deletion, custom email delivery and broader signup testing remain follow-up work. No settings were changed speculatively.
7. **Performance:** ZIP assembly consumes browser memory within the 50 MB selection cap; thumbnails re-render with the existing UI. Each function instance has its own bounded cache. No new infrastructure or paid dependency was provisioned.

## GitHub delivery

Working branch: `fix/ghostpost-full-audit-buffer-oauth`.

- `a8c4d5b370efc662ee8ffc1dff5c0e968428cf7e` — Fix versioned OAuth namespaces in the Postgres adapter.
- `07524a846871d22cad2296f06df47ff7ad06d7e8` — Preserve campaign media through secure manual cross-post workflows, with SQL/media/DOM regressions.
- A separate documentation commit contains this audit and refreshed setup/release instructions.

The PR targets main for review only. No main merge or Vercel deployment is authorized by this audit delivery.

## Manual deployment checklist

The candidate is **ready for owner review and a controlled manual deployment**, with the live/browser checks above still pending. It is not certified as fully production-verified.

1. Review the PR and this report. Merge only with explicit owner authorization. Preserve Git deployment disabling; no automatic release is needed.
2. Confirm existing Production values are targeted to the GhostPost project: DATABASE_URL, Neon Auth URL/cookie secret, APP_ORIGIN, BUFFER_REDIRECT_URI, BUFFER_CLIENT_ID/SECRET and the existing encryption key. Do not replace the key. Expected origin is `https://ghostpost.planet-x.co` and callback is `/api/auth/buffer/callback`.
3. Confirm that exact callback is approved in the existing Buffer application. Production schema already exists; do not reset or reapply destructive SQL. New namespaces use the existing table without a new migration.
4. Manually deploy the reviewed release commit to the existing Vercel project. No new project/database is required. Verify health/UI reports 0.4.0 and deployment commit matches the reviewed release.
5. Sign in, choose **Settings → Connect Buffer**, reach the genuine Buffer consent screen, and approve only the existing read scopes. Return to GhostPost and confirm no lingering code/state in the address bar.
6. Confirm connected status, reload the page, then refresh channels, scheduled queue and history. Check the intended organization and actual publication-minute grouping. Test tabs/previous/next, filters, refresh and load more without losing source associations.
7. Try an image, a video/poster and a multi-attachment post: download selected files and campaign ZIP; verify the caption/media manifest. Test expired/unavailable source recovery and a web-page source with honest fallback.
8. Prepare/edit a manual destination, copy caption, attach files yourself, open the composer, and verify it remains pending until you explicitly confirm publication. Do not publish a test post unless you choose to.
9. Verify signed-out/expired-session behavior and use a second test account for isolation. Check keyboard/mobile layouts and system Share in supported browsers.
10. If a check fails, preserve drafts/tasks, capture only the displayed request reference and safe Vercel event, and fix on the branch. For rollback, redeploy the previous reviewed deployment; no incompatible schema change was introduced.

## Primary references consulted

- Neon Auth API-only Next.js quickstart: https://neon.com/docs/auth/quick-start/nextjs-api-only and installed 0.8.2 source.
- Buffer OAuth/PKCE/scopes/rotation: https://developers.buffer.com/guides/authentication.html
- Buffer schema and post timestamps/relationship inputs: https://developers.buffer.com/reference.html
- Buffer assets: https://developers.buffer.com/types/Asset.html
- Buffer media hosting/retention: https://developers.buffer.com/guides/hosting-media
- Bluesky intent documentation redirected from docs.bsky.app to https://bsky.network/docs/intent-links/ ; https://github.com/bluesky-social/social-app/issues/6933 also confirms the official implementation's compose route, with platform limitations.
- X's current publisher generates `intent/tweet` links: https://publish.x.com/ . Its old Web Intent documentation URL now redirects to the general overview; actual signed-in prefill remains a browser verification item.
- Reddit's own archived controller confirms separate `text` and `selftext` form parameters: https://github.com/reddit-archive/reddit/blob/master/r2/r2/controllers/front.py . Modern Reddit UI prefill remains best effort; Copy caption always remains available.
