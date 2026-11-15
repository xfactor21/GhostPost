import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { PublicError, failure } from "./diagnostics";
import { Readable } from "node:stream";
import { hash } from "./security";
import { publicMediaUrl, type MediaAsset } from "../shared/media";
const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as [string, number][])
  blocked.addSubnet(ip, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [ip, bits] of [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
] as [string, number][])
  blockedV6.addSubnet(ip, bits, "ipv6");
export function publicAddress(ip: string) {
  const family = isIP(ip);
  return family === 4
    ? !blocked.check(ip, "ipv4")
    : family === 6 &&
        globalV6.check(ip, "ipv6") &&
        !blockedV6.check(ip, "ipv6");
}
export function normalizeAssets(postId: string, assets: unknown): MediaAsset[] {
  if (!Array.isArray(assets)) return [];
  return assets
    .slice(0, 20)
    .filter((a) => a && typeof a === "object")
    .map((asset, index) => {
      const source = publicMediaUrl(asset.source),
        thumbnail = publicMediaUrl(asset.thumbnail);
      const mimeType =
        typeof asset.mimeType === "string"
          ? asset.mimeType.slice(0, 100)
          : "application/octet-stream";
      let path = "";
      try {
        const u = new URL(source);
        path = u.origin + u.pathname;
      } catch {}
      return {
        id: typeof asset.id === "string" ? asset.id : null,
        key: hash(
          postId + "\n" + (asset.id || index) + "\n" + path + "\n" + mimeType,
        ).slice(0, 32),
        mimeType,
        source,
        thumbnail,
      };
    });
}
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export type MediaDependencies = {
  resolve: typeof lookup;
  request: typeof httpsRequest;
};
const dependencies: MediaDependencies = {
  resolve: lookup,
  request: httpsRequest,
};
export async function downloadMedia(
  raw: string,
  thumbnail = false,
  hops = 0,
  deadline = Date.now() + 25000,
  deps: MediaDependencies = dependencies,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
  const limit = thumbnail ? 2 * 1024 * 1024 : MAX_MEDIA_BYTES;
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new PublicError(
      "Media download timed out. Please retry.",
      504,
      "MEDIA_DOWNLOAD_FAILED",
    );
  const safe = publicMediaUrl(raw);
  if (!safe || hops > 3)
    throw new PublicError(
      "This media URL is unavailable. Refresh the source post.",
      410,
      "BUFFER_MEDIA_UNAVAILABLE",
    );
  const url = new URL(safe),
    hostname = url.hostname.replace(/^\[|\]$/g, "");
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
          deps.resolve(hostname, { all: true }).catch(() => []),
          new Promise<never>((_, reject) => {
            lookupTimer = setTimeout(
              () =>
                reject(
                  new PublicError(
                    "Media host lookup timed out. Please retry.",
                    504,
                    "MEDIA_DOWNLOAD_FAILED",
                  ),
                ),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
  } finally {
    clearTimeout(lookupTimer);
  }
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new PublicError(
      "This media host cannot be downloaded securely.",
      422,
      "MEDIA_HOST_REJECTED",
    );
  if (Date.now() >= deadline)
    throw new PublicError(
      "Media host lookup timed out. Please retry.",
      504,
      "MEDIA_DOWNLOAD_FAILED",
    );
  const address = addresses[0];
  // Pin validated DNS to TLS and validate every redirect. Forward no credentials.
  return new Promise((resolve, reject) => {
    const req = deps.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: thumbnail ? "image/*" : "image/*,video/*,application/pdf",
        },
        lookup: (_host, options, callback) => {
          const all = typeof options === "object" && options?.all;
          (callback as Function)(
            null,
            all ? [address] : address.address,
            all ? undefined : address.family,
          );
        },
        timeout: 20000,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      },
      (res) => {
        if (
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode)
        ) {
          res.destroy();
          if (!res.headers.location) {
            reject(
              new PublicError(
                "Media redirect is unavailable.",
                410,
                "BUFFER_MEDIA_UNAVAILABLE",
              ),
            );
            return;
          }
          downloadMedia(
            new URL(res.headers.location, url).href,
            thumbnail,
            hops + 1,
            deadline,
            deps,
          ).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.destroy();
          reject(
            new PublicError(
              "Buffer’s media file is unavailable or expired. Refresh the source post, or open its original source.",
              410,
              "BUFFER_MEDIA_UNAVAILABLE",
            ),
          );
          return;
        }
        const contentType = (res.headers["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const safeType =
          /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm|quicktime)|application\/pdf)$/.test(
            contentType,
          );
        if (!safeType || (thumbnail && !contentType.startsWith("image/"))) {
          res.destroy();
          reject(
            new PublicError(
              "Buffer returned a web page or unsupported file, rather than downloadable original media. Open the source link instead.",
              422,
              "MEDIA_FORMAT_UNAVAILABLE",
            ),
          );
          return;
        }
        if (Number(res.headers["content-length"]) > limit) {
          res.destroy();
          reject(
            new PublicError(
              "This file exceeds the 50 MB download limit. Open its original source to save it.",
              413,
              "MEDIA_TOO_LARGE",
            ),
          );
          return;
        }
        let size = 0;
        const body = (
          Readable.toWeb(res) as ReadableStream<Uint8Array>
        ).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              size += chunk.length;
              if (size > limit) {
                const error = new PublicError(
                  "This file exceeds the download size limit. Open its original source to save it.",
                  413,
                  "MEDIA_TOO_LARGE",
                );
                failure(error);
                throw error;
              }
              controller.enqueue(chunk);
            },
          }),
        );
        resolve({ body, contentType });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () =>
      reject(
        new PublicError(
          "The media host could not be reached. Refresh the source post and retry.",
          502,
          "MEDIA_DOWNLOAD_FAILED",
        ),
      ),
    );
    req.end();
  });
}
