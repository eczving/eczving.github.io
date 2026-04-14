'use strict';
window.T2 = window.T2 || {};

// Terrain visual effects: per-surface wheel-spray particles and atmospheric
// fog colour blending. Particles spawn at rear wheel positions when the car
// is moving; colour, count and trajectory are surface-specific.
// Fog colour lerps toward a terrain-matched tint so the whole scene shifts
// atmosphere as the car crosses terrain boundaries.
//
// IMPACT SPARKS (new):
//   spawnImpactBurst(pos, intensity) spawns a short-lived burst of orange/
//   white spark particles at a world position — called by vehicle.js on
//   car-vs-car collision and prop collision above a speed threshold.
//
// DAMAGE SMOKE (new):
//   When vs.health < 40, a continuous dark smoke stream spawns from the
//   engine position (front-centre of car) each frame, giving a visible
//   "struggling" signal without any UI.
T2.Effects = (function () {

  var MAX_PARTICLES = 2500;   // raised from 250 to accommodate sparks + smoke

  var FX_CONFIG = {
    'DEEP WATER': { r: 0.26, g: 0.50, b: 0.83, rate: 30, upMin: 2.0, upMax: 5.5, spread: 2.5, kick: 3.5, decay: 0.70, size: 0.5 },
    'WATER':      { r: 0.37, g: 0.67, b: 0.91, rate: 25, upMin: 1.5, upMax: 4.5, spread: 2.0, kick: 3.0, decay: 0.75, size: 0.4 },
    'MUD':        { r: 0.38, g: 0.26, b: 0.10, rate: 40, upMin: 2.0, upMax: 4.5, spread: 1.8, kick: 3.5, decay: 0.60, size: 0.7 },
    'GRASS':      { r: 0.18, g: 0.45, b: 0.08, rate: 35, upMin: 1.5, upMax: 3.5, spread: 1.5, kick: 3.0, decay: 0.80, size: 0.6 },
    'HIGHLAND':   { r: 0.53, g: 0.40, b: 0.20, rate: 15, upMin: 0.8, upMax: 2.5, spread: 1.0, kick: 1.5, decay: 1.00, size: 0.4 },
    'ROCK':       { r: 0.56, g: 0.55, b: 0.50, rate:  6, upMin: 0.6, upMax: 2.0, spread: 0.5, kick: 1.2, decay: 1.20 },
    'HIGH ROCK':  { r: 0.69, g: 0.69, b: 0.63, rate:  5, upMin: 0.6, upMax: 1.8, spread: 0.5, kick: 1.0, decay: 1.20 },
    'SNOW':       { r: 0.91, g: 0.91, b: 0.97, rate: 10, upMin: 1.2, upMax: 3.0, spread: 1.5, kick: 1.8, decay: 0.80 },
  };

  var FOG_COLORS = {
    'DEEP WATER': { r: 0x18 / 255, g: 0x40 / 255, b: 0x70 / 255 },
    'WATER':      { r: 0x28 / 255, g: 0x58 / 255, b: 0x90 / 255 },
    'MUD':        { r: 0x70 / 255, g: 0x60 / 255, b: 0x40 / 255 },
    'GRASS':      { r: 0x50 / 255, g: 0x78 / 255, b: 0x58 / 255 },
    'HIGHLAND':   { r: 0x60 / 255, g: 0x60 / 255, b: 0x55 / 255 },
    'ROCK':       { r: 0x68 / 255, g: 0x68 / 255, b: 0x60 / 255 },
    'HIGH ROCK':  { r: 0x78 / 255, g: 0x78 / 255, b: 0x72 / 255 },
    'SNOW':       { r: 0xb0 / 255, g: 0xb8 / 255, b: 0xcc / 255 },
  };
  var DEFAULT_FOG = { r: 0x80 / 255, g: 0x90 / 255, b: 0xa8 / 255 };

  var REAR_OFFSETS = [
    { ox: -1.1, oz: -1.55 },
    { ox:  1.1, oz: -1.55 },
  ];

  // Engine offset in local car space (front-centre)
  var ENGINE_OFFSET = { ox: 0, oz: 1.8 };

  var particles  = [];
  var sceneRef   = null;
  var posAttr    = null;
  var colorAttr  = null;
  var spawnAccum = 0;
  var smokeAccum = 0;

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init(scene) {
    sceneRef = scene;

    var positions = new Float32Array(MAX_PARTICLES * 3);
    var colors    = new Float32Array(MAX_PARTICLES * 3);

    for (var i = 0; i < MAX_PARTICLES; i++) {
      positions[i * 3 + 1] = -9999;
    }

    var geo   = new THREE.BufferGeometry();
    posAttr   = new THREE.BufferAttribute(positions, 3);
    colorAttr = new THREE.BufferAttribute(colors, 3);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color',    colorAttr);

    var mat = new THREE.PointsMaterial({
      size:            0.85,
      vertexColors:    true,
      transparent:     true,
      opacity:         1.0,
      depthWrite:      false,
      sizeAttenuation: true,
    });

    scene.add(new THREE.Points(geo, mat));
  }

  // ── Wheel spray batch ────────────────────────────────────────────────────────
  function spawnBatch(vs, cfg) {
    if (particles.length >= MAX_PARTICLES) return;
    var cosY = Math.cos(vs.yaw);
    var sinY = Math.sin(vs.yaw);
    var px   = vs.position.x;
    var py   = vs.position.y - 0.5;
    var pz   = vs.position.z;

    for (var i = 0; i < 4 && particles.length < MAX_PARTICLES; i++) {
      var wo = REAR_OFFSETS[i % 2];
      var wx = px + wo.ox * cosY + wo.oz * sinY + (Math.random() - 0.5) * cfg.spread;
      var wz = pz - wo.ox * sinY + wo.oz * cosY + (Math.random() - 0.5) * cfg.spread;
      particles.push({
        x: wx, y: py, z: wz,
        vx: (Math.random() - 0.5) * cfg.kick - sinY * vs.speed * 0.1,
        vy: cfg.upMin + Math.random() * (cfg.upMax - cfg.upMin),
        vz: (Math.random() - 0.5) * cfg.kick - cosY * vs.speed * 0.1,
        life:  1.0,
        decay: cfg.decay * (0.8 + Math.random() * 0.4),
        r: cfg.r, g: cfg.g, b: cfg.b,
      });
    }
  }

  // ── Impact spark burst ───────────────────────────────────────────────────────
  // Called by vehicle.js on car-vs-car collision.
  // pos = { x, y, z } world position of impact
  // intensity = 0..1 (scaled from impact speed)
  function spawnImpactBurst(pos, intensity) {
    var count = Math.round(10 + intensity * 20);   // 10–30 sparks
    for (var i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      // Alternate orange and near-white sparks
      var isWhite = (i % 3 === 0);
      var speed   = 3 + Math.random() * 8 * intensity;
      var theta   = Math.random() * Math.PI * 2;
      var phi     = Math.random() * Math.PI * 0.6;  // bias upward
      particles.push({
        x: pos.x + (Math.random() - 0.5) * 0.3,
        y: pos.y + (Math.random() - 0.5) * 0.3,
        z: pos.z + (Math.random() - 0.5) * 0.3,
        vx: Math.cos(theta) * Math.sin(phi) * speed,
        vy: Math.cos(phi)                   * speed,
        vz: Math.sin(theta) * Math.sin(phi) * speed,
        life:  0.8 + Math.random() * 0.4,
        decay: 2.2 + Math.random() * 1.2,   // fast-decaying sparks
        r: isWhite ? 1.0 : 1.0,
        g: isWhite ? 0.9 : 0.45,
        b: isWhite ? 0.7 : 0.05,
      });
    }
  }

  // ── Damage smoke ─────────────────────────────────────────────────────────────
  // Spawns dark grey smoke from the engine when health < 40.
  function spawnDamageSmoke(vs) {
    if (particles.length >= MAX_PARTICLES) return;
    var cosY = Math.cos(vs.yaw);
    var sinY = Math.sin(vs.yaw);
    // Engine position in world space (front-centre of car)
    var ex = vs.position.x + ENGINE_OFFSET.ox * cosY + ENGINE_OFFSET.oz * sinY;
    var ey = vs.position.y + 0.5;
    var ez = vs.position.z - ENGINE_OFFSET.ox * sinY + ENGINE_OFFSET.oz * cosY;
    // Smoke darkness scales with damage severity
    var darkT  = (40 - vs.health) / 40;  // 0 at 40hp, 1 at 0hp
    var grey   = 0.35 - darkT * 0.25;    // 0.35 (light grey) → 0.10 (near black)
    particles.push({
      x: ex + (Math.random() - 0.5) * 0.4,
      y: ey,
      z: ez + (Math.random() - 0.5) * 0.4,
      vx: (Math.random() - 0.5) * 0.5,
      vy: 0.8 + Math.random() * 0.8,
      vz: (Math.random() - 0.5) * 0.5,
      life:  1.0,
      decay: 0.55 + Math.random() * 0.25,  // slow lingering smoke
      r: grey, g: grey, b: grey,
    });
  }

  // ── Per-frame update ──────────────────────────────────────────────────────
  function tick(vs, dt) {
    if (!sceneRef) return;

    var surface  = vs.surfaceType;
    var surfName = surface ? surface.name : '';
    var speed    = vs.speed;
    var cfg      = FX_CONFIG[surfName];

    // Atmospheric fog blend
    var fogTarget = cfg ? FOG_COLORS[surfName] : DEFAULT_FOG;
    var fog = sceneRef.fog;
    if (fog) {
      var rate = Math.min(1, dt * 1.5);
      fog.color.r += (fogTarget.r - fog.color.r) * rate;
      fog.color.g += (fogTarget.g - fog.color.g) * rate;
      fog.color.b += (fogTarget.b - fog.color.b) * rate;
      sceneRef.background.copy(fog.color);
    }

    // Wheel spray
    var MIN_SPEED = 2.0;
    if (cfg && speed > MIN_SPEED && vs.isGrounded !== false) {
      var spawnInterval = 1.0 / (cfg.rate * Math.max(1.0, speed / 5.0));
      spawnAccum += dt;
      while (spawnAccum >= spawnInterval) {
        spawnBatch(vs, cfg);
        spawnAccum -= spawnInterval;
      }
    } else {
      spawnAccum = 0;
    }

    // Damage smoke — only when health < 40
    if (vs.health !== undefined && vs.health < 40) {
      // Rate scales with damage: one puff every 0.1s at 40hp → every 0.04s at 0hp
      var smokeInterval = 0.04 + (vs.health / 40) * 0.06;
      smokeAccum += dt;
      while (smokeAccum >= smokeInterval) {
        spawnDamageSmoke(vs);
        smokeAccum -= smokeInterval;
      }
    } else {
      smokeAccum = 0;
    }

    // Simulate particles
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      p.z  += p.vz * dt;
      p.vy -= 9.81 * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) particles.splice(i, 1);
    }

    // Upload to GPU
    var posArr = posAttr.array;
    var colArr = colorAttr.array;

    for (var j = 0; j < MAX_PARTICLES; j++) {
      if (j < particles.length) {
        var pt = particles[j];
        var a  = Math.max(0, pt.life);
        posArr[j * 3]     = pt.x;
        posArr[j * 3 + 1] = pt.y;
        posArr[j * 3 + 2] = pt.z;
        colArr[j * 3]     = pt.r * a;
        colArr[j * 3 + 1] = pt.g * a;
        colArr[j * 3 + 2] = pt.b * a;
      } else {
        posArr[j * 3 + 1] = -9999;
        colArr[j * 3]     = 0;
        colArr[j * 3 + 1] = 0;
        colArr[j * 3 + 2] = 0;
      }
    }

    posAttr.needsUpdate   = true;
    colorAttr.needsUpdate = true;
  }

  return {
    init,
    tick,
    spawnImpactBurst,  // exposed for vehicle.js
  };

})();
