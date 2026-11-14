import { auth } from "../lib/auth";
export { db } from "./store";
export type RouterResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
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
    if (!value) throw new Error("Required server configuration is missing.");
    return value;
  },
  async listSecretNames() {
    return Object.keys(process.env).filter((k) => Boolean(process.env[k]));
  },
};
export function isAppDatabaseError(
  _error: unknown,
): _error is { code: string } {
  return false;
}
export function requireAuth(): RouterMiddleware {
  return async (ctx) => {
    const { data } = await auth.getSession();
    if (!data?.user)
      return json({ error: "Sign in to GhostPost to continue." }, 401);
    ctx.user = { userId: data.user.id };
  };
}
export function router(routes: Record<string, RouterMiddleware[]>) {
  return async (request: Request) => {
    const url = new URL(request.url),
      headers = Object.fromEntries(request.headers.entries());
    let result: RouterResponse | undefined;
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        const origin = request.headers.get("origin");
        const allowed = new Set([
          process.env.APP_ORIGIN,
          ...(process.env.APP_ADDITIONAL_ORIGINS || "")
            .split(",")
            .filter(Boolean),
          ...(!process.env.VERCEL ? ["http://localhost:3000"] : []),
        ]);
        if (
          !origin ||
          !allowed.has(origin) ||
          request.headers.get("sec-fetch-site") === "cross-site"
        )
          return Response.json(
            { error: "Request origin was not accepted." },
            { status: 403 },
          );
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          return Response.json({ error: "Expected JSON." }, { status: 415 });
      }
      for (const [pattern, middlewares] of Object.entries(routes)) {
        const [method, path] = pattern.split(" ");
        if (method !== request.method) continue;
        const keys: string[] = [];
        const matcher = new RegExp(
          "^" +
            path.replace(/:([a-z]+)/g, (_all, key) => {
              keys.push(key);
              return "([^/]+)";
            }) +
            "$",
        );
        const match = url.pathname.match(matcher);
        if (!match) continue;
        const raw = ["GET", "HEAD"].includes(request.method)
          ? ""
          : await request.text();
        if (Buffer.byteLength(raw) > 240000)
          return Response.json(
            { error: "Request is too large." },
            { status: 413 },
          );
        const context: RouterContext = {
          body: raw ? JSON.parse(raw) : undefined,
          query: Object.fromEntries(url.searchParams.entries()),
          params: Object.fromEntries(
            keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]),
          ),
          event: { headers },
        };
        for (const middleware of middlewares) {
          const response = await middleware(context);
          if (response) {
            result = response;
            break;
          }
        }
        break;
      }
    } catch {
      result = json(
        { error: "The operation could not be completed. Please retry." },
        503,
      );
    }
    result ||= json({ error: "Not found." }, 404);
    return new Response(result.body, {
      status: result.statusCode,
      headers: {
        ...result.headers,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}
