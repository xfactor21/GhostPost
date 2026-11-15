import pg from "pg";
import { DatabaseError, failure } from "./diagnostics";
import { attachDatabasePool } from "@vercel/functions";
let pool: pg.Pool | undefined;
export function database() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl(process.env.DATABASE_URL),
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 5000,
    });
    pool.on("error", (error) => {
      failure(new DatabaseError(error));
    });
    attachDatabasePool(pool);
  }
  return pool;
}
export function databaseUrl(raw: string | undefined) {
  if (!raw) throw new DatabaseError({ code: "DATABASE_CONFIGURATION" });
  try {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol))
      throw new Error("Invalid database scheme");
    if (
      ["require", "prefer", "verify-ca"].includes(
        url.searchParams.get("sslmode") || "",
      )
    )
      url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  } catch {
    throw new DatabaseError({ code: "DATABASE_CONFIGURATION" });
  }
}
export function validateNamespace(value: string) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value))
    throw new DatabaseError({ code: "NAMESPACE_INVALID" });
  return value;
}
type Row = Record<string, unknown>;
type Change = { id: string; record: Row; if?: Row };
export function createStore(
  execute: (
    sql: string,
    values: unknown[],
  ) => Promise<{ rows: Record<string, any>[] }>,
) {
  const query = async (sql: string, values: unknown[]) => {
    try {
      return await execute(sql, values);
    } catch (error) {
      throw error instanceof DatabaseError ? error : new DatabaseError(error);
    }
  };
  return {
    async get<T = Row>(
      ns: string,
      ids: string[],
      _options?: unknown,
    ): Promise<(T | undefined)[]> {
      const { rows } = await query(
        "SELECT id,data FROM ghostpost.records WHERE namespace=$1 AND id=ANY($2::text[])",
        [validateNamespace(ns), ids],
      );
      const map = new Map(rows.map((r) => [r.id, r.data]));
      return ids.map((id) => map.get(id));
    },
    async delete(ns: string, ids: string[]) {
      await query(
        "DELETE FROM ghostpost.records WHERE namespace=$1 AND id=ANY($2::text[])",
        [validateNamespace(ns), ids],
      );
    },
    tx: {
      async consume(ns: string, id: string, window: number, limit: number) {
        const result = await query(
          `INSERT INTO ghostpost.records(namespace,id,data) VALUES($1,$2,jsonb_build_object('window',$3::bigint,'count',1)) ON CONFLICT(namespace,id) DO UPDATE SET data=jsonb_build_object('window',$3::bigint,'count',CASE WHEN ghostpost.records.data->>'window'=$3::text THEN (ghostpost.records.data->>'count')::integer+1 ELSE 1 END),updated_at=now() WHERE ghostpost.records.data->>'window' IS DISTINCT FROM $3::text OR (ghostpost.records.data->>'count')::integer < $4::integer RETURNING id`,
          [validateNamespace(ns), id, window, limit],
        );
        return result.rows.length > 0;
      },
      async add(ns: string, records: (Row & { id: string })[]) {
        return Promise.all(
          records.map(async (record) => {
            const r = await query(
              "INSERT INTO ghostpost.records(namespace,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING id",
              [validateNamespace(ns), record.id, JSON.stringify(record)],
            );
            return r.rows.length > 0;
          }),
        );
      },
      async update(
        ns: string,
        changes: Change[],
        options?: { patch?: boolean },
      ) {
        return Promise.all(
          changes.map(async (change) => {
            const absent = Object.keys(change.record).filter(
              (k) => change.record[k] === undefined,
            );
            const values: unknown[] = [
              validateNamespace(ns),
              change.id,
              JSON.stringify(change.record),
            ];
            if (options?.patch) values.push(absent);
            const expression = options?.patch
              ? "(data - $4::text[]) || $3::jsonb"
              : "$3::jsonb";
            if (change.if) {
              const checks = Object.entries(change.if).map(([key, value]) => {
                values.push(key);
                const keyIndex = values.length;
                if (value === undefined)
                  return `NOT (data ? $${keyIndex}::text)`;
                values.push(JSON.stringify(value));
                return `data -> $${keyIndex}::text = $${values.length}::jsonb`;
              });
              const result = await query(
                `UPDATE ghostpost.records SET data=${expression}, updated_at=now() WHERE namespace=$1 AND id=$2 AND ${checks.length ? checks.join(" AND ") : "true"} RETURNING id`,
                values,
              );
              return result.rows.length > 0;
            }
            // Unconditional updates intentionally upsert, matching workspace initialization.
            const result = await query(
              `INSERT INTO ghostpost.records(namespace,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,id) DO UPDATE SET data=${options?.patch ? "(ghostpost.records.data - $4::text[]) || EXCLUDED.data" : "EXCLUDED.data"},updated_at=now() RETURNING id`,
              values.slice(0, options?.patch ? 4 : 3),
            );
            return result.rows.length > 0;
          }),
        );
      },
    },
  };
}
export const db = createStore(async (sql, values) =>
  database().query(sql, values),
);
