import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { CallbackData, QueryResponseItem, TeamSpeakClient } from 'node-ts' with { 'resolution-mode': 'import' };

/** node-ts is published as an ES module, so it is loaded with a dynamic import from this CommonJS app. */
type NodeTsModule = typeof import('node-ts', { with: { 'resolution-mode': 'import' } });
let nodeTs: Promise<NodeTsModule> | undefined;
function loadNodeTs(): Promise<NodeTsModule> {
  if (!nodeTs) nodeTs = import('node-ts');
  return nodeTs;
}

export interface TeamSpeakConnectionOptions {
  host: string;
  /** Raw ServerQuery port, 10011 by default. */
  queryPort: number;
  username: string;
  password: string;
  /**
   * Voice port of the virtual server to select. One TeamSpeak instance can host several virtual
   * servers behind the same query port; the voice port is only used to pick one of them.
   * Leave it out to stay on the instance level, e.g. to list the virtual servers.
   */
  serverPort?: number;
  /** Nickname of the query client, shown to other admins. Optional. */
  nickname?: string;
  /** Timeout for connecting and for every single command. */
  timeoutMs?: number;
}

/** Error ids returned by the TeamSpeak ServerQuery interface that the app handles explicitly. */
export const QueryErrorId = {
  DATABASE_EMPTY_RESULT: 1281,
  INVALID_LOGIN: 520,
  INVALID_SERVER_ID: 1024,
  SERVER_NOT_RUNNING: 1033,
  INSUFFICIENT_PERMISSIONS: 2568,
  FLOOD_BANNED: 3329,
  /** Not a server error: the virtual servers could not be listed and the default voice port did not work. */
  SERVER_LIST_DENIED: -1,
  /** Not a server error: the instance has no running virtual servers. */
  NO_RUNNING_SERVERS: -2,
} as const;

export class TeamSpeakQueryError extends Error {
  constructor(message: string, public readonly id?: number) {
    super(message);
    this.name = 'TeamSpeakQueryError';
  }
}

export type RawItem = QueryResponseItem;

const CLIENT_LIST_OPTIONS = ['uid', 'away', 'voice', 'times', 'info', 'country', 'groups'];

/**
 * Small wrapper around the node-ts TeamSpeakClient that adds the things a long running
 * Homey device needs: timeouts, proper Error objects, cleanup of pending commands when the
 * socket closes and a single "clients-changed" event for join/leave/move notifications.
 *
 * Events: `clients-changed`, `close` (with the last error, if any).
 */
export class TeamSpeakQuery extends EventEmitter {
  private client?: TeamSpeakClient;
  private connected = false;
  private closing = false;
  private lastError?: Error;
  private readonly pending = new Set<(err: Error) => void>();
  private readonly timeoutMs: number;

  constructor(private readonly options: TeamSpeakConnectionOptions) {
    super();
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Connects, logs in, selects the virtual server and subscribes to server events. */
  async connect(): Promise<void> {
    const { TeamSpeakClient } = await loadNodeTs();
    const client = new TeamSpeakClient(this.options.host, this.options.queryPort);
    this.client = client;
    catchReaderErrors(client, (err) => { this.lastError = this.lastError ?? err; });

    // node-ts re-emits socket errors; without a listener EventEmitter would throw them.
    client.on('error', (err: Error) => { this.lastError = err; });
    client.on('close', () => this.handleClose());
    client.on('cliententerview', () => this.emit('clients-changed', 'cliententerview'));
    client.on('clientleftview', () => this.emit('clients-changed', 'clientleftview'));
    client.on('clientmoved', () => this.emit('clients-changed', 'clientmoved'));

    try {
      await this.withTimeout(client.connect(), `Could not connect to ${this.options.host}:${this.options.queryPort}`);
      this.connected = true;
      await this.command('login', { client_login_name: this.options.username, client_login_password: this.options.password });
      if (this.options.serverPort) await this.command('use', { port: this.options.serverPort });
      if (this.options.serverPort && this.options.nickname) {
        // The nickname may already be taken or not allowed; that is not a reason to fail.
        await this.command('clientupdate', { client_nickname: this.options.nickname }).catch(() => undefined);
      }
      if (this.options.serverPort) {
        // Without the b_virtualserver_notify_register permission the app falls back to polling only.
        await this.command('servernotifyregister', { event: 'server' }).catch(() => undefined);
      }
    } catch (err) {
      this.destroy();
      throw toError(err, this.lastError);
    }
  }

  /** Lists the virtual servers of this instance. Needs the b_serverinstance_virtualserver_list permission. */
  async listServers(): Promise<RawItem[]> {
    return this.command('serverlist', {}, ['uid']);
  }

  async selectServer(port: number): Promise<void> {
    await this.command('use', { port });
  }

  async getServerInfo(): Promise<RawItem> {
    const [info] = await this.command('serverinfo');
    if (!info) throw new TeamSpeakQueryError('Empty serverinfo response');
    return info;
  }

  async getClients(): Promise<RawItem[]> {
    return this.command('clientlist', {}, CLIENT_LIST_OPTIONS);
  }

  async getChannels(): Promise<RawItem[]> {
    return this.command('channellist');
  }

  async sendServerMessage(serverId: number, message: string): Promise<void> {
    await this.command('sendtextmessage', { targetmode: 3, target: serverId, msg: message });
  }

  async pokeClient(clientId: number, message: string): Promise<void> {
    await this.command('clientpoke', { clid: clientId, msg: message });
  }

  /** Logs out and closes the socket. Safe to call multiple times. */
  async disconnect(): Promise<void> {
    if (!this.client) return;
    this.closing = true;
    const socket = this.getSocket();
    if (this.connected && socket && !socket.destroyed) {
      // The server closes the connection after "quit"; waiting for that lets node-ts finish reading cleanly.
      const closed = new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        setTimeout(resolve, 1000);
      });
      this.client.send('quit', {}, []).catch(() => undefined);
      await closed;
    }
    this.destroy();
  }

  /** Sends a command and returns the parsed response items. An empty result set is returned as []. */
  async command(cmd: string, params: Record<string, unknown> = {}, options: string[] = []): Promise<RawItem[]> {
    if (!this.client || !this.connected) throw new TeamSpeakQueryError('Not connected to the TeamSpeak server');
    try {
      const result = await this.withTimeout<CallbackData<RawItem>>(this.client.send(cmd, params, options), `Command "${cmd}" timed out`);
      return (result.response ?? []).filter((item) => Object.keys(item).length > 0);
    } catch (err) {
      const error = toError(err);
      if (error instanceof TeamSpeakQueryError && error.id === QueryErrorId.DATABASE_EMPTY_RESULT) return [];
      throw error;
    }
  }

  private withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = this.timeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const fail = (err: Error) => { cleanup(); reject(err); };
      const timer = setTimeout(() => {
        fail(new TeamSpeakQueryError(message));
        // A command that never answers means the connection is unusable.
        this.destroy();
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.pending.delete(fail); };
      this.pending.add(fail);
      promise.then((value) => { cleanup(); resolve(value); }, (err) => fail(toError(err, this.lastError)));
    });
  }

  private handleClose(): void {
    const wasConnected = this.connected;
    this.connected = false;
    const error = this.lastError ?? new TeamSpeakQueryError('Connection to the TeamSpeak server was closed');
    for (const reject of [...this.pending]) reject(error);
    this.pending.clear();
    if (wasConnected && !this.closing) this.emit('close', error);
  }

  /** node-ts does not expose its socket, but it is needed to close a connection that is not healthy. */
  private getSocket(): Socket | undefined {
    return (this.client as unknown as { socket?: Socket } | undefined)?.socket;
  }

  private destroy(): void {
    this.closing = true;
    this.getSocket()?.destroy();
    this.client?.removeAllListeners();
    this.connected = false;
    for (const reject of [...this.pending]) reject(new TeamSpeakQueryError('Connection closed'));
    this.pending.clear();
  }
}

/**
 * node-ts reads the socket in an async method that is started from the socket's "connect" event
 * and never awaited. When the socket closes before the stream ends (a reset, or a timeout), that
 * method rejects with nobody handling it, which crashes Node. Wrap it to catch those errors.
 */
function catchReaderErrors(client: TeamSpeakClient, onError: (err: Error) => void): void {
  const target = client as unknown as { onConnect?: (...args: unknown[]) => Promise<void> };
  const original = target.onConnect;
  if (typeof original !== 'function') return;
  target.onConnect = (...args: unknown[]) => original.apply(client, args).catch((err: unknown) => onError(toError(err)));
}

/** node-ts rejects with its CallbackData object instead of an Error; turn everything into an Error. */
export function toError(err: unknown, fallback?: Error): Error {
  if (err instanceof Error) return err;
  const data = err as Partial<CallbackData<RawItem>> | undefined;
  if (data?.error && typeof data.error.msg === 'string') {
    const permission = data.error.failed_permid ? ` (permission ${data.error.failed_permid})` : '';
    return new TeamSpeakQueryError(`${data.error.msg}${permission}`, data.error.id);
  }
  if (fallback) return fallback;
  return new TeamSpeakQueryError(err === undefined ? 'Connection to the TeamSpeak server failed' : String(err));
}
