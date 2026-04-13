'use strict';
window.T2 = window.T2 || {};

// WebSocket client for multiplayer.
// Connects to the relay server, performs the room handshake, sends the local
// vehicle state at ~20 Hz, and dispatches incoming messages to T2.Multiplayer.
//
// DAMAGE (new):
//   sendHit(victimId, damage) — sends a player_hit message with a 150ms
//   cooldown so sustained bumper-contact doesn't spam the channel.
//   Incoming player_hit routes to T2.Vehicle.applyRemoteDamage() so the
//   local player registers damage when someone rams them.

T2.Network = (function () {

  var ws            = null;
  var connected     = false;
  var localId       = null;
  var roomCode      = null;

  var sendAccum     = 0;
  var SEND_INTERVAL = 1 / 20;

  // Hit message cooldown — keyed by victimId
  var hitCooldowns  = {};
  var HIT_COOLDOWN  = 0.15;   // seconds
  var hitAccum      = 0;      // shares the same dt accumulator as tick()

  var _onRoomReady  = null;

  var WS_URL = (window.location.protocol === 'https:' ? 'wss:' : 'ws:')
             + '//' + window.location.host + '/';

  function codeFromHash() {
    var h = (window.location.hash || '').replace('#', '').trim().toUpperCase();
    return h.length === 6 ? h : null;
  }

  function onOpen() {
    connected = true;
    var inviteCode = codeFromHash();
    if (inviteCode) {
      ws.send(JSON.stringify({ type: 'join_room', code: inviteCode }));
    } else {
      ws.send(JSON.stringify({ type: 'create_room' }));
    }
  }

  function onClose() { connected = false; ws = null; }
  function onError() { connected = false; ws = null; }

  function onMessage(e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch (ex) { return; }

    if (msg.type === 'welcome') {
      localId  = msg.id;
      roomCode = msg.roomCode;
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', '#' + roomCode);
      }
      if (msg.snapshot && msg.snapshot.length > 0) {
        T2.Multiplayer.applySnapshot(msg.snapshot);
      }
      if (typeof _onRoomReady === 'function') {
        _onRoomReady(roomCode, msg.playerCount);
      }
      return;
    }

    if (msg.type === 'error') {
      console.warn('[T2.Network] server error:', msg.reason, msg.code);
      if (msg.reason === 'room_not_found') {
        window.history.replaceState(null, '', '#');
        ws.send(JSON.stringify({ type: 'create_room' }));
      }
      return;
    }

    // player_hit: someone rammed the local player
    if (msg.type === 'player_hit' && msg.victimId === localId) {
      if (T2.Vehicle && T2.Vehicle.applyRemoteDamage) {
        T2.Vehicle.applyRemoteDamage(msg.damage);
      }
      // Also flash the attacker's mesh so we know who hit us
      if (T2.Multiplayer && T2.Multiplayer.applyRemoteHit) {
        T2.Multiplayer.applyRemoteHit(msg.id);
      }
      return;
    }

    // player_hit: someone rammed a third player — flash their mesh
    if (msg.type === 'player_hit' && msg.victimId !== localId) {
      if (T2.Multiplayer && T2.Multiplayer.applyRemoteHit) {
        T2.Multiplayer.applyRemoteHit(msg.victimId);
      }
      return;
    }

    if (
      msg.type === 'player_join'  ||
      msg.type === 'player_leave' ||
      msg.type === 'player_state'
    ) {
      T2.Multiplayer.handleMessage(msg);
    }
  }

  return {

    init: function (onRoomReady) {
      _onRoomReady = onRoomReady || null;
      try {
        ws           = new WebSocket(WS_URL);
        ws.onopen    = onOpen;
        ws.onclose   = onClose;
        ws.onerror   = onError;
        ws.onmessage = onMessage;
      } catch (e) {
        ws = null;
      }
    },

    tick: function (vehicleState, dt) {
      if (!connected || !ws || !roomCode) return;

      sendAccum += dt;
      if (sendAccum < SEND_INTERVAL) return;
      sendAccum -= SEND_INTERVAL;

      var pos = vehicleState.position;
      var vel = vehicleState.velocity;
      try {
        ws.send(JSON.stringify({
          type:    'player_state',
          x:       pos.x,
          y:       pos.y,
          z:       pos.z,
          vx:      vel ? vel.x : 0,
          vy:      vel ? vel.y : 0,
          vz:      vel ? vel.z : 0,
          yaw:     vehicleState.yaw,
          yawRate: vehicleState.yawRate,
          pitch:   vehicleState.pitch,
          roll:    vehicleState.roll,
          speed:   vehicleState.speed,
        }));
      } catch (e) {
        connected = false;
        ws = null;
      }
    },

    // Send a hit notification to the server, which relays it to the victim.
    // Rate-limited per victim to avoid spamming on sustained contact.
    sendHit: function (victimId, damage) {
      if (!connected || !ws || !roomCode || !localId) return;
      var nowSec = Date.now() / 1000;
      if (hitCooldowns[victimId] && nowSec < hitCooldowns[victimId]) return;
      hitCooldowns[victimId] = nowSec + HIT_COOLDOWN;
      try {
        ws.send(JSON.stringify({
          type:     'player_hit',
          victimId: victimId,
          damage:   Math.round(damage),
        }));
      } catch (e) {
        connected = false;
        ws = null;
      }
    },

    isConnected:    function () { return connected; },
    getLocalId:     function () { return localId; },
    getRoomCode:    function () { return roomCode; },
    setOnRoomReady: function (fn) { _onRoomReady = fn; },

    getPlayerCount: function () {
      return T2.Multiplayer.getPlayerCount() + (connected ? 1 : 0);
    },
  };

})();
