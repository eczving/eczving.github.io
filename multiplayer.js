'use strict';
window.T2 = window.T2 || {};

// Remote-player rendering with dead-reckoning interpolation.
//
// Each remote car maintains two positions:
//   • A "physics snapshot" — the last authoritative state from the server,
//     including velocity.  This is integrated forward each frame using the
//     same simple Euler step the local vehicle uses, so the ghost keeps moving
//     smoothly even when packets are delayed or dropped (dead reckoning).
//   • A "render position" — linearly blended toward the dead-reckoned position
//     at a gentle rate so network jitter doesn't cause visible snapping.
//
// COLLISION (new):
//   getColliders() returns the current render position of each remote car
//   as a circle collider so vehicle.js can test against them each frame.
//
// DAMAGE (new):
//   applyRemoteHit(id) triggers a brief orange flash on the remote car mesh
//   when a player_hit message arrives, giving visual confirmation that you
//   landed a hit on someone.

T2.Multiplayer = (function () {

  // ── Constants (mirror vehicle.js) ──────────────────────────────────────────
  var WHEEL_OFFSETS = [
    { x: -1.1, z:  1.55 },
    { x:  1.1, z:  1.55 },
    { x: -1.1, z: -1.55 },
    { x:  1.1, z: -1.55 },
  ];
  var WHEEL_REST_Y         = -0.42;
  var WHEEL_RADIUS         = 0.4;
  var CAR_COLLISION_RADIUS = 1.4;
  var BLEND_RATE           = 8;
  var DR_MAX_AGE           = 0.5;
  var DAMAGE_FLASH_DURATION = 0.30;

  // ── Colour palette ──────────────────────────────────────────────────────────
  var GHOST_COLORS = [
    { body: 0x2090d0, cabin: 0x1870a8 },
    { body: 0x20a830, cabin: 0x188020 },
    { body: 0xd09020, cabin: 0xa07010 },
    { body: 0xa020c8, cabin: 0x801898 },
    { body: 0x20c8a8, cabin: 0x18a080 },
    { body: 0xd04020, cabin: 0xa03018 },
  ];

  // ── Module state ────────────────────────────────────────────────────────────
  var sceneRef      = null;
  var remotePlayers = {};

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function makeMat(hex) {
    return new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
  }

  function lerpAngle(a, b, t) {
    var diff = b - a;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── Ghost mesh construction ──────────────────────────────────────────────────
  function buildGhostMesh(colorIndex) {
    var c     = GHOST_COLORS[colorIndex % GHOST_COLORS.length];
    var group = new THREE.Group();

    var bodyMat  = makeMat(c.body);
    var bodyMesh = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.6, 4.2), bodyMat
    );
    group.add(bodyMesh);

    var cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.7, 2.2), makeMat(c.cabin)
    );
    cabin.position.set(0, 0.65, -0.25);
    group.add(cabin);

    var wheels  = [];
    var tyreMat = makeMat(0x1a1a1a);
    for (var i = 0; i < 4; i++) {
      var wGroup   = new THREE.Group();
      var tyreMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.32, 10),
        tyreMat
      );
      tyreMesh.rotation.z = Math.PI / 2;
      wGroup.add(tyreMesh);
      wGroup.position.set(WHEEL_OFFSETS[i].x, WHEEL_REST_Y, WHEEL_OFFSETS[i].z);
      group.add(wGroup);
      wheels.push({ group: wGroup, tyre: tyreMesh, spinAngle: 0 });
    }

    group.visible = false;
    sceneRef.add(group);
    return { group, wheels, bodyMesh, bodyMat, baseColor: c.body };
  }

  // ── Add / initialise a remote player entry ───────────────────────────────────
  function addPlayer(id, colorIndex, initialState) {
    if (remotePlayers[id]) return;
    var mesh = buildGhostMesh(colorIndex);
    var s    = initialState || {};
    var ix = s.x || 0, iy = s.y || 5, iz = s.z || 0;

    remotePlayers[id] = {
      group:      mesh.group,
      wheels:     mesh.wheels,
      bodyMesh:   mesh.bodyMesh,
      bodyMat:    mesh.bodyMat,
      baseColor:  mesh.baseColor,
      colorIndex,

      dr: {
        x: ix, y: iy, z: iz,
        vx: 0, vy: 0, vz: 0,
        yaw: s.yaw || 0, yawRate: 0,
        pitch: s.pitch || 0,
        roll:  s.roll  || 0,
        speed: s.speed || 0,
        age:   0,
      },

      rx: ix, ry: iy, rz: iz,
      smoothYaw:   s.yaw   || 0,
      smoothPitch: s.pitch || 0,
      smoothRoll:  s.roll  || 0,

      damageFlash:    0,
      seenFirstPacket: !!initialState,
    };

    if (initialState) {
      mesh.group.position.set(ix, iy, iz);
      mesh.group.rotation.set(s.pitch || 0, s.yaw || 0, s.roll || 0, 'YXZ');
      mesh.group.visible = true;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  return {

    init: function (scene) {
      sceneRef = scene;
    },

    tick: function (dt) {
      var blend = clamp(BLEND_RATE * dt, 0, 1);

      for (var id in remotePlayers) {
        var p  = remotePlayers[id];
        var dr = p.dr;

        dr.age = Math.min(dr.age + dt, DR_MAX_AGE);
        dr.x  += dr.vx * dt;
        dr.y  += dr.vy * dt;
        dr.z  += dr.vz * dt;
        dr.yaw += dr.yawRate * dt;
        if (dr.y > 0.8) dr.vy -= 4.9 * dt;

        p.rx += (dr.x - p.rx) * blend;
        p.ry += (dr.y - p.ry) * blend;
        p.rz += (dr.z - p.rz) * blend;

        p.smoothYaw   = lerpAngle(p.smoothYaw,   dr.yaw,   blend);
        p.smoothPitch = lerp(p.smoothPitch, dr.pitch, blend);
        p.smoothRoll  = lerp(p.smoothRoll,  dr.roll,  blend);

        var g = p.group;
        g.position.set(p.rx, p.ry, p.rz);
        g.rotation.set(p.smoothPitch, p.smoothYaw, p.smoothRoll, 'YXZ');

        var spinDelta = dr.speed * dt / WHEEL_RADIUS;
        for (var wi = 0; wi < p.wheels.length; wi++) {
          p.wheels[wi].spinAngle   += spinDelta;
          p.wheels[wi].tyre.rotation.x = p.wheels[wi].spinAngle;
        }

        // Damage flash: tint remote body mesh orange then back to base colour
        if (p.damageFlash > 0) {
          p.damageFlash -= dt;
          var ft = Math.max(0, p.damageFlash) / DAMAGE_FLASH_DURATION;
          // base colour → orange (0xff8800) → base
          var bc = p.baseColor;
          var br = (bc >> 16) & 0xff;
          var bg = (bc >>  8) & 0xff;
          var bb =  bc        & 0xff;
          var nr = Math.round(lerp(br, 0xff, ft));
          var ng = Math.round(lerp(bg, 0x88, ft));
          var nb = Math.round(lerp(bb, 0x00, ft));
          p.bodyMat.color.setRGB(nr / 255, ng / 255, nb / 255);
        } else if (p.damageFlash <= 0 && p.bodyMat) {
          p.bodyMat.color.setHex(p.baseColor);
        }
      }
    },

    handleMessage: function (msg) {
      if (msg.type === 'player_join') {
        addPlayer(msg.id, msg.colorIndex, null);
      }
      else if (msg.type === 'player_leave') {
        var p = remotePlayers[msg.id];
        if (p) {
          sceneRef.remove(p.group);
          delete remotePlayers[msg.id];
        }
      }
      else if (msg.type === 'player_state') {
        var p = remotePlayers[msg.id];
        if (!p) return;

        if (!p.seenFirstPacket) {
          p.seenFirstPacket = true;
          p.group.position.set(msg.x, msg.y, msg.z);
          p.rx = msg.x; p.ry = msg.y; p.rz = msg.z;
          p.smoothYaw   = msg.yaw;
          p.smoothPitch = msg.pitch;
          p.smoothRoll  = msg.roll;
          p.group.visible = true;
        }

        var dr   = p.dr;
        dr.x     = msg.x;    dr.y    = msg.y;   dr.z    = msg.z;
        dr.vx    = msg.vx   || 0;
        dr.vy    = msg.vy   || 0;
        dr.vz    = msg.vz   || 0;
        dr.yaw   = msg.yaw;  dr.yawRate = msg.yawRate || 0;
        dr.pitch = msg.pitch;
        dr.roll  = msg.roll;
        dr.speed = msg.speed;
        dr.age   = 0;
      }
    },

    applySnapshot: function (snapshot) {
      for (var i = 0; i < snapshot.length; i++) {
        var s = snapshot[i];
        addPlayer(s.id, s.colorIndex, s);
      }
    },

    // Called when a player_hit arrives: flash the car we hit
    applyRemoteHit: function (id) {
      var p = remotePlayers[id];
      if (p) p.damageFlash = DAMAGE_FLASH_DURATION;
    },

    // Returns circle colliders for all remote cars (used by vehicle.js)
    getColliders: function () {
      var out = [];
      for (var id in remotePlayers) {
        var p = remotePlayers[id];
        if (p.group.visible) {
          out.push({ id: id, x: p.rx, y: p.ry, z: p.rz, radius: CAR_COLLISION_RADIUS });
        }
      }
      return out;
    },

    getPlayerCount:   function () { return Object.keys(remotePlayers).length; },
    getRemotePlayers: function () { return remotePlayers; },
  };

})();
