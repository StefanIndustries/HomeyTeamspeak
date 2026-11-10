const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseServerInfo, parseServerList, parseChannels, parseUsers, diffUsers, matchesUser, groupUsersByChannel, channelTreeOrder,
} = require('../.homeybuild/lib/ServerState.js');
const { normalizeSettings, parsePort, errorLocaleKey } = require('../.homeybuild/lib/settings.js');
const { toError, TeamSpeakQueryError } = require('../.homeybuild/lib/TeamSpeakQuery.js');

// Shapes as parsed by node-ts: numeric strings become numbers.
const rawChannels = [
  { cid: 1, pid: 0, channel_order: 0, channel_name: 'Lobby', total_clients: 1 },
  { cid: 3, pid: 0, channel_order: 2, channel_name: 'AFK', total_clients: 0 },
  { cid: 2, pid: 0, channel_order: 1, channel_name: 'Gaming', total_clients: 2 },
  { cid: 4, pid: 2, channel_order: 0, channel_name: 'Squad', total_clients: 0 },
];

const client = (clid, nickname, cid, extra = {}) => ({
  clid, cid, client_database_id: clid + 100, client_nickname: nickname, client_type: 0,
  client_unique_identifier: `uid-${nickname}=`, client_away: 0, client_away_message: '',
  client_input_muted: 0, client_output_muted: 0, client_input_hardware: 1, client_output_hardware: 1,
  client_is_recording: 0, client_idle_time: 4500, client_lastconnected: 1700000000,
  client_platform: 'Windows', client_version: '3.6.2 [Build: 1695203293]', client_country: 'NL',
  ...extra,
});

test('parses server info and excludes query clients from the online count', () => {
  const info = parseServerInfo({
    virtualserver_id: 1, virtualserver_unique_identifier: 'abc=', virtualserver_name: 'My server',
    virtualserver_version: '3.13.7 [Build: 1655727713]', virtualserver_maxclients: 32,
    virtualserver_clientsonline: 4, virtualserver_queryclientsonline: 1, virtualserver_uptime: 90061,
    virtualserver_total_ping: '23.4567', virtualserver_total_packetloss_total: '0.0123',
  });
  assert.equal(info.version, '3.13.7');
  assert.equal(info.clientsOnline, 3);
  assert.equal(info.pingMs, 23.5);
  assert.equal(info.packetLossPercent, 1.23);
});

test('parses users, skips query clients and resolves channel names', () => {
  const channels = parseChannels(rawChannels);
  const users = parseUsers([
    client(5, 'zoe', 2),
    client(6, 'Homey', 1, { client_type: 1 }),
    client(7, 1234, 1, { client_away: 1, client_away_message: 'brb', client_input_hardware: 0 }),
    client(8, 'Alice', 2, { client_output_muted: 1 }),
  ], channels);

  assert.deepEqual(users.map((u) => u.nickname), ['1234', 'Alice', 'zoe']);
  const numeric = users[0];
  assert.equal(numeric.channelName, 'Lobby');
  assert.equal(numeric.away, true);
  assert.equal(numeric.awayMessage, 'brb');
  assert.equal(numeric.inputMuted, true, 'disabled microphone counts as muted');
  assert.equal(numeric.idleSeconds, 4);
  assert.equal(numeric.version, '3.6.2');
  assert.equal(users[1].outputMuted, true);
});

test('handles an empty server', () => {
  assert.deepEqual(parseUsers([], []), []);
  assert.deepEqual(parseUsers([{}], []), []);
});

test('diffs joins, leaves and channel switches by connection id', () => {
  const channels = parseChannels(rawChannels);
  const before = parseUsers([client(1, 'Alice', 1), client(2, 'Bob', 1)], channels);
  const after = parseUsers([client(1, 'Alice', 2), client(3, 'Carol', 1)], channels);
  const changes = diffUsers(before, after);
  assert.deepEqual(changes.joined.map((u) => u.nickname), ['Carol']);
  assert.deepEqual(changes.left.map((u) => u.nickname), ['Bob']);
  assert.deepEqual(changes.moved.map((m) => [m.user.nickname, m.from, m.to]), [['Alice', 'Lobby', 'Gaming']]);
});

test('diffs by identity after a reconnect, when connection ids may be reassigned', () => {
  const channels = parseChannels(rawChannels);
  const before = parseUsers([client(1, 'Alice', 1), client(2, 'Bob', 1)], channels);
  const after = parseUsers([client(9, 'Alice', 1), client(10, 'Bob', 1)], channels);
  assert.equal(diffUsers(before, after, 'clientId').joined.length, 2);
  const changes = diffUsers(before, after, 'uniqueId');
  assert.equal(changes.joined.length + changes.left.length + changes.moved.length, 0);
});

test('matches users by identity or by typed nickname', () => {
  const user = { uniqueId: 'uid-Alice=', nickname: 'Alice ' };
  assert.equal(matchesUser({ id: 'uid-Alice=', name: 'Alice' }, user), true);
  assert.equal(matchesUser({ id: 'uid-Bob=', name: 'Bob' }, user), false);
  assert.equal(matchesUser({ id: 'nickname:alice', name: 'alice' }, user), true);
  assert.equal(matchesUser(undefined, user), false);
});

test('orders channels like the TeamSpeak channel tree', () => {
  const order = channelTreeOrder(parseChannels(rawChannels));
  assert.deepEqual([...order.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id), [1, 2, 4, 3]);

  const channels = parseChannels(rawChannels);
  const users = parseUsers([client(1, 'Alice', 3), client(2, 'Bob', 1), client(3, 'Carol', 4)], channels);
  assert.deepEqual(groupUsersByChannel(users, channels).map((g) => g.channel), ['Lobby', 'Squad', 'AFK']);
});

test('normalizes pair input', () => {
  const settings = normalizeSettings({ host: ' ts3server://ts.example.com/?port=9987 ', query_port: 'abc', server_port: '9988', username: '', poll_interval: 5 });
  assert.equal(settings.host, 'ts.example.com');
  assert.equal(settings.query_port, 10011);
  assert.equal(settings.server_port, 9988);
  assert.equal(settings.username, 'serveradmin');
  assert.equal(settings.poll_interval, 10);
});

test('turns node-ts rejections into errors with a known locale key', () => {
  const error = toError({ error: { id: 520, msg: 'invalid loginname or password' }, response: [] });
  assert.ok(error instanceof TeamSpeakQueryError);
  assert.equal(error.id, 520);
  assert.equal(errorLocaleKey(error), 'invalid_login');

  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.equal(toError(true, refused), refused, 'the boolean from the close event falls back to the socket error');
  assert.equal(errorLocaleKey(refused), 'connection_refused');
  assert.equal(errorLocaleKey(new Error('Remove server is not a TS3 Query Server endpoint.')), 'not_a_query_port');
});

test('parses the server list and only marks running servers as online', () => {
  const servers = parseServerList([
    { virtualserver_id: 1, virtualserver_port: 9987, virtualserver_status: 'online', virtualserver_name: 'Main',
      virtualserver_unique_identifier: 'a=', virtualserver_clientsonline: 3, virtualserver_queryclientsonline: 1 },
    { virtualserver_id: 2, virtualserver_port: 9988, virtualserver_status: 'offline', virtualserver_name: 'Old' },
  ]);
  assert.deepEqual(servers.map((s) => [s.port, s.online, s.clientsOnline]), [[9987, true, 2], [9988, false, 0]]);
});

test('treats an empty voice port as "find it automatically"', () => {
  assert.equal(parsePort(''), undefined);
  assert.equal(parsePort('  '), undefined);
  assert.equal(parsePort(undefined), undefined);
  assert.equal(parsePort('abc'), undefined);
  assert.equal(parsePort('9988'), 9988);
});
