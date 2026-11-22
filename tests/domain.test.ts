import { test } from "node:test";
import assert from "node:assert/strict";
import {
  campaignGroups,
  campaignKey,
  campaignMinute,
  type CampaignPost,
} from "../shared/campaigns";
import { normalizeAssets, publicAddress } from "../backend/media";
import { createStore, validateNamespace, databaseUrl } from "../backend/store";
const post = (
  id: string,
  channelId: string,
  minute: number,
  extra: Partial<CampaignPost> = {},
): CampaignPost => ({
  id,
  channelId,
  status: "sent",
  sentAt: new Date(Date.UTC(2026, 10, 14, 12, minute, 20)).toISOString(),
  createdAt: "2026-11-01T00:00:00Z",
  ...extra,
});
test("nine versions at three exact publication minutes form three campaigns", () => {
  const data = [0, 1, 2].flatMap((minute) =>
    ["a", "b", "c"].map((channel) => post(channel + minute, channel, minute)),
  );
  const groups = campaignGroups(data);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((g) => g.length),
    [3, 3, 3],
  );
});
test("publication is not inferred from scheduled/created timestamps; statuses stay separate", () => {
  const data = [
    post("sent", "a", 0),
    post("scheduled", "b", 0, {
      status: "scheduled",
      dueAt: "2026-11-14T12:00:00Z",
    }),
    post("missing", "c", 0, {
      sentAt: undefined,
      dueAt: "2026-11-14T12:00:00Z",
    }),
  ];
  assert.equal(campaignGroups(data).length, 3);
  assert.equal(campaignMinute(data[2]), null);
});
test("reliable relationship IDs and duplicate channels prevent accidental merges", () => {
  assert.equal(
    campaignGroups([
      post("a", "one", 0, { contentItemId: "one" }),
      post("b", "two", 0, { contentItemId: "two" }),
    ]).length,
    2,
  );
  assert.equal(
    campaignGroups([
      post("a", "one", 0),
      post("b", "one", 0),
      post("c", "two", 0),
    ]).length,
    3,
  );
});
test("campaign keys and version IDs survive pagination, ordering, duplicates and filtering", () => {
  const a = post("a", "z", 0),
    b = post("b", "y", 0),
    c = post("c", "a", 0);
  const before = campaignGroups([a, b])[0];
  const after = campaignGroups([c, b, a, b])[0];
  assert.equal(campaignKey(before), campaignKey(after));
  assert.equal(after.length, 3);
  assert.ok(after.some((p) => p.id === b.id));
  assert.equal(campaignKey(campaignGroups([b, c])[0]), campaignKey(after));
});
test("shared source identity groups staggered platform publications", () => {
  const posts = [
    post("facebook", "fb", 0, { contentItemId: "episode-1" }),
    post("linkedin", "li", 1, { contentItemId: "episode-1" }),
    post("pinterest", "pin", 2, { contentItemId: "episode-1" }),
  ];
  const group = campaignGroups(posts);
  assert.equal(group.length, 1);
  assert.equal(group[0].length, 3);
  assert.equal(campaignKey(group[0]), "sent:content:episode-1");
  assert.equal(campaignKey(campaignGroups(posts.slice(0, 2))[0]), campaignKey(group[0]));
});
test("shared idea identity groups across different minutes without a content ID", () => {
  assert.equal(campaignGroups([
    post("a", "fb", 0, { ideaId: "idea-1" }),
    post("b", "li", 2, { ideaId: "idea-1" }),
  ]).length, 1);
});
test("unrelated nearby posts and statuses never merge without source identity", () => {
  assert.equal(campaignGroups([
    post("a", "fb", 0, { contentItemId: "episode-1" }),
    post("b", "li", 1, { contentItemId: "episode-2" }),
    post("c", "pin", 2),
    post("d", "x", 0, { status: "scheduled", dueAt: "2026-11-14T12:00:00Z", contentItemId: "episode-1" }),
  ]).length, 4);
});
test("repeated channel versions are not silently combined across minutes", () => {
  assert.equal(campaignGroups([
    post("a", "fb", 0, { contentItemId: "episode-1" }),
    post("b", "fb", 1, { contentItemId: "episode-1" }),
    post("c", "li", 2, { contentItemId: "episode-1" }),
  ]).length, 3);
});
test("media with null IDs keeps per-post associations and stable refreshed URL keys", () => {
  const a = normalizeAssets("post-one", [
    {
      id: null,
      mimeType: "video/mp4",
      source: "https://cdn.example.org/original.mp4?signature=old",
      thumbnail: "https://cdn.example.org/poster.jpg",
    },
  ]);
  const b = normalizeAssets("post-one", [
    {
      id: null,
      mimeType: "video/mp4",
      source: "https://cdn.example.org/original.mp4?signature=new",
      thumbnail: "https://cdn.example.org/poster.jpg",
    },
  ]);
  assert.equal(a[0].key, b[0].key);
  assert.equal(a[0].id, null);
  assert.notEqual(
    a[0].key,
    normalizeAssets("post-two", [
      { mimeType: "video/mp4", source: "https://cdn.example.org/original.mp4" },
    ])[0].key,
  );
  assert.equal(
    normalizeAssets("p", [
      { source: "javascript:evil", thumbnail: "http://example.org/" },
    ])[0].source,
    "",
  );
});
test("media SSRF policy blocks private, mapped, metadata, multicast and special addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.0.1",
    "172.16.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
});
test("all application namespaces reach SQL; malformed namespaces never do", async () => {
  const seen: string[] = [];
  const db = createStore(async (_sql, values) => {
    seen.push(String(values[0]));
    return { rows: [] };
  });
  for (const name of [
    "oauth_pending_v2",
    "buffer_connections",
    "request_limits",
    "workspaces",
    "sync_meta",
    "buffer_media",
    "media_limits",
  ])
    await db.tx.update(name, [{ id: "fixture", record: { value: 1 } }]);
  assert.equal(seen.length, 7);
  for (const value of [
    "",
    "9bad",
    "x; DROP TABLE",
    "../secret",
    "a".repeat(65),
  ])
    assert.throws(() => validateNamespace(value));
  assert.match(
    databaseUrl("postgresql://example.org/db?sslmode=require"),
    /sslmode=verify-full/,
  );
});
import { shareLaunch, variantFor } from "../shared/handoff";
test("manual destination adaptation preserves captions and validates exact host boundaries", () => {
  const text = "Original #caption\n" + "x".repeat(400);
  assert.equal(variantFor(text, { platform: "bluesky" }), text);
  const b = shareLaunch({ url: "https://bsky.app/profile/example.test" }, text);
  assert.equal(new URL(b.url).searchParams.get("text"), text);
  const r = shareLaunch({ url: "https://www.reddit.com/r/test/" }, text);
  assert.equal(new URL(r.url).searchParams.get("sr"), "test");
  assert.equal(new URL(r.url).searchParams.get("selftext"), "true");
  assert.equal(new URL(r.url).searchParams.get("text"), text);
  assert.equal(
    shareLaunch({ url: "https://notreddit.com/" }, text).prefilled,
    false,
  );
  assert.equal(
    shareLaunch({ url: "https://bsky.app.attacker.test" }, text).prefilled,
    false,
  );
  assert.throws(() => shareLaunch({ url: "javascript:evil" }, text));
  assert.equal(
    shareLaunch({ url: "https://x.com/" }, "x".repeat(10000)).prefilled,
    false,
  );
});
