'use client';
import { useEffect } from 'react';
export default function Workspace() {
  useEffect(() => {void import('../src/main');},[]);
  return <><div id="app"><div className="signin-banner">Loading GhostPost…</div></div><div id="toast" role="status" aria-live="polite" /></>;
}
