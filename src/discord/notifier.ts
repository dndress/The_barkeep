// Minimal Discord notifier — REST-only, no gateway connection.
//
// Purpose: send Andres (the admin / developer) a Direct Message when the
// pipeline hits something that needs human intervention. Right now that's
// just "couldn't reconcile a session's campaign/DM/characters" but the
// surface is meant to grow as we add more ops-relevant signals.
//
// Why REST-only (not discord.js): we don't need slash commands or message
// listeners yet — those come in Stage 6 when the Barkeep starts answering
// players. Avoiding the gateway keeps the runtime lean and avoids managing
// a long-lived WebSocket connection.
//
// Idempotency: no — duplicate calls send duplicate DMs. Callers are
// expected to gate notifications behind a status change (e.g. only on the
// transition to NEEDS_REVIEW).
import type { FastifyBaseLogger } from 'fastify';

const DISCORD_API = 'https://discord.com/api/v10';

interface NotifierConfig {
  botToken: string;
  adminUserId: string;
}

export interface AdminMessageContext {
  /** Optional structured context. Rendered inline as a small code block. */
  [key: string]: unknown;
}

let _config: NotifierConfig | null | undefined;

function getNotifierConfig(): NotifierConfig | null {
  if (_config !== undefined) return _config;
  const botToken = process.env.BARKEEP_DISCORD_BOT_TOKEN;
  const adminUserId = process.env.ADMIN_DISCORD_USER_ID;
  if (!botToken || !adminUserId) {
    _config = null;
  } else {
    _config = { botToken, adminUserId };
  }
  return _config;
}

async function discordFetch(
  cfg: NotifierConfig,
  path: string,
  init: RequestInit & { body?: string } = {}
): Promise<Response> {
  return fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bot ${cfg.botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'BarkeepBot (https://github.com/, v0.5.0)'
    }
  });
}

async function withRateLimitRetry<T>(
  log: FastifyBaseLogger,
  fn: () => Promise<Response>,
  parse: (r: Response) => Promise<T>
): Promise<T> {
  const first = await fn();
  if (first.status === 429) {
    // Discord tells us how long to wait via retry_after (seconds).
    let waitMs = 1000;
    try {
      const body = (await first.clone().json()) as { retry_after?: number };
      if (typeof body.retry_after === 'number') waitMs = Math.ceil(body.retry_after * 1000);
    } catch {
      // ignore parse error, use default
    }
    log.warn({ waitMs }, 'discord rate-limited; retrying once');
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const second = await fn();
    if (!second.ok) {
      throw new Error(`discord retry failed: HTTP ${second.status} ${await second.text()}`);
    }
    return parse(second);
  }
  if (!first.ok) {
    throw new Error(`discord call failed: HTTP ${first.status} ${await first.text()}`);
  }
  return parse(first);
}

/** Resolve or open a DM channel with the admin. Cached in memory. */
let _dmChannelId: string | undefined;
async function getAdminDmChannel(cfg: NotifierConfig, log: FastifyBaseLogger): Promise<string> {
  if (_dmChannelId) return _dmChannelId;
  const data = await withRateLimitRetry(
    log,
    () =>
      discordFetch(cfg, '/users/@me/channels', {
        method: 'POST',
        body: JSON.stringify({ recipient_id: cfg.adminUserId })
      }),
    (r) => r.json() as Promise<{ id: string }>
  );
  _dmChannelId = data.id;
  return data.id;
}

/**
 * Send a DM to the admin. No-op (and logs a warning) when bot token or
 * admin id isn't configured — Stage 5 will still work without the bot, but
 * NEEDS_REVIEW sessions will only show up in logs and DB.
 *
 * Failures are caught + logged but never thrown — a Discord outage must
 * not break the pipeline.
 */
export async function notifyAdmin(
  log: FastifyBaseLogger,
  message: string,
  context?: AdminMessageContext
): Promise<void> {
  const cfg = getNotifierConfig();
  if (!cfg) {
    log.warn(
      { message },
      'notifyAdmin called but BARKEEP_DISCORD_BOT_TOKEN or ADMIN_DISCORD_USER_ID is unset — skipping DM'
    );
    return;
  }

  // Format the body: human-readable message + optional context block.
  let body = message;
  if (context && Object.keys(context).length > 0) {
    const json = JSON.stringify(context, null, 2);
    // Discord caps message content at 2000 chars; trim the context if
    // necessary so we don't lose the human-readable lead.
    const room = 1900 - body.length - 10; // 10 for the code-fence markers
    const ctx = json.length > room ? json.slice(0, Math.max(0, room - 3)) + '...' : json;
    body += `\n\`\`\`json\n${ctx}\n\`\`\``;
  }

  try {
    const channelId = await getAdminDmChannel(cfg, log);
    await withRateLimitRetry(
      log,
      () =>
        discordFetch(cfg, `/channels/${channelId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: body })
        }),
      (r) => r.json() as Promise<unknown>
    );
    log.info({ adminUserId: cfg.adminUserId }, 'admin DM sent');
  } catch (err) {
    log.error({ err }, 'failed to send admin DM (continuing)');
  }
}
