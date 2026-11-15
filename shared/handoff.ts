type Destination = { url?: string; platform?: string };
export type ShareLaunch = {
  url: string;
  prefilled: boolean;
  explanation: string;
};
export function variantFor(source: string, _destination: Destination) {
  return source.trim();
}
export function shareLaunch(
  destination: Destination,
  caption: string,
): ShareLaunch {
  let u: URL;
  try {
    u = new URL(destination.url || "");
  } catch {
    throw new Error("Choose a valid destination URL.");
  }
  if (u.protocol !== "https:" || u.username || u.password)
    throw new Error("Choose a secure HTTPS destination.");
  const host = u.hostname.toLowerCase(),
    text = caption.trim();
  let result: ShareLaunch;
  if (host === "reddit.com" || host.endsWith(".reddit.com")) {
    const path = u.pathname.match(/^\/r\/([A-Za-z0-9_]+)(?:\/|$)/),
      params = new URLSearchParams({
        selftext: "true",
        text,
        type: "TEXT",
        title: text.split("\n").find(Boolean)?.slice(0, 300) || "New post",
      });
    if (path) params.set("sr", path[1]);
    result = {
      url: "https://www.reddit.com/submit?" + params,
      prefilled: true,
      explanation: "Reddit text submit intent. Attach media manually.",
    };
  } else if (host === "bsky.app")
    result = {
      url: "https://bsky.app/intent/compose?" + new URLSearchParams({ text }),
      prefilled: true,
      explanation: "Bluesky text compose intent. Attach media manually.",
    };
  else if (host === "x.com" || host === "twitter.com")
    result = {
      url: "https://twitter.com/intent/tweet?" + new URLSearchParams({ text }),
      prefilled: true,
      explanation: "X text compose intent. Attach media manually.",
    };
  else
    return {
      url: u.href,
      prefilled: false,
      explanation:
        "Open the destination, then paste the caption and attach media.",
    };
  // Long web-intent URLs are not portable across browsers/platforms. Keep the
  // exact edited caption available to Copy instead of silently shortening it.
  return result.url.length <= 7000
    ? result
    : {
        url: u.href,
        prefilled: false,
        explanation:
          "Caption is too long for a reliable compose URL. Copy it and paste manually.",
      };
}
