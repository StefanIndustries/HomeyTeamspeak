import Homey from 'homey';
import { TeamSpeakQuery, TeamSpeakQueryError } from '../../lib/TeamSpeakQuery';
import {
  Channel, diffUsers, groupUsersByChannel, matchesUser, NICKNAME_PREFIX, OnlineUser, parseChannels, parseServerInfo,
  parseUsers, ServerInfo, UserSelector,
} from '../../lib/ServerState';
import { checkConnection } from '../../lib/discovery';
import {
  describeError, errorLocaleKey, normalizeSettings, ServerSettings, toConnectionOptions,
} from '../../lib/settings';

const CAPABILITIES = ['online_users', 'server_ping', 'server_packet_loss', 'server_uptime', 'alarm_server_offline'];
const CONNECTION_SETTINGS: (keyof ServerSettings)[] = ['host', 'query_port', 'server_port', 'username', 'password', 'nickname'];

/** Join/leave notifications are bundled, so a busy server never hits the ServerQuery flood limit. */
const EVENT_REFRESH_DELAY_MS = 1500;
const RETRY_DELAY_MS = 2000;
const MIN_RECONNECT_DELAY_MS = 10 * 1000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;
const MAX_KNOWN_USERS = 250;

interface KnownUser {
  nickname: string;
  lastSeen: number;
}

export interface WidgetUser {
  nickname: string;
  away: boolean;
  awayMessage: string;
  inputMuted: boolean;
  outputMuted: boolean;
  recording: boolean;
  connectedAt: number | null;
  idleSeconds: number;
  country: string;
  platform: string;
}

export interface WidgetData {
  deviceId: string;
  name: string;
  online: boolean | null;
  error: string | null;
  onlineUsers: number;
  maxClients: number;
  updatedAt: number | null;
  groups: { channel: string; users: WidgetUser[] }[];
}

export class TeamSpeakServerDevice extends Homey.Device {

  private query?: TeamSpeakQuery;
  private users: OnlineUser[] = [];
  private channels: Channel[] = [];
  private serverInfo?: ServerInfo;
  /** null until the first connection attempt finished. */
  private online: boolean | null = null;
  private lastError: string | null = null;
  private updatedAt: number | null = null;
  /** The next snapshot is the first one of a new connection, connection ids may have changed. */
  private freshConnection = true;
  private hasSnapshot = false;
  private failures = 0;
  private stopped = false;

  private pollTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private eventRefreshTimer?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private refreshQueued = false;
  private lastWidgetHash = '';
  private readonly logError = (err: unknown) => this.error(err);

  async onInit() {
    for (const capability of CAPABILITIES) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }
    // Connect in the background so a slow or offline server does not block the app start.
    this.connect().catch(this.logError);
    this.log('TeamSpeak server device has been initialized');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }: {
    oldSettings: { [key: string]: unknown };
    newSettings: { [key: string]: unknown };
    changedKeys: string[];
  }): Promise<string | void> {
    const settings = normalizeSettings(newSettings as Partial<ServerSettings>);
    if (!settings.host) throw new Error(this.homey.__('errors.host_required'));

    if (changedKeys.some((key) => CONNECTION_SETTINGS.includes(key as keyof ServerSettings))) {
      // Refuse settings that don't work, instead of saving them and showing the device as offline.
      try {
        await checkConnection(toConnectionOptions(settings));
      } catch (err) {
        throw new Error(this.describeError(err));
      }
      // Settings are saved after this method resolves, so pass the new values explicitly.
      this.connect(settings).catch(this.logError);
    } else if (changedKeys.includes('poll_interval') && this.query?.isConnected) {
      this.startPolling(settings.poll_interval);
    }
    this.log('settings changed', changedKeys, oldSettings.host !== newSettings.host ? 'host changed' : '');
  }

  async onUninit() {
    await this.stop();
  }

  async onDeleted() {
    await this.stop();
    this.log('TeamSpeak server device has been deleted');
  }

  /** Reconnects with the given (or saved) settings, used after settings changes. */
  async connect(settings: ServerSettings = this.getServerSettings()): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.stopPolling();
    await this.closeQuery();

    const query = new TeamSpeakQuery(toConnectionOptions(settings));
    this.query = query;
    try {
      await query.connect();
      if (this.query !== query) {
        await query.disconnect();
        return;
      }
      query.on('clients-changed', () => this.scheduleEventRefresh());
      query.on('close', (err: Error) => this.handleConnectionLost(query, err));
      this.freshConnection = true;
      await this.refresh();
      if (this.query === query && query.isConnected) {
        this.failures = 0;
        this.startPolling(settings.poll_interval);
      }
    } catch (err) {
      await this.handleConnectionLost(query, err);
    }
  }

  getServerSettings(): ServerSettings {
    return normalizeSettings(this.getSettings());
  }

  getServerId(): number {
    return this.serverInfo?.id ?? 1;
  }

  getOnlineUsers(): OnlineUser[] {
    return this.users;
  }

  isServerOnline(): boolean {
    return this.online === true;
  }

  isUserOnline(selector: UserSelector): boolean {
    return this.users.some((user) => matchesUser(selector, user));
  }

  async sendServerMessage(message: string): Promise<void> {
    await this.requireQuery().sendServerMessage(this.getServerId(), message);
  }

  /** Pokes every connection of the selected user and returns how many were poked. */
  async pokeUser(selector: UserSelector, message: string): Promise<number> {
    const targets = this.users.filter((user) => matchesUser(selector, user));
    if (targets.length === 0) throw new Error(this.homey.__('errors.user_not_online', { name: selector.name }));
    const query = this.requireQuery();
    for (const user of targets) await query.pokeClient(user.clientId, message);
    return targets.length;
  }

  /** Autocomplete results for Flow cards: online users first, then users seen before. */
  getUserSuggestions(search: string): (UserSelector & { description?: string })[] {
    const needle = search.trim().toLowerCase();
    const results: (UserSelector & { description?: string })[] = [];
    const seen = new Set<string>();

    for (const user of this.users) {
      if (seen.has(user.uniqueId)) continue;
      seen.add(user.uniqueId);
      results.push({
        id: user.uniqueId,
        name: user.nickname,
        description: this.homey.__('flow.online_in', { channel: user.channelName }),
      });
    }

    const known = this.getKnownUsers();
    Object.entries(known)
      .sort(([, a], [, b]) => b.lastSeen - a.lastSeen)
      .forEach(([uniqueId, user]) => {
        if (seen.has(uniqueId)) return;
        seen.add(uniqueId);
        results.push({
          id: uniqueId,
          name: user.nickname,
          description: this.homey.__('flow.last_seen', { date: this.formatDate(user.lastSeen) }),
        });
      });

    const filtered = results.filter((result) => result.name.toLowerCase().includes(needle));
    if (needle && !filtered.some((result) => result.name.toLowerCase() === needle)) {
      // Allow matching people who have never been seen by Homey, by their nickname.
      filtered.push({
        id: `${NICKNAME_PREFIX}${search.trim()}`,
        name: search.trim(),
        description: this.homey.__('flow.match_nickname'),
      });
    }
    return filtered;
  }

  getWidgetData(): WidgetData {
    const toWidgetUser = (user: OnlineUser): WidgetUser => ({
      nickname: user.nickname,
      away: user.away,
      awayMessage: user.awayMessage,
      inputMuted: user.inputMuted,
      outputMuted: user.outputMuted,
      recording: user.recording,
      connectedAt: user.connectedAt,
      idleSeconds: user.idleSeconds,
      country: user.country,
      platform: user.platform,
    });
    return {
      deviceId: this.getData().id,
      name: this.serverInfo?.name || this.getName(),
      online: this.online,
      error: this.lastError,
      onlineUsers: this.users.length,
      maxClients: this.serverInfo?.maxClients ?? 0,
      updatedAt: this.updatedAt,
      groups: groupUsersByChannel(this.users, this.channels)
        .map((group) => ({ channel: group.channel, users: group.users.map(toWidgetUser) })),
    };
  }

  private requireQuery(): TeamSpeakQuery {
    if (!this.query?.isConnected) throw new Error(this.homey.__('errors.not_connected'));
    return this.query;
  }

  private startPolling(intervalSeconds: number) {
    this.stopPolling();
    this.pollTimer = this.homey.setInterval(() => {
      this.refresh().catch(this.logError);
    }, intervalSeconds * 1000);
  }

  private stopPolling() {
    this.homey.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.homey.clearTimeout(this.eventRefreshTimer);
    this.eventRefreshTimer = undefined;
  }

  private scheduleEventRefresh() {
    if (this.eventRefreshTimer) return;
    this.eventRefreshTimer = this.homey.setTimeout(() => {
      this.eventRefreshTimer = undefined;
      this.refresh().catch(this.logError);
    }, EVENT_REFRESH_DELAY_MS);
  }

  /** Refreshes the server state; calls while a refresh is running are merged into one extra refresh. */
  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshQueued = false;
        await this.fetchSnapshot();
      } while (this.refreshQueued);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async fetchSnapshot(): Promise<void> {
    const query = this.query;
    if (!query?.isConnected) return;
    try {
      const info = parseServerInfo(await query.getServerInfo());
      const channels = parseChannels(await query.getChannels());
      const users = parseUsers(await query.getClients(), channels);
      if (this.query !== query) return;
      await this.applySnapshot(info, channels, users);
    } catch (err) {
      if (!query.isConnected) {
        await this.handleConnectionLost(query, err);
      } else {
        // The connection still works, e.g. a missing permission. Keep the last known state.
        this.error('refresh failed', err);
        await this.setWarning(this.describeError(err)).catch(this.logError);
      }
    }
  }

  private async applySnapshot(info: ServerInfo, channels: Channel[], users: OnlineUser[]) {
    const previous = this.users;
    const hadSnapshot = this.hasSnapshot;
    const freshConnection = this.freshConnection;

    this.serverInfo = info;
    this.channels = channels;
    this.users = users;
    this.updatedAt = Date.now();
    this.hasSnapshot = true;
    this.freshConnection = false;
    this.lastError = null;

    await this.unsetWarning().catch(this.logError);
    if (!this.getAvailable()) await this.setAvailable().catch(this.logError);
    await this.setServerOnline(true);
    await this.rememberUsers(users);

    await this.setCapability('online_users', users.length);
    await this.setCapability('server_ping', info.pingMs);
    await this.setCapability('server_packet_loss', info.packetLossPercent);
    await this.setCapability('server_uptime', Math.round((info.uptimeSeconds / 86400) * 10) / 10);

    // The first snapshot after the app started is the baseline: nobody "joined" just now.
    if (hadSnapshot) {
      // After a reconnect the server may have restarted and handed out new connection ids.
      const changes = diffUsers(previous, users, freshConnection ? 'uniqueId' : 'clientId');
      await this.triggerUserChanges(previous.length, users.length, changes);
    }

    this.publishWidgetUpdate();
  }

  private async triggerUserChanges(previousCount: number, count: number, changes: ReturnType<typeof diffUsers>) {
    const triggers: Promise<unknown>[] = [];
    const trigger = (id: string, tokens: object = {}, state: object = {}) => {
      triggers.push(this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens, state).catch(this.logError));
    };

    for (const user of changes.joined) {
      const tokens = {
        nickname: user.nickname, channel: user.channelName, country: user.country, platform: user.platform, online_users: count,
      };
      trigger('user_joined', tokens);
      trigger('specific_user_joined', tokens, user);
    }
    for (const user of changes.left) {
      const minutes = user.connectedAt ? Math.max(0, Math.round((Date.now() / 1000 - user.connectedAt) / 60)) : 0;
      const tokens = { nickname: user.nickname, channel: user.channelName, online_minutes: minutes, online_users: count };
      trigger('user_left', tokens);
      trigger('specific_user_left', tokens, user);
    }
    for (const { user, from, to } of changes.moved) {
      trigger('user_moved', { nickname: user.nickname, from_channel: from, to_channel: to });
    }
    if (previousCount !== count) {
      trigger('online_users_changed', { online_users: count });
      if (previousCount === 0 && count > 0) trigger('server_occupied', { nickname: changes.joined[0]?.nickname ?? '' });
      if (previousCount > 0 && count === 0) trigger('server_empty', { nickname: changes.left[changes.left.length - 1]?.nickname ?? '' });
    }
    await Promise.all(triggers);
  }

  private async setServerOnline(online: boolean, error?: string) {
    const previous = this.online;
    this.online = online;
    await this.setCapability('alarm_server_offline', !online);
    if (previous === online) return;
    // No trigger for the very first state after the app started.
    if (previous === null) return;
    const card = this.homey.flow.getDeviceTriggerCard(online ? 'server_online' : 'server_offline');
    await card.trigger(this, online ? {} : { error: error ?? '' }).catch(this.logError);
  }

  private async handleConnectionLost(query: TeamSpeakQuery, err: unknown) {
    // Ignore errors of connections that were already replaced or closed on purpose.
    if (this.query !== query || this.stopped) return;
    this.query = undefined;
    this.stopPolling();
    await query.disconnect().catch(() => undefined);

    this.failures += 1;
    const message = this.describeError(err);
    this.log(`connection lost (attempt ${this.failures}): ${message}`);

    // A working connection that drops is retried right away, so a short hiccup does not trigger "offline" Flows.
    if (this.failures === 1 && this.online === true) {
      this.scheduleReconnect(RETRY_DELAY_MS);
      return;
    }

    this.lastError = message;
    await this.setServerOnline(false, message);
    await this.setWarning(message).catch(this.logError);
    this.publishWidgetUpdate();

    const isLoginError = err instanceof TeamSpeakQueryError && errorLocaleKey(err) === 'invalid_login';
    const delay = isLoginError
      ? MAX_RECONNECT_DELAY_MS
      : Math.min(MIN_RECONNECT_DELAY_MS * 2 ** Math.max(0, this.failures - 2), MAX_RECONNECT_DELAY_MS);
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delayMs: number) {
    this.homey.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.homey.setTimeout(() => {
      this.connect().catch(this.logError);
    }, delayMs);
  }

  private async closeQuery() {
    const query = this.query;
    this.query = undefined;
    if (query) await query.disconnect().catch(() => undefined);
  }

  private async stop() {
    this.stopped = true;
    this.stopPolling();
    this.homey.clearTimeout(this.reconnectTimer);
    await this.closeQuery();
  }

  private getKnownUsers(): Record<string, KnownUser> {
    return this.getStoreValue('knownUsers') ?? {};
  }

  /** Remembers who has been online, so Flow cards can offer users that are offline right now. */
  private async rememberUsers(users: OnlineUser[]) {
    const known = this.getKnownUsers();
    const now = Date.now();
    let changed = false;
    for (const user of users) {
      const entry = known[user.uniqueId];
      // Only write when something relevant changed, the store is persisted to disk.
      if (!entry || entry.nickname !== user.nickname || now - entry.lastSeen > 60 * 60 * 1000) {
        known[user.uniqueId] = { nickname: user.nickname, lastSeen: now };
        changed = true;
      }
    }
    if (!changed) return;
    const trimmed = Object.entries(known)
      .sort(([, a], [, b]) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_KNOWN_USERS);
    await this.setStoreValue('knownUsers', Object.fromEntries(trimmed)).catch(this.logError);
  }

  private async setCapability(capability: string, value: number | boolean) {
    if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.logError);
  }

  /** Tells the widgets showing this server to reload, only when what they show actually changed. */
  private publishWidgetUpdate() {
    const data = this.getWidgetData();
    const hash = JSON.stringify({ ...data, updatedAt: null, groups: data.groups.map((group) => ({
      ...group, users: group.users.map((user) => ({ ...user, idleSeconds: 0 })),
    })) });
    if (hash === this.lastWidgetHash) return;
    this.lastWidgetHash = hash;
    this.homey.api.realtime('server-updated', { deviceId: data.deviceId }).catch(this.logError);
  }

  private describeError(err: unknown): string {
    return describeError(this.homey, err);
  }

  private formatDate(timestamp: number): string {
    try {
      return new Date(timestamp).toLocaleDateString(this.homey.i18n.getLanguage(), {
        day: 'numeric', month: 'short', timeZone: this.homey.clock.getTimezone(),
      });
    } catch {
      return new Date(timestamp).toISOString().slice(0, 10);
    }
  }

}

module.exports = TeamSpeakServerDevice;
