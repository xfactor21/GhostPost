import { test, after } from "node:test";
import assert from "node:assert/strict";
import { handler } from "../backend/index.ts";
import { postgres, db } from "./sql-store-fixture.mjs";
import { session } from "./auth-fixture.mjs";
import { encrypt, hash, parseKey } from "../backend/security.ts";
import { downloads } from "./media-fixture.mjs";
const origin = "https://ghostpost.planet-x.co",
  key = "1".repeat(64);
Object.assign(process.env, {
  APP_ORIGIN: origin,
  GHOSTPOST_TOKEN_ENCRYPTION_KEY: key,
});
await db.tx.add("buffer_connections", [
  {
    id: hash("media-owner"),
    ownerId: "media-owner",
    version: "version",
    expiresAt: Date.now() + 3600000,
    ...encrypt({ access_token: "synthetic-media-token" }, parseKey(key)),
  },
]);
let reads = 0,
  expectedToken = "synthetic-media-token";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(url, "https://api.buffer.com");
  assert.equal(options.headers.Authorization, "Bearer " + expectedToken);
  const { query } = JSON.parse(options.body);
  assert.match(query, /post\(input:\{id:"post"\}\)/);
  assert.match(query, /assets \{ id mimeType source thumbnail \}/);
  reads++;
  return Response.json({
    data: {
      post: {
        id: "post",
        channelId: "channel",
        text: "Exact source caption",
        status: "sent",
        createdAt: "2026-11-14T12:00:00Z",
        sentAt: "2026-11-14T12:00:10Z",
        assets: [
          {
            id: null,
            mimeType: "image/png",
            source: "https://cdn.example.org/original.png?signature=private",
            thumbnail: "https://cdn.example.org/thumb.png",
          },
        ],
      },
    },
  });
};
after(async () => {
  globalThis.fetch = nativeFetch;
  await postgres.close();
});
const call = (method, path, body, user = "media-owner") =>
  session.run(user, () =>
    handler(
      new Request(origin + path, {
        method,
        headers: { origin, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    ),
  );
let assetKey = "";
test("private source refresh uses installed router and SQL; media streams with safe headers and per-owner cache", async () => {
  const response = await call("POST", "/api/buffer/post", { postId: "post" });
  assert.equal(response.status, 200);
  const { post } = await response.json();
  assetKey = post.assets[0].key;
  assert.ok(assetKey);
  assert.equal(post.assets[0].id, null);
  const first = await call("GET", `/api/buffer/media/post/${assetKey}`);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "synthetic original media");
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    first.headers.get("content-disposition"),
    /^attachment; filename="GhostPost-/,
  );
  const preview = await call(
    "GET",
    `/api/buffer/media/post/${assetKey}?variant=thumbnail`,
  );
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-disposition"), /^inline/);
  await preview.text();
  assert.equal(reads, 1);
  assert.equal(
    downloads[0].url,
    "https://cdn.example.org/original.png?signature=private",
  );
  assert.equal(downloads[1].thumbnail, true);
});
test("private media rejects anonymous access, other accounts, stale keys, malformed IDs and arbitrary URLs", async () => {
  const before = downloads.length;
  assert.equal(
    (await call("GET", `/api/buffer/media/post/${assetKey}`, undefined, null))
      .status,
    401,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/buffer/media/post/${assetKey}`,
        undefined,
        "other-owner",
      )
    ).status,
    401,
  );
  assert.equal((await call("GET", "/api/buffer/media/post/stale")).status, 410);
  assert.equal(
    (await call("GET", "/api/buffer/media/post/https%3A%2F%2F127.0.0.1"))
      .status,
    400,
  );
  assert.equal(downloads.length, before);
  assert.equal(reads, 1);
});
test("original media rate limit is atomic and applies before another source lookup", async () => {
  await postgres.query(
    "DELETE FROM ghostpost.records WHERE namespace='media_limits'",
  );
  const responses = await Promise.all(
    Array.from({ length: 13 }, () =>
      call("GET", `/api/buffer/media/post/${assetKey}`),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 12);
  assert.equal(responses.filter((r) => r.status === 429).length, 1);
  await Promise.all(
    responses.filter((r) => r.status === 200).map((r) => r.text()),
  );
  assert.equal(reads, 1);
});
test("reconnecting with different credentials invalidates the prior media cache", async () => {
  await postgres.query(
    "DELETE FROM ghostpost.records WHERE namespace='media_limits'",
  );
  expectedToken = "synthetic-new-connection";
  await db.tx.update(
    "buffer_connections",
    [
      {
        id: hash("media-owner"),
        record: encrypt({ access_token: expectedToken }, parseKey(key)),
      },
    ],
    { patch: true },
  );
  const response = await call("GET", `/api/buffer/media/post/${assetKey}`);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(reads, 2);
});
test("unreadable saved envelopes report reconnect instead of falsely connected", async () => {
  await postgres.query(
    "DELETE FROM ghostpost.records WHERE namespace='media_limits'",
  );
  await db.tx.update(
    "buffer_connections",
    [{ id: hash("media-owner"), record: { ciphertext: "corrupt" } }],
    { patch: true },
  );
  const response = await call("GET", "/api/buffer/me");
  const data = await response.json();
  assert.equal(data.connected, false);
  assert.equal(data.reconnectRequired, true);
  assert.equal(
    (await call("GET", `/api/buffer/media/post/${assetKey}`)).status,
    409,
  );
});
