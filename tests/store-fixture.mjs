import { validateNamespace } from "../backend/store.ts";
// Test-only, in-memory database and authentication adapter.
export const tables = new Map();
export const secretValues = {
  BUFFER_CLIENT_ID: "synthetic-client",
  BUFFER_CLIENT_SECRET: "synthetic-secret",
  GHOSTPOST_TOKEN_ENCRYPTION_KEY: "1".repeat(64),
};
const table = (name) => {
  validateNamespace(name);
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
