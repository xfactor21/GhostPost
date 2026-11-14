import { api, auth } from "./client";

type Item = {
  id: string;
  title?: string;
  text?: string;
  platform?: string;
  campaign?: string;
  plannedAt?: string;
  name?: string;
  url?: string;
  notes?: string;
  instructions?: string;
  format?: string;
  active?: boolean;
  archived?: boolean;
  state?: string;
  destinationId?: string;
  destinationName?: string;
  destinationUrl?: string;
  contentRef?: string;
  resultUrl?: string;
  completedAt?: number;
  updatedAt?: number;
  createdAt?: number;
};
type Workspace = {
  revision: number;
  drafts: Item[];
  destinations: Item[];
  tasks: Item[];
};
type Channel = {
  id: string;
  name: string;
  service: string;
  avatar: string;
  isDisconnected: boolean;
  isLocked: boolean;
  isQueuePaused: boolean;
  timezone: string;
  canScheduleInBuffer: boolean;
};
type Post = {
  id: string;
  text: string;
  status: string;
  channelId: string;
  dueAt?: string;
  sentAt?: string;
  createdAt: string;
  externalLink?: string;
  assets?: { mimeType: string }[];
};
type View = "today" | "queue" | "composer" | "history" | "settings";
const app = document.querySelector<HTMLDivElement>("#app")!;
const toastEl = document.querySelector<HTMLDivElement>("#toast")!;
const emptyWorkspace = (): Workspace => ({
  revision: 0,
  drafts: [],
  destinations: [],
  tasks: [],
});
let user: { userId: string; name?: string; email?: string } | null = null;
let ws = emptyWorkspace();
let view: View = "today";
let busy = false;
let booting = true;
let configured = false;
let linked = false;
let reconnect = false;
let connectedAt: number | null = null;
let channels: Channel[] = [];
let organizations: { id: string; name: string }[] = [];
let organizationId = "";
let accountId = "";
let queue: Post[] = [];
let history: Post[] = [];
let queueCursor = "";
let historyCursor = "";
let queueLoaded = false;
let historyLoaded = false;
let lastSync: number | null = null;
let syncError = "";
let message = "";
let selectedDay = "";
let channelFilter = "";
let statusFilter = "";
let search = "";
let editor: Item = {
  id: "",
  title: "",
  text: "",
  platform: "general",
  campaign: "",
  plannedAt: "",
};
let dirty = false;
let destinationEditor: Item = {
  id: "",
  name: "",
  platform: "Reddit",
  url: "",
  active: true,
};
let prepare: Item | null = null;
let toastTimer: ReturnType<typeof setTimeout>;
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const active = (items: Item[]) => items.filter((item) => !item.archived);
const dateKey = (value: string | number) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const today = () => dateKey(Date.now());
const date = (value?: string | number | null) =>
  value
    ? new Date(value).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not scheduled";
const localInput = (value?: string) => {
  if (!value) return "";
  const d = new Date(value);
  return `${dateKey(value)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const url = (value?: string) => {
  try {
    const parsed = new URL(value || "");
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.href
      : "";
  } catch {
    return "";
  }
};
const link = (href: string | undefined, label: string) =>
  url(href)
    ? `<a class="button subtle" href="${escape(url(href))}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`
    : "";
const button = (label: string, action: string, extra = "", style = "") =>
  `<button type="button" class="${style}" data-action="${action}" ${extra}>${label}</button>`;
const badge = (label: string, style = "") =>
  `<span class="badge ${style}">${escape(label)}</span>`;
const ghost = `<svg viewBox="0 0 64 72" aria-hidden="true"><path d="M9 59V29C9 0 55 0 55 29v35l-12-6-11 7-11-7-12 6Z" fill="#fff8fc" stroke="#ff55ab" stroke-width="3"/><path d="m22 28 7 8m0-8-7 8m15-8 7 8m0-8-7 8" stroke="#23152d" stroke-width="4" stroke-linecap="round"/><path d="M27 46q5 4 10 0" fill="none" stroke="#23152d" stroke-width="2.5" stroke-linecap="round"/></svg>`;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 5500);
}
function errorMessage(error: unknown) {
  const data = (
    error as {
      response?: { data?: { error?: string; message?: string } };
      data?: { error?: string };
    }
  )?.response?.data;
  return (
    data?.error ||
    data?.message ||
    (error as { data?: { error?: string } })?.data?.error ||
    (error instanceof Error
      ? error.message
      : "Could not complete this action. Retry.")
  );
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  message = "";
  render();
  try {
    await action();
  } catch (error) {
    message = errorMessage(error);
    toast(message);
  } finally {
    busy = false;
    render();
  }
}
const noData = (title: string, detail: string, action = "") =>
  `<div class="empty"><span class="empty-glyph" aria-hidden="true">✕</span><h3>${title}</h3><p>${detail}</p>${action}</div>`;
const readonlyNote = `<p class="hint">GhostPost reads your Buffer activity. Drafts and manual tasks are saved here. Publishing happens in Buffer or at your destination.</p>`;
function navigation() {
  return (["today", "queue", "composer", "history", "settings"] as View[])
    .map(
      (name) =>
        `<a href="#${name}" ${view === name ? 'aria-current="page"' : ""}>${{ today: "Home", queue: "Scheduled", composer: "Drafts", history: "History", settings: "Settings" }[name]}</a>`,
    )
    .join("");
}
function timeline() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
  const days = Array.from({ length: 10 }, (_, index) => {
    const d = new Date(start);
    d.setDate(d.getDate() + index);
    const key = dateKey(d.toISOString());
    const count = [...queue, ...history].filter(
      (post) => dateKey(post.sentAt || post.dueAt || post.createdAt) === key,
    ).length;
    return `<button data-action="day" data-id="${key}" class="day ${selectedDay === key ? "selected" : ""}" aria-pressed="${selectedDay === key}"><span>${d.toLocaleDateString([], { weekday: "short" })}</span><strong>${d.getDate()}</strong><i class="${count ? "has-post" : ""}"></i></button>`;
  }).join("");
  const posts = [...queue, ...history]
    .filter(
      (post) =>
        (!selectedDay ||
          dateKey(post.sentAt || post.dueAt || post.createdAt) ===
            selectedDay) &&
        (!channelFilter || post.channelId === channelFilter),
    )
    .sort(
      (a, b) =>
        new Date(a.sentAt || a.dueAt || a.createdAt).getTime() -
        new Date(b.sentAt || b.dueAt || b.createdAt).getTime(),
    )
    .slice(0, 12);
  return `<aside class="timeline" aria-label="Publishing timeline"><div class="section-label">YOUR PUBLISHING RHYTHM</div><h2>On the radar<span class="cyan">.</span></h2><p class="muted">${now.toLocaleDateString([], { month: "long", year: "numeric" })}</p><div class="days">${days}</div><label class="compact">Jump to date<input type="date" id="day-picker" value="${selectedDay}"></label>${selectedDay ? button("Clear date", "clear-day", "", "text-button") : ""}<div class="section-row"><h3>Activity</h3><small>${selectedDay ? escape(selectedDay) : "Loaded records"}</small></div><div class="timeline-items">${posts.length ? posts.map((post) => `<button class="timeline-item" data-action="prepare-post" data-id="${escape(post.id)}"><span class="dot ${post.status === "error" ? "danger" : ""}"></span><span><small>${escape(date(post.sentAt || post.dueAt))}</small><strong>${escape(post.text.slice(0, 65) || "Media post")}</strong><small>${escape(channels.find((ch) => ch.id === post.channelId)?.name || post.channelId)} · ${escape(post.status)}</small></span></button>`).join("") : `<div class="quiet">No activity loaded for this date. Refresh Buffer to see available records.</div>`}</div></aside>`;
}
function filters(includeStatus = true) {
  return `<div class="filters"><label><span class="sr-only">Search content</span><input id="search" type="search" placeholder="Search loaded content…" value="${escape(search)}"></label><label><span class="sr-only">Filter channel</span><select id="channel-filter"><option value="">All channels</option>${channels.map((ch) => `<option value="${escape(ch.id)}" ${ch.id === channelFilter ? "selected" : ""}>${escape(ch.name)}</option>`).join("")}</select></label>${includeStatus ? `<label><span class="sr-only">Filter status</span><select id="status-filter"><option value="">All statuses</option>${["scheduled", "sending", "needs_approval", "draft", "sent", "error"].map((status) => `<option ${statusFilter === status ? "selected" : ""}>${status}</option>`).join("")}</select></label>` : ""}${selectedDay ? badge(selectedDay) : ""}</div>`;
}
function filtered(posts: Post[]) {
  return posts.filter(
    (post) =>
      (!search || post.text.toLowerCase().includes(search.toLowerCase())) &&
      (!channelFilter || post.channelId === channelFilter) &&
      (!statusFilter || post.status === statusFilter) &&
      (!selectedDay ||
        dateKey(post.sentAt || post.dueAt || post.createdAt) === selectedDay),
  );
}
function postCard(post: Post) {
  const channel = channels.find((item) => item.id === post.channelId);
  return `<article class="post-card"><div class="post-top"><div class="avatar">${escape(channel?.service?.slice(0, 2).toUpperCase() || "B")}</div><div><strong>${escape(channel?.name || post.channelId)}</strong><small>${escape(channel?.service || "Buffer")} · ${escape(date(post.sentAt || post.dueAt || post.createdAt))}</small></div>${badge(post.status, post.status === "error" ? "bad" : post.status === "sent" ? "good" : "")}</div><p class="post-text">${escape(post.text || "Media-only post")}</p>${post.assets?.length ? `<p class="hint">${post.assets.length} media attachment(s) · ${escape([...new Set(post.assets.map((a) => a.mimeType))].join(", "))}</p>` : ""}<div class="actions">${button("Prepare cross-post", "prepare-post", `data-id="${escape(post.id)}"`, "subtle")}${button("Copy text", "copy-post", `data-id="${escape(post.id)}"`, "text-button")}${link(post.externalLink, "View post")}</div></article>`;
}
function taskCard(task: Item) {
  return `<article class="task-card"><div class="section-row"><strong>${escape(task.destinationName)}</strong>${badge(task.state === "complete" ? "User-reported complete" : "Manual · pending", task.state === "complete" ? "good" : "")}</div><p>${escape(task.text?.slice(0, 180))}</p><small>${task.completedAt ? escape(date(task.completedAt)) : "Open the destination, publish manually, then confirm completion."}</small><div class="actions">${button("Open task", "open-task", `data-id="${escape(task.id)}"`, "subtle")}${button("Archive", "archive", `data-kind="tasks" data-id="${escape(task.id)}"`, "text-button")}</div></article>`;
}
function todayView() {
  const posts = [...queue, ...history].filter(
    (post) => dateKey(post.sentAt || post.dueAt || post.createdAt) === today(),
  );
  const pending = active(ws.tasks).filter((task) => task.state !== "complete");
  const drafts = active(ws.drafts).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  );
  return `<section class="hero panel"><div><span class="section-label">YOUR PUBLISHING WORKSPACE</span><h1>Your next post,<br><em>without the clutter.</em></h1><p>Write a draft, check your schedule, and keep track of what’s next.</p><div class="actions">${button("＋ Write a draft", "new", "", "primary")}${linked ? button("View scheduled posts", "queue", "", "subtle") : button(configured ? "Connect Buffer" : "Set up Buffer", configured ? "connect" : "settings", "", "subtle")}</div></div><div class="hero-ghost" aria-hidden="true">${ghost}</div></section>
  <section class="connection-strip panel" aria-label="Buffer connection"><div><strong>${linked ? (reconnect ? "Buffer needs reconnecting" : "Buffer connected") : configured ? "Connect your Buffer account" : "Buffer setup needs finishing"}</strong><p>${linked ? (lastSync ? "Updated " + escape(date(lastSync)) : "Refresh to load your channels and posts.") : configured ? "Bring your channels, scheduled posts, and history into GhostPost." : "The new deployment needs its Buffer app credentials. You can still work on your drafts."}</p></div>${button(linked ? (reconnect ? "Reconnect" : "Refresh") : configured ? "Connect Buffer" : "View setup", linked ? (reconnect ? "connect" : "sync") : configured ? "connect" : "settings", busy ? "disabled" : "", "subtle")}</section>
  <div class="home-grid"><section><div class="section-row"><h2>Recent drafts</h2>${button("All drafts", "drafts", "", "text-button")}</div>${
    drafts
      .slice(0, 3)
      .map(
        (d) =>
          `<article class="post-card"><h3>${escape(d.title)}</h3><p>${escape(d.text?.slice(0, 160))}</p>${button("Continue writing", "edit-draft", `data-id="${escape(d.id)}"`, "subtle")}</article>`,
      )
      .join("") ||
    noData(
      "Start with an idea",
      "Your saved drafts will be right here.",
      button("Write your first draft", "new", "", "subtle"),
    )
  }</section><section><div class="section-row"><h2>Today’s posts</h2><small>${escape(new Date().toLocaleDateString())}</small></div>${
    posts.length
      ? posts
          .sort((a, b) => (a.dueAt || "").localeCompare(b.dueAt || ""))
          .map(postCard)
          .join("")
      : `<div class="panel quiet">${linked ? "No posts loaded for today. Refresh Buffer to check for updates." : "Your Buffer posts will appear here after you connect."}</div>`
  }${pending.length ? `<div class="section-row"><h2>Post by hand</h2>${badge(pending.length + " pending")}</div>${pending.map(taskCard).join("")}` : ""}</section></div>
  <details class="help-panel panel"><summary>How GhostPost works</summary><p>Save a draft here, check your publishing activity in Buffer, or prepare a copy for another destination. Open that destination to publish, then return to record completion. Planning dates are reminders; they do not schedule a post.</p></details>`;
}
function queueView() {
  const posts = filtered(queue);
  return `<div class="view-title"><div class="section-label">KNOW WHAT’S COMING</div><h1>Your queue<span class="pink">.</span></h1><p>Scheduled, in-flight, approval and draft records from Buffer.</p></div>${filters()}<div class="actions">${button(busy ? "Refreshing…" : "Refresh queue", "sync-queue", busy || !linked ? "disabled" : "", "subtle")}</div>${posts.length ? posts.map(postCard).join("") : noData("No queue records to show", queueLoaded ? "Nothing matches these filters in the loaded pages." : "Connect Buffer and refresh the queue to load available posts.")}${queueCursor ? button("Load more queue records", "more-queue", busy ? "disabled" : "", "subtle wide") : ""}`;
}
function field(
  label: string,
  name: string,
  value: unknown = "",
  extra = "",
  type = "text",
) {
  return `<label>${label}<input type="${type}" name="${name}" value="${escape(value)}" ${extra}></label>`;
}
function composerView() {
  return `<div class="view-title"><div class="section-label">THOUGHT → DRAFT → DESTINATION</div><h1>Your drafts<span class="cyan">.</span></h1><p>Save a GhostPost draft, then adapt it for a manual destination.</p></div><form id="composer-form" class="panel"><div class="section-row"><h2>${editor.id ? "Edit draft" : "New draft"}</h2>${badge(dirty ? "Unsaved changes" : editor.id ? "Saved draft" : "Draft-first")}</div>${field("Draft title", "title", editor.title, 'required maxlength="120"')}<label>Content<textarea name="text" rows="8" required maxlength="10000" placeholder="What do you want to put out into the world?">${escape(editor.text)}</textarea></label><div class="section-row"><small id="char-count">${editor.text?.length || 0} / 10,000 characters</small><small>${user ? 'Private draft · not published' : 'Sign in to save this draft'}</small></div><details class="draft-options"><summary>Platform, campaign & reminder</summary><div class="form-grid"><label>Platform<select name="platform">${["general", "linkedin", "facebook", "reddit", "instagram", "threads", "bluesky", "twitter", "other"].map((p) => `<option ${editor.platform === p ? "selected" : ""}>${p}</option>`).join("")}</select></label>${field("Campaign / tags", "campaign", editor.campaign, 'maxlength="80"')}${field("Planning date (reminder only)", "plannedAt", localInput(editor.plannedAt), "", "datetime-local")}</div><p class="hint">Planning dates do not schedule publishing. Platform limits and media requirements must be checked at the destination.</p></details><div class="actions"><button class="primary" ${!user || busy ? "disabled" : ""}>${busy ? "Saving…" : "Save draft"}</button>${button("Copy text", "copy-editor", "", "subtle")}${button("New draft", "new", "", "text-button")}</div>${!user ? '<p class="hint">Sign in to save account-owned drafts.</p>' : ""}</form><details class="panel preview"><summary>Preview your draft</summary><p id="content-preview" class="post-text">${escape(editor.text || "Your words will appear here.")}</p></details><div class="section-row"><h2>Draft library</h2>${badge(active(ws.drafts).length + " drafts")}</div><label><span class="sr-only">Search drafts</span><input id="draft-search" type="search" placeholder="Search drafts by title, text or campaign…" value="${escape(search)}"></label>${
    active(ws.drafts)
      .filter((d) =>
        [d.title, d.text, d.campaign]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(
        (d) =>
          `<article class="post-card"><div class="section-row"><h3>${escape(d.title)}</h3>${badge(d.campaign || "GhostPost")}</div><p class="post-text">${escape(d.text?.slice(0, 240))}</p><small>${escape(d.platform)} · ${d.plannedAt ? "Planned " + escape(date(d.plannedAt)) : "Unscheduled"}</small><div class="actions">${button("Edit", "edit-draft", `data-id="${escape(d.id)}"`, "subtle")}${button("Cross-post", "prepare-draft", `data-id="${escape(d.id)}"`, "subtle")}${button("Duplicate", "duplicate", `data-id="${escape(d.id)}"`, "text-button")}${button("Archive", "archive", `data-kind="drafts" data-id="${escape(d.id)}"`, "text-button")}</div></article>`,
      )
      .join("") ||
    noData(
      "Room for your next idea",
      "Saved drafts will appear here. They remain separate from Buffer drafts.",
    )
  }`;
}
function historyView() {
  const posts = filtered(history);
  return `<div class="view-title"><div class="section-label">A RECORD OF THE WORK</div><h1>Publishing history<span class="pink">.</span></h1><p>API-reported Buffer activity and your own manual completion records.</p></div>${filters()}<div class="actions">${button("Refresh history", "sync-history", busy || !linked ? "disabled" : "", "subtle")}</div>${posts.length ? posts.map(postCard).join("") : noData("No Buffer history loaded", historyLoaded ? "No records match your current filters." : "Refresh history to retrieve published and failed posts.")}${historyCursor ? button("Load more history", "more-history", busy ? "disabled" : "", "subtle wide") : ""}<div class="section-row"><h2>Manual posting log</h2><small>User-reported, never API-verified</small></div>${
    active(ws.tasks)
      .filter(
        (task) =>
          (!search ||
            [task.text, task.destinationName, task.notes]
              .join(" ")
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (!selectedDay ||
            dateKey(task.completedAt || task.createdAt || 0) === selectedDay),
      )
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(taskCard)
      .join("") ||
    '<div class="panel quiet">No manual posting records yet.</div>'
  }`;
}
function bufferSetup() {
  return `<div class="setup-notice" role="status"><h3>Finish connecting this deployment</h3><p>GhostPost is live, but the Buffer app credentials have not been added to Vercel yet. The deployment owner needs to finish these steps once.</p><ol><li>Add <code>BUFFER_CLIENT_ID</code> and <code>BUFFER_CLIENT_SECRET</code> as sensitive Production environment variables in <a href="https://vercel.com/xfactor21s-projects/ghostpost/settings/environment-variables" target="_blank" rel="noopener noreferrer">Vercel settings ↗</a>.</li><li>Add this redirect URL to the existing Buffer developer app:<code class="callback-url">https://ghostpost.planet-x.co/api/auth/buffer/callback</code>${button("Copy redirect URL", "copy-callback", "", "text-button")}</li><li>Redeploy GhostPost, then choose Connect Buffer.</li></ol><small>Use the existing client credentials. Keep them out of drafts, exports, and chat.</small></div>`;
}
function settingsView() {
  const archived = (["drafts", "destinations", "tasks"] as const).flatMap(
    (kind) =>
      ws[kind].filter((item) => item.archived).map((item) => ({ kind, item })),
  );
  return `<div class="view-title"><div class="section-label">YOUR WORKSPACE, YOUR RULES</div><h1>Settings<span class="cyan">.</span></h1></div><section class="panel"><div class="section-row"><h2>Buffer connection</h2>${badge(linked ? (reconnect ? "Reconnect needed" : "Linked") : "Not linked", linked && !reconnect ? "good" : "")}</div><p>${escape(user?.email || user?.name || "Sign in to use a private GhostPost workspace.")}</p><small>Connected: ${connectedAt ? escape(date(connectedAt)) : 'Not connected'}</small>${accountId ? `<p class="hint">Buffer account: ${escape(accountId)}</p>` : ""}${readonlyNote}${!configured ? bufferSetup() : ""}<div class="actions">${configured ? button(linked ? "Reconnect Buffer" : "Connect Buffer", "connect", busy ? "disabled" : "", "primary") : button("Check setup again", "check-setup", busy ? "disabled" : "", "subtle")}${button("Refresh channels", "sync", busy || !linked ? "disabled" : "", "subtle")}${linked ? button("Disconnect", "disconnect", busy ? "disabled" : "", "danger-button") : ""}${user ? button("Sign out", "signout", "", "text-button") : ""}</div>${organizations.length > 1 ? `<label>Buffer organization<select id="org">${organizations.map((org) => `<option value="${escape(org.id)}" ${org.id === organizationId ? "selected" : ""}>${escape(org.name)}</option>`).join("")}</select></label>` : ""}<p class="hint">Last successful sync: ${lastSync ? escape(date(lastSync)) : 'Not synced yet'}. ${escape(syncError)}</p></section><section class="panel"><h2>Channels</h2>${channels.length ? channels.map((ch) => `<div class="channel"><span class="avatar">${url(ch.avatar) ? `<img src="${escape(url(ch.avatar))}" alt="" referrerpolicy="no-referrer" loading="lazy">` : escape(ch.service.slice(0, 2).toUpperCase())}</span><div><strong>${escape(ch.name)}</strong><small>${escape(ch.service)} · ${escape(ch.timezone)}</small></div>${badge(ch.isDisconnected ? "Disconnected" : ch.isLocked ? "Locked" : ch.isQueuePaused ? "Queue paused" : "Connected", ch.isDisconnected || ch.isLocked ? "bad" : "good")}<small>${ch.canScheduleInBuffer ? "Scheduling allowed in Buffer" : "Scheduling unavailable"}</small></div>`).join("") : '<p class="quiet">No channels loaded. Refresh after connecting Buffer.</p>'}</section><section class="panel"><h2>Manual destinations</h2><p>Reddit, personal profiles, communities, or any HTTPS destination. GhostPost never logs in to these sites for you.</p>${active(
    ws.destinations,
  )
    .map(
      (d) =>
        `<div class="destination"><div><strong>${escape(d.name)}</strong><small>${escape(d.platform)} · ${d.active === false ? "Inactive" : "Active"}</small><small>${escape(d.url)}</small></div><div class="actions">${button("Edit", "edit-destination", `data-id="${escape(d.id)}"`, "subtle")}${button("Archive", "archive", `data-kind="destinations" data-id="${escape(d.id)}"`, "text-button")}</div></div>`,
    )
    .join(
      "",
    )}<form id="destination-form"><h3>${destinationEditor.id ? "Edit destination" : "Add a destination"}</h3><div class="form-grid">${field("Destination name", "name", destinationEditor.name, 'required maxlength="100"')}${field("Platform", "platform", destinationEditor.platform, 'required maxlength="40"')}</div>${field("Destination URL", "url", destinationEditor.url, 'required maxlength="2048" placeholder="https://www.reddit.com/r/yourcommunity/"', "url")}${field("Preferred content format", "format", destinationEditor.format, 'maxlength="120"')}<label>Posting instructions<textarea name="instructions" rows="2" maxlength="2000">${escape(destinationEditor.instructions)}</textarea></label><label>Notes<textarea name="notes" rows="2" maxlength="2000">${escape(destinationEditor.notes)}</textarea></label><label class="check"><input type="checkbox" name="active" ${destinationEditor.active !== false ? "checked" : ""}> Active destination</label><div class="actions"><button class="primary" ${busy || !user ? "disabled" : ""}>Save destination</button>${button("Clear form", "new-destination", "", "text-button")}</div></form></section><section class="panel"><h2>Data & security</h2><p>Buffer credentials stay encrypted on the server. GhostPost data is scoped to your signed-in account. Disconnect clears stored credentials; revoke the grant in Buffer settings to remove upstream authorization.</p><p class="hint">This alpha supports up to 100 records per collection and 220 KB per workspace. Export includes your drafts, destinations and manual records, without credentials.</p><div class="actions">${button("Export workspace JSON", "export", !user ? "disabled" : "", "subtle")}${button("Import workspace JSON", "import", !user || busy ? "disabled" : "", "subtle")}${button("Reload workspace", "reload-workspace", !user || busy ? "disabled" : "", "subtle")}<a class="button subtle" href="/privacy" target="_blank" rel="noopener noreferrer">Privacy policy ↗</a></div><h3>Recoverable archive</h3>${archived.map(({ kind, item }) => `<div class="archive-row"><span>${escape(item.title || item.name || item.destinationName)} <small>(${kind})</small></span>${button("Restore", "restore", `data-kind="${kind}" data-id="${escape(item.id)}"`, "text-button")}</div>`).join("") || '<p class="quiet">Archive is empty.</p>'}</section>`;
}
function preparePanel() {
  if (!prepare) return "";
  const dest = ws.destinations.find((d) => d.id === prepare!.destinationId);
  return `<dialog open id="manual-dialog" aria-labelledby="manual-title"><div class="section-row"><div><span class="section-label">THE HUMAN LAST MILE</span><h2 id="manual-title">Prepare a cross-post</h2></div>${button("Close", "close-prepare", 'aria-label="Close manual cross-post"', "subtle")}</div><p class="hint">1. Review → 2. Copy → 3. Open destination → 4. Publish manually → 5. Return and mark complete.</p>${message ? `<div class="notice" role="alert">${escape(message)}</div>` : ""}<form id="manual-form"><label>Destination<select name="destinationId" required><option value="">Select an active destination</option>${active(
    ws.destinations,
  )
    .filter((d) => d.active !== false || d.id === prepare!.destinationId)
    .map(
      (d) =>
        `<option value="${escape(d.id)}" ${d.id === prepare!.destinationId ? "selected" : ""}>${escape(d.name)} · ${escape(d.platform)}</option>`,
    )
    .join(
      "",
    )}</select></label>${!active(ws.destinations).length ? `<p>Add a destination in Settings first.</p>${button("Open Settings", "destinations", "", "subtle")}` : ""}${dest ? `<div class="notice"><strong>${escape(dest.format || "Destination guidance")}</strong><p>${escape(dest.instructions || "Review this destination’s current posting rules before publishing.")}</p><small>${escape(dest.notes)}</small></div>` : ""}<label>Destination-specific copy<textarea name="text" rows="7" required maxlength="10000">${escape(prepare.text)}</textarea></label><small id="manual-count">${prepare.text?.length || 0} characters</small>${field("Published URL (optional)", "resultUrl", prepare.resultUrl, 'maxlength="2048"', "url")}<label>Completion notes<textarea name="notes" rows="2" maxlength="2000">${escape(prepare.notes)}</textarea></label><div class="actions">${button("Copy caption", "copy-task", "", "subtle")}${link(dest?.url || prepare.destinationUrl, "Open destination")}<button class="primary" ${busy || !user ? "disabled" : ""}>Save manual task</button></div>${prepare.id ? `<div class="completion"><label class="check"><input type="checkbox" name="confirmed" id="manual-confirm"> I published this myself and want to record completion.</label>${button(prepare.state === "complete" ? "Reopen task" : "Mark complete", "complete-task", busy ? "disabled" : "", "subtle")}<p class="hint">Completion is your report, not confirmation from the social platform.</p></div>` : '<p class="hint">Save this task before recording completion.</p>'}</form></dialog><div class="modal-backdrop"></div>`;
}
function render() {
  if (booting) return;
  const focus = document.activeElement as HTMLInputElement | null;
  const focusId = focus?.id;
  const selection = focus?.selectionStart;
  app.innerHTML = `<header class="topbar"><a href="#today" class="wordmark"><span class="brand-ghost">${ghost}</span><span>Ghost<span class="pink">Post</span><small>by planet.X <b>✕</b> <i>v0.3.1 · alpha</i></small></span></a><nav aria-label="Workspace">${navigation()}</nav><div class="account">${badge(linked ? "Buffer connected" : configured ? "Buffer not connected" : "Buffer setup needed", linked ? "good" : "")}${button(user ? user.name?.split(" ")[0] || "Account" : "Sign in", user ? "account" : "signin", busy ? "disabled" : "", "subtle")}</div></header>${!user ? `<div class="signin-banner"><span><strong>Your publishing flow starts here.</strong> Sign in for private drafts, destinations and Buffer activity.</span>${button("Sign in to GhostPost", "signin", busy ? "disabled" : "", "primary")}</div>` : ""}${message ? `<div class="alert" role="alert"><span>${escape(message)}</span>${button("Dismiss", "dismiss", "", "text-button")}</div>` : ""}${!navigator.onLine ? '<div class="alert">You’re offline. Keep this page open to preserve unsaved text. Saving and Buffer sync need a connection.</div>' : ""}<div class="workspace workspace-simple"><main id="main" tabindex="-1">${view === "queue" || view === "history" ? `<details class="calendar-panel panel" ${selectedDay ? "open" : ""}><summary>Filter by date${selectedDay ? " · " + escape(selectedDay) : ""}</summary>${timeline()}</details>` : ""}${{ today: todayView, queue: queueView, composer: composerView, history: historyView, settings: settingsView }[view]()}</main></div>${preparePanel()}`;
  if (
    focusId &&
    [
      "search",
      "draft-search",
      "channel-filter",
      "status-filter",
      "day-picker",
    ].includes(focusId)
  ) {
    const target = document.getElementById(focusId) as HTMLInputElement | null;
    target?.focus();
    if (
      target &&
      ["search", "draft-search"].includes(focusId) &&
      selection !== null &&
      selection !== undefined
    )
      target.setSelectionRange(selection, selection);
  }
  const dialog = document.querySelector<HTMLDialogElement>("#manual-dialog");
  if (dialog && !dialog.matches(":modal")) {
    dialog.close();
    dialog.showModal();
  }
}
async function save(
  kind: keyof Pick<Workspace, "drafts" | "destinations" | "tasks">,
  item: Item,
) {
  if (!user) throw new Error("Sign in to save your workspace.");
  await verifyAccount();
  const id = item.id || crypto.randomUUID();
  const response = await api.put(`/api/workspace/${kind}/${id}`, {
    ...item,
    revision: ws.revision,
  });
  ws = response.data;
  return ws[kind].find((record) => record.id === id)!;
}
async function loadWorkspace() {
  ws = (await api.get("/api/workspace")).data;
}
async function loadConnection() {
  const result = (await api.get("/api/buffer/me")).data;
  linked = result.connected;
  reconnect = result.reconnectRequired;
  connectedAt = result.connectedAt;
  lastSync = result.sync?.syncedAt || null;
  syncError = result.lastError?.message || "";
}
async function sync(mode: "channels" | "queue" | "history", more = false) {
  if (!linked) throw new Error("Connect Buffer in Settings first.");
  try {
    const result = (
      await api.post("/api/buffer/sync", {
        mode,
        organizationId,
        after: more ? (mode === "queue" ? queueCursor : historyCursor) : "",
      })
    ).data;
    organizations = result.organizations;
    organizationId = result.organizationId || "";
    accountId = result.accountId || "";
    if (mode === "channels") channels = result.channels || [];
    else {
      const old = more ? (mode === "queue" ? queue : history) : [];
      const records = [
        ...new Map(
          [...old, ...(result.posts || [])].map((post: Post) => [
            post.id,
            post,
          ]),
        ).values(),
      ] as Post[];
      const cursor = result.pageInfo?.hasNextPage
        ? result.pageInfo.endCursor || ""
        : "";
      if (mode === "queue") {
        queue = records;
        queueCursor = cursor;
        queueLoaded = true;
      } else {
        history = records;
        historyCursor = cursor;
        historyLoaded = true;
      }
    }
    lastSync = result.syncedAt;
    syncError = "";
    toast("Buffer " + mode + " synchronized.");
  } catch (err) {
    syncError = errorMessage(err);
    throw err;
  }
}
async function refreshBuffer() {
  await sync("channels");
  if (!organizationId) return;
  await sync("queue");
  await sync("history");
}
async function verifyAccount() {
  const current = await auth.getUser();
  if (current?.userId !== user?.userId) {
    ws = emptyWorkspace();
    channels = [];
    queue = [];
    history = [];
    editor = { id: "", title: "", text: "" };
    prepare = null;
    dirty = false;
    app.innerHTML =
      '<main class="boot" role="status">Account changed. Restoring your workspace…</main>';
    location.reload();
    throw new Error("Your account changed. Reloading the workspace.");
  }
}
function navigate(next: View) {
  if (view !== next) {
    search = "";
    statusFilter = "";
  }
  location.hash = next;
  view = next;
  render();
}
async function copy(value = "") {
  if (!value.trim()) {
    toast("Add some content first.");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast("Caption copied. Publish manually at your destination.");
  } catch {
    toast("Clipboard unavailable. Select the caption and copy it manually.");
  }
}
function openPrepare(item: Item, ref: string) {
  message = "";
  prepare = {
    id: "",
    text: item.text || "",
    contentRef: ref,
    notes: "",
    resultUrl: "",
    destinationId: "",
  };
  render();
  document.querySelector<HTMLSelectElement>("#manual-form select")?.focus();
}
async function saveDraft() {
  editor = await save("drafts", {
    ...editor,
    plannedAt: editor.plannedAt ? new Date(editor.plannedAt).toISOString() : "",
  });
  dirty = false;
  toast("Draft saved to your GhostPost account.");
}
app.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  const form = target.closest("form")?.id;
  if (form === "composer-form") {
    editor = { ...editor, [target.name]: target.value };
    dirty = true;
    const count = document.getElementById("char-count");
    if (count)
      count.textContent = `${editor.text?.length || 0} / 10,000 characters · unsaved`;
    const preview = document.getElementById("content-preview");
    if (preview)
      preview.textContent = editor.text || "Your words will appear here.";
  }
  if (form === "destination-form")
    destinationEditor = {
      ...destinationEditor,
      [target.name]: target.type === "checkbox" ? target.checked : target.value,
    };
  if (form === "manual-form" && prepare && target.name !== "confirmed") {
    prepare = { ...prepare, [target.name]: target.value };
    const count = document.getElementById("manual-count");
    if (count) count.textContent = `${prepare.text?.length || 0} characters`;
  }
  if (target.id === "search" || target.id === "draft-search") {
    search = target.value;
    render();
  }
});
app.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === "channel-filter") {
    channelFilter = target.value;
    render();
  }
  if (target.id === "status-filter") {
    statusFilter = target.value;
    render();
  }
  if (target.id === "day-picker") {
    selectedDay = target.value;
    render();
  }
  if (target.name === "destinationId" && prepare) {
    prepare.destinationId = target.value;
    render();
  }
  if (target.id === "org")
    void run(async () => {
      organizationId = target.value;
      channels = [];
      queue = [];
      history = [];
      queueCursor = "";
      historyCursor = "";
      queueLoaded = false;
      historyLoaded = false;
      await refreshBuffer();
    });
});
app.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  if (!form.reportValidity()) return;
  void run(async () => {
    if (form.id === "composer-form") await saveDraft();
    if (form.id === "destination-form") {
      await save("destinations", destinationEditor);
      destinationEditor = {
        id: "",
        name: "",
        platform: "Reddit",
        active: true,
      };
      toast("Destination saved.");
    }
    if (form.id === "manual-form" && prepare) {
      const dest = ws.destinations.find((d) => d.id === prepare!.destinationId);
      if (!dest) throw new Error("Select a destination.");
      prepare = await save("tasks", {
        ...prepare,
        destinationName: dest.name,
        destinationUrl: dest.url,
      });
      toast("Manual task saved. No content was published.");
    }
  });
});
app.addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLElement>(
    "[data-action]",
  );
  if (!target) return;
  const confirmed = Boolean(
    document.querySelector<HTMLInputElement>("#manual-confirm")?.checked,
  );
  const action = target.dataset.action;
  const id = target.dataset.id;
  const kind = target.dataset.kind as "drafts" | "destinations" | "tasks";
  const post = [...queue, ...history].find((item) => item.id === id);
  if (action === "dismiss") {
    message = "";
    render();
    return;
  }
  if (action === "today" || action === "settings" || action === "account") {
    navigate(action === "today" ? "today" : "settings");
    return;
  }
  if (action === "queue" || action === "drafts") {
    navigate(action === "queue" ? "queue" : "composer");
    return;
  }
  if (action === "copy-callback") {
    void copy("https://ghostpost.planet-x.co/api/auth/buffer/callback");
    return;
  }
  if (action === "connect" && !configured) {
    navigate("settings");
    toast("Finish the Buffer setup shown here first.");
    return;
  }
  if (action === "new") {
    if (dirty && !confirm("Discard unsaved draft changes?")) return;
    editor = { id: "", title: "", text: "", platform: "general" };
    dirty = false;
    navigate("composer");
    return;
  }
  if (action === "day") {
    selectedDay = id || "";
    render();
    return;
  }
  if (action === "clear-day") {
    selectedDay = "";
    render();
    return;
  }
  if (action === "edit-draft") {
    if (dirty && !confirm("Discard unsaved draft changes?")) return;
    editor = { ...ws.drafts.find((d) => d.id === id)! };
    dirty = false;
    navigate("composer");
    return;
  }
  if (action === "edit-destination") {
    destinationEditor = { ...ws.destinations.find((d) => d.id === id)! };
    render();
    document
      .getElementById("destination-form")
      ?.scrollIntoView({ behavior: "auto", block: "center" });
    return;
  }
  if (action === "new-destination") {
    destinationEditor = { id: "", name: "", platform: "Reddit", active: true };
    render();
    return;
  }
  if (action === "prepare-post" && post) {
    openPrepare({ id: "", text: post.text }, "buffer:" + post.id);
    return;
  }
  if (action === "prepare-draft") {
    openPrepare(ws.drafts.find((d) => d.id === id)!, "draft:" + id);
    return;
  }
  if (action === "open-task") {
    prepare = { ...ws.tasks.find((t) => t.id === id)! };
    render();
    return;
  }
  if (action === "close-prepare") {
    if (
      confirm("Close this task editor? Unsaved task changes will be discarded.")
    ) {
      prepare = null;
      render();
    }
    return;
  }
  if (action === "destinations") {
    prepare = null;
    navigate("settings");
    return;
  }
  if (action === "copy-post") {
    void copy(post?.text);
    return;
  }
  if (action === "copy-editor") {
    void copy(editor.text);
    return;
  }
  if (action === "copy-task") {
    void copy(prepare?.text);
    return;
  }
  void run(async () => {
    if (action !== "signin" && user) await verifyAccount();
    if (action === "signin") {
      await auth.signInWithRedirect();
      return;
    }
    if (action === "check-setup") {
      configured = (await api.get("/api/buffer/status")).data.configured;
      toast(
        configured
          ? "Buffer is ready. You can connect now."
          : "Buffer credentials are still missing from this deployment.",
      );
      return;
    }
    if (action === "connect") {
      if (!user) {
        await auth.signInWithRedirect();
        return;
      }
      if (!configured) throw new Error("Buffer configuration is incomplete.");
      const result = (await api.post("/api/buffer/start", {})).data;
      const targetUrl = new URL(result.authorizationUrl);
      if (
        targetUrl.origin !== "https://auth.buffer.com" ||
        targetUrl.pathname !== "/auth"
      )
        throw new Error("Invalid authorization destination.");
      location.assign(targetUrl.href);
    }
    if (
      action === "disconnect" &&
      confirm(
        "Disconnect Buffer and remove its stored credentials? Your GhostPost drafts and manual records will remain.",
      )
    ) {
      await api.post("/api/buffer/disconnect", {});
      linked = false;
      reconnect = false;
      connectedAt = null;
      channels = [];
      queue = [];
      history = [];
      queueCursor = "";
      historyCursor = "";
      lastSync = null;
      accountId = "";
      organizations = [];
      organizationId = "";
      queueLoaded = false;
      historyLoaded = false;
      toast("Buffer disconnected. Stored credentials removed.");
    }
    if (action === "signout") {
      if (dirty && !confirm("Sign out and discard unsaved draft changes?"))
        return;
      await auth.signOut();
      user = null;
      ws = emptyWorkspace();
      channels = [];
      queue = [];
      history = [];
      editor = { id: "", text: "", title: "", platform: "general" };
      destinationEditor = { id: "", platform: "Reddit", active: true };
      prepare = null;
      dirty = false;
      linked = false;
      lastSync = null;
      accountId = "";
      organizationId = "";
      organizations = [];
      connectedAt = null;
      syncError = "";
      message = "";
      queueCursor = "";
      historyCursor = "";
      navigate("today");
    }
    if (action === "sync") await refreshBuffer();
    if (action === "sync-queue" || action === "more-queue")
      await sync("queue", action === "more-queue");
    if (action === "sync-history" || action === "more-history")
      await sync("history", action === "more-history");
    if (action === "save") {
      if (
        document
          .querySelector<HTMLFormElement>("#composer-form")
          ?.reportValidity()
      )
        await saveDraft();
    }
    if (action === "duplicate") {
      const original = ws.drafts.find((d) => d.id === id)!;
      await save("drafts", {
        ...original,
        id: "",
        title: (original.title || "Draft").slice(0, 110) + " (copy)",
      });
      toast("Draft duplicated.");
    }
    if (
      action === "archive" &&
      confirm("Move this record to the recoverable archive?")
    ) {
      const record = ws[kind].find((item) => item.id === id);
      if (!record)
        throw new Error(
          "This record is no longer available. Reload your workspace.",
        );
      await save(kind, { ...record, archived: true });
      toast("Archived. Restore it in Settings.");
    }
    if (action === "restore") {
      await save(kind, {
        ...ws[kind].find((item) => item.id === id)!,
        archived: false,
      });
      toast("Record restored.");
    }
    if (action === "complete-task" && prepare) {
      if (prepare.state !== "complete" && !confirmed)
        throw new Error(
          "Confirm you published the content yourself before recording completion.",
        );
      const destination = ws.destinations.find(
        (item) => item.id === prepare!.destinationId,
      );
      if (!destination)
        throw new Error(
          "Select an available destination before recording completion.",
        );
      prepare = await save("tasks", {
        ...prepare,
        destinationName: destination.name,
        destinationUrl: destination.url,
        state: prepare.state === "complete" ? "pending" : "complete",
      });
      toast(
        prepare.state === "complete"
          ? "Recorded as user-reported completion."
          : "Task reopened.",
      );
    }
    if (action === "reload-workspace") {
      await loadWorkspace();
      toast("Workspace reloaded. Unsaved editor text is preserved.");
    }
    if (action === "import") {
      if (
        dirty &&
        !confirm(
          "Import will refresh your workspace. Unsaved editor text will remain. Continue?",
        )
      )
        return;
      const file = await new Promise<File | null>((resolve) => {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.accept = ".json,application/json";
        picker.onchange = () => resolve(picker.files?.[0] || null);
        picker.addEventListener("cancel", () => resolve(null), { once: true });
        picker.click();
      });
      if (!file) return;
      if (file.size > 240000)
        throw new Error("Choose a workspace export smaller than 240 KB.");
      const exported = JSON.parse(await file.text());
      if (exported.application !== "GhostPost" || !exported.workspace)
        throw new Error("Choose a GhostPost workspace export.");
      const source = exported.workspace;
      const counts = ["drafts", "destinations", "tasks"]
        .map((kind) => {
          if (!Array.isArray(source[kind]))
            throw new Error("Invalid workspace export.");
          return source[kind].length + " " + kind;
        })
        .join(", ");
      if (
        !confirm(
          "Import " +
            counts +
            " into this account? Existing records are preserved. Overlapping records will stop the import.",
        )
      )
        return;
      const result = (
        await api.post("/api/workspace/import", {
          revision: ws.revision,
          workspace: source,
        })
      ).data;
      ws = result.workspace;
      toast("Workspace imported. Buffer credentials were not included.");
    }
    if (action === "export") {
      const blob = new Blob(
        [
          JSON.stringify(
            {
              application: "GhostPost",
              version: "0.3.1",
              exportedAt: new Date().toISOString(),
              workspace: ws,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "GhostPost-11.14-v0.3.1-workspace.json";
      a.click();
      URL.revokeObjectURL(href);
      toast("Workspace export created without credentials.");
    }
  });
});
window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1) as View;
  if (["today", "queue", "composer", "history", "settings"].includes(next)) {
    if (view !== next) {
      search = "";
      statusFilter = "";
    }
    view = next;
  }
  render();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !booting) void verifyAccount().catch(() => undefined);
});
window.addEventListener("online", render);
window.addEventListener("offline", render);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && prepare) {
    event.preventDefault();
    if (confirm("Close this task editor? Unsaved changes will be discarded.")) {
      prepare = null;
      render();
    }
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key === "s" &&
    view === "composer"
  ) {
    event.preventDefault();
    void run(saveDraft);
  }
});
async function init() {
  const query = new URLSearchParams(location.search);
  // Only the dedicated Buffer callback redirect sets this marker. Generic
  // code/state parameters are not interpreted as Buffer callbacks.
  const bufferCallback = query.get("gp_buffer") === "1";
  const callback = bufferCallback
    ? {
        state: query.get("gp_state"),
        code: query.get("gp_code"),
        error: query.get("gp_error"),
      }
    : null;
  if (bufferCallback) historyReplace();
  try {
    user = await auth.getUser();
    configured = (await api.get("/api/buffer/status")).data.configured;
    if (callback) {
      if (!user)
        message =
          "Your GhostPost session expired. Sign in, then start Connect Buffer again.";
      else if (!callback.state || (!callback.code && !callback.error))
        message =
          "Buffer authorization was incomplete. Start Connect Buffer again.";
      else {
        try {
          const result = (await api.post("/api/buffer/finish", callback)).data;
          message = result.message;
        } catch (err) {
          message = errorMessage(err);
        }
      }
    }
    if (user) {
      await loadWorkspace();
      await loadConnection();
    }
  } catch (err) {
    message = errorMessage(err);
  }
  view = ["today", "queue", "composer", "history", "settings"].includes(
    location.hash.slice(1),
  )
    ? (location.hash.slice(1) as View)
    : "today";
  booting = false;
  render();
  if (user && linked && !reconnect) await run(refreshBuffer);
}
function historyReplace() {
  window.history.replaceState(null, "", "/" + location.hash);
}
void init();
