export type MediaAsset = {
  id?: string | null;
  key: string;
  mimeType: string;
  source: string;
  thumbnail: string;
};
export type SourceReference = {
  sourcePostId?: string;
  sourceChannelId?: string;
  sourceAssetKeys?: string[];
};
export function mediaPath(postId: string, key: string, thumbnail = false) {
  return (
    "/api/buffer/media/" +
    encodeURIComponent(postId) +
    "/" +
    encodeURIComponent(key) +
    (thumbnail ? "?variant=thumbnail" : "")
  );
}
export function mediaExtension(mime: string) {
  return (
    (
      {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/avif": "avif",
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "video/webm": "webm",
        "application/pdf": "pdf",
      } as Record<string, string>
    )[mime] || "bin"
  );
}
export function publicMediaUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
      ? url.href
      : "";
  } catch {
    return "";
  }
}
