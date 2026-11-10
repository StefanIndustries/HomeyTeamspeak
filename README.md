# TeamSpeak for Homey

See who is online on your TeamSpeak server and automate on it with Homey.

The app connects to the ServerQuery interface of a TeamSpeak 3 server (self-hosted or hosted) using
[node-ts](https://github.com/nikeee/node-ts).

## Requirements

* Homey Pro with Homey v12.4.0 or newer
* A TeamSpeak 3 server with the **raw** ServerQuery port reachable from Homey (10011 by default; the SSH port 10022 is not supported)
* A query login, for example `serveradmin` or a dedicated query account

To avoid hitting the flood protection, add Homey's IP address to `query_ip_allowlist.txt` on the server.
The query account needs `b_virtualserver_notify_register` to pick up joins and leaves instantly; without it the app
falls back to polling.

## Device

Add a **TeamSpeak Server** device, enter the host and query login and tap **Next**. Homey lists the virtual servers on
that TeamSpeak instance, so you don't need to know the voice port. Only when the query login isn't allowed to list them
(common on hosted servers) and the server doesn't run on the default port 9987, enter the voice port under **Advanced**.
The voice port is only used to pick the virtual server; the app doesn't do anything with voice.

Changed connection settings are tested before they're saved. The device has these capabilities:

| Capability | Description |
| --- | --- |
| Online users | Number of connected users, query clients are not counted |
| Average ping | Average ping of all connected users |
| Packet loss | Average packet loss of the server |
| Uptime | Uptime of the virtual server in days |
| Server offline | Turns on when Homey can't reach the server |

## Flow cards

| Type | Card |
| --- | --- |
| When | A user joined / left the server |
| When | A specific user joined / left the server |
| When | A user switched channels |
| When | The number of online users changed |
| When | The first user joined the empty server / The last user left the server |
| When | The server went offline / came back online |
| And | A user is online |
| And | Somebody is online |
| And | More than _x_ users are online |
| And | The server is online |
| Then | Send a message to the server chat |
| Then | Poke a user |

Users can be picked from the people who are online or have been seen before. Typing a nickname that is not in the list
matches on that nickname.

## Widget

The **Online users** widget shows who is online, grouped per channel, with away, microphone and sound status and how
long everybody has been online. It updates right away when someone joins or leaves.

Widget settings:

* **TeamSpeak server**: can be left empty when only one server is added
* **Group by channel**: on by default
* **Show how long users are online**: on by default

## Development

```bash
npm install
npm test
homey app run --remote
```

`lib/TeamSpeakQuery.ts` wraps node-ts with timeouts, reconnect friendly cleanup and proper errors, and catches a
node-ts read error that would otherwise be an unhandled rejection. `lib/discovery.ts` finds the virtual servers during
pairing. `lib/ServerState.ts` holds the parsing and diffing logic. The tests in `test/` cover the parsing, and run
discovery end to end through node-ts against a small fake ServerQuery server.

## Trademark

TeamSpeak is a registered trademark of TeamSpeak Systems, Inc. The logos are taken from the official
[TeamSpeak media kit](https://teamspeak.com/en/mediakit/). This app is not made by or affiliated with TeamSpeak Systems, Inc.
