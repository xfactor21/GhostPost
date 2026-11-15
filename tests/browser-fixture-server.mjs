// LOCAL TEST HARNESS ONLY. Never imported by the app or deployed as a route.
// All records are synthetic. This server makes no Buffer/OAuth requests.
import http from "node:http";
import next from "next";
const app = next({ dev: false, hostname: "127.0.0.1", port: 3000 });
await app.prepare();
const handle = app.getRequestHandler();
const channels = ["linkedin", "facebook", "threads"].map((service, i) => ({
  id: "channel-" + i,
  name: "Fixture " + service,
  service,
  timezone: "America/Chicago",
  isLocked: false,
  isDisconnected: false,
  isQueuePaused: false,
  avatar: "",
  canScheduleInBuffer: true,
}));
const posts = [0, 1, 2].flatMap((campaign) =>
  channels.map((channel, i) => ({
    id: "fixture-" + campaign + "-" + i,
    channelId: channel.id,
    status: "sent",
    text:
      "Fixture campaign " +
      (campaign + 1) +
      " — " +
      channel.service +
      " caption",
    sentAt: new Date(
      Date.UTC(2026, 10, 14, 12, campaign, 20 + i),
    ).toISOString(),
    createdAt: "2026-11-13T00:00:00Z",
    assets: [
      {
        id: null,
        key: "fixtureasset" + campaign + i,
        mimeType: "image/png",
        source: "https://example.invalid/original.png",
        thumbnail: "https://example.invalid/thumbnail.png",
      },
    ],
  })),
);
let ws = {
  revision: 0,
  drafts: [],
  tasks: [],
  destinations: [
    {
      id: "destination",
      name: "Fixture Reddit",
      platform: "Reddit",
      url: "https://www.reddit.com/r/test/",
      active: true,
    },
  ],
};
function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost:3000").pathname;
  if (path === "/api/auth/get-session")
    return json(res, {
      user: {
        id: "synthetic-browser-user",
        name: "Fixture User",
        email: "qa@example.invalid",
      },
      session: {
        id: "synthetic-session",
        userId: "synthetic-browser-user",
        expiresAt: "2030-01-01T00:00:00Z",
      },
    });
  if (path === "/api/buffer/status")
    return json(res, {
      configured: true,
      callback: "https://ghostpost.planet-x.co/api/auth/buffer/callback",
    });
  if (path === "/api/workspace" && req.method === "GET") return json(res, ws);
  if (path === "/api/buffer/me")
    return json(res, {
      connected: true,
      connectedAt: Date.now(),
      reconnectRequired: false,
    });
  if (path === "/api/buffer/sync") {
    let body = "";
    for await (const part of req) body += part;
    const { mode } = JSON.parse(body);
    return json(res, {
      accountId: "fixture-account",
      organizationId: "fixture-org",
      organizations: [{ id: "fixture-org", name: "Synthetic QA" }],
      channels,
      posts: mode === "history" ? posts : [],
      syncedAt: Date.now(),
      pageInfo: { hasNextPage: false },
    });
  }
  if (path.startsWith("/api/buffer/media/")) {
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    });
    return res.end(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
  }
  if (path === "/api/buffer/post") {
    let body = "";
    for await (const part of req) body += part;
    return json(res, {
      post: posts.find((p) => p.id === JSON.parse(body).postId),
    });
  }
  if (path.startsWith("/api/workspace/") && req.method === "PUT") {
    let body = "";
    for await (const part of req) body += part;
    const value = JSON.parse(body),
      [, , , kind, id] = path.split("/");
    if (value.revision !== ws.revision)
      return json(res, { error: "Fixture revision changed" }, 409);
    ws = {
      ...ws,
      revision: ws.revision + 1,
      [kind]: [...ws[kind].filter((item) => item.id !== id), { ...value, id }],
    };
    return json(res, ws);
  }
  if (path.startsWith("/api/"))
    return json(
      res,
      { error: "Local fixture does not call external providers." },
      501,
    );
  return handle(req, res);
});
server.listen(3000, "0.0.0.0", () =>
  console.log("Synthetic GhostPost browser fixture: http://localhost:3000"),
);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
