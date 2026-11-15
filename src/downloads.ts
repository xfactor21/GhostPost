import { mediaPath, mediaExtension, type MediaAsset } from "../shared/media";
type DownloadItem = {
  post: { id: string; channelId: string; text: string };
  asset: MediaAsset;
};
const MAX_BYTES = 50 * 1024 * 1024;
function save(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
export async function downloadAssets(items: DownloadItem[], zip: boolean) {
  if (!items.length) throw new Error("Select at least one media attachment.");
  const files: Record<string, Uint8Array<ArrayBuffer>> = {},
    manifest: {
      postId: string;
      channelId: string;
      caption: string;
      file: string;
    }[] = [];
  let size = 0;
  for (const { post, asset } of items) {
    const response = await fetch(mediaPath(post.id, asset.key), {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(55000),
    });
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ error: "Download failed." }));
      throw new Error(
        (body.error || "Download failed.") +
          (body.requestId ? " Reference: " + body.requestId : ""),
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new Error(
        "This browser cannot download this file. Open its source instead.",
      );
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      length += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error(
          "Selected media exceeds the 50 MB download limit. Download individual files or open their source links.",
        );
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const name =
      post.id +
      "-" +
      asset.key +
      "." +
      mediaExtension(
        response.headers.get("content-type")?.split(";")[0] || asset.mimeType,
      );
    if (!zip) {
      save(new Blob([bytes], { type: asset.mimeType }), name);
      return;
    }
    files[name] = bytes;
    manifest.push({
      postId: post.id,
      channelId: post.channelId,
      caption: post.text,
      file: name,
    });
  }
  const { zipSync, strToU8 } = await import("fflate");
  files["captions-and-media.json"] = Uint8Array.from(
    strToU8(JSON.stringify(manifest, null, 2)),
  );
  save(
    new Blob([Uint8Array.from(zipSync(files, { level: 0 }))], {
      type: "application/zip",
    }),
    "GhostPost-11.14-v0.4.0-campaign-media.zip",
  );
}
