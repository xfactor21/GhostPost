import {
  campaignGroups,
  campaignKey,
  campaignMinute,
  postTime,
} from "../shared/campaigns";
import {
  mediaPath,
  mediaExtension,
  type MediaAsset,
  type SourceReference,
} from "../shared/media";
import { downloadAssets } from "./downloads";
import { shareLaunch, variantFor } from "../shared/handoff";
import { api, auth } from "./client";

type Item = SourceReference & {
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
  contentItemId?: string | null;
  ideaId?: string | null;
  assets?: MediaAsset[];
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
let taskSourcePost: Post | null = null;
let toastTimer: ReturnType<typeof setTimeout>;
let coachVisible = false;
let batchPost: Post | null = null;
let batchDirty = false;
let batchSourceId = "";
let expandedCampaigns = new Set<string>();
const selectedCampaignVersion = new Map<string, string>();
const mediaSelected = new Map<string, Set<string>>();
function mediaPreview(post: Post) {
  const assets = post.assets || [];
  if (!assets.length)
    return `<div class="campaign-media-empty"><small>No media returned for this platform version.</small></div>`;
  const selected =
    mediaSelected.get(post.id) || new Set(assets.map((a) => a.key));
  return `<section class="media-gallery" aria-label="Media for this platform version"><div class="media-grid">${assets.map((asset, index) => `<figure class="media-attachment"><label class="check"><input type="checkbox" data-media-post="${escape(post.id)}" data-media-key="${escape(asset.key)}" ${selected.has(asset.key) ? "checked" : ""}>Attachment ${index + 1}</label>${asset.mimeType.startsWith("video/") ? `<video controls preload="none" ${asset.thumbnail ? `poster="${escape(mediaPath(post.id, asset.key, true))}"` : ""} src="${escape(mediaPath(post.id, asset.key))}" aria-label="Video attachment ${index + 1}"></video>` : asset.thumbnail || asset.mimeType.startsWith("image/") ? `<img loading="lazy" src="${escape(mediaPath(post.id, asset.key, Boolean(asset.thumbnail)))}" alt="Attachment ${index + 1} preview" data-media-preview>` : "<p>Preview unavailable</p>"}<figcaption>${escape(asset.mimeType)}<div class="actions">${button("Download", "download-asset", `data-id="${escape(post.id)}" data-key="${escape(asset.key)}"`, "subtle")}${link(asset.source, "Open source")}</div></figcaption></figure>`).join("")}</div><div class="actions">${button("Download selected media", "download-selected", `data-id="${escape(post.id)}"`, "subtle")}${button("Refresh source media", "refresh-source", `data-id="${escape(post.id)}"`, "text-button")}</div><small>Downloads use media returned by Buffer. Expired files or source pages may require opening the source link. Up to 50 MB per file or ZIP; downloads do not upload or publish anything.</small></section>`;
}
function visibleGroups() {
  return campaignGroups(filtered(view === "history" ? history : queue));
}
function groupKey(group: Post[]) {
  return organizationId + ":" + campaignKey(group);
}
function campaignCard(group: Post[]) {
  if (group.length === 1) return postCard(group[0]);
  const key = groupKey(group);
  const chosen =
    group.find((p) => p.id === selectedCampaignVersion.get(key)) || group[0];
  const index = group.findIndex((p) => p.id === chosen.id);
  const channel = channels.find((c) => c.id === chosen.channelId);
  const minute = campaignMinute(chosen);
  const time =
    minute === null
      ? ""
      : new Date(minute * 60000).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  return `<article class="post-card campaign-card" aria-label="Grouped Buffer campaign with ${group.length} channel versions">
 <div class="campaign-head"><span class="campaign-ghost">${ghost}</span><div><span class="section-label">✕ CAMPAIGN RADAR</span><h3>One moment. ${group.length} voices.</h3><small>${escape(time)} · matching Buffer publish minute</small></div><span class="campaign-count">${group.length}×</span></div>
 <div class="campaign-tabs" role="group" aria-label="Choose the source platform version">${group
   .map((p, i) => {
     const c = channels.find((x) => x.id === p.channelId);
     return button(
       `${escape(c?.service || "Channel")} <small>${escape(c?.name || "")}</small>`,
       "campaign-select",
       `data-id="${escape(key)}" data-version="${escape(p.id)}" aria-pressed="${p.id === chosen.id}" title="Show ${escape(c?.name || c?.service || "channel")} version"`,
       p.id === chosen.id ? "campaign-tab active" : "campaign-tab",
     );
   })
   .join("")}</div>
 <div class="campaign-copy" aria-live="polite"><div class="campaign-copy-head"><strong>${escape(channel?.name || channel?.service || "Buffer version")}</strong><span>${index + 1} / ${group.length}</span></div><p class="post-text">${escape(chosen.text || "Media-only post")}</p>${mediaPreview(chosen)}</div>
 <div class="campaign-actions"><span class="hint">Select a platform to inspect its exact caption and attached media. Equal publish minutes are a strong grouping signal, not an API-confirmed campaign ID.</span><div class="actions">${button("Download campaign media", "download-campaign", `data-id="${escape(key)}"`, "subtle")}${button("← Previous", "campaign-prev", `data-id="${escape(key)}"`, "subtle")}${button("Next version →", "campaign-next", `data-id="${escape(key)}"`, "subtle")}${button("✕ Prepare this version", "batch-post", `data-id="${escape(chosen.id)}"`, "primary")}</div></div>
 </article>`;
}
function nextCampaignPost() {
  const groups = campaignGroups(queue.filter((p) => p.text.trim()));
  return groups.sort((a, b) => postTime(a[0]) - postTime(b[0]))[0]?.[0] || null;
}
let batchSelected: string[] = [];
let batchText: Record<string, string> = {};
function startBatch(post: Post) {
  batchPost = post;
  batchDirty = false;
  batchSourceId = post.id;
  const dest = active(ws.destinations).filter(
    (d) => d.active !== false && url(d.url),
  );
  batchSelected = dest.map((d) => d.id);
  batchText = Object.fromEntries(
    dest.map((d) => [d.id, variantFor(post.text, d)]),
  );
  coachVisible = false;
  render();
}
function batchPanel() {
  if (!batchPost) return "";
  const dest = active(ws.destinations).filter(
    (d) => d.active !== false && url(d.url),
  );
  return `<dialog id="batch-dialog" aria-labelledby="batch-title"><div class="section-row"><div><span class="section-label">✕ SPECTRAL WORKFLOW</span><h2 id="batch-title">One post. Many destinations.</h2></div>${button("Close", "batch-close", 'aria-label="Close batch workflow"', "subtle")}</div><p class="hint">The selected platform version supplies this caption and media. Edit each destination version. No automatic publishing. Download the media, then attach it yourself at the destination.</p>${message ? `<div class="notice" role="alert">${escape(message)}</div>` : ""}<div class="batch-source"><small>BUFFER SOURCE · ${escape(batchPost.status)}</small><p>${escape(batchPost.text.slice(0, 450))}</p>${mediaPreview(batchPost)}</div>${dest.length ? dest.map((d) => `<div class="batch-destination"><label class="check"><input type="checkbox" data-batch-select="${escape(d.id)}" ${batchSelected.includes(d.id) ? "checked" : ""}><strong>${escape(d.name)}</strong>${badge(d.platform || "Custom")}</label><textarea data-batch-copy="${escape(d.id)}" aria-label="Adapted copy for ${escape(d.name)}" rows="4" maxlength="10000">${escape(batchText[d.id] || "")}</textarea><small>${escape(d.instructions || "Check this destination's current posting rules.")}</small><div class="actions">${button("Copy caption", "batch-copy", `data-id="${escape(d.id)}"`, "subtle")}${button(shareLaunch(d, batchText[d.id] || "").prefilled ? "Open prefilled composer ↗" : "Open posting page ↗", "batch-open", `data-id="${escape(d.id)}"`, "subtle")}${button("Share caption ↗", "batch-share", `data-id="${escape(d.id)}"`, "text-button")}</div></div>`).join("") : `<div class="empty"><h3>No destinations yet</h3><p>Add your Reddit community, personal profile, or custom posting URL in Settings.</p>${button("Add destination", "batch-settings", "", "primary")}</div>`}<div class="actions">${button("Open selected pages ↗", "batch-open-all", !dest.length ? "disabled" : "", "subtle")}${button("Save selected manual tasks", "batch-save", !dest.length || busy ? "disabled" : "", "primary")}</div><p class="hint">Supported compose intents pass text to the platform. Other sites may need manual paste. System Share can hand content to an installed app when supported. Review before publishing.</p></dialog>`;
}
const guide: Record<View, { title: string; detail: string; steps: string[] }> =
  {
    today: {
      title: "Welcome to Mission Control",
      detail:
        "Your private bridge from Buffer to the places you publish by hand.",
      steps: [
        "Connect Buffer and refresh your channels.",
        "Use Next post to prepare manual cross-posts.",
        "Track what you published yourself.",
      ],
    },
    queue: {
      title: "On the radar",
      detail:
        "These are real records returned by Buffer, not simulated publishing.",
      steps: [
        "Refresh your scheduled queue.",
        "Filter by date or channel.",
        "Prepare any post for a manual destination.",
      ],
    },
    composer: {
      title: "Create in your own space",
      detail: "GhostPost drafts stay private and separate from Buffer.",
      steps: [
        "Write and save a draft.",
        "Adapt the draft for a destination.",
        "Copy and publish manually.",
      ],
    },
    history: {
      title: "Every signal has a story",
      detail:
        "Buffer activity and your manual completion reports are clearly separated.",
      steps: [
        "Refresh published history.",
        "Review manual tasks.",
        "Mark completion only after publishing yourself.",
      ],
    },
    settings: {
      title: "Connect your orbit",
      detail: "Configure Buffer and your favorite manual destinations.",
      steps: [
        "Connect your own Buffer account.",
        "Add HTTPS posting URLs for each destination.",
        "Review exports, privacy and connection health.",
      ],
    },
  };
function coachKey() {
  return "ghostpost-tour-v1:" + (user?.userId || "guest") + ":" + view;
}
function showCoach(force = false) {
  try {
    coachVisible = force || localStorage.getItem(coachKey()) !== "seen";
  } catch {
    coachVisible = force;
  }
}
function coachPanel() {
  if (!coachVisible || prepare) return "";
  const g = guide[view];
  return `<section class="coach-card" role="dialog" aria-modal="false" aria-label="Page guide"><div class="coach-top"><span class="section-label">✦ FIRST LOOK · GHOSTPOST GUIDE</span>${button("✕", "coach-dismiss", 'aria-label="Dismiss guide"', "text-button")}</div><h2>${escape(g.title)}</h2><p>${escape(g.detail)}</p><ol>${g.steps.map((x) => `<li>${escape(x)}</li>`).join("")}</ol><div class="actions">${button("Got it ✓", "coach-dismiss", "", "primary")}</div></section>`;
}
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
      response?: {
        data?: { error?: string; message?: string; requestId?: string };
      };
      data?: { error?: string };
    }
  )?.response?.data;
  return (
    (data?.error
      ? data.error + (data.requestId ? " Reference: " + data.requestId : "")
      : undefined) ||
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
  return `<article class="post-card"><div class="post-top"><div class="avatar">${escape(channel?.service?.slice(0, 2).toUpperCase() || "B")}</div><div><strong>${escape(channel?.name || post.channelId)}</strong><small>${escape(channel?.service || "Buffer")} · ${escape(date(post.sentAt || post.dueAt || post.createdAt))}</small></div>${badge(post.status, post.status === "error" ? "bad" : post.status === "sent" ? "good" : "")}</div><p class="post-text">${escape(post.text || "Media-only post")}</p>${mediaPreview(post)}<div class="actions">${button("✕ Adapt for destinations", "batch-post", `data-id="${escape(post.id)}"`, "primary")}${button("Single destination", "prepare-post", `data-id="${escape(post.id)}"`, "subtle")}${button("Copy text", "copy-post", `data-id="${escape(post.id)}"`, "text-button")}${link(post.externalLink, "View post")}</div></article>`;
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
  return `<section class="hero panel"><div><span class="section-label">MISSION CONTROL · PLANET.X</span><h1>Your next post,<br><em>without the clutter.</em></h1><p>Connect Buffer, adapt your next post for manual destinations, and track the human last mile.</p><div class="actions">${button("✕ Next Buffer post", "next-buffer", !linked || !queue.length ? "disabled" : "", "primary")}${button("＋ Write a draft", "new", "", "subtle")}${linked ? button("View scheduled posts", "queue", "", "subtle") : button(configured ? "Connect Buffer" : "Set up Buffer", configured ? "connect" : "settings", "", "subtle")}</div></div><div class="hero-ghost" aria-hidden="true">${ghost}</div></section>
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
  const groups = campaignGroups(posts);
  return `<div class="view-title"><div class="section-label">KNOW WHAT’S COMING</div><h1>Your queue<span class="pink">.</span></h1><p>Scheduled, in-flight, approval and draft records from Buffer. Posts sharing the exact publish minute across different channels appear together. Select a channel tab to switch versions.</p></div>${filters()}<div class="actions">${button(busy ? "Refreshing…" : "Refresh queue", "sync-queue", busy || !linked ? "disabled" : "", "subtle")}</div>${posts.length ? groups.map(campaignCard).join("") : noData("No queue records to show", queueLoaded ? "Nothing matches these filters in the loaded pages." : "Connect Buffer and refresh the queue to load available posts.")}${queueCursor ? button("Load more queue records", "more-queue", busy ? "disabled" : "", "subtle wide") : ""}`;
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
  return `<div class="view-title"><div class="section-label">THOUGHT → DRAFT → DESTINATION</div><h1>Your drafts<span class="cyan">.</span></h1><p>Save a GhostPost draft, then adapt it for a manual destination.</p></div><form id="composer-form" class="panel"><div class="section-row"><h2>${editor.id ? "Edit draft" : "New draft"}</h2>${badge(dirty ? "Unsaved changes" : editor.id ? "Saved draft" : "Draft-first")}</div>${field("Draft title", "title", editor.title, 'required maxlength="120"')}<label>Content<textarea name="text" rows="8" required maxlength="10000" placeholder="What do you want to put out into the world?">${escape(editor.text)}</textarea></label><div class="section-row"><small id="char-count">${editor.text?.length || 0} / 10,000 characters</small><small>${user ? "Private draft · not published" : "Sign in to save this draft"}</small></div><details class="draft-options"><summary>Platform, campaign & reminder</summary><div class="form-grid"><label>Platform<select name="platform">${["general", "linkedin", "facebook", "reddit", "instagram", "threads", "bluesky", "twitter", "other"].map((p) => `<option ${editor.platform === p ? "selected" : ""}>${p}</option>`).join("")}</select></label>${field("Campaign / tags", "campaign", editor.campaign, 'maxlength="80"')}${field("Planning date (reminder only)", "plannedAt", localInput(editor.plannedAt), "", "datetime-local")}</div><p class="hint">Planning dates do not schedule publishing. Platform limits and media requirements must be checked at the destination.</p></details><div class="actions"><button class="primary" ${!user || busy ? "disabled" : ""}>${busy ? "Saving…" : "Save draft"}</button>${button("Copy text", "copy-editor", "", "subtle")}${button("New draft", "new", "", "text-button")}</div>${!user ? '<p class="hint">Sign in to save account-owned drafts.</p>' : ""}</form><details class="panel preview"><summary>Preview your draft</summary><p id="content-preview" class="post-text">${escape(editor.text || "Your words will appear here.")}</p></details><div class="section-row"><h2>Draft library</h2>${badge(active(ws.drafts).length + " drafts")}</div><label><span class="sr-only">Search drafts</span><input id="draft-search" type="search" placeholder="Search drafts by title, text or campaign…" value="${escape(search)}"></label>${
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
  const groups = campaignGroups(posts).sort(
    (a, b) => postTime(b[0]) - postTime(a[0]),
  );
  return `<div class="view-title"><div class="section-label">A RECORD OF THE WORK</div><h1>Publishing history<span class="pink">.</span></h1><p>API-reported Buffer activity and your own manual completion records.</p></div>${filters()}<div class="actions">${button("Refresh history", "sync-history", busy || !linked ? "disabled" : "", "subtle")}</div>${posts.length ? groups.map(campaignCard).join("") : noData("No Buffer history loaded", historyLoaded ? "No records match your current filters." : "Refresh history to retrieve published and failed posts.")}${historyCursor ? button("Load more history", "more-history", busy ? "disabled" : "", "subtle wide") : ""}<div class="section-row"><h2>Manual posting log</h2><small>User-reported, never API-verified</small></div>${
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
  return `<div class="view-title"><div class="section-label">YOUR WORKSPACE, YOUR RULES</div><h1>Settings<span class="cyan">.</span></h1></div><section class="panel"><div class="section-row"><h2>Buffer connection</h2>${badge(linked ? (reconnect ? "Reconnect needed" : "Linked") : "Not linked", linked && !reconnect ? "good" : "")}</div><p>${escape(user?.email || user?.name || "Sign in to use a private GhostPost workspace.")}</p><small>Connected: ${connectedAt ? escape(date(connectedAt)) : "Not connected"}</small>${accountId ? `<p class="hint">Buffer account: ${escape(accountId)}</p>` : ""}${readonlyNote}${!configured ? bufferSetup() : ""}<div class="actions">${configured ? button(linked ? "Reconnect Buffer" : "Connect Buffer", "connect", busy ? "disabled" : "", "primary") : button("Check setup again", "check-setup", busy ? "disabled" : "", "subtle")}${button("Refresh channels", "sync", busy || !linked ? "disabled" : "", "subtle")}${linked ? button("Disconnect", "disconnect", busy ? "disabled" : "", "danger-button") : ""}${user ? button("Sign out", "signout", "", "text-button") : ""}</div>${organizations.length > 1 ? `<label>Buffer organization<select id="org">${organizations.map((org) => `<option value="${escape(org.id)}" ${org.id === organizationId ? "selected" : ""}>${escape(org.name)}</option>`).join("")}</select></label>` : ""}<p class="hint">Last successful sync: ${lastSync ? escape(date(lastSync)) : "Not synced yet"}. ${escape(syncError)}</p></section><section class="panel"><h2>Channels</h2>${channels.length ? channels.map((ch) => `<div class="channel"><span class="avatar">${url(ch.avatar) ? `<img src="${escape(url(ch.avatar))}" alt="" referrerpolicy="no-referrer" loading="lazy">` : escape(ch.service.slice(0, 2).toUpperCase())}</span><div><strong>${escape(ch.name)}</strong><small>${escape(ch.service)} · ${escape(ch.timezone)}</small></div>${badge(ch.isDisconnected ? "Disconnected" : ch.isLocked ? "Locked" : ch.isQueuePaused ? "Queue paused" : "Connected", ch.isDisconnected || ch.isLocked ? "bad" : "good")}<small>${ch.canScheduleInBuffer ? "Scheduling allowed in Buffer" : "Scheduling unavailable"}</small></div>`).join("") : '<p class="quiet">No channels loaded. Refresh after connecting Buffer.</p>'}</section><section class="panel"><h2>Manual destinations</h2><p>Reddit, personal profiles, communities, or any HTTPS destination. GhostPost never logs in to these sites for you.</p>${active(
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
  return `<dialog open id="manual-dialog" aria-labelledby="manual-title"><div class="section-row"><div><span class="section-label">THE HUMAN LAST MILE</span><h2 id="manual-title">Prepare a cross-post</h2></div>${button("Close", "close-prepare", 'aria-label="Close manual cross-post"', "subtle")}</div><p class="hint">1. Review → 2. Copy → 3. Open destination → 4. Publish manually → 5. Return and mark complete.</p>${message ? `<div class="notice" role="alert">${escape(message)}</div>` : ""}${taskSourcePost ? mediaPreview(taskSourcePost) : prepare.sourcePostId ? '<p class="hint">Source media will load when Buffer is connected.</p>' : ""}<form id="manual-form"><label>Destination<select name="destinationId" required><option value="">Select an active destination</option>${ws.destinations
    .filter(
      (d) =>
        (!d.archived && d.active !== false) || d.id === prepare!.destinationId,
    )
    .map(
      (d) =>
        `<option value="${escape(d.id)}" ${d.id === prepare!.destinationId ? "selected" : ""}>${escape(d.name)} · ${escape(d.platform)}</option>`,
    )
    .join(
      "",
    )}</select></label>${!active(ws.destinations).length ? `<p>Add a destination in Settings first.</p>${button("Open Settings", "destinations", "", "subtle")}` : ""}${dest ? `<div class="notice"><strong>${escape(dest.format || "Destination guidance")}</strong><p>${escape(dest.instructions || "Review this destination’s current posting rules before publishing.")}</p><small>${escape(dest.notes)}</small></div>` : ""}<label>Destination-specific copy<textarea name="text" rows="7" required maxlength="10000">${escape(prepare.text)}</textarea></label><small id="manual-count">${prepare.text?.length || 0} characters</small>${field("Published URL (optional)", "resultUrl", prepare.resultUrl, 'maxlength="2048"', "url")}<label>Completion notes<textarea name="notes" rows="2" maxlength="2000">${escape(prepare.notes)}</textarea></label><div class="actions">${button("Copy caption", "copy-task", "", "subtle")}${link(dest?.url || prepare.destinationUrl, "Open destination")}<button class="primary" ${busy || !user ? "disabled" : ""}>Save manual task</button></div>${prepare.id ? `<div class="completion"><label class="check"><input type="checkbox" name="confirmed" id="manual-confirm"> I published this myself and want to record completion.</label>${button(prepare.state === "complete" ? "Reopen task" : "Mark complete", "complete-task", busy ? "disabled" : "", "subtle")}<p class="hint">Completion is your report, not confirmation from the social platform.</p></div>` : '<p class="hint">Save this task before recording completion.</p>'}</form></dialog><div class="modal-backdrop"></div>`;
}
function insightsPanel() {
  const pending = active(ws.tasks).filter((t) => t.state !== "complete").length;
  const completed = active(ws.tasks).filter(
    (t) => t.state === "complete",
  ).length;
  const next = nextCampaignPost();
  return `<aside class="insights" aria-label="Mission intelligence"><span class="section-label">✦ LIVE INTELLIGENCE</span><h2>Signal check<span class="cyan">.</span></h2><div class="health"><span class="dot ${linked && !reconnect ? "healthy" : "danger"}"></span><strong>${linked && !reconnect ? "Buffer linked" : reconnect ? "Reconnect needed" : "Buffer offline"}</strong><small>${lastSync ? "Last sync " + escape(date(lastSync)) : "No verified sync yet"}</small></div><div class="metric-grid"><div><strong>${channels.length}</strong><span>Channels loaded</span></div><div><strong>${queue.length}</strong><span>Queue loaded</span></div><div><strong>${pending}</strong><span>Manual pending</span></div><div><strong>${completed}</strong><span>User-completed</span></div></div><div class="panel inset"><h3>Next signal</h3>${next ? `<p>${escape(next.text.slice(0, 125))}</p>${button("Prepare next ↗", "next-buffer", "", "primary")}` : `<p>${linked ? "Refresh your queue to find the next post." : "Connect Buffer to activate your publishing radar."}</p>`}</div><div class="footnote"><span class="dot"></span><p>Real Buffer data only. Manual completions are user-reported.</p></div></aside>`;
}
function dock() {
  return `<div class="smart-dock" role="toolbar" aria-label="Quick actions">${button("⌂ Home", "today")}${button("✕ Next post", "next-buffer", !linked || !queue.length ? "disabled" : "", "dock-primary")}${button("＋ Draft", "new")}${button("↻ Sync", "sync", !linked || busy ? "disabled" : "")}${button("? Guide", "coach-open")}</div>`;
}
function render() {
  if (booting) return;
  const focus = document.activeElement as HTMLInputElement | null;
  const focusId = focus?.id;
  const selection = focus?.selectionStart;
  app.innerHTML = `<header class="topbar"><a href="#today" class="wordmark"><span class="brand-ghost">${ghost}</span><span>Ghost<span class="pink">Post</span><small>by planet.X <b>✕</b> <i>v0.4.0 · alpha</i></small></span></a><nav aria-label="Workspace">${navigation()}</nav><div class="account">${badge(linked ? "Buffer connected" : configured ? "Buffer not connected" : "Buffer setup needed", linked ? "good" : "")}${button(user ? user.name?.split(" ")[0] || "Account" : "Sign in", user ? "account" : "signin", busy ? "disabled" : "", "subtle")}</div></header>${!user ? `<div class="signin-banner"><span><strong>Your publishing flow starts here.</strong> Sign in for private drafts, destinations and Buffer activity.</span>${button("Sign in to GhostPost", "signin", busy ? "disabled" : "", "primary")}</div>` : ""}${message ? `<div class="alert" role="alert"><span>${escape(message)}</span>${button("Dismiss", "dismiss", "", "text-button")}</div>` : ""}${!navigator.onLine ? '<div class="alert">You’re offline. Keep this page open to preserve unsaved text. Saving and Buffer sync need a connection.</div>' : ""}<div class="workspace">${timeline()}<main id="main" tabindex="-1">${{ today: todayView, queue: queueView, composer: composerView, history: historyView, settings: settingsView }[view]()}</main>${insightsPanel()}</div>${dock()}${preparePanel()}${batchPanel()}${coachPanel()}`;
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
  const dialog =
    document.querySelector<HTMLDialogElement>("#manual-dialog") ||
    document.querySelector<HTMLDialogElement>("#batch-dialog");
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
    batchPost = null;
    taskSourcePost = null;
    batchText = {};
    mediaSelected.clear();
    selectedCampaignVersion.clear();
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
  showCoach();
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
  if (taskSourcePost?.id !== item.sourcePostId) taskSourcePost = null;
  prepare = {
    id: "",
    text: item.text || "",
    contentRef: ref,
    sourcePostId: item.sourcePostId,
    sourceChannelId: item.sourceChannelId,
    sourceAssetKeys: item.sourceAssetKeys,
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
  if (target.dataset.batchCopy) {
    batchText[target.dataset.batchCopy] = target.value;
    batchDirty = true;
  }
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
  const mediaTarget = event.target as HTMLInputElement;
  if (mediaTarget.dataset.mediaPost && mediaTarget.dataset.mediaKey) {
    const source = [...queue, ...history, batchPost, taskSourcePost].find(
      (p) => p?.id === mediaTarget.dataset.mediaPost,
    );
    if (source) {
      const selected =
        mediaSelected.get(source.id) ||
        new Set(source.assets?.map((a) => a.key));
      mediaTarget.checked
        ? selected.add(mediaTarget.dataset.mediaKey)
        : selected.delete(mediaTarget.dataset.mediaKey);
      mediaSelected.set(source.id, selected);
      if (batchPost?.id === source.id) batchDirty = true;
      if (prepare?.sourcePostId === source.id)
        prepare.sourceAssetKeys = [...selected];
    }
    return;
  }

  const target = event.target as HTMLInputElement;
  if (target.dataset.batchSelect)
    batchSelected = target.checked
      ? [...new Set([...batchSelected, target.dataset.batchSelect])]
      : batchSelected.filter((x) => x !== target.dataset.batchSelect);
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
      selectedCampaignVersion.clear();
      mediaSelected.clear();
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
app.addEventListener(
  "cancel",
  (event) => {
    const dialog = event.target as HTMLDialogElement;
    if (dialog.id === "batch-dialog") {
      event.preventDefault();
      if (!batchDirty || confirm("Discard your unsaved destination edits?")) {
        batchPost = null;
        batchDirty = false;
        render();
      }
    }
    if (dialog.id === "manual-dialog") {
      event.preventDefault();
      if (
        confirm("Close this task editor? Unsaved changes will be discarded.")
      ) {
        prepare = null;
        taskSourcePost = null;
        render();
      }
    }
  },
  true,
);
app.addEventListener(
  "error",
  (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-media-preview],.media-attachment video")) {
      target.setAttribute(
        "aria-label",
        "Preview unavailable. Try Refresh source media or Open source.",
      );
      const parent = target.closest(".media-attachment");
      if (parent && !parent.querySelector(".media-error"))
        parent.insertAdjacentHTML(
          "beforeend",
          '<small class="media-error">Preview unavailable. Refresh source media or open its source.</small>',
        );
    }
  },
  true,
);
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
  if (action === "coach-dismiss") {
    try {
      localStorage.setItem(coachKey(), "seen");
    } catch {
      /* Optional guide preference. */
    }
    coachVisible = false;
    render();
    return;
  }
  if (action === "coach-open") {
    showCoach(true);
    render();
    return;
  }
  if (action === "next-buffer") {
    const next = nextCampaignPost();
    if (next) startBatch(next);
    else toast("Refresh your Buffer queue first.");
    return;
  }
  if (
    action === "campaign-select" ||
    action === "campaign-next" ||
    action === "campaign-prev"
  ) {
    const group = visibleGroups().find(
      (g) => g.length > 1 && groupKey(g) === id,
    );
    if (!group || !id) return;
    if (action === "campaign-select") {
      const version = target.dataset.version;
      if (group.some((p) => p.id === version))
        selectedCampaignVersion.set(id, version!);
    } else {
      const current = group.findIndex(
        (p) => p.id === selectedCampaignVersion.get(id),
      );
      const position = current < 0 ? 0 : current;
      selectedCampaignVersion.set(
        id,
        group[
          (position + (action === "campaign-next" ? 1 : -1) + group.length) %
            group.length
        ].id,
      );
    }
    render();
    document
      .querySelector<HTMLElement>(
        `[data-action="campaign-select"][data-id="${CSS.escape(id)}"][data-version="${CSS.escape(selectedCampaignVersion.get(id) || group[0].id)}"]`,
      )
      ?.focus();
    return;
  }
  if (
    action === "download-asset" ||
    action === "download-selected" ||
    action === "download-campaign"
  ) {
    void run(async () => {
      const sources =
        action === "download-campaign"
          ? visibleGroups().find((g) => groupKey(g) === id) || []
          : post
            ? [post]
            : batchPost?.id === id
              ? [batchPost]
              : taskSourcePost?.id === id
                ? [taskSourcePost]
                : [];
      const items = sources
        .filter((source): source is Post => Boolean(source))
        .flatMap((source) =>
          (source.assets || [])
            .filter((asset) =>
              action === "download-asset"
                ? asset.key === target.dataset.key
                : action === "download-campaign" ||
                  (
                    mediaSelected.get(source.id) ||
                    new Set(source.assets?.map((a) => a.key))
                  ).has(asset.key),
            )
            .map((asset) => ({ post: source, asset })),
        );
      await downloadAssets(items, action !== "download-asset");
      toast("Download prepared. Attach the files yourself before publishing.");
    });
    return;
  }
  if (action === "refresh-source") {
    void run(async () => {
      if (!id) return;
      const updated = (await api.post("/api/buffer/post", { postId: id })).data
        .post as Post;
      queue = queue.map((p) => (p.id === id ? updated : p));
      history = history.map((p) => (p.id === id ? updated : p));
      if (batchPost?.id === id) batchPost = updated;
      if (taskSourcePost?.id === id) taskSourcePost = updated;
      mediaSelected.delete(id);
      toast("Source media refreshed. Your edited caption is preserved.");
    });
    return;
  }
  if (action === "batch-post" && post) {
    startBatch(post);
    return;
  }
  if (action === "batch-close") {
    if (batchDirty && !confirm("Discard your unsaved destination edits?"))
      return;
    batchPost = null;
    batchDirty = false;
    render();
    return;
  }
  if (action === "batch-settings") {
    batchPost = null;
    navigate("settings");
    return;
  }
  if (action === "batch-copy") {
    void copy(batchText[id || ""]);
    return;
  }
  if (action === "batch-share") {
    const d = ws.destinations.find((x) => x.id === id);
    if (!d) return;
    if (navigator.share) {
      void navigator.share({ text: batchText[d.id] || "" }).catch((err) => {
        if (err?.name !== "AbortError")
          toast("System Share unavailable. Use Copy caption.");
      });
    } else
      toast("System Share isn't available in this browser. Use Copy caption.");
    return;
  }
  if (action === "batch-open" || action === "batch-open-all") {
    const dest = active(ws.destinations).filter(
      (d) =>
        d.active !== false &&
        url(d.url) &&
        (action === "batch-open-all"
          ? batchSelected.includes(d.id)
          : d.id === id),
    );
    if (!dest.length) {
      toast("Select an active destination.");
      return;
    }
    const outcomes = dest.map((d) => shareLaunch(d, batchText[d.id] || ""));
    for (const launch of outcomes)
      window.open(launch.url, "_blank", "noopener,noreferrer");
    toast(
      "Requested " +
        outcomes.length +
        " destination page(s). If extra tabs are blocked, open each destination individually. Review before posting.",
    );
    return;
  }
  if (action === "batch-save") {
    const source = batchPost;
    if (!source) return;
    const dest = active(ws.destinations).filter(
      (d) => batchSelected.includes(d.id) && d.active !== false && url(d.url),
    );
    if (!dest.length) {
      toast("Select at least one destination.");
      return;
    }
    if (
      !confirm(
        "Save " +
          dest.length +
          " manual posting tasks? Nothing will be published automatically.",
      )
    )
      return;
    void run(async () => {
      if (dest.some((d) => !batchText[d.id]?.trim()))
        throw new Error(
          "Every selected destination needs a caption. Review the empty version before saving.",
        );
      for (const d of dest)
        await save("tasks", {
          id:
            ws.tasks.find(
              (t) =>
                t.contentRef === "buffer:" + source.id &&
                t.destinationId === d.id &&
                t.state !== "complete" &&
                !t.archived,
            )?.id || "",
          sourcePostId: source.id,
          sourceChannelId: source.channelId,
          sourceAssetKeys: [
            ...(mediaSelected.get(source.id) ||
              new Set(source.assets?.map((a) => a.key))),
          ],
          text: batchText[d.id],
          contentRef: "buffer:" + source.id,
          destinationId: d.id,
          destinationName: d.name,
          destinationUrl: d.url,
          state: "pending",
          notes: "Prepared from Buffer. Publish manually.",
        });
      batchPost = null;
      batchDirty = false;
      toast("Saved " + dest.length + " manual tasks. Nothing was published.");
    });
    return;
  }
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
    taskSourcePost = post;
    openPrepare(
      {
        id: "",
        text: post.text,
        sourcePostId: post.id,
        sourceChannelId: post.channelId,
        sourceAssetKeys: [
          ...(mediaSelected.get(post.id) ||
            new Set(post.assets?.map((a) => a.key))),
        ],
      },
      "buffer:" + post.id,
    );
    return;
  }
  if (action === "prepare-draft") {
    openPrepare(ws.drafts.find((d) => d.id === id)!, "draft:" + id);
    return;
  }
  if (action === "open-task") {
    prepare = { ...ws.tasks.find((t) => t.id === id)! };
    taskSourcePost = null;
    render();
    if (prepare.sourcePostId)
      void run(async () => {
        taskSourcePost = (
          await api.post("/api/buffer/post", { postId: prepare!.sourcePostId })
        ).data.post;
        if (taskSourcePost && prepare?.sourceAssetKeys)
          mediaSelected.set(
            taskSourcePost.id,
            new Set(prepare.sourceAssetKeys),
          );
      });
    return;
  }
  if (action === "close-prepare") {
    if (
      confirm("Close this task editor? Unsaved task changes will be discarded.")
    ) {
      prepare = null;
      taskSourcePost = null;
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
      batchPost = null;
      taskSourcePost = null;
      batchText = {};
      prepare = null;
      batchSelected = [];
      batchDirty = false;
      mediaSelected.clear();
      selectedCampaignVersion.clear();
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
      selectedCampaignVersion.clear();
      mediaSelected.clear();
      toast("Buffer disconnected. Stored credentials removed.");
    }
    if (action === "signout") {
      if (dirty && !confirm("Sign out and discard unsaved draft changes?"))
        return;
      await auth.signOut();
      user = null;
      batchPost = null;
      taskSourcePost = null;
      batchText = {};
      prepare = null;
      batchSelected = [];
      batchDirty = false;
      mediaSelected.clear();
      selectedCampaignVersion.clear();
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
              version: "0.4.0",
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
      a.download = "GhostPost-11.14-v0.4.0-workspace.json";
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
    showCoach();
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
  showCoach();
  render();
  if (user && linked && !reconnect) await run(refreshBuffer);
}
function historyReplace() {
  window.history.replaceState(null, "", "/" + location.hash);
}
void init();
