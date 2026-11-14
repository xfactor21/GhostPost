import { createAuthClient } from "@neon/auth/next";
export const authClient = createAuthClient();
export const auth = {
  async getUser() {
    const { data, error } = await authClient.getSession();
    if (error)
      throw new Error("Could not verify your session. Please sign in again.");
    return data?.user
      ? { userId: data.user.id, name: data.user.name, email: data.user.email }
      : null;
  },
  async signInWithRedirect() {
    location.assign("/auth/sign-in");
  },
  async signOut() {
    const { error } = await authClient.signOut();
    if (error)
      throw new Error("Sign out could not be confirmed. Please retry.");
  },
};
async function request(method: string, path: string, body?: unknown) {
  if (!path.startsWith("/api/") || path.startsWith("//"))
    throw new Error("Invalid API destination.");
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res
    .json()
    .catch(() => ({ error: "The server returned an unexpected response." }));
  if (!res.ok) {
    const error = new Error(data.error || "Request failed.") as Error & {
      response: unknown;
    };
    error.response = { data, status: res.status };
    throw error;
  }
  return { data };
}
export const api = {
  get: (path: string) => request("GET", path),
  post: (path: string, body: unknown) => request("POST", path, body),
  put: (path: string, body: unknown) => request("PUT", path, body),
  delete: (path: string, body: unknown) => request("DELETE", path, body),
};
