import Homey from 'homey';
import PairSession from 'homey/lib/PairSession';
import { discoverServers } from '../../lib/discovery';
import { matchesUser, UserSelector } from '../../lib/ServerState';
import {
  DEFAULT_SETTINGS, describeError, normalizeSettings, parsePort, ServerSettings, toConnectionOptions,
} from '../../lib/settings';
import type { TeamSpeakServerDevice } from './device';

interface DeviceArgs {
  device: TeamSpeakServerDevice;
}

type UserArgs = DeviceArgs & { user: UserSelector };

class TeamSpeakServerDriver extends Homey.Driver {

  async onInit() {
    this.registerTriggers();
    this.registerConditions();
    this.registerActions();
    this.log('TeamSpeak server driver has been initialized');
  }

  /**
   * The pair view sends its form values while the user types. Homey's own "Next" button then opens
   * the device list, which connects and lists the virtual servers. Errors show up in that list,
   * with Homey's "Back" button leading to the form again.
   */
  async onPair(session: PairSession) {
    let input: Partial<Record<keyof ServerSettings, unknown>> = {};

    session.setHandler('form_changed', async (data: Partial<Record<keyof ServerSettings, unknown>>) => {
      input = data ?? {};
    });

    session.setHandler('list_devices', async () => {
      const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...input });
      if (!settings.host) throw new Error(this.homey.__('errors.host_required'));
      try {
        const servers = await discoverServers(toConnectionOptions(settings), parsePort(input.server_port));
        return servers.map((server) => ({
          name: server.name || settings.host,
          data: {
            // The unique identifier survives a host or port change, fall back to the address for old servers.
            id: server.uniqueId || `${settings.host}:${server.port}`,
          },
          settings: { ...settings, server_port: server.port },
        }));
      } catch (err) {
        this.error('pairing failed', err);
        throw new Error(describeError(this.homey, err));
      }
    });
  }

  private registerTriggers() {
    for (const id of ['specific_user_joined', 'specific_user_left']) {
      const card = this.homey.flow.getDeviceTriggerCard(id);
      card.registerRunListener(async (args: UserArgs, state: { uniqueId: string; nickname: string }) => matchesUser(args.user, state));
      card.registerArgumentAutocompleteListener('user', async (query: string, args: DeviceArgs) => args.device.getUserSuggestions(query));
    }
  }

  private registerConditions() {
    const userOnline = this.homey.flow.getConditionCard('user_is_online');
    userOnline.registerRunListener(async (args: UserArgs) => args.device.isUserOnline(args.user));
    userOnline.registerArgumentAutocompleteListener('user', async (query: string, args: DeviceArgs) => args.device.getUserSuggestions(query));

    this.homey.flow.getConditionCard('anyone_online')
      .registerRunListener(async (args: DeviceArgs) => args.device.getOnlineUsers().length > 0);

    this.homey.flow.getConditionCard('users_online_more_than')
      .registerRunListener(async (args: DeviceArgs & { count: number }) => args.device.getOnlineUsers().length > args.count);

    this.homey.flow.getConditionCard('server_is_online')
      .registerRunListener(async (args: DeviceArgs) => args.device.isServerOnline());
  }

  private registerActions() {
    this.homey.flow.getActionCard('send_server_message')
      .registerRunListener(async (args: DeviceArgs & { message: string }) => {
        await args.device.sendServerMessage(args.message);
      });

    const poke = this.homey.flow.getActionCard('poke_user');
    poke.registerRunListener(async (args: UserArgs & { message: string }) => {
      await args.device.pokeUser(args.user, args.message);
    });
    poke.registerArgumentAutocompleteListener('user', async (query: string, args: DeviceArgs) => args.device.getUserSuggestions(query));
  }

}

module.exports = TeamSpeakServerDriver;
