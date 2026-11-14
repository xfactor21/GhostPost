// Test-only, in-memory database and authentication adapter.
export const tables = new Map();
export const secretValues = {
  BUFFER_CLIENT_ID: "synthetic-client",
  BUFFER_CLIENT_SECRET: "synthetic-secret",
  GHOSTPOST_TOKEN_ENCRYPTION_KEY: "1".repeat(64),
};
export const json = (value, statusCode = 200) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
export const secrets = {
  listSecretNames: async () => Object.keys(secretValues),
  readSecret: async (name) => secretValues[name],
};
export const isAppDatabaseError = (err) =>
  Boolean(err?.code?.startsWith("AppDatabase"));
const table = (name) => {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
};
const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);
export const db = {
  get: async (name, ids) => ids.map((id) => clone(table(name).get(id)) || null),
  delete: async (name, ids) => ids.map((id) => table(name).delete(id)),
  tx: {
    add: async (name, records) =>
      records.map((record) => {
        const target = table(name);
        if (target.has(record.id)) return null;
        target.set(record.id, clone(record));
        return record.id;
      }),
    update: async (name, items, options) =>
      items.map((item) => {
        const target = table(name);
        const current = target.get(item.id);
        if (
          (options?.patch && !current) ||
          (item.if &&
            (!current ||
              Object.entries(item.if).some(
                ([key, value]) => current[key] !== value,
              )))
        )
          return false;
        const record = options?.patch
          ? { ...current, ...item.record }
          : item.record;
        target.set(
          item.id,
          clone(
            Object.fromEntries(
              Object.entries(record).filter(([, value]) => value !== undefined),
            ),
          ),
        );
        return true;
      }),
  },
};
export const requireAuth = () => async (ctx) => {
  const id = ctx.event.headers?.authorization;
  if (!id?.startsWith("synthetic-user-"))
    return json({ error: "Unauthorized" }, 401);
  ctx.user = { userId: id, email: id + "@example.test" };
};
export const router = (routes) => async (event) => {
  for (const [route, handlers] of Object.entries(routes)) {
    const [verb, path] = route.split(" ");
    const names = [...path.matchAll(/:([^/]+)/g)].map((match) => match[1]);
    const match = event.rawPath.match(
      new RegExp("^" + path.replace(/:([^/]+)/g, "([^/]+)") + "$"),
    );
    if (event.requestContext.http.method !== verb || !match) continue;
    const ctx = {
      event,
      query: event.queryStringParameters || {},
      params: Object.fromEntries(names.map((name, i) => [name, match[i + 1]])),
      body: event.body ? JSON.parse(event.body) : undefined,
    };
    for (const handler of handlers) {
      const result = await handler(ctx);
      if (result) return result;
    }
  }
  return json({ error: "Not found" }, 404);
};
