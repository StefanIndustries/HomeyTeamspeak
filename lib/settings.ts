import type { TeamSpeakConnectionOptions } from './TeamSpeakQuery';
import { QueryErrorId, TeamSpeakQueryError } from './TeamSpeakQuery';

/** Device settings, see drivers/server/driver.compose.json. */
export interface ServerSettings {
  host: string;
  query_port: number;
  server_port: number;
  username: string;
  password: string;
  nickname: string;
  poll_interval: number;
}

export const DEFAULT_SETTINGS: Omit<ServerSettings, 'host' | 'password'> = {
  query_port: 10011,
  server_port: 9987,
  username: 'serveradmin',
  nickname: 'Homey',
  poll_interval: 30,
};

export const MIN_POLL_INTERVAL = 10;
/** The ServerQuery interface closes idle connections after 5 minutes, polling also keeps it alive. */
export const MAX_POLL_INTERVAL = 240;

/** Returns the port, or undefined for empty or invalid input. */
export function parsePort(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function toPort(value: unknown, fallback: number): number {
  return parsePort(value) ?? fallback;
}

/** Cleans up user input from the pair view or the device settings. */
export function normalizeSettings(input: Partial<Record<keyof ServerSettings, unknown>>): ServerSettings {
  const host = String(input.host ?? '').trim()
    // People tend to paste URLs or ts3server:// links.
    .replace(/^[a-z0-9]+:\/\//i, '')
    .replace(/\/.*$/, '');
  const interval = Number(input.poll_interval);
  return {
    host,
    query_port: toPort(input.query_port, DEFAULT_SETTINGS.query_port),
    server_port: toPort(input.server_port, DEFAULT_SETTINGS.server_port),
    username: String(input.username ?? '').trim() || DEFAULT_SETTINGS.username,
    password: String(input.password ?? ''),
    nickname: String(input.nickname ?? '').trim(),
    poll_interval: Number.isFinite(interval)
      ? Math.min(Math.max(Math.round(interval), MIN_POLL_INTERVAL), MAX_POLL_INTERVAL)
      : DEFAULT_SETTINGS.poll_interval,
  };
}

export function toConnectionOptions(settings: ServerSettings): TeamSpeakConnectionOptions {
  return {
    host: settings.host,
    queryPort: settings.query_port,
    serverPort: settings.server_port,
    username: settings.username,
    password: settings.password,
    nickname: settings.nickname || undefined,
  };
}

/** Returns the locale key (under "errors") that explains an error to the user, if it is a known one. */
export function errorLocaleKey(err: unknown): string | undefined {
  const error = err as (Error & { code?: string; id?: number }) | undefined;
  if (error instanceof TeamSpeakQueryError) {
    switch (error.id) {
      case QueryErrorId.INVALID_LOGIN: return 'invalid_login';
      case QueryErrorId.INVALID_SERVER_ID:
      case QueryErrorId.SERVER_NOT_RUNNING: return 'server_not_found';
      case QueryErrorId.INSUFFICIENT_PERMISSIONS: return 'insufficient_permissions';
      case QueryErrorId.FLOOD_BANNED: return 'banned';
      case QueryErrorId.NO_RUNNING_SERVERS: return 'no_running_servers';
      case QueryErrorId.SERVER_LIST_DENIED: return 'voice_port_required';
      default: break;
    }
    if (/timed out|could not connect/i.test(error.message)) return 'timeout';
  }
  switch (error?.code) {
    case 'ECONNREFUSED': return 'connection_refused';
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return 'host_not_found';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return 'timeout';
    case 'ECONNRESET': return 'connection_reset';
    default: break;
  }
  if (/not a TS3 Query Server/i.test(error?.message ?? '')) return 'not_a_query_port';
  return undefined;
}

/** A readable, translated error message for the user. */
export function describeError(homey: { __(key: string): string }, err: unknown): string {
  const key = errorLocaleKey(err);
  if (key) return homey.__(`errors.${key}`);
  return err instanceof Error ? err.message : String(err);
}
