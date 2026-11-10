// Runs discovery end to end through node-ts against a minimal fake ServerQuery server.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { discoverServers, checkConnection } = require('../.homeybuild/lib/discovery.js');
const { errorLocaleKey } = require('../.homeybuild/lib/settings.js');

const OK = 'error id=0 msg=ok';
const esc = (s) => s.replace(/ /g, '\\s');

/** Starts a fake query server. `handlers` maps a command name to the response lines. */
function fakeServer(handlers) {
  const commands = [];
  const server = net.createServer((socket) => {
    socket.write('TS3\n\rWelcome to the TeamSpeak 3 ServerQuery interface\n\r');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        commands.push(line);
        const name = line.split(' ')[0];
        if (name === 'quit') { socket.end(`${OK}\n\r`); return; }
        const reply = (handlers[name] ?? (() => [OK]))(line);
        socket.write(`${reply.join('\n\r')}\n\r`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, commands, close: () => new Promise((r) => server.close(r)),
  })));
}

const login = (port) => ({ host: '127.0.0.1', queryPort: port, username: 'serveradmin', password: 'secret', timeoutMs: 2000 });
const serverinfo = (name, uid) => () => [`virtualserver_id=1 virtualserver_name=${esc(name)} virtualserver_unique_identifier=${uid} virtualserver_maxclients=32`, OK];

test('lists the running virtual servers without selecting one', async () => {
  const fake = await fakeServer({
    serverlist: () => [
      `virtualserver_id=1 virtualserver_port=9987 virtualserver_status=online virtualserver_name=${esc('Main server')} virtualserver_unique_identifier=abc=|`
      + 'virtualserver_id=2 virtualserver_port=9988 virtualserver_status=offline virtualserver_name=Old virtualserver_unique_identifier=def=',
      OK,
    ],
  });
  try {
    const servers = await discoverServers(login(fake.port));
    assert.deepEqual(servers, [{ name: 'Main server', uniqueId: 'abc=', port: 9987 }]);
    assert.ok(fake.commands.some((c) => c.startsWith('login ')));
    assert.ok(fake.commands.includes('serverlist -uid'));
    assert.ok(!fake.commands.some((c) => c.startsWith('use ')), 'no server is selected while discovering');
  } finally {
    await fake.close();
  }
});

test('falls back to the default voice port when the server list is not allowed', async () => {
  const fake = await fakeServer({
    serverlist: () => ['error id=2568 msg=insufficient\\sclient\\spermissions failed_permid=4'],
    serverinfo: serverinfo('Hosted', 'xyz='),
  });
  try {
    const servers = await discoverServers(login(fake.port));
    assert.deepEqual(servers, [{ name: 'Hosted', uniqueId: 'xyz=', port: 9987 }]);
    assert.ok(fake.commands.includes('use port=9987'));
  } finally {
    await fake.close();
  }
});

test('asks for the voice port when nothing can be found', async () => {
  const fake = await fakeServer({
    serverlist: () => ['error id=2568 msg=insufficient\\sclient\\spermissions'],
    use: () => ['error id=1024 msg=invalid\\sserverID'],
  });
  try {
    await assert.rejects(discoverServers(login(fake.port)), (err) => errorLocaleKey(err) === 'voice_port_required');
  } finally {
    await fake.close();
  }
});

test('uses the voice port when one is given', async () => {
  const fake = await fakeServer({ serverinfo: serverinfo('Second', 'two=') });
  try {
    const servers = await discoverServers(login(fake.port), 9988);
    assert.deepEqual(servers, [{ name: 'Second', uniqueId: 'two=', port: 9988 }]);
    assert.ok(!fake.commands.includes('serverlist -uid'));
  } finally {
    await fake.close();
  }
});

test('reports a wrong login', async () => {
  const fake = await fakeServer({ login: () => ['error id=520 msg=invalid\\sloginname\\sor\\spassword'] });
  try {
    await assert.rejects(checkConnection({ ...login(fake.port), serverPort: 9987 }), (err) => errorLocaleKey(err) === 'invalid_login');
  } finally {
    await fake.close();
  }
});

test('reports a refused connection', async () => {
  const fake = await fakeServer({});
  const { port } = fake;
  await fake.close();
  await assert.rejects(discoverServers(login(port)), (err) => errorLocaleKey(err) === 'connection_refused');
});
