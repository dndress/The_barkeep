// Discord.js client singleton. Replaces the REST-only fetch calls from
// Stage 5 — Stage 6 needs a real gateway connection so we can receive
// button-click interactions and slash commands.
//
// Intents:
//   - Guilds:         required for everything; bot needs to know about guilds
//   - DirectMessages: needed so we can receive button-click interactions
//                     that come from DMs (the NEEDS_REVIEW review flow)
//
// We do NOT request MessageContent or GuildMembers (both privileged) —
// nothing in Stage 6 needs to read message bodies or member rosters.
import {
  Client,
  GatewayIntentBits,
  Partials
} from 'discord.js';
import type { FastifyBaseLogger } from 'fastify';

let _client: Client | undefined;
let _readyPromise: Promise<Client> | undefined;

interface StartDiscordClientOptions {
  token: string;
  log: FastifyBaseLogger;
}

/**
 * Start the client and resolve once it emits `ready`. Subsequent calls
 * return the same in-flight or completed promise.
 */
export function startDiscordClient(opts: StartDiscordClientOptions): Promise<Client> {
  if (_readyPromise) return _readyPromise;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    // Required for receiving interactions originating in DM channels — the
    // channel object is partial until materialized.
    partials: [Partials.Channel]
  });
  _client = client;

  _readyPromise = new Promise<Client>((resolve, reject) => {
    const onReady = (): void => {
      opts.log.info({ tag: client.user?.tag }, 'discord client ready');
      resolve(client);
    };
    client.once('ready', onReady);
    client.once('error', (err) => {
      opts.log.error({ err }, 'discord client error during login');
      reject(err);
    });
    client.login(opts.token).catch((err) => {
      opts.log.error({ err }, 'discord login failed');
      reject(err);
    });
  });

  return _readyPromise;
}

/**
 * Get the ready client. Throws if startDiscordClient hasn't been called
 * yet — boot order in index.ts must start the client before the worker.
 */
export function getDiscordClient(): Client {
  if (!_client || !_client.isReady()) {
    throw new Error(
      'discord client is not ready — startDiscordClient must run and resolve before this is called'
    );
  }
  return _client;
}

/** True if the client has been started AND is currently ready. */
export function isDiscordReady(): boolean {
  return Boolean(_client?.isReady());
}

export async function destroyDiscordClient(): Promise<void> {
  if (_client) {
    await _client.destroy();
    _client = undefined;
    _readyPromise = undefined;
  }
}
