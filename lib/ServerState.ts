import type { RawItem } from './TeamSpeakQuery';

export interface OnlineUser {
  /** Connection id, unique while the user stays connected. */
  clientId: number;
  databaseId: number;
  /** Identity of the user, stays the same across connections. */
  uniqueId: string;
  nickname: string;
  channelId: number;
  channelName: string;
  away: boolean;
  awayMessage: string;
  inputMuted: boolean;
  outputMuted: boolean;
  recording: boolean;
  idleSeconds: number;
  /** Unix timestamp (seconds) of the moment the user connected. */
  connectedAt: number | null;
  platform: string;
  version: string;
  country: string;
}

export interface Channel {
  id: number;
  parentId: number;
  order: number;
  name: string;
}

export interface ServerInfo {
  id: number;
  uniqueId: string;
  name: string;
  version: string;
  platform: string;
  maxClients: number;
  reservedSlots: number;
  /** Includes query clients, use the length of the user list for real users. */
  clientsOnline: number;
  channelsOnline: number;
  uptimeSeconds: number;
  pingMs: number;
  packetLossPercent: number;
}

/** A virtual server as returned by `serverlist`. */
export interface VirtualServer {
  id: number;
  uniqueId: string;
  name: string;
  port: number;
  online: boolean;
  clientsOnline: number;
}

export interface UserChanges {
  joined: OnlineUser[];
  left: OnlineUser[];
  moved: { user: OnlineUser; from: string; to: string }[];
}

const str = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(str(value));
  return Number.isFinite(parsed) ? parsed : 0;
};
const flag = (value: unknown): boolean => num(value) === 1;

export function parseServerInfo(raw: RawItem): ServerInfo {
  return {
    id: num(raw.virtualserver_id),
    uniqueId: str(raw.virtualserver_unique_identifier),
    name: str(raw.virtualserver_name),
    version: str(raw.virtualserver_version).split(' ')[0],
    platform: str(raw.virtualserver_platform),
    maxClients: num(raw.virtualserver_maxclients),
    reservedSlots: num(raw.virtualserver_reserved_slots),
    clientsOnline: num(raw.virtualserver_clientsonline) - num(raw.virtualserver_queryclientsonline),
    channelsOnline: num(raw.virtualserver_channelsonline),
    uptimeSeconds: num(raw.virtualserver_uptime),
    pingMs: Math.round(num(raw.virtualserver_total_ping) * 10) / 10,
    // The server reports packet loss as a fraction (0.0123 = 1.23%).
    packetLossPercent: Math.round(num(raw.virtualserver_total_packetloss_total) * 10000) / 100,
  };
}

export function parseServerList(raw: RawItem[]): VirtualServer[] {
  return raw
    .filter((item) => item.virtualserver_port !== undefined)
    .map((item) => ({
      id: num(item.virtualserver_id),
      uniqueId: str(item.virtualserver_unique_identifier),
      name: str(item.virtualserver_name),
      port: num(item.virtualserver_port),
      // "online", "offline", "virtual online", "other instance", ...
      online: str(item.virtualserver_status) === 'online',
      clientsOnline: num(item.virtualserver_clientsonline) - num(item.virtualserver_queryclientsonline),
    }));
}

export function parseChannels(raw: RawItem[]): Channel[] {
  return raw
    .filter((item) => item.cid !== undefined)
    .map((item) => ({
      id: num(item.cid),
      parentId: num(item.pid),
      order: num(item.channel_order),
      name: str(item.channel_name),
    }));
}

/** Converts the clientlist response to users, skipping ServerQuery clients (like this app itself). */
export function parseUsers(raw: RawItem[], channels: Channel[]): OnlineUser[] {
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
  return raw
    .filter((item) => item.clid !== undefined && num(item.client_type) === 0)
    .map((item) => ({
      clientId: num(item.clid),
      databaseId: num(item.client_database_id),
      uniqueId: str(item.client_unique_identifier),
      nickname: str(item.client_nickname),
      channelId: num(item.cid),
      channelName: channelNames.get(num(item.cid)) ?? '',
      away: flag(item.client_away),
      awayMessage: str(item.client_away_message),
      inputMuted: flag(item.client_input_muted) || item.client_input_hardware === 0,
      outputMuted: flag(item.client_output_muted) || item.client_output_hardware === 0,
      recording: flag(item.client_is_recording),
      idleSeconds: Math.floor(num(item.client_idle_time) / 1000),
      connectedAt: item.client_lastconnected ? num(item.client_lastconnected) : null,
      platform: str(item.client_platform),
      version: str(item.client_version).split(' ')[0],
      country: str(item.client_country),
    }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname, undefined, { sensitivity: 'base' }));
}

/**
 * Compares two user lists. Connection ids (`clientId`) are exact while the query connection stays
 * open; after a reconnect the server may have restarted, so identities (`uniqueId`) are compared instead.
 */
export function diffUsers(previous: OnlineUser[], current: OnlineUser[], key: 'clientId' | 'uniqueId' = 'clientId'): UserChanges {
  const keyOf = (user: OnlineUser) => (key === 'uniqueId' && user.uniqueId ? user.uniqueId : `#${user.clientId}`);
  const before = new Map(previous.map((user) => [keyOf(user), user]));
  const after = new Map(current.map((user) => [keyOf(user), user]));
  const changes: UserChanges = { joined: [], left: [], moved: [] };

  for (const [id, user] of after) {
    const old = before.get(id);
    if (!old) changes.joined.push(user);
    else if (old.channelId !== user.channelId) changes.moved.push({ user, from: old.channelName, to: user.channelName });
  }
  for (const [id, user] of before) {
    if (!after.has(id)) changes.left.push(user);
  }
  return changes;
}

/**
 * A user selected in a Flow card: either a specific identity (unique id) or, when the user typed
 * a name that is not in the list, a nickname that is compared case-insensitively.
 */
export interface UserSelector {
  id: string;
  name: string;
}

export const NICKNAME_PREFIX = 'nickname:';

export function matchesUser(selector: UserSelector | undefined, user: Pick<OnlineUser, 'uniqueId' | 'nickname'>): boolean {
  if (!selector?.id) return false;
  if (selector.id.startsWith(NICKNAME_PREFIX)) {
    return selector.id.slice(NICKNAME_PREFIX.length).trim().toLowerCase() === user.nickname.trim().toLowerCase();
  }
  return selector.id === user.uniqueId;
}

/** Groups users by channel in the order of the server's channel tree. */
export function groupUsersByChannel(users: OnlineUser[], channels: Channel[]): { channel: string; users: OnlineUser[] }[] {
  const order = channelTreeOrder(channels);
  const groups = new Map<number, OnlineUser[]>();
  for (const user of users) {
    const list = groups.get(user.channelId) ?? [];
    list.push(user);
    groups.set(user.channelId, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
    .map(([channelId, list]) => ({ channel: list[0].channelName || `#${channelId}`, users: list }));
}

/**
 * The channel list is a tree where channel_order is the id of the sibling above (0 = first).
 * Returns a map from channel id to its position when the tree is walked top to bottom.
 */
export function channelTreeOrder(channels: Channel[]): Map<number, number> {
  const children = new Map<number, Channel[]>();
  for (const channel of channels) {
    const siblings = children.get(channel.parentId) ?? [];
    siblings.push(channel);
    children.set(channel.parentId, siblings);
  }

  const positions = new Map<number, number>();
  const visit = (parentId: number) => {
    const siblings = children.get(parentId) ?? [];
    const byPrevious = new Map(siblings.map((channel) => [channel.order, channel]));
    let next = byPrevious.get(0);
    const seen = new Set<number>();
    while (next && !seen.has(next.id)) {
      seen.add(next.id);
      positions.set(next.id, positions.size);
      visit(next.id);
      next = byPrevious.get(next.id);
    }
    // Channels that are not reachable through the order chain are appended, so nothing is lost.
    for (const channel of siblings) {
      if (!seen.has(channel.id)) {
        positions.set(channel.id, positions.size);
        visit(channel.id);
      }
    }
  };
  visit(0);
  return positions;
}
