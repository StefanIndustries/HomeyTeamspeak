import Homey from 'homey';
import type { TeamSpeakServerDevice, WidgetData } from './drivers/server/device';

const WIDGET_IDS = ['online-users'];

class TeamSpeakApp extends Homey.App {

  async onInit() {
    for (const widgetId of WIDGET_IDS) {
      this.homey.dashboards.getWidget(widgetId)
        .registerSettingAutocompleteListener('server', async (query: string) => this.getServerDevices()
          .map((device) => ({ name: device.getName(), id: device.getData().id }))
          .filter((result) => result.name.toLowerCase().includes(query.toLowerCase())));
    }
    this.log('TeamSpeak app has been initialized');
  }

  /** Used by the widget API. */
  async getWidgetData(deviceId?: string): Promise<WidgetData> {
    return this.getServerDevice(deviceId).getWidgetData();
  }

  private getServerDevices(): TeamSpeakServerDevice[] {
    return this.homey.drivers.getDriver('server').getDevices() as TeamSpeakServerDevice[];
  }

  /**
   * Returns the server for the given device id. When no id is given and exactly one server is
   * added, that one is used so the widget works without configuration.
   */
  private getServerDevice(deviceId?: string): TeamSpeakServerDevice {
    const devices = this.getServerDevices();
    if (!deviceId) {
      if (devices.length === 1) return devices[0];
      throw new Error(this.homey.__(devices.length === 0 ? 'widget.errors.no_servers' : 'widget.errors.select_server'));
    }
    const device = devices.find((d) => d.getData().id === deviceId);
    if (!device) throw new Error(this.homey.__('widget.errors.server_not_found'));
    return device;
  }

}

module.exports = TeamSpeakApp;
