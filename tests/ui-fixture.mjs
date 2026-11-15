// Synthetic API boundary for DOM tests; never used by application routes.
export const channels = ["linkedin", "facebook", "threads"].map(
  (service, i) => ({
    id: "channel-" + i,
    name: "Fixture " + service,
    service,
    isDisconnected: false,
    isLocked: false,
    isQueuePaused: false,
    timezone: "UTC",
  }),
);
export const posts = [0, 1, 2].flatMap((c) =>
  channels.map((channel, i) => ({
    id: `post-${c}-${i}`,
    channelId: channel.id,
    status: "sent",
    text: `Campaign ${c} ${channel.service} original caption`,
    sentAt: new Date(Date.UTC(2026, 10, 14, 12, c, 20 + i)).toISOString(),
    createdAt: "2026-11-13T00:00:00Z",
    assets: [0, 1].map((j) => ({
      id: null,
      key: `asset${c}${i}${j}`,
      mimeType: "image/png",
      source: "https://example.invalid/original.png",
      thumbnail: "https://example.invalid/thumb.png",
    })),
  })),
);
export const state = {
  reverse: false,
  signedIn: true,
  calls: [],
  workspace: {
    revision: 0,
    drafts: [
      { id: "draft", title: "Synthetic draft", text: "Draft without media" },
    ],
    tasks: [],
    destinations: [
      {
        id: "reddit",
        name: "Fixture Reddit",
        platform: "Reddit",
        url: "https://www.reddit.com/r/test/",
        active: true,
      },
    ],
  },
};
export const auth = {
  getUser: async () =>
    state.signedIn ? { userId: "dom-user", name: "Synthetic User" } : null,
  signOut: async () => {
    state.signedIn = false;
  },
  signInWithRedirect: async () => {},
};
export const api = {
  async get(path) {
    state.calls.push({ path });
    if (path === "/api/buffer/status") return { data: { configured: true } };
    if (path === "/api/workspace")
      return { data: structuredClone(state.workspace) };
    if (path === "/api/buffer/me")
      return { data: { connected: true, reconnectRequired: false } };
    throw new Error("Unexpected fixture read " + path);
  },
  async post(path, body) {
    state.calls.push({ path, body: structuredClone(body) });
    if (path === "/api/buffer/start")
      return {
        data: {
          authorizationUrl:
            "https://auth.buffer.com/auth?client_id=synthetic&state=synthetic",
        },
      };
    if (path === "/api/buffer/sync")
      return {
        data: {
          accountId: "fixture-account",
          organizationId: "fixture-org",
          organizations: [{ id: "fixture-org", name: "Synthetic QA" }],
          channels,
          posts:
            body.mode === "history"
              ? state.reverse
                ? [...posts].reverse()
                : posts
              : [],
          syncedAt: Date.now(),
          pageInfo: { hasNextPage: false },
        },
      };
    if (path === "/api/buffer/post")
      return {
        data: {
          post: structuredClone(posts.find((p) => p.id === body.postId)),
        },
      };
    throw new Error("Unexpected fixture write " + path);
  },
  async put(path, body) {
    state.calls.push({ path, body: structuredClone(body) });
    const [, , , kind, id] = path.split("/");
    if (body.revision !== state.workspace.revision)
      throw new Error("Fixture revision mismatch");
    state.workspace = {
      ...state.workspace,
      revision: body.revision + 1,
      [kind]: [
        ...state.workspace[kind].filter((v) => v.id !== id),
        { ...body, id },
      ],
    };
    return { data: structuredClone(state.workspace) };
  },
};
