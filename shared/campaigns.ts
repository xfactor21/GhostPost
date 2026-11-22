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

// Publication time is a display/sorting value, not a campaign identifier.
// Buffer may publish different channels minutes apart.
export function campaignMinute(post: CampaignPost) {
  const timestamp = post.status === "sent" ? post.sentAt : post.dueAt;
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 60000) : null;
}
export function postTime(post: CampaignPost) {
  const timestamp = post.status === "sent" ? post.sentAt : post.dueAt;
  return Date.parse(timestamp || post.createdAt) || 0;
}
function relationship(post: CampaignPost) {
  const contentId = post.contentItemId?.trim();
  if (contentId) return "content:" + contentId;
  const ideaId = post.ideaId?.trim();
  if (ideaId) return "idea:" + ideaId;
  return null;
}
function bucketKey(post: CampaignPost) {
  const id = relationship(post);
  if (id) return post.status + ":" + id;
  const minute = campaignMinute(post);
  return minute === null ? "post:" + post.id : post.status + ":minute:" + minute;
}
export function campaignKey(group: CampaignPost[]) {
  if (!group.length) return "empty";
  const first = group[0];
  const key = bucketKey(first);
  return group.length === 1 ? key + ":post:" + first.id : key;
}
export function campaignGroups<T extends CampaignPost>(posts: T[]): T[][] {
  const buckets = new Map<string, T[]>();
  for (const post of new Map(posts.map((p) => [p.id, p])).values()) {
    const key = bucketKey(post);
    buckets.set(key, [...(buckets.get(key) || []), post]);
  }
  const groups: T[][] = [];
  for (const bucket of buckets.values()) {
    bucket.sort(
      (a, b) =>
        a.channelId.localeCompare(b.channelId) || a.id.localeCompare(b.id),
    );
    // Never collapse repeated versions on the same channel without a
    // verified relationship and an explicit user decision.
    if (new Set(bucket.map((p) => p.channelId)).size !== bucket.length)
      groups.push(...bucket.map((p) => [p]));
    else groups.push(bucket);
  }
  return groups.sort(
    (a, b) =>
      Math.min(...a.map(postTime)) - Math.min(...b.map(postTime)) ||
      campaignKey(a).localeCompare(campaignKey(b)),
  );
}
