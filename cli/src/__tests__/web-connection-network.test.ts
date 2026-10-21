import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';

it('recovers automatic and manual connections over real HTTP/SSE without replaying commands', async () => {
  const compiled = await build({ entryPoints: ['src/web/ui/connection.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.css': 'empty' } });
  const script = `
    const assert = require('node:assert/strict');
    const { createServer } = require('node:http');
    const { setTimeout: pause } = require('node:timers/promises');
    const nativeFetch = globalThis.fetch;
    const timers = new Set();
    const streams = new Set();
    const listeners = new Map();
    const messages = [];
    let available = false, heartbeat = true, sessions = 0, connections = 0, commands = 0, version = 1;
    let eventsAvailable = true, stalled = false, obsoleteClosed = false;
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/message') {
        commands++;
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          const message = JSON.parse(body);
          if (message.type === 'send') {
            stalled = true;
            response.on('close', () => { obsoleteClosed = true; });
            response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); return;
          }
          assert.equal(message.type, 'stop'); assert.equal(message.sessionId, 'original');
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ messages: [{ type: 'stopped', sessionId: message.sessionId }] }));
        });
        return;
      }
      if (url.pathname === '/api/session') sessions++;
      if (!available) { response.writeHead(503).end(); return; }
      if (url.pathname === '/api/events') {
        if (!eventsAvailable) { response.writeHead(503).end(); return; }
        connections++; streams.add(response);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: ' + JSON.stringify({ type: 'state', version, running: false, queuedInputs: [{ id: 'existing' }] }) + '\\n\\n');
        response.once('close', () => streams.delete(response)); return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
    const poll = setInterval(() => {
      if (heartbeat) for (const stream of streams) stream.write('event: heartbeat\\ndata: {}\\n\\n');
    }, 50);
    const waitFor = async (condition) => {
      const deadline = Date.now() + 3000;
      while (!condition()) { assert(Date.now() < deadline, 'Connection did not recover'); await pause(10); }
    };
    let connection;
    (async () => {
      try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        globalThis.fetch = (input, init) => nativeFetch(new URL(input, origin), init);
        globalThis.location = new URL(origin + '/#session=test-capability');
        globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
        globalThis.history = { replaceState() {} };
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: true } });
        globalThis.addEventListener = (type, callback) => listeners.set(type, callback);
        const BrowserConnection = ((setTimeout, clearTimeout) => {
          const module = { exports: {} };
          ${compiled.outputFiles[0].text}
          return module.exports.BrowserConnection;
        })((callback, delay) => {
          const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay === 10000 ? 1000 : delay === 45000 ? 1000 : 20);
          timers.add(timer); return timer;
        }, timer => { clearTimeout(timer); timers.delete(timer); });
        connection = new BrowserConnection(message => messages.push(message), true, false);
        await waitFor(() => sessions >= 3);
        available = true;
        await waitFor(() => messages.at(-1)?.status === 'connected');
        assert(messages.some(message => message.type === 'state' && message.version === 1));

        available = false;
        for (const stream of streams) stream.destroy();
        await waitFor(() => messages.at(-1)?.status === 'reconnecting');
        const beforeRetry = sessions;
        await connection.reconnect();
        assert(sessions > beforeRetry, 'Retry must issue a request immediately');
        assert(messages.some(message => message.status === 'reconnecting' && message.manual));
        version = 2; available = true;
        await waitFor(() => messages.at(-1)?.status === 'connected');
        assert(messages.some(message => message.type === 'state' && message.version === 2));

        const beforeSilence = connections;
        await pause(1100);
        assert.equal(connections, beforeSilence, 'Heartbeats must keep an idle connection alive');
        heartbeat = false; version = 3;
        await waitFor(() => connections > beforeSilence && messages.some(message => message.type === 'state' && message.version === 3));
        assert.equal(commands, 0, 'Reconnecting must not replay a model or tool command');
        assert(messages.filter(message => message.type === 'state').every(message => message.queuedInputs[0].id === 'existing'));

        const obsolete = connection.request({ type: 'send', sessionId: 'original', requestId: 'input' }).then(() => { throw new Error('Obsolete response was accepted'); }, error => error.message);
        await waitFor(() => stalled);
        await connection.reconnect();
        assert.match(await obsolete, /Connection interrupted|Connection changed/);
        await waitFor(() => obsoleteClosed);
        eventsAvailable = false;
        for (const stream of streams) stream.destroy();
        await waitFor(() => messages.at(-1)?.status === 'reconnecting');
        assert.deepEqual(await connection.request({ type: 'stop', sessionId: 'original' }), [{ type: 'stopped', sessionId: 'original' }]);
        eventsAvailable = true;
        await waitFor(() => messages.at(-1)?.status === 'connected');
        assert.equal(commands, 2, 'Recovery must release stale requests and issue a stop only once');
        console.log('HTTP/SSE automatic recovery, manual Retry, heartbeat recovery, and command isolation passed');
      } finally {
        listeners.get('pagehide')?.();
        clearInterval(poll);
        for (const timer of timers) clearTimeout(timer);
        for (const stream of streams) stream.destroy();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-eventsource', '--input-type=commonjs'], { timeout: 10_000, windowsHide: true });
    let output = '', errors = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    child.once('error', reject);
    child.once('close', code => { if (code === 0) resolve(output); else reject(new Error(errors || 'HTTP/SSE recovery check failed')); });
    child.stdin.end(script);
  });
  expect(stdout).toContain('HTTP/SSE automatic recovery, manual Retry, heartbeat recovery, and command isolation passed');
}, 15_000);
