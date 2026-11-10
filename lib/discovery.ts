import { QueryErrorId, TeamSpeakConnectionOptions, TeamSpeakQuery, TeamSpeakQueryError } from './TeamSpeakQuery';
import { parseServerInfo, parseServerList, ServerInfo } from './ServerState';
import { DEFAULT_SETTINGS } from './settings';

export interface DiscoveredServer {
  name: string;
  uniqueId: string;
  port: number;
}

type LoginOptions = Omit<TeamSpeakConnectionOptions, 'serverPort' | 'nickname'>;

/**
 * Finds the virtual servers the query login can see, so nobody has to know the voice port.
 * When a voice port is given, only that server is checked.
 */
export async function discoverServers(login: LoginOptions, voicePort?: number): Promise<DiscoveredServer[]> {
  // Stay on the instance level: no server is selected until we know which ones exist.
  const query = new TeamSpeakQuery({ ...login, serverPort: undefined, nickname: undefined });
  try {
    await query.connect();
    if (voicePort) return [await describeServer(query, voicePort)];

    let servers;
    try {
      servers = parseServerList(await query.listServers());
    } catch (err) {
      if (!(err instanceof TeamSpeakQueryError) || !query.isConnected) throw err;
      // Hosted servers often only allow the query login on its own virtual server. Try the default port.
      try {
        return [await describeServer(query, DEFAULT_SETTINGS.server_port)];
      } catch {
        throw new TeamSpeakQueryError('The virtual servers could not be listed', QueryErrorId.SERVER_LIST_DENIED);
      }
    }

    const running = servers.filter((server) => server.online);
    if (running.length === 0) throw new TeamSpeakQueryError('No running virtual servers', QueryErrorId.NO_RUNNING_SERVERS);
    return running.map((server) => ({ name: server.name, uniqueId: server.uniqueId, port: server.port }));
  } finally {
    await query.disconnect().catch(() => undefined);
  }
}

/** Connects once with the full connection options and returns the server info, used to check new settings. */
export async function checkConnection(options: TeamSpeakConnectionOptions): Promise<ServerInfo> {
  const query = new TeamSpeakQuery({ ...options, nickname: undefined });
  try {
    await query.connect();
    return parseServerInfo(await query.getServerInfo());
  } finally {
    await query.disconnect().catch(() => undefined);
  }
}

async function describeServer(query: TeamSpeakQuery, port: number): Promise<DiscoveredServer> {
  await query.selectServer(port);
  const info = parseServerInfo(await query.getServerInfo());
  return { name: info.name, uniqueId: info.uniqueId, port };
}
