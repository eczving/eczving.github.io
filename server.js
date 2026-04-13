'use strict';

// Terep multiplayer server.
// Serves static files from this directory over HTTP and runs a WebSocket
// relay on the same port. The server is deliberately thin: it assigns player
// IDs + colours, rate-limits incoming state messages, and broadcasts them to
// all other connected clients. Physics remain entirely client-side.
//
// ROOMS: players create or join a room via a short invite code.
// SNAPSHOT: when a player joins, they receive the last known state of every
//   existing player immediately.
// VELOCITY RELAY: vx/vy/vz/yawRate forwarded for client-side dead-reckoning.
// DAMAGE RELAY (new): player_hit {victimId, damage} messages are relayed to
//   the whole room so all clients can flash the right car and apply damage.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');
const { Server: WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function sanitiseState(msg) {
  return {
    x:       +msg.x       || 0,
    y:       +msg.y       || 0,
    z:       +msg.z       || 0,
    yaw:     +msg.yaw     || 0,
    pitch:   +msg.pitch   || 0,
    roll:    +msg.roll    || 0,
    speed:   +msg.speed   || 0,
    vx:      +msg.vx      || 0,
    vy:      +msg.vy      || 0,
    vz:      +msg.vz      || 0,
    yawRate: +msg.yawRate || 0,
  };
}

function serveStatic(req, res) {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(ROOT, '.' + pathname);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (rooms[code]);
  return code;
}

function getOrCreateRoom(code) {
  if (!rooms[code]) {
    rooms[code] = { code, players: {} };
    console.log('  room ' + code + ' created');
  }
  return rooms[code];
}

function destroyRoomIfEmpty(room) {
  if (Object.keys(room.players).length === 0) {
    delete rooms[room.code];
    console.log('  room ' + room.code + ' destroyed (empty)');
  }
}

function broadcastToRoom(room, excludeWs, msg) {
  const data = JSON.stringify(msg);
  for (const id in room.players) {
    const p = room.players[id];
    if (p.ws !== excludeWs && p.ws.readyState === p.ws.OPEN) {
      p.ws.send(data);
    }
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

let nextId = 1;

const server = http.createServer(serveStatic);
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id         = 'p' + nextId;
  const colorIndex = (nextId - 1) % 6;
  nextId++;

  let room        = null;
  let lastStateMs = 0;
  // Hit rate-limit per attacker (keyed by victimId)
  const hitCooldowns = {};
  const HIT_COOLDOWN_MS = 150;

  ws.on('message', (raw) => {
    const now = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create_room') {
      if (room) return;
      const code = generateCode();
      room = getOrCreateRoom(code);
      sendTo(ws, { type: 'welcome', id, colorIndex, roomCode: code, playerCount: 0, snapshot: [] });
      room.players[id] = { id, ws, colorIndex, lastState: null };
      console.log('+ ' + id + ' created room ' + code + ' | room size: 1');
      return;
    }

    if (msg.type === 'join_room') {
      if (room) return;
      const code = (msg.code || '').toString().toUpperCase().trim();
      if (!code || !rooms[code]) {
        sendTo(ws, { type: 'error', reason: 'room_not_found', code });
        return;
      }
      room = rooms[code];
      const snapshot = Object.values(room.players).map((p) => ({
        id: p.id, colorIndex: p.colorIndex,
        ...(p.lastState || { x:0,y:0,z:0,vx:0,vy:0,vz:0,yaw:0,yawRate:0,pitch:0,roll:0,speed:0 }),
      }));
      sendTo(ws, { type: 'welcome', id, colorIndex, roomCode: code, playerCount: Object.keys(room.players).length, snapshot });
      broadcastToRoom(room, ws, { type: 'player_join', id, colorIndex });
      room.players[id] = { id, ws, colorIndex, lastState: null };
      console.log('+ ' + id + ' joined room ' + code + ' | room size: ' + Object.keys(room.players).length);
      return;
    }

    if (msg.type === 'player_state') {
      if (!room) return;
      if (now - lastStateMs < 40) return;
      lastStateMs = now;
      const state = sanitiseState(msg);
      room.players[id].lastState = state;
      broadcastToRoom(room, ws, { type: 'player_state', id, ...state });
      return;
    }

    // Relay hit messages — rate-limited server-side per attacker/victim pair
    if (msg.type === 'player_hit') {
      if (!room) return;
      const victimId = (msg.victimId || '').toString();
      const damage   = Math.min(Math.max(+msg.damage || 0, 0), 35);  // clamp 0-35
      if (!victimId || !room.players[victimId]) return;
      const coolKey = id + '->' + victimId;
      if (hitCooldowns[coolKey] && now - hitCooldowns[coolKey] < HIT_COOLDOWN_MS) return;
      hitCooldowns[coolKey] = now;
      // Send only to victim (attacker already applied damage locally)
      const victimWs = room.players[victimId].ws;
      sendTo(victimWs, { type: 'player_hit', id, victimId, damage });
      // Broadcast to rest of room so they can flash the right car mesh
      broadcastToRoom(room, victimWs, { type: 'player_hit', id, victimId, damage });
      return;
    }
  });

  function cleanup() {
    if (!room || !room.players[id]) return;
    delete room.players[id];
    broadcastToRoom(room, null, { type: 'player_leave', id });
    console.log('- ' + id + ' left room ' + room.code + ' | room size: ' + Object.keys(room.players).length);
    destroyRoomIfEmpty(room);
    room = null;
  }

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log('Terep running at http://localhost:' + PORT);
});
