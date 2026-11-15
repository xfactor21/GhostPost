import { test, after } from "node:test";
import assert from "node:assert/strict";
import { handler } from "../backend/index.ts";
import { postgres, db, faults } from "./sql-store-fixture.mjs";
import { session } from "./auth-fixture.mjs";
import { decrypt, hash, parseKey } from "../backend/security.ts";
const origin = "https://ghostpost.planet-x.co";
Object.assign(process.env, {
  APP_ORIGIN: origin,
  BUFFER_CLIENT_ID: "test-client",
  BUFFER_CLIENT_SECRET: "test-secret",
  GHOSTPOST_TOKEN_ENCRYPTION_KEY: "1".repeat(64),
});
let exchangeFailure = false,
  tokenRequests = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(url, "https://auth.buffer.com/token");
  tokenRequests++;
  assert.equal(options.body.get("code_verifier")?.length, 43);
  assert.equal(options.body.get("client_secret"), "test-secret");
  return exchangeFailure
    ? new Response("{}", { status: 400 })
    : Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_in: 3600,
      });
};
after(async () => {
  globalThis.fetch = nativeFetch;
  await postgres.close();
});
async function call(method, path, body, user = "sql-user", cookie = "") {
  const response = await session.run(user, () =>
    handler(
      new Request(origin + path, {
        method,
        headers: { origin, "Content-Type": "application/json", cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    ),
  );
  return {
    status: response.status,
    headers: response.headers,
    data: response.headers.get("content-type")?.includes("json")
      ? await response.json()
      : null,
  };
}
async function begin(user = "sql-user") {
  await postgres.query(
    "DELETE FROM ghostpost.records WHERE namespace='request_limits'",
  );
  const start = await call("POST", "/api/buffer/start", {}, user);
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const url = new URL(start.data.authorizationUrl);
  return {
    start,
    url,
    state: url.searchParams.get("state"),
    cookie: start.headers.get("set-cookie").split(";")[0],
  };
}
test("real SQL adapter accepts the versioned OAuth namespace and stores PKCE before redirect", async () => {
  const { start, url, state } = await begin();
  assert.equal(url.origin, "https://auth.buffer.com");
  assert.equal(url.pathname, "/auth");
  assert.equal(
    url.searchParams.get("scope"),
    "posts:read account:read offline_access",
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(state.length, 43);
  assert.match(
    start.headers.get("set-cookie"),
    /HttpOnly; Secure; SameSite=Lax/,
  );
  const [pending] = await db.get("oauth_pending_v2", [hash("sql-user")]);
  assert.equal(pending.userId, "sql-user");
  assert.equal(pending.used, false);
  assert.equal(pending.verifier.length, 43);
  assert.notEqual(pending.stateHash, state);
});
test("real SQL lifecycle: callback, one claim, encrypted persistence, reconnect", async () => {
  const flow = await begin();
  const callback = await call(
    "GET",
    "/api/auth/buffer/callback?state=" + flow.state + "&code=synthetic-code",
  );
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get("location"), /gp_buffer=1/);
  let result = await call(
    "POST",
    "/api/buffer/finish",
    { state: flow.state, code: "synthetic-code" },
    "sql-user",
    flow.cookie,
  );
  assert.equal(result.status, 200);
  assert.match(result.headers.get("set-cookie"), /Max-Age=0/);
  const [stored] = await db.get("buffer_connections", [hash("sql-user")]);
  assert.equal(
    decrypt(stored, parseKey(process.env.GHOSTPOST_TOKEN_ENCRYPTION_KEY))
      .access_token,
    "synthetic-access",
  );
  assert.equal(stored.access_token, undefined);
  assert.equal(JSON.stringify(stored).includes("synthetic-access"), false);
  assert.equal((await call("GET", "/api/buffer/me")).data.connected, true);
  const before = tokenRequests;
  assert.equal(
    (
      await call(
        "POST",
        "/api/buffer/finish",
        { state: flow.state, code: "synthetic-code" },
        "sql-user",
        flow.cookie,
      )
    ).status,
    403,
  );
  assert.equal(tokenRequests, before);
  const next = await begin();
  assert.equal(
    (
      await call(
        "POST",
        "/api/buffer/finish",
        { state: next.state, code: "synthetic-code" },
        "sql-user",
        next.cookie,
      )
    ).status,
    200,
  );
});
test("SQL lifecycle rejects expired state, wrong browser, wrong owner and expired session", async () => {
  const flow = await begin();
  assert.equal(
    (
      await call("POST", "/api/buffer/finish", {
        state: flow.state,
        code: "synthetic-code",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/buffer/finish",
        { state: flow.state, code: "synthetic-code" },
        "other-user",
        flow.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/buffer/finish",
        { state: flow.state, code: "synthetic-code" },
        null,
        flow.cookie,
      )
    ).status,
    401,
  );
  await db.tx.update(
    "oauth_pending_v2",
    [{ id: hash("sql-user"), record: { createdAt: Date.now() - 600001 } }],
    { patch: true },
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/buffer/finish",
        { state: flow.state, code: "synthetic-code" },
        "sql-user",
        flow.cookie,
      )
    ).status,
    403,
  );
});
test("SQL lifecycle: denial preserves connection; token failure never marks connected", async () => {
  let flow = await begin();
  const before = tokenRequests;
  const denied = await call(
    "POST",
    "/api/buffer/finish",
    { state: flow.state, error: "access_denied" },
    "sql-user",
    flow.cookie,
  );
  assert.equal(denied.status, 400);
  assert.equal(tokenRequests, before);
  assert.equal((await call("GET", "/api/buffer/me")).data.connected, true);
  flow = await begin("unconnected-user");
  exchangeFailure = true;
  try {
    assert.equal(
      (
        await call(
          "POST",
          "/api/buffer/finish",
          { state: flow.state, code: "synthetic-code" },
          "unconnected-user",
          flow.cookie,
        )
      ).status,
      502,
    );
    assert.equal(
      (await call("GET", "/api/buffer/me", undefined, "unconnected-user")).data
        .connected,
      false,
    );
  } finally {
    exchangeFailure = false;
  }
});
test("concurrent authorization starts have one winner with the real SQL conditional write", async () => {
  await postgres.query(
    "DELETE FROM ghostpost.records WHERE namespace='request_limits'",
  );
  const results = await Promise.all([
    call("POST", "/api/buffer/start", {}, "concurrent-user"),
    call("POST", "/api/buffer/start", {}, "concurrent-user"),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
});
test("database down, missing schema, invalid key and missing config are actionable and sanitized", async () => {
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    for (const [code, expected] of [
      ["ECONNREFUSED", "STORAGE_UNAVAILABLE"],
      ["42P01", "STORAGE_SCHEMA_MISSING"],
      ["42501", "STORAGE_PERMISSION_DENIED"],
    ]) {
      faults.code = code;
      const r = await call("POST", "/api/buffer/start", {});
      assert.equal(r.status, 503);
      assert.equal(r.data.code, expected);
      assert.ok(r.data.requestId);
      assert.equal(r.headers.get("x-request-id"), r.data.requestId);
    }
    faults.code = null;
    const key = process.env.GHOSTPOST_TOKEN_ENCRYPTION_KEY;
    process.env.GHOSTPOST_TOKEN_ENCRYPTION_KEY = "bad-key";
    assert.equal(
      (await call("POST", "/api/buffer/start", {})).data.code,
      "ENCRYPTION_CONFIGURATION",
    );
    process.env.GHOSTPOST_TOKEN_ENCRYPTION_KEY = key;
    const secret = process.env.BUFFER_CLIENT_SECRET;
    delete process.env.BUFFER_CLIENT_SECRET;
    assert.equal((await call("POST", "/api/buffer/start", {})).status, 503);
    process.env.BUFFER_CLIENT_SECRET = secret;
    assert.equal(
      (await call("POST", "/api/buffer/start", {}, null)).status,
      401,
    );
    for (const line of logs) {
      const log = JSON.parse(line);
      assert.ok(log.requestId);
      assert.ok(log.stage);
      assert.ok(log.endpoint);
      assert.equal(line.includes("synthetic private"), false);
      assert.equal(line.includes("test-secret"), false);
    }
  } finally {
    faults.code = null;
    console.error = original;
  }
});
test("repeatable schema, conditional patch/remove and atomic quotas use real PostgreSQL semantics", async () => {
  const { readFile } = await import("node:fs/promises");
  const migration = await readFile(
    new URL("../migrations/001_records.sql", import.meta.url),
    "utf8",
  );
  const before = (
    await postgres.query("SELECT count(*) FROM ghostpost.records")
  ).rows[0].count;
  await postgres.exec(migration);
  assert.equal(
    (await postgres.query("SELECT count(*) FROM ghostpost.records")).rows[0]
      .count,
    before,
  );
  await db.tx.add("probe", [
    { id: "data", owner: "alice", version: 0, nullable: null, remove: "old" },
  ]);
  assert.deepEqual(
    await db.tx.update(
      "probe",
      [{ id: "data", record: { version: 1 }, if: { owner: "bob" } }],
      { patch: true },
    ),
    [false],
  );
  assert.deepEqual(
    await db.tx.update(
      "probe",
      [
        {
          id: "data",
          record: { remove: undefined, version: 1 },
          if: { nullable: null, missing: undefined },
        },
      ],
      { patch: true },
    ),
    [true],
  );
  const [value] = await db.get("probe", ["data"]);
  assert.equal(Object.hasOwn(value, "remove"), false);
  const claims = await Promise.all(
    Array.from({ length: 20 }, () =>
      db.tx.consume("media_limits", "quota", 1, 4),
    ),
  );
  assert.equal(claims.filter(Boolean).length, 4);
  assert.equal(await db.tx.consume("media_limits", "quota", 2, 4), true);
});
