import {
  router,
  json,
  db,
  secrets,
  requireAuth,
  isAppDatabaseError,
} from './platform';
import type {
  RouterContext,
  RouterMiddleware,
  RouterResponse,
} from './platform';
import { createHash } from 'node:crypto';
import {
  hash,
  nonce,
  parseKey,
  parseToken,
  encrypt,
  decrypt,
  needsRefresh,
  safeUrl,
  text,
  validId,
  plannedDate,
} from './security.ts';
import type { TokenData, Envelope } from './security.ts';

const CALLBACK =
  process.env.BUFFER_REDIRECT_URI || 'https://ghostpost.planet-x.co/api/auth/buffer/callback';
type Connection = Partial<Envelope> & {
  ownerId: string;
  version?: string;
  connectedAt?: number;
  expiresAt?: number | null;
  refreshId?: string;
  reconnectRequired?: boolean;
};
type Pending = {
  userId: string;
  stateHash: string;
  verifier: string;
  createdAt: number;
  used: boolean;
  version: string;
};
type Item = Record<string, unknown> & { id: string; archived?: boolean };
type Workspace = {
  ownerId: string;
  revision: number;
  drafts: Item[];
  destinations: Item[];
  tasks: Item[];
};
type Organization = { id: string; name: string };
type Channel = {
  id: string;
  name: string;
  service: string;
  avatar: string;
  isDisconnected: boolean;
  isLocked: boolean;
  isQueuePaused: boolean;
  allowedActions: string[];
  timezone: string;
  externalLink?: string;
};
type Post = {
  id: string;
  text: string;
  channelId: string;
  status: string;
  dueAt?: string;
  sentAt?: string;
  createdAt: string;
  assets?: { id: string; mimeType: string }[];
  externalLink?: string;
};
type Page = {
  edges: { node: Post }[];
  pageInfo: { hasNextPage: boolean; endCursor?: string };
};

class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
const secured =
  (fn: (ctx: RouterContext) => Promise<RouterResponse>): RouterMiddleware =>
  async (ctx) => {
    try {
      const result = await fn(ctx);
      result.headers = {
        ...result.headers,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      };
      return result;
    } catch (err) {
      let status = 503;
      let message =
        'This operation could not be completed. Please retry or reconnect Buffer.';
      if (err instanceof PublicError) {
        status = err.status;
        message = err.message;
      } else if (isAppDatabaseError(err)) {
        status = err.code === 'AppDatabaseQuotaExceeded' ? 429 : 503;
        message =
          status === 429
            ? 'Storage limit reached. Please wait before retrying.'
            : 'Storage could not confirm this operation. Reload before retrying.';
      }
      const result = json({ error: message }, status);
      result.headers['Cache-Control'] = 'no-store';
      return result;
    }
  };
function input(body: unknown): Record<string, unknown> {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Buffer.byteLength(JSON.stringify(body)) > 30000
  )
    throw new PublicError('Invalid or oversized request.');
  return body as Record<string, unknown>;
}
async function encryptionKey() {
  return parseKey(await secrets.readSecret('GHOSTPOST_TOKEN_ENCRYPTION_KEY'));
}
async function connection(userId: string): Promise<Connection> {
  const id = hash(userId);
  let [saved] = await db.get<Connection>('buffer_connections', [id], {
    consistent: true,
  });
  if (!saved) {
    await db.tx.add('buffer_connections', [
      { id, ownerId: userId, version: nonce() },
    ]);
    [saved] = await db.get<Connection>('buffer_connections', [id], {
      consistent: true,
    });
  }
  if (!saved || saved.ownerId !== userId)
    throw new PublicError('Connection could not be verified.', 403);
  if (!saved.version) {
    await db.tx.update(
      'buffer_connections',
      [
        {
          id,
          record: { version: nonce() },
          if: { version: undefined, ownerId: userId },
        },
      ],
      { patch: true },
    );
    [saved] = await db.get<Connection>('buffer_connections', [id], {
      consistent: true,
    });
    if (!saved || !saved.version || saved.ownerId !== userId)
      throw new PublicError('Connection changed. Retry.', 409);
  }
  return saved;
}
async function patchConnection(
  userId: string,
  saved: Connection,
  record: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const [ok] = await db.tx.update(
    'buffer_connections',
    [
      {
        id: hash(userId),
        record,
        if: { ownerId: userId, version: saved.version, ...extra },
      },
    ],
    { patch: true },
  );
  if (!ok)
    throw new PublicError(
      'Connection changed in another session. Refresh and retry.',
      409,
    );
}
async function accessToken(userId: string): Promise<string> {
  const saved = await connection(userId);
  if (!saved.ciphertext || !saved.iv || !saved.tag || saved.reconnectRequired)
    throw new PublicError('Reconnect Buffer to synchronize.', 401);
  const key = await encryptionKey();
  let token: TokenData;
  try {
    token = decrypt(saved as Envelope, key);
  } catch {
    throw new PublicError(
      'Stored connection cannot be opened. Reconnect Buffer.',
      409,
    );
  }
  if (saved.refreshId)
    throw new PublicError(
      'A token refresh is pending. If this persists, reconnect Buffer.',
      409,
    );
  if (!needsRefresh(saved.expiresAt)) return token.access_token;
  if (!token.refresh_token)
    throw new PublicError(
      'Buffer authorization expired. Reconnect Buffer.',
      401,
    );
  // Never steal a durable refresh lock: an unknown exchange outcome requires reconnect.
  const refreshId = nonce();
  await patchConnection(
    userId,
    saved,
    { refreshId },
    { refreshId: undefined, ciphertext: saved.ciphertext },
  );
  try {
    const response = await fetch('https://auth.buffer.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: await secrets.readSecret('BUFFER_CLIENT_ID'),
        client_secret: await secrets.readSecret('BUFFER_CLIENT_SECRET'),
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      }),
    });
    if (!response.ok) throw new Error('Refresh declined.');
    const rotated = parseToken(await response.json());
    if (!rotated.refresh_token || rotated.refresh_token === token.refresh_token)
      throw new Error('Missing rotated refresh token.');
    await patchConnection(
      userId,
      saved,
      {
        ...encrypt(rotated, key),
        expiresAt: Date.now() + (rotated.expires_in || 3600) * 1000,
        version: nonce(),
        refreshId: undefined,
        reconnectRequired: false,
      },
      { refreshId },
    );
    return rotated.access_token;
  } catch {
    await patchConnection(
      userId,
      saved,
      { reconnectRequired: true },
      { refreshId },
    ).catch(() => undefined);
    throw new PublicError(
      'Token refresh could not be safely confirmed. Reconnect Buffer.',
      401,
    );
  }
}
async function graph<T>(token: string, query: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch('https://api.buffer.com', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
  } catch {
    throw new PublicError(
      'Buffer did not respond. Try manual refresh again later.',
      502,
    );
  }
  if (response.status === 401)
    throw new PublicError(
      'Buffer access was revoked or expired. Reconnect Buffer.',
      401,
    );
  if (response.status === 429)
    throw new PublicError(
      'Buffer rate limit reached. Wait at least a minute before refreshing.',
      429,
    );
  if (!response.ok)
    throw new PublicError(
      'Buffer is unavailable. Your GhostPost records are preserved.',
      502,
    );
  const result = (await response.json()) as { data?: T; errors?: unknown[] };
  if (result.errors?.length || !result.data)
    throw new PublicError(
      'Buffer rejected this read. Check permissions and try reconnecting.',
      502,
    );
  return result.data;
}
async function cooldown(userId: string, action: string, ms: number) {
  const id = hash(userId + ':' + action);
  const [saved] = await db.get<{ at: number }>('request_limits', [id], {
    consistent: true,
  });
  const at = Date.now();
  if (saved && at - saved.at < ms)
    throw new PublicError('Please wait a moment before retrying.', 429);
  const ok = !saved
    ? (await db.tx.add('request_limits', [{ id, at }]))[0]
    : (
        await db.tx.update(
          'request_limits',
          [{ id, record: { at }, if: { at: saved.at } }],
          { patch: true },
        )
      )[0];
  if (!ok) throw new PublicError('A request is already running.', 429);
}
async function workspace(userId: string): Promise<Workspace> {
  const id = hash(userId);
  let [saved] = await db.get<Workspace>('workspaces', [id], {
    consistent: true,
  });
  if (!saved) {
    await db.tx.add('workspaces', [
      {
        id,
        ownerId: userId,
        revision: 0,
        drafts: [],
        destinations: [],
        tasks: [],
      },
    ]);
    [saved] = await db.get<Workspace>('workspaces', [id], { consistent: true });
  }
  if (!saved || saved.ownerId !== userId)
    throw new PublicError('Workspace could not be verified.', 403);
  return saved;
}
function validated(
  kind: string,
  value: Record<string, unknown>,
  current?: Item,
): Item {
  try {
    const shared = {
      id: validId(value.id),
      createdAt: current?.createdAt || Date.now(),
      updatedAt: Date.now(),
      archived: value.archived === true,
    };
    if (kind === 'drafts')
      return {
        ...shared,
        title: text(value.title, 120, true),
        text: text(value.text, 10000, true),
        platform: text(value.platform || 'general', 40),
        campaign: text(value.campaign || '', 80),
        plannedAt: plannedDate(value.plannedAt),
      };
    if (kind === 'destinations')
      return {
        ...shared,
        name: text(value.name, 100, true),
        platform: text(value.platform, 40, true),
        url: safeUrl(value.url),
        notes: text(value.notes || '', 2000),
        format: text(value.format || '', 120),
        instructions: text(value.instructions || '', 2000),
        active: value.active !== false,
      };
    if (kind === 'tasks') {
      const complete = value.state === 'complete';
      return {
        ...shared,
        destinationId: validId(value.destinationId),
        destinationName: text(value.destinationName, 100, true),
        destinationUrl: safeUrl(value.destinationUrl),
        contentRef: text(value.contentRef || '', 200),
        text: text(value.text, 10000, true),
        notes: text(value.notes || '', 2000),
        resultUrl: safeUrl(value.resultUrl, true),
        state: complete ? 'complete' : 'pending',
        completedAt: complete
          ? current?.state === 'complete'
            ? current.completedAt
            : Date.now()
          : null,
        verification: 'user-reported',
      };
    }
  } catch (err) {
    throw new PublicError(
      err instanceof Error ? err.message : 'Invalid record.',
    );
  }
  throw new PublicError('Unknown record type.', 404);
}
const recordRoute = (remove = false) =>
  secured(async ({ user, body, params }) => {
    const kind = params.kind as 'drafts' | 'destinations' | 'tasks';
    if (!['drafts', 'destinations', 'tasks'].includes(kind))
      throw new PublicError('Unknown record type.', 404);
    const request = input(body);
    const id = validId(params.id);
    const saved = await workspace(user!.userId);
    if (request.revision !== saved.revision)
      throw new PublicError(
        'Workspace changed in another tab. Reload your workspace before saving.',
        409,
      );
    const current = saved[kind].find((item) => item.id === id);
    if (remove && !current) throw new PublicError('Record not found.', 404);
    const item = remove
      ? { ...current!, archived: true, updatedAt: Date.now() }
      : validated(kind, { ...request, id }, current);
    if (
      kind === 'tasks' &&
      !current &&
      !saved.destinations.some(
        (d) => d.id === item.destinationId && !d.archived && d.active !== false,
      )
    )
      throw new PublicError('Choose an active destination in this workspace.');
    const items = current
      ? saved[kind].map((record) => (record.id === id ? item : record))
      : [...saved[kind], item];
    if (items.length > 100)
      throw new PublicError('This alpha supports 100 records per collection.');
    const next = { ...saved, [kind]: items, revision: saved.revision + 1 };
    if (Buffer.byteLength(JSON.stringify(next)) > 220000)
      throw new PublicError(
        'Workspace capacity reached. Shorten long records before adding more.',
      );
    const [ok] = await db.tx.update('workspaces', [
      {
        id: hash(user!.userId),
        record: next,
        if: { ownerId: user!.userId, revision: saved.revision },
      },
    ]);
    if (!ok)
      throw new PublicError('Workspace changed. Reload before saving.', 409);
    return json(next);
  });
// Persist safe sync diagnostics separately from encrypted credentials. Errors
// never include upstream response bodies, authorization codes or token values.
const trackedSync = (fn: (ctx: RouterContext) => Promise<RouterResponse>) =>
  secured(async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      const id = hash(ctx.user!.userId);
      const lastError = {
        message:
          err instanceof PublicError
            ? err.message
            : 'Synchronization could not be completed.',
        at: Date.now(),
      };
      try {
        const [saved] = await db.get<{ ownerId: string }>('sync_meta', [id], {
          consistent: true,
        });
        if (saved?.ownerId === ctx.user!.userId) {
          await db.tx.update(
            'sync_meta',
            [{ id, record: { lastError }, if: { ownerId: ctx.user!.userId } }],
            { patch: true },
          );
        } else if (!saved) {
          await db.tx.add('sync_meta', [
            { id, ownerId: ctx.user!.userId, lastError },
          ]);
        }
      } catch {
        /* Diagnostics must not hide the original error or replay a request. */
      }
      throw err;
    }
  });

export const handler = router({
  'GET /api/_healthcheck': [
    secured(async () => {
      let encryptionReady = false;
      try {
        const key = await encryptionKey();
        encryptionReady =
          decrypt(encrypt({ access_token: 'synthetic-healthcheck' }, key), key)
            .access_token === 'synthetic-healthcheck';
      } catch {
        /* Derived status only. */
      }
      return json({ status: 'ok', version: '0.3.0', encryptionReady });
    }),
  ],
  'GET /api/buffer/status': [
    secured(async () => {
      const names = await secrets.listSecretNames();
      return json({
        configured: [
          'BUFFER_CLIENT_ID',
          'BUFFER_CLIENT_SECRET',
          'GHOSTPOST_TOKEN_ENCRYPTION_KEY',
        ].every((name) => names.includes(name)),
        callback: CALLBACK,
        mode: 'read-only',
      });
    }),
  ],
  'GET /api/buffer/me': [
    requireAuth(),
    secured(async ({ user }) => {
      const saved = await connection(user!.userId);
      const [sync] = await db.get('sync_meta', [hash(user!.userId)], {
        consistent: true,
      });
      return json({
        connected: Boolean(saved.ciphertext),
        connectedAt: saved.ciphertext ? saved.connectedAt : null,
        expiresAt: saved.expiresAt || null,
        reconnectRequired: Boolean(saved.reconnectRequired || saved.refreshId),
        sync: sync?.data || null,
        lastError: sync?.lastError || null,
      });
    }),
  ],
  'POST /api/buffer/disconnect': [
    requireAuth(),
    secured(async ({ user }) => {
      const saved = await connection(user!.userId);
      await patchConnection(user!.userId, saved, {
        ciphertext: undefined,
        iv: undefined,
        tag: undefined,
        expiresAt: undefined,
        connectedAt: undefined,
        refreshId: undefined,
        reconnectRequired: false,
        disconnectedAt: Date.now(),
        version: nonce(),
      });
      await db.delete('sync_meta', [hash(user!.userId)]);
      return json({ disconnected: true });
    }),
  ],
  'POST /api/buffer/start': [
    requireAuth(),
    secured(async ({ user }) => {
      await cooldown(user!.userId, 'oauth', 5000);
      await encryptionKey();
      const saved = await connection(user!.userId);
      const verifier = nonce();
      const state = nonce();
      const [created] = await db.tx.update('oauth_pending_v2', [
        {
          id: hash(user!.userId),
          record: {
            userId: user!.userId,
            stateHash: hash(state),
            verifier,
            createdAt: Date.now(),
            used: false,
            version: saved.version,
          },
        },
      ]);
      if (!created)
        throw new PublicError(
          'Could not confirm authorization initialization.',
          503,
        );
      const query = new URLSearchParams({
        client_id: await secrets.readSecret('BUFFER_CLIENT_ID'),
        redirect_uri: CALLBACK,
        response_type: 'code',
        scope: 'posts:read account:read offline_access',
        state,
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'consent',
      });
      const response = json({
        authorizationUrl: 'https://auth.buffer.com/auth?' + query.toString(),
      });
      response.headers['Set-Cookie'] =
        'gp_oauth=' +
        state +
        '; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax';
      return response;
    }),
  ],
  'GET /api/auth/buffer/callback': [
    async ({ query }) => {
      const params = new URLSearchParams({ gp_buffer: '1' });
      for (const name of ['state', 'code', 'error'])
        if (query[name]) params.set('gp_' + name, query[name].slice(0, 4096));
      return {
        statusCode: 302,
        headers: {
          Location: '/?' + params.toString(),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
        body: '',
      };
    },
  ],
  'POST /api/buffer/finish': [
    requireAuth(),
    secured(async ({ body, event, user }) => {
      const request = input(body);
      const state = typeof request.state === 'string' ? request.state : '';
      const cookies = [
        ...(event.cookies || []),
        event.headers?.cookie || event.headers?.Cookie || '',
      ].join(';');
      const browserState = cookies
        .split(';')
        .map((s: string) => s.trim())
        .find((s: string) => s.startsWith('gp_oauth='))
        ?.slice(9);
      if (!/^[a-zA-Z0-9_-]{43}$/.test(state) || state !== browserState)
        throw new PublicError(
          'OAuth state did not match this browser. Start Connect Buffer again.',
          403,
        );
      const id = hash(user!.userId);
      const [pending] = await db.get<Pending>('oauth_pending_v2', [id], {
        consistent: true,
      });
      if (
        !pending ||
        pending.userId !== user!.userId ||
        pending.stateHash !== hash(state) ||
        pending.used ||
        Date.now() - pending.createdAt > 600000 ||
        pending.createdAt > Date.now()
      )
        throw new PublicError(
          'Authorization is expired or already used. Start Connect Buffer again.',
          403,
        );
      const [claimed] = await db.tx.update(
        'oauth_pending_v2',
        [
          {
            id,
            record: { used: true, verifier: undefined },
            if: {
              stateHash: pending.stateHash,
              used: false,
              userId: user!.userId,
            },
          },
        ],
        { patch: true },
      );
      if (!claimed) throw new PublicError('Authorization already used.', 403);
      const saved = await connection(user!.userId);
      if (saved.version !== pending.version)
        throw new PublicError(
          'Connection changed after authorization began. Start again.',
          409,
        );
      if (request.error)
        throw new PublicError(
          'Buffer authorization was canceled. Your previous connection is preserved.',
        );
      if (
        typeof request.code !== 'string' ||
        !request.code ||
        request.code.length > 4096
      )
        throw new PublicError('Buffer returned no valid authorization code.');
      const key = await encryptionKey();
      const response = await fetch('https://auth.buffer.com/token', {
        method: 'POST',
        signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: await secrets.readSecret('BUFFER_CLIENT_ID'),
          client_secret: await secrets.readSecret('BUFFER_CLIENT_SECRET'),
          grant_type: 'authorization_code',
          code: request.code,
          redirect_uri: CALLBACK,
          code_verifier: pending.verifier,
        }),
      });
      if (!response.ok)
        throw new PublicError(
          'Buffer declined the exchange. Start Connect Buffer again.',
          502,
        );
      const token = parseToken(await response.json());
      await patchConnection(user!.userId, saved, {
        ...encrypt(token, key),
        connectedAt: Date.now(),
        expiresAt: Date.now() + (token.expires_in || 3600) * 1000,
        refreshId: undefined,
        reconnectRequired: false,
        disconnectedAt: undefined,
        version: nonce(),
      });
      const result = json({
        status: 'connected',
        message:
          'Buffer connected. Credentials are encrypted for your GhostPost account.',
      });
      result.headers['Set-Cookie'] =
        'gp_oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
      return result;
    }),
  ],
  'POST /api/buffer/sync': [
    requireAuth(),
    trackedSync(async ({ user, body }) => {
      const request = input(body);
      const mode = String(request.mode || 'channels');
      if (!['channels', 'queue', 'history'].includes(mode))
        throw new PublicError('Unknown sync mode.');
      await cooldown(user!.userId, 'sync_' + mode, 4000);
      const token = await accessToken(user!.userId);
      const { account } = await graph<{
        account: { id: string; organizations: Organization[] };
      }>(
        token,
        'query GhostPostAccount { account { id organizations { id name } } }',
      );
      const orgs = account.organizations;
      const org =
        orgs.find((item) => item.id === request.organizationId) ||
        (!request.organizationId ? orgs[0] : undefined);
      if (!org) {
        if (orgs.length)
          throw new PublicError(
            'Choose an organization available to this Buffer account.',
            403,
          );
        return json({
          accountId: account.id,
          organizations: [],
          channels: [],
          posts: [],
          pageInfo: { hasNextPage: false },
          syncedAt: Date.now(),
        });
      }
      const orgLiteral = JSON.stringify(org.id);
      let data: Record<string, unknown>;
      if (mode === 'channels') {
        const result = await graph<{ channels: Channel[] }>(
          token,
          `query GhostPostChannels { channels(input: { organizationId: ${orgLiteral} }) { id name service avatar isDisconnected isLocked isQueuePaused allowedActions timezone externalLink } }`,
        );
        data = {
          channels: result.channels.map((channel) => ({
            ...channel,
            canScheduleInBuffer:
              !channel.isDisconnected &&
              !channel.isLocked &&
              channel.allowedActions.includes('scheduleUpdates'),
          })),
        };
      } else {
        const after = request.after ? text(request.after, 2048) : '';
        const statuses =
          mode === 'queue'
            ? '[scheduled, sending, needs_approval, draft]'
            : '[sent, error]';
        const direction = mode === 'queue' ? 'asc' : 'desc';
        const query = `query GhostPostPosts { posts(first: 30, after: ${after ? JSON.stringify(after) : 'null'}, input: { organizationId: ${orgLiteral}, filter: { status: ${statuses} }, sort: [{ field: dueAt, direction: ${direction} }, { field: createdAt, direction: ${direction} }] }) { edges { node { id text channelId status dueAt sentAt createdAt externalLink assets { id mimeType } } } pageInfo { hasNextPage endCursor } } }`;
        const result = await graph<{ posts: Page }>(token, query);
        data = {
          posts: result.posts.edges.map((edge) => ({
            ...edge.node,
            text: edge.node.text.slice(0, 10000),
            assets: edge.node.assets?.slice(0, 20) || [],
          })),
          pageInfo: result.posts.pageInfo,
        };
      }
      const syncedAt = Date.now();
      await db.tx.update('sync_meta', [
        {
          id: hash(user!.userId),
          record: {
            ownerId: user!.userId,
            data: { mode, syncedAt, organizationId: org.id },
          },
        },
      ]);
      return json({
        ...data,
        accountId: account.id,
        organizations: orgs,
        organizationId: org.id,
        syncedAt,
      });
    }),
  ],
  'POST /api/workspace/import': [
    requireAuth(),
    secured(async ({user,body}) => {
      const request = body as Record<string,unknown>;
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new PublicError('Choose a GhostPost workspace export.');
      const saved = await workspace(user!.userId);
      if (request.revision !== saved.revision) throw new PublicError('Workspace changed. Reload before importing.',409);
      const source = request.workspace as Record<string,unknown>;
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new PublicError('Invalid workspace export.');
      const next = {...saved, revision:saved.revision+1};
      const counts:Record<string,number> = {};
      for (const kind of ['destinations','drafts','tasks'] as const) {
        const values = source[kind];
        if (!Array.isArray(values) || values.length > 100) throw new PublicError('Each collection must contain at most 100 records.');
        const additions:Item[] = [];
        const seen = new Set<string>();
        for (const raw of values) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PublicError('Invalid record in export.');
          const item = validated(kind,raw,raw);
          if(seen.has(item.id)) throw new PublicError('Export contains duplicate record IDs.');
          seen.add(item.id);
          if(saved[kind].some(existing=>existing.id===item.id)) throw new PublicError('This export overlaps existing records. No records were imported.',409);
          additions.push(item);
        }
        next[kind] = [...saved[kind],...additions];
        if(next[kind].length > 100) throw new PublicError('Import would exceed workspace capacity.');
        counts[kind]=additions.length;
      }
      if(next.tasks.some(task=>!next.destinations.some(dest=>dest.id===task.destinationId))) throw new PublicError('An imported task is missing its destination.');
      if(Buffer.byteLength(JSON.stringify(next))>220000) throw new PublicError('Import would exceed workspace capacity.');
      const [ok]=await db.tx.update('workspaces',[{id:hash(user!.userId),record:next,if:{ownerId:user!.userId,revision:saved.revision}}]);
      if(!ok) throw new PublicError('Workspace changed. Reload before importing.',409);
      return json({workspace:next,counts});
    }),
  ],
  'GET /api/workspace': [
    requireAuth(),
    secured(async ({ user }) => json(await workspace(user!.userId))),
  ],
  'PUT /api/workspace/:kind/:id': [requireAuth(), recordRoute()],
  'DELETE /api/workspace/:kind/:id': [requireAuth(), recordRoute(true)],
});
