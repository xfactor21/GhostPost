import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "../backend/index.ts";
import {
  hash,
  nonce,
  encrypt,
  decrypt,
  parseKey,
  needsRefresh,
  safeUrl,
} from "../backend/security.ts";
import { tables, db, secretValues } from "./store-fixture.mjs";
const A = "synthetic-user-A",
  B = "synthetic-user-B",
  key = parseKey(secretValues.GHOSTPOST_TOKEN_ENCRYPTION_KEY);
import { session } from "./auth-fixture.mjs";
Object.assign(process.env, secretValues, {
  APP_ORIGIN: "https://ghostpost.planet-x.co",
});
const call = async (method, path, body, who = A, extra = {}) => {
  const url = new URL(path, "https://ghostpost.planet-x.co");
  for (const [key, value] of Object.entries(extra.queryStringParameters || {}))
    url.searchParams.set(key, value);
  const headers = {
    origin: "https://ghostpost.planet-x.co",
    ...(body ? { "Content-Type": "application/json" } : {}),
    ...extra.headers,
  };
  const result = await session.run(who, () =>
    handler(
      new Request(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }),
    ),
  );
  return {
    status: result.status,
    data: result.headers.get("Content-Type")?.includes("application/json")
      ? await result.json()
      : await result.text(),
    headers: Object.fromEntries(
      [...result.headers].map(([k, v]) => [
        k === "set-cookie" ? "Set-Cookie" : k === "location" ? "Location" : k,
        v,
      ]),
    ),
  };
};
const clearLimits = () => tables.delete("request_limits");
async function seed(expiresAt = Date.now() + 3600000) {
  clearLimits();
  await db.tx.update("buffer_connections", [
    {
      id: hash(A),
      record: {
        ownerId: A,
        version: nonce(),
        connectedAt: Date.now(),
        expiresAt,
        ...encrypt(
          {
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
            expires_in: 3600,
          },
          key,
        ),
      },
    },
  ]);
}
let refreshes = 0,
  apiFailure = 0,
  refreshFailure = false,
  gate = null,
  release;
globalThis.fetch = async (target, options) => {
  if (target === "https://auth.buffer.com/token") {
    if (options.body.get("grant_type") === "refresh_token") {
      refreshes++;
      if (gate) await gate;
      if (refreshFailure) throw new Error("synthetic timeout");
    }
    return new Response(
      JSON.stringify({
        access_token: "synthetic-new-access",
        refresh_token: "synthetic-new-refresh",
        expires_in: 3600,
      }),
      { status: 200 },
    );
  }
  assert.equal(target, "https://api.buffer.com");
  if (apiFailure) return new Response("{}", { status: apiFailure });
  const { query } = JSON.parse(options.body);
  assert.equal(query.includes("mutation"), false);
  const data = query.includes("GhostPostAccount")
    ? {
        account: {
          id: "test-account",
          organizations: [{ id: "org-one", name: "Synthetic org" }],
        },
      }
    : query.includes("GhostPostChannels")
      ? {
          channels: [
            {
              id: "channel-one",
              name: "Synthetic LinkedIn",
              service: "linkedin",
              avatar: "https://example.test/avatar.png",
              isDisconnected: false,
              isLocked: false,
              isQueuePaused: false,
              allowedActions: ["scheduleUpdates"],
              timezone: "America/Chicago",
            },
          ],
        }
      : {
          posts: {
            edges: [
              {
                node: {
                  id: query.includes("[sent, error]")
                    ? "history-post"
                    : "queue-post",
                  text: "Synthetic Buffer content",
                  channelId: "channel-one",
                  status: query.includes("[sent, error]")
                    ? "sent"
                    : "scheduled",
                  dueAt: new Date().toISOString(),
                  createdAt: new Date().toISOString(),
                  assets: [{ id: "asset-one", mimeType: "image/png" }],
                },
              },
            ],
            pageInfo: {
              hasNextPage: !query.includes("cursor-two"),
              endCursor: "cursor-two",
            },
          },
        };
  return new Response(JSON.stringify({ data }), { status: 200 });
};
test("AES-GCM roundtrip, IV uniqueness, tamper rejection, expiration and URL guards", () => {
  const one = encrypt({ access_token: "synthetic" }, key),
    two = encrypt({ access_token: "synthetic" }, key);
  assert.notEqual(one.iv, two.iv);
  assert.equal(decrypt(one, key).access_token, "synthetic");
  assert.throws(() =>
    decrypt({ ...one, tag: Buffer.alloc(16).toString("base64") }, key),
  );
  assert.throws(() => parseKey("bad"));
  assert.equal(needsRefresh(Date.now() + 3600000), false);
  assert.equal(needsRefresh(Date.now() + 1000), true);
  for (const u of [
    "javascript:alert(1)",
    "http://example.test",
    "https://user:password@example.test",
  ])
    assert.throws(() => safeUrl(u));
});
test("all protected endpoint families reject anonymous requests; health checks only expose derived status", async () => {
  for (const [method, path, body] of [
    ["GET", "/api/buffer/me"],
    ["POST", "/api/buffer/start", {}],
    ["POST", "/api/buffer/finish", {}],
    ["POST", "/api/buffer/sync", {}],
    ["POST", "/api/buffer/disconnect", {}],
    ["GET", "/api/workspace"],
    ["PUT", "/api/workspace/drafts/test", {}],
    ["DELETE", "/api/workspace/drafts/test", {}],
  ])
    assert.equal((await call(method, path, body, null)).status, 401);
  assert.equal(
    (await call("GET", "/api/_healthcheck", undefined, null)).data
      .encryptionReady,
    true,
  );
  assert.equal(
    (await call("GET", "/api/buffer/status", undefined, null)).data.mode,
    "read-only",
  );
});
test("workspace CRUD is durable, validates URLs, rejects stale writes and isolates users", async () => {
  tables.delete("workspaces");
  assert.equal((await call("GET", "/api/workspace")).data.revision, 0);
  let r = await call("PUT", "/api/workspace/drafts/test", {
    revision: 0,
    title: "Test draft",
    text: "Synthetic content",
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await call("GET", "/api/workspace", undefined, B)).data.drafts.length,
    0,
  );
  assert.equal(
    (
      await call("PUT", "/api/workspace/drafts/test", {
        revision: 0,
        title: "Stale",
        text: "Stale",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("PUT", "/api/workspace/destinations/bad", {
        revision: 1,
        name: "Bad",
        platform: "Other",
        url: "javascript:alert(1)",
      })
    ).status,
    400,
  );
  r = await call("PUT", "/api/workspace/destinations/dest", {
    revision: 1,
    name: "Synthetic destination",
    platform: "Reddit",
    url: "https://example.test/community",
  });
  assert.equal(r.status, 200);
  r = await call("PUT", "/api/workspace/tasks/task", {
    revision: 2,
    destinationId: "dest",
    destinationName: "Synthetic destination",
    destinationUrl: "https://example.test/community",
    text: "Caption",
  });
  assert.equal(r.status, 200);
  r = await call("PUT", "/api/workspace/tasks/task", {
    ...r.data.tasks[0],
    revision: 3,
    state: "complete",
  });
  assert.equal(r.data.tasks[0].verification, "user-reported");
  assert.ok(r.data.tasks[0].completedAt);
  r = await call("DELETE", "/api/workspace/drafts/test", { revision: 4 });
  assert.equal(r.data.drafts[0].archived, true);
  r = await call("PUT", "/api/workspace/drafts/test", {
    ...r.data.drafts[0],
    archived: false,
    revision: 5,
  });
  assert.equal(r.data.drafts[0].archived, false);
  assert.equal((await call("GET", "/api/workspace")).data.revision, 6);
  assert.equal(
    (await call("DELETE", "/api/workspace/drafts/test", { revision: 0 }, B))
      .status,
    404,
  );
});
test("OAuth binds browser/user, claims once, preserves exact callback and encrypts credentials", async () => {
  clearLimits();
  const start = await call("POST", "/api/buffer/start", {});
  assert.equal(start.status, 200);
  const target = new URL(start.data.authorizationUrl),
    state = target.searchParams.get("state");
  assert.equal(
    target.searchParams.get("redirect_uri"),
    "https://ghostpost.planet-x.co/api/auth/buffer/callback",
  );
  assert.equal(
    target.searchParams.get("scope"),
    "posts:read account:read offline_access",
  );
  assert.match(start.headers["Set-Cookie"], /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(
    (await call("POST", "/api/buffer/finish", { state, code: "test" })).status,
    403,
  );
  assert.equal(
    (
      await call("POST", "/api/buffer/finish", { state, code: "test" }, B, {
        headers: { authorization: B, cookie: "gp_oauth=" + state },
      })
    ).status,
    403,
  );
  const extra = { headers: { authorization: A, cookie: "gp_oauth=" + state } };
  const results = await Promise.all([
    call("POST", "/api/buffer/finish", { state, code: "test" }, A, extra),
    call("POST", "/api/buffer/finish", { state, code: "test" }, A, extra),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
  const [record] = await db.get("buffer_connections", [hash(A)]);
  assert.equal(record.access_token, undefined);
  assert.equal(decrypt(record, key).access_token, "synthetic-new-access");
  const me = await call("GET", "/api/buffer/me");
  assert.equal(me.data.connected, true);
  assert.equal(JSON.stringify(me.data).includes("synthetic-new-access"), false);
  const redirect = await call(
    "GET",
    "/api/auth/buffer/callback",
    undefined,
    null,
    { queryStringParameters: { state: "invalid", code: "test" } },
  );
  assert.match(redirect.headers.Location, /gp_buffer=1/);
  assert.match(redirect.headers.Location, /gp_state=invalid/);
});
test("expired OAuth state and disconnect during authorization cannot link credentials", async () => {
  clearLimits();
  let start = await call("POST", "/api/buffer/start", {});
  let state = new URL(start.data.authorizationUrl).searchParams.get("state");
  const [pending] = await db.get("oauth_pending_v2", [hash(A)]);
  await db.tx.update("oauth_pending_v2", [
    { id: hash(A), record: { ...pending, createdAt: Date.now() - 700000 } },
  ]);
  assert.equal(
    (
      await call("POST", "/api/buffer/finish", { state, code: "test" }, A, {
        headers: { authorization: A, cookie: "gp_oauth=" + state },
      })
    ).status,
    403,
  );
  clearLimits();
  start = await call("POST", "/api/buffer/start", {});
  state = new URL(start.data.authorizationUrl).searchParams.get("state");
  await call("POST", "/api/buffer/disconnect", {});
  assert.equal(
    (
      await call("POST", "/api/buffer/finish", { state, code: "test" }, A, {
        headers: { authorization: A, cookie: "gp_oauth=" + state },
      })
    ).status,
    409,
  );
});
test("Buffer read service normalizes channels, paginates posts, validates org ownership and handles upstream errors", async () => {
  await seed();
  let r = await call("POST", "/api/buffer/sync", { mode: "channels" });
  assert.equal(r.status, 200);
  assert.equal(r.data.channels[0].canScheduleInBuffer, true);
  r = await call("POST", "/api/buffer/sync", { mode: "queue" });
  assert.equal(r.data.posts[0].id, "queue-post");
  assert.equal(r.data.pageInfo.hasNextPage, true);
  clearLimits();
  r = await call("POST", "/api/buffer/sync", {
    mode: "queue",
    after: "cursor-two",
  });
  assert.equal(r.data.pageInfo.hasNextPage, false);
  r = await call("POST", "/api/buffer/sync", { mode: "history" });
  assert.equal(r.data.posts[0].status, "sent");
  clearLimits();
  assert.equal(
    (
      await call("POST", "/api/buffer/sync", {
        mode: "channels",
        organizationId: "foreign",
      })
    ).status,
    403,
  );
  for (const status of [429, 401, 500]) {
    apiFailure = status;
    clearLimits();
    assert.equal(
      (await call("POST", "/api/buffer/sync", { mode: "channels" })).status,
      status === 500 ? 502 : status,
    );
  }
  apiFailure = 0;
  clearLimits();
  assert.equal(
    (await call("POST", "/api/buffer/sync", { mode: "channels" })).status,
    200,
  );
});
test("concurrent token refresh makes exactly one exchange and stores rotated tokens", async () => {
  await seed(Date.now() - 1000);
  refreshes = 0;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = call("POST", "/api/buffer/sync", { mode: "channels" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await call("POST", "/api/buffer/sync", { mode: "queue" })).status,
    409,
  );
  release();
  gate = null;
  assert.equal((await first).status, 200);
  assert.equal(refreshes, 1);
  const [record] = await db.get("buffer_connections", [hash(A)]);
  assert.equal(decrypt(record, key).refresh_token, "synthetic-new-refresh");
  assert.equal(record.refreshId, undefined);
});
test("unknown refresh outcome is never replayed and disconnect removes all credential material", async () => {
  await seed(Date.now() - 1000);
  refreshes = 0;
  refreshFailure = true;
  assert.equal(
    (await call("POST", "/api/buffer/sync", { mode: "channels" })).status,
    401,
  );
  clearLimits();
  assert.equal(
    (await call("POST", "/api/buffer/sync", { mode: "channels" })).status,
    401,
  );
  assert.equal(refreshes, 1);
  await call("POST", "/api/buffer/disconnect", {});
  const [record] = await db.get("buffer_connections", [hash(A)]);
  for (const field of ["ciphertext", "iv", "tag", "refreshId", "expiresAt"])
    assert.equal(record[field], undefined);
  assert.equal((await call("GET", "/api/buffer/me")).data.connected, false);
  refreshFailure = false;
});

test("sync failures are saved as safe diagnostics and success clears them", async () => {
  await seed();
  apiFailure = 429;
  assert.equal(
    (await call("POST", "/api/buffer/sync", { mode: "channels" })).status,
    429,
  );
  let me = await call("GET", "/api/buffer/me");
  assert.match(me.data.lastError.message, /rate limit/);
  assert.equal(JSON.stringify(me.data).includes("synthetic-access"), false);
  apiFailure = 0;
  clearLimits();
  await call("POST", "/api/buffer/sync", { mode: "channels" });
  me = await call("GET", "/api/buffer/me");
  assert.equal(me.data.lastError, null);
  assert.ok(me.data.sync.syncedAt);
});

test("native cookie routes reject missing and cross-site origins", async () => {
  for (const origin of [undefined, "https://attacker.test"]) {
    const r = await session.run(A, () =>
      handler(
        new Request("https://ghostpost.planet-x.co/api/workspace/import", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(origin ? { origin } : {}),
          },
          body: "{}",
        }),
      ),
    );
    assert.equal(r.status, 403);
  }
});
test("workspace import is atomic, owner-scoped and refuses overlapping records", async () => {
  tables.delete("workspaces");
  const source = {
    drafts: [{ id: "imported", title: "Imported", text: "Safe" }],
    destinations: [],
    tasks: [],
    ownerId: B,
  };
  let result = await call("POST", "/api/workspace/import", {
    revision: 0,
    workspace: source,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.workspace.ownerId, A);
  assert.equal(
    (await call("GET", "/api/workspace", undefined, B)).data.drafts.length,
    0,
  );
  result = await call("POST", "/api/workspace/import", {
    revision: 1,
    workspace: source,
  });
  assert.equal(result.status, 409);
  assert.equal((await call("GET", "/api/workspace")).data.revision, 1);
  result = await call("POST", "/api/workspace/import", {
    revision: 1,
    workspace: {
      ...source,
      drafts: [{ id: "bad", title: "A", text: "B" }],
      tasks: [
        {
          id: "dangling",
          destinationId: "missing",
          destinationName: "A",
          destinationUrl: "https://example.test",
          text: "B",
        },
      ],
    },
  });
  assert.equal(result.status, 400);
  assert.equal((await call("GET", "/api/workspace")).data.drafts.length, 1);
});

test("missing Buffer configuration gives a useful error without starting OAuth", async () => {
  const previous = process.env.BUFFER_CLIENT_SECRET;
  delete process.env.BUFFER_CLIENT_SECRET;
  try {
    const before = tables.get("oauth_pending_v2")?.size || 0;
    const status = await call("GET", "/api/buffer/status");
    assert.equal(status.data.configured, false);
    const result = await call("POST", "/api/buffer/start", {});
    assert.equal(result.status, 503);
    assert.match(result.data.error, /Open Settings/);
    assert.equal(tables.get("oauth_pending_v2")?.size || 0, before);
  } finally {
    if (previous !== undefined) process.env.BUFFER_CLIENT_SECRET = previous;
  }
});
