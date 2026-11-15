export type CampaignPost = {
  id: string;
  channelId: string;
  status: string;
  sentAt?: string | null;
  dueAt?: string | null;
  createdAt: string;
  contentItemId?: string | null;
  ideaId?: string | null;
};
export function campaignMinute(post: CampaignPost) {
  const timestamp = post.status === "sent" ? post.sentAt : post.dueAt;
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 60000) : null;
}
export function postTime(post: CampaignPost) {
  const timestamp = post.status === "sent" ? post.sentAt : post.dueAt;
  return Date.parse(timestamp || post.createdAt) || 0;
}
function identity(post: CampaignPost) {
  return post.contentItemId
    ? "content:" + post.contentItemId
    : post.ideaId
      ? "idea:" + post.ideaId
      : "minute";
}
export function campaignKey(group: CampaignPost[]) {
  const first = group[0];
  if (!first) return "empty";
  const minute = campaignMinute(first);
  return minute === null
    ? "post:" + first.id
    : first.status +
        ":" +
        minute +
        ":" +
        identity(first) +
        (group.length === 1 ? ":" + first.id : "");
}
export function campaignGroups<T extends CampaignPost>(posts: T[]): T[][] {
  const buckets = new Map<string, T[]>(),
    singles: T[][] = [];
  for (const post of new Map(posts.map((p) => [p.id, p])).values()) {
    const minute = campaignMinute(post);
    if (minute === null) {
      singles.push([post]);
      continue;
    }
    const key = post.status + ":" + minute + ":" + identity(post);
    buckets.set(key, [...(buckets.get(key) || []), post]);
  }
  const groups = [...singles];
  for (const bucket of buckets.values()) {
    bucket.sort(
      (a, b) =>
        a.channelId.localeCompare(b.channelId) || a.id.localeCompare(b.id),
    );
    // Repeated channels without a reliable relationship are ambiguous; never guess.
    if (
      identity(bucket[0]) === "minute" &&
      new Set(bucket.map((p) => p.channelId)).size < bucket.length
    )
      groups.push(...bucket.map((p) => [p]));
    else groups.push(bucket);
  }
  return groups.sort(
    (a, b) =>
      postTime(a[0]) - postTime(b[0]) ||
      campaignKey(a).localeCompare(campaignKey(b)),
  );
}
