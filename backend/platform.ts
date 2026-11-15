import {
  PublicError,
  requestScope,
  stage,
  endpoint,
  failure,
  requestId,
} from "./diagnostics";
import { auth } from "../lib/auth";
export { db } from "./store";
export type RouterResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: BodyInit | null;
};
export type RouterContext = {
  body: unknown;
  query: Record<string, string>;
  params: Record<string, string>;
  event: { headers: Record<string, string>; cookies?: string[] };
  user?: { userId: string };
};
export type RouterMiddleware = (
  ctx: RouterContext,
) => Promise<RouterResponse | void>;
export const json = (body: unknown, statusCode = 200): RouterResponse => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
export const secrets = {
  async readSecret(name: string) {
    const value = process.env[name];
    if (!value)
      throw new PublicError(
        "Required server configuration is missing. Contact the deployment owner.",
        503,
        "SERVER_CONFIGURATION",
      );
    return value;
  },
  async listSecretNames() {
    return Object.keys(process.env).filter((k) => Boolean(process.env[k]));
  },
};
export function errorResponse(error: unknown) {
  const result = failure(error);
  return {
    ...json(
      { error: result.message, code: result.code, requestId: result.requestId },
      result.status,
    ),
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Request-ID": result.requestId,
      ...(result.status === 429 ? { "Retry-After": "5" } : {}),
    },
  };
}
export function requireAuth(): RouterMiddleware {
  return async (ctx) => {
    stage("authentication.session");
    let result;
    try {
      result = await auth.getSession();
    } catch {
      throw new PublicError(
        "Your sign-in could not be verified. Please retry shortly.",
        503,
        "AUTH_UNAVAILABLE",
      );
    }
    if (result.error)
      throw new PublicError(
        "The sign-in service is temporarily unavailable. Please retry.",
        503,
        "AUTH_UNAVAILABLE",
      );
    if (!result.data?.user)
      throw new PublicError(
        "Your GhostPost session has expired. Sign in and try again.",
        401,
        "AUTH_REQUIRED",
      );
    ctx.user = { userId: result.data.user.id };
  };
}
export function router(routes: Record<string, RouterMiddleware[]>) {
  const compiled = Object.entries(routes).map(([pattern, middlewares]) => {
    const [method, path] = pattern.split(" "),
      keys: string[] = [];
    const parts = path.split("/").map((part) => {
      if (part.startsWith(":")) {
        const key = part.slice(1);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key))
          throw new Error("Invalid route parameter.");
        keys.push(key);
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    return {
      pattern,
      method,
      keys,
      matcher: new RegExp("^" + parts.join("/") + "$"),
      middlewares,
    };
  });
  return async (request: Request) => {
    const url = new URL(request.url);
    const route = compiled.find(
      (route) =>
        route.method === request.method && route.matcher.test(url.pathname),
    );
    return requestScope(
      route?.pattern || request.method + " /unmatched",
      async () => {
        let result: RouterResponse;
        try {
          if (!["GET", "HEAD"].includes(request.method)) {
            const allowed = new Set([
              process.env.APP_ORIGIN,
              ...(process.env.APP_ADDITIONAL_ORIGINS || "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
              ...(!process.env.VERCEL ? ["http://localhost:3000"] : []),
            ]);
            const origin = request.headers.get("origin");
            if (
              !origin ||
              !allowed.has(origin) ||
              request.headers.get("sec-fetch-site") === "cross-site"
            )
              throw new PublicError(
                "This request did not come from an accepted GhostPost page. Reload GhostPost and try again.",
                403,
                "ORIGIN_REJECTED",
              );
            if (
              !request.headers
                .get("content-type")
                ?.toLowerCase()
                .startsWith("application/json")
            )
              throw new PublicError(
                "Expected a JSON request.",
                415,
                "CONTENT_TYPE_REJECTED",
              );
          }
          result = json({ error: "Not found." }, 404);
          if (route) {
            const match = url.pathname.match(route.matcher)!;
            const raw = ["GET", "HEAD"].includes(request.method)
              ? ""
              : await request.text();
            if (Buffer.byteLength(raw) > 240000)
              throw new PublicError(
                "The request is too large.",
                413,
                "BODY_TOO_LARGE",
              );
            const ctx: RouterContext = {
              body: raw ? JSON.parse(raw) : undefined,
              query: Object.fromEntries(url.searchParams),
              params: Object.fromEntries(
                route.keys.map((key, index) => [
                  key,
                  decodeURIComponent(match[index + 1]),
                ]),
              ),
              event: { headers: Object.fromEntries(request.headers) },
            };
            for (const middleware of route.middlewares) {
              const response = await middleware(ctx);
              if (response) {
                result = response;
                break;
              }
            }
          }
        } catch (error) {
          result = errorResponse(error);
        }
        return new Response(result.body, {
          status: result.statusCode,
          headers: {
            ...result.headers,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Request-ID": requestId(),
          },
        });
      },
    );
  };
}
