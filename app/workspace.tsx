"use client";
import { useEffect } from "react";
export default function Workspace() {
  useEffect(() => {
    void import("../src/main").catch(() => {
      const host = document.getElementById("app");
      if (host) {
        host.textContent =
          "GhostPost could not load. Reload this page to try again.";
        host.setAttribute("role", "alert");
      }
    });
  }, []);
  return (
    <>
      <div id="app">
        <div className="signin-banner">Loading GhostPost…</div>
      </div>
      <div id="toast" role="status" aria-live="polite" />
    </>
  );
}
