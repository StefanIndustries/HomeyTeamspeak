import type Homey from 'homey/lib/Homey';

interface WidgetApiArgs {
  homey: Homey;
  query: Record<string, string | undefined>;
}

module.exports = {
  async getOnlineUsers({ homey, query }: WidgetApiArgs) {
    return (homey.app as unknown as { getWidgetData(deviceId?: string): Promise<unknown> }).getWidgetData(query.deviceId || undefined);
  },
};
