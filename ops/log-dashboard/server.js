'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const port = Number(process.env.PORT || 8090);
const dockerSocket = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const clients = new Set();
const apiVersion = process.env.DOCKER_API_VERSION || 'v1.41';

function sendFrame(socket, value) {
  if (socket.destroyed || !socket.writable) return;
  const payload = Buffer.from(JSON.stringify(value));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function dockerRequest(path, callback) {
  const request = http.request({
    socketPath: dockerSocket,
    path: `/${apiVersion}${path}`,
    method: 'GET',
    timeout: 5000,
  }, callback);
  request.on('timeout', () => request.destroy(new Error('Docker Engine request timed out')));
  request.on('error', (error) => callback(null, error));
  request.end();
  return request;
}

function emitLog(client, name, stream, line) {
  const text = line.replace(/\r$/, '');
  if (!text) return;
  sendFrame(client.socket, { type: 'log', container: name, stream, time: new Date().toISOString(), text });
}

function startContainerLogs(client, container) {
  if (client.closed || client.streams.has(container.Id) || client.completed.has(container.Id)) return;
  const name = (container.Names && container.Names[0] || container.Id.slice(0, 12)).replace(/^\//, '');
  const follow = container.State === 'running';
  const path = `/containers/${container.Id}/logs?follow=${follow ? 1 : 0}&stdout=1&stderr=1&tail=150&timestamps=1`;
  const state = { request: null, retry: null, follow };
  client.streams.set(container.Id, state);

  const request = dockerRequest(path, (response, error) => {
    if (error) {
      sendFrame(client.socket, { type: 'status', text: `Docker log stream for ${name} failed: ${error.message}` });
      client.streams.delete(container.Id);
      return;
    }
    if (!response || response.statusCode !== 200) {
      sendFrame(client.socket, { type: 'status', text: `Docker returned ${response ? response.statusCode : 'no response'} for ${name}` });
      if (response) response.resume();
      client.streams.delete(container.Id);
      return;
    }

    let frames = Buffer.alloc(0);
    let lineBuffer = '';
    response.on('data', (chunk) => {
      frames = Buffer.concat([frames, chunk]);
      while (frames.length >= 8) {
        const kind = frames[0];
        const size = frames.readUInt32BE(4);
        if ((kind !== 1 && kind !== 2) || size > 4 * 1024 * 1024) {
          // A TTY-enabled container is not multiplexed by Docker.
          lineBuffer += frames.toString('utf8');
          frames = Buffer.alloc(0);
          break;
        }
        if (frames.length < 8 + size) break;
        const stream = kind === 2 ? 'stderr' : 'stdout';
        const payload = frames.toString('utf8', 8, 8 + size);
        frames = frames.subarray(8 + size);
        lineBuffer += payload;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const line of lines) emitLog(client, name, stream, line);
      }
    });
    response.on('end', () => {
      if (lineBuffer) emitLog(client, name, 'stdout', lineBuffer);
    });
  });
  state.request = request;
  request.on('close', () => {
    if (client.closed) return;
    client.streams.delete(container.Id);
    if (state.follow) state.retry = setTimeout(() => refreshClientContainers(client), 2500);
    else client.completed.add(container.Id);
  });
}

function refreshClientContainers(client) {
  if (client.closed) return;
  const label = encodeURIComponent(JSON.stringify({ label: ['assessment-platform.logs=true'] }));
  dockerRequest(`/containers/json?all=1&filters=${label}`, (response, error) => {
    if (error || !response || response.statusCode !== 200) {
      sendFrame(client.socket, { type: 'status', text: `Docker Engine unavailable: ${error ? error.message : `HTTP ${response && response.statusCode}`}` });
      if (response) response.resume();
      return;
    }
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try {
        for (const container of JSON.parse(body)) startContainerLogs(client, container);
        sendFrame(client.socket, { type: 'status', text: 'Connected to Docker Engine' });
      } catch (parseError) {
        sendFrame(client.socket, { type: 'status', text: `Unable to read Docker container list: ${parseError.message}` });
      }
    });
  });
}

function closeClient(client) {
  if (client.closed) return;
  client.closed = true;
  clearInterval(client.refreshTimer);
  for (const state of client.streams.values()) {
    clearTimeout(state.retry);
    state.request && state.request.destroy();
  }
  client.streams.clear();
  clients.delete(client);
}

const server = http.createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  if (request.url === '/' || request.url === '/logs.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream('/app/logs.html').pipe(response);
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.on('upgrade', (request, socket) => {
  if (request.url !== '/stream' || !request.headers['sec-websocket-key']) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const origin = request.headers.origin || '';
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1')
    .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));

  const client = { socket, streams: new Map(), completed: new Set(), closed: false, refreshTimer: null };
  clients.add(client);
  socket.on('data', (data) => {
    if (data.length && (data[0] & 0x0f) === 0x8) {
      socket.write(Buffer.from([0x88, 0x00]));
      socket.end();
    }
  });
  socket.on('close', () => closeClient(client));
  socket.on('error', () => closeClient(client));
  refreshClientContainers(client);
  client.refreshTimer = setInterval(() => refreshClientContainers(client), 5000);
});

server.listen(port, '0.0.0.0', () => console.log(`Container log dashboard listening on :${port}`));
process.on('SIGTERM', () => {
  for (const client of clients) closeClient(client);
  server.close(() => process.exit(0));
});
