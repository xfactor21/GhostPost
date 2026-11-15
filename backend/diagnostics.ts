import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
export type Diagnostic = { requestId: string; endpoint: string; stage: string };
const requests = new AsyncLocalStorage<Diagnostic>();
export class PublicError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "REQUEST_REJECTED",
  ) {
    super(message);
  }
}
export class DatabaseError extends Error {
  readonly code: string;
  constructor(error: unknown) {
    super("Database operation failed.");
    const code = (error as { code?: unknown })?.code;
    this.code =
      typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code)
        ? code
        : "DATABASE_ERROR";
  }
}
export function requestScope<T>(endpoint: string, fn: () => Promise<T>) {
  return requests.run(
    { requestId: randomUUID(), endpoint, stage: "request.validation" },
    fn,
  );
}
export function stage(value: string) {
  const context = requests.getStore();
  if (context) context.stage = value;
}
export function endpoint(value: string) {
  const context = requests.getStore();
  if (context) context.endpoint = value;
}
export function requestId() {
  return requests.getStore()?.requestId || randomUUID();
}
export function classifyFailure(error: unknown) {
  let status = 503,
    code = "SERVICE_UNAVAILABLE",
    category = "internal",
    message =
      "This operation could not be completed. Please retry. If it continues, share the reference below with support.";
  if (error instanceof PublicError) {
    status = error.status;
    code = error.code;
    message = error.message;
    category = code.startsWith("AUTH")
      ? "authentication"
      : code.includes("CONFIGURATION")
        ? "configuration"
        : code.startsWith("MEDIA") || code.startsWith("BUFFER_MEDIA")
          ? "media"
          : code.startsWith("BUFFER_SYNC") ||
              code.startsWith("BUFFER_POST") ||
              code === "BUFFER_RESPONSE_INVALID"
            ? "synchronization"
            : code.startsWith("BUFFER_EXCHANGE")
              ? "token_exchange"
              : code.startsWith("BUFFER")
                ? "authorization"
                : "request";
  } else if (error instanceof DatabaseError) {
    category = "database";
    code =
      error.code === "DATABASE_CONFIGURATION"
        ? "STORAGE_CONFIGURATION"
        : error.code === "42P01" || error.code === "3F000"
          ? "STORAGE_SCHEMA_MISSING"
          : error.code === "42501"
            ? "STORAGE_PERMISSION_DENIED"
            : "STORAGE_UNAVAILABLE";
    message =
      code === "STORAGE_CONFIGURATION"
        ? "Workspace storage configuration needs attention. Contact the deployment owner."
        : code === "STORAGE_SCHEMA_MISSING"
          ? "Workspace storage needs its database migration. Contact the deployment owner."
          : code === "STORAGE_PERMISSION_DENIED"
            ? "Workspace storage permissions need attention. Contact the deployment owner."
            : "Workspace storage is temporarily unavailable. Wait a moment and retry.";
  } else if (error instanceof SyntaxError) {
    status = 400;
    code = "INVALID_JSON";
    category = "request";
    message = "The request was not valid JSON.";
  } else if (error instanceof URIError) {
    status = 400;
    code = "INVALID_PATH";
    category = "request";
    message = "The request path was not valid.";
  }
  const context = requests.getStore();
  return {
    status,
    code,
    category,
    message,
    requestId: context?.requestId || randomUUID(),
    endpoint: context?.endpoint || "internal",
    stage: context?.stage || "unknown",
  };
}
export function failure(error: unknown) {
  const result = classifyFailure(error);
  // Strict allowlist only. Never serialize exceptions, messages, stacks, URLs,
  // request bodies, cookies, headers, account IDs or upstream response bodies.
  console.error(
    JSON.stringify({
      event: "ghostpost.request.failure",
      requestId: result.requestId,
      endpoint: result.endpoint,
      stage: result.stage,
      category: result.category,
      code: result.code,
      status: result.status,
      ...(error instanceof DatabaseError && /^[0-9A-Z]{5}$/.test(error.code)
        ? { sqlState: error.code }
        : {}),
    }),
  );
  return result;
}
