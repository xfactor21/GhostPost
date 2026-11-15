import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { createStore } from "../backend/store.ts";
export const postgres = new PGlite();
await postgres.exec(
  await readFile(
    new URL("../migrations/001_records.sql", import.meta.url),
    "utf8",
  ),
);
export const faults = { code: null };
export const db = createStore(async (sql, values) => {
  if (faults.code)
    throw Object.assign(
      new Error("synthetic private credential must never reach logs"),
      { code: faults.code },
    );
  return postgres.query(sql, values);
});
