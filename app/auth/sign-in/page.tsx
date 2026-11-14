"use client";
import { useState } from "react";
import { authClient } from "../../../src/client";
export default function SignIn() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const credentials = {
        email: String(form.get("email")),
        password: String(form.get("password")),
      };
      const result =
        mode === "signup"
          ? await authClient.signUp.email({
              ...credentials,
              name: String(form.get("name")),
              callbackURL: "/",
            })
          : await authClient.signIn.email({ ...credentials, callbackURL: "/" });
      if (result.error)
        throw new Error(result.error.message || "Sign in failed.");
      location.assign("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="panel auth-card">
        <a href="/" className="wordmark">
          Ghost<span className="pink">Post</span>
          <small>by planet.X ✕</small>
        </a>
        <h1>{mode === "signin" ? "Welcome back." : "Your publishing home."}</h1>
        <p>Sign in to your private GhostPost workspace.</p>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const r = await authClient.signIn.social({
                provider: "google",
                callbackURL: "/",
              });
              if (r.error)
                throw new Error(r.error.message || "Google sign in failed.");
            } catch (e) {
              setError(e instanceof Error ? e.message : "Sign in failed.");
              setBusy(false);
            }
          }}
        >
          Continue with Google
        </button>
        <p className="quiet">or use your email</p>
        <form onSubmit={submit}>
          {mode === "signup" && (
            <label>
              Name
              <input name="name" required maxLength={100} autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
            />
          </label>
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy
              ? "Working…"
              : mode === "signup"
                ? "Create account"
                : "Sign in"}
          </button>
        </form>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError("");
          }}
        >
          {mode === "signin"
            ? "New here? Create an account"
            : "Already have an account? Sign in"}
        </button>
        <p className="hint">
          Moving from the demo? This is a new secure sign in. Export your old
          workspace and import it in Settings. Buffer must be connected again.
        </p>
        <a href="/privacy">Privacy policy</a>
      </section>
    </main>
  );
}
