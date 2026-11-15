import { test, after } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { unzipSync, strFromU8 } from "fflate";
import { state, posts } from "./ui-fixture.mjs";
const { window } = parseHTML(
  '<html><body><div id="app"></div><div id="toast"></div></body></html>',
);
const { document } = window;
// DOM simulation only: dialogs, navigation and clipboard use explicit test stubs.
const originalMatches = window.HTMLElement.prototype.matches;
window.HTMLElement.prototype.matches = function (selector) {
  return selector === ":modal"
    ? this.hasAttribute("data-modal")
    : originalMatches.call(this, selector);
};
window.HTMLElement.prototype.showModal = function () {
  this.setAttribute("open", "");
  this.setAttribute("data-modal", "");
};
window.HTMLElement.prototype.close = function () {
  this.removeAttribute("open");
  this.removeAttribute("data-modal");
};
window.HTMLElement.prototype.reportValidity = () => true;
let copied = "",
  navigated = "",
  confirmResult = true;
const location = {
  hash: "#history",
  search: "",
  reload() {},
  assign(value) {
    navigated = value;
  },
};
const nativeFetch = globalThis.fetch;
Object.assign(globalThis, {
  window,
  document,
  location,
  localStorage: { getItem: () => "seen", setItem() {} },
  CSS: { escape: (value) => value },
  confirm: () => confirmResult,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    onLine: true,
    clipboard: {
      writeText: async (text) => {
        copied = text;
      },
    },
  },
});
globalThis.fetch = async (path) => {
  assert.match(path, /^\/api\/buffer\/media\//);
  return new Response("synthetic image", {
    headers: { "content-type": "image/png" },
  });
};
const saved = [];
URL.createObjectURL = (blob) => {
  saved.push(blob);
  return "blob:fixture";
};
URL.revokeObjectURL = () => {};
const click = (selector) => {
  const element = document.querySelector(selector);
  assert.ok(element, selector);
  element.dispatchEvent(new window.Event("click", { bubbles: true }));
};
const input = (element, value) => {
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
};
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("DOM fixture did not settle");
}
await import("../src/main.ts");
await until(
  () =>
    document.querySelectorAll(".campaign-card").length === 3 &&
    document.querySelector('[data-action="sync-history"]')?.disabled !== true,
);
after(() => {
  globalThis.fetch = nativeFetch;
});
test("campaign DOM keeps exact caption/media/version through tabs, next/previous and reordered refresh", async () => {
  const card = document.querySelector(".campaign-card"),
    key = card.querySelector('[data-action="campaign-next"]').dataset.id;
  const version = card.querySelectorAll('[data-action="campaign-select"]')[2]
    .dataset.version;
  const byKey = (suffix) => `[data-id="${key}"]${suffix}`;
  click(byKey(`[data-version="${version}"]`));
  const selected = posts.find((p) => p.id === version);
  assert.equal(
    document.querySelector(".campaign-card .post-text").textContent,
    selected.text,
  );
  assert.ok(
    document.querySelector(
      `.campaign-card input[data-media-post="${version}"]`,
    ),
  );
  click(byKey('[data-action="campaign-next"]'));
  assert.equal(
    document.querySelector(".campaign-card .post-text").textContent,
    posts.find((p) => p.id === "post-2-0").text,
  );
  click(byKey('[data-action="campaign-prev"]'));
  assert.equal(
    document.querySelector(".campaign-card .post-text").textContent,
    selected.text,
  );
  state.reverse = true;
  click('[data-action="sync-history"]');
  await until(
    () =>
      state.calls.filter(
        (c) => c.path === "/api/buffer/sync" && c.body?.mode === "history",
      ).length === 2 &&
      document.querySelector('[data-action="sync-history"]')?.disabled !== true,
  );
  assert.equal(
    document.querySelector(".campaign-card .post-text").textContent,
    selected.text,
  );
  click(`.campaign-card [data-action="batch-post"]`);
  assert.equal(
    document.querySelector("#batch-dialog textarea").value,
    selected.text,
  );
  const attachment = document.querySelector(
    "#batch-dialog input[data-media-key]",
  );
  attachment.checked = false;
  attachment.dispatchEvent(new window.Event("change", { bubbles: true }));
  input(
    document.querySelector("#batch-dialog textarea"),
    "Edited destination caption",
  );
  click('#batch-dialog [data-action="batch-copy"]');
  await until(() => copied === "Edited destination caption");
  click('#batch-dialog [data-action="refresh-source"]');
  await until(
    () =>
      state.calls.some((c) => c.path === "/api/buffer/post") &&
      document.querySelector('#batch-dialog [data-action="batch-save"]')
        ?.disabled === false,
  );
  assert.equal(
    document.querySelector("#batch-dialog textarea").value,
    "Edited destination caption",
  );
  // A successful source refresh resets media selection to the latest attachment list.
  const second = document.querySelectorAll(
    "#batch-dialog input[data-media-key]",
  )[1];
  second.checked = false;
  second.dispatchEvent(new window.Event("change", { bubbles: true }));
  confirmResult = false;
  click('#batch-dialog [data-action="batch-close"]');
  assert.ok(document.querySelector("#batch-dialog"));
  confirmResult = true;
  click('#batch-dialog [data-action="batch-save"]');
  await until(
    () =>
      state.workspace.tasks.length === 1 &&
      !document.querySelector("#batch-dialog"),
  );
  const task = state.workspace.tasks[0];
  assert.equal(task.text, "Edited destination caption");
  assert.equal(task.sourcePostId, selected.id);
  assert.equal(task.sourceChannelId, selected.channelId);
  assert.deepEqual(task.sourceAssetKeys, [selected.assets[0].key]);
  assert.equal(task.state, "pending");
});
test("campaign ZIP manifest associates each original caption with its own attachments", async () => {
  click('.campaign-card [data-action="download-campaign"]');
  await until(() => saved.length === 1);
  const zip = unzipSync(new Uint8Array(await saved[0].arrayBuffer())),
    manifest = JSON.parse(strFromU8(zip["captions-and-media.json"]));
  assert.equal(manifest.length, 6);
  for (const item of manifest) {
    const post = posts.find((p) => p.id === item.postId);
    assert.equal(item.caption, post.text);
    assert.equal(item.channelId, post.channelId);
    assert.ok(zip[item.file]);
  }
});
test("manual completion requires explicit confirmation; saved source reloads and drafts have no stale media", async () => {
  const task = state.workspace.tasks[0];
  click(`[data-action="open-task"][data-id="${task.id}"]`);
  await until(() =>
    document.querySelector("#manual-dialog input[data-media-post]"),
  );
  assert.equal(
    document.querySelectorAll("#manual-dialog input[data-media-key]:checked")
      .length,
    1,
  );
  click('#manual-dialog [data-action="complete-task"]');
  await until(() =>
    document
      .querySelector("#manual-dialog .notice")
      ?.textContent.includes("Confirm you published"),
  );
  assert.equal(state.workspace.tasks[0].state, "pending");
  document.querySelector("#manual-confirm").checked = true;
  click('#manual-dialog [data-action="complete-task"]');
  await until(() => state.workspace.tasks[0].state === "complete");
  click('#manual-dialog [data-action="close-prepare"]');
  location.hash = "#composer";
  window.dispatchEvent(new window.Event("hashchange"));
  click('[data-action="prepare-draft"][data-id="draft"]');
  assert.equal(
    document.querySelector("#manual-dialog input[data-media-post]"),
    null,
  );
  assert.equal(
    document.querySelector("#manual-dialog textarea").value,
    "Draft without media",
  );
});
test("Connect action posts to the correct route then navigates to the validated Buffer URL; logout clears private UI", async () => {
  click('#manual-dialog [data-action="close-prepare"]');
  location.hash = "#settings";
  window.dispatchEvent(new window.Event("hashchange"));
  click('[data-action="connect"]');
  await until(
    () =>
      navigated.startsWith("https://auth.buffer.com/auth?") &&
      document.querySelector('[data-action="signout"]')?.disabled === false,
  );
  assert.ok(state.calls.some((c) => c.path === "/api/buffer/start"));
  click('[data-action="signout"]');
  await until(() => document.querySelector(".signin-banner"));
  assert.equal(document.querySelectorAll(".campaign-card").length, 0);
  assert.equal(document.querySelector("#manual-dialog"), null);
  assert.equal(document.querySelector(".task-card"), null);
  assert.equal(
    document.querySelector("#app").textContent.includes("Campaign 2"),
    false,
  );
});
