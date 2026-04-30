'use strict';
window.T2 = window.T2 || {};

// Vehicle physics and 3D mesh.
// Spring-mass suspension (4 wheels) + simplified bicycle-model rigid body.
// All physics in SI-ish units (world units ≈ metres, dt in seconds).
//
// PHYSICS NOTES:
//  - Terrain grounding: per-wheel contact, not body centre.
//  - Engine torque curve: peaks at mid-RPM, drops at redline.
//  - Flywheel inertia: RPM ramps with throttle input.
//  - Traction / slip: force-based grip cap — full traction at launch,
//    wheelspin only when commanded force exceeds tyre capacity.
//  - Weight transfer: braking loads front, acceleration loads rear.
//  - Airborne: car leaves ground over crests; floor uses lowest
//    wheel-position terrain sample + 0.25 m penetration threshold.
//
// MESH:
//  - Retro Escort MK1-inspired rally car (original design, no real-world branding).
//  - White rally livery with red stripe, 4-lamp roof light bar, flared arches,
//    chrome bumpers, roll cage, 5-spoke alloys, exhaust, mud flaps.
//
// DAMAGE MODEL:
//  - state.health (0-100): drains on collisions proportional to impact speed.
//  - Speed capped at MAX_SPEED * (0.5 + health/200).
//  - Visual: orange body-tint flash + squash. R resets health.
T2.Vehicle = (function () {

  // ── Constants ───────────────────────────────────────────────────────────────
  var WHEEL_RADIUS   = 0.4;
  var WHEEL_OFFSETS  = [
    { x: -1.1, z:  1.55 },  // FL
    { x:  1.1, z:  1.55 },  // FR
    { x: -1.1, z: -1.55 },  // RL
    { x:  1.1, z: -1.55 },  // RR
  ];
  var WHEEL_REST_Y        = -0.42;
  var WHEELBASE           = 3.1;
  var CAR_MASS            = 1200;
  var BASE_MAX_SPEED      = 28;      // m/s (~100 km/h)

  var SPRING_K            = 80;
  var SPRING_DAMPER       = 10;
  var SPRING_REST         = 0.5;
  var WHEEL_MASS          = 40;

  var MAX_STEER           = 0.50;
  var CAR_COLLISION_RADIUS = 1.4;

  // ── Gearbox ─────────────────────────────────────────────────────────────────
  var NUM_GEARS        = 5;
  var RPM_IDLE         = 850;
  var RPM_MAX          = 6200;
  var GEAR_RATIOS      = [1.65, 1.28, 1.00, 0.80, 0.65];
  var SHIFT_UP_SPEED   = [5.5, 10.0, 15.5, 21.0];
  var SHIFT_DOWN_SPEED = [3.2,  7.5, 12.0, 17.5];
  var SHIFT_LOCKOUT    = 0.55;

  // ── Engine torque curve ─────────────────────────────────────────────────────
  var TORQUE_CURVE     = [0.55, 0.78, 0.95, 1.00, 0.88, 0.65];
  var PEAK_TORQUE_NM   = 280;
  var FLYWHEEL_INERTIA = 0.22;

  // ── Traction model ──────────────────────────────────────────────────────────
  var MU_TYRE          = 1.1;
  var WHEELSPIN_BLEND  = 6.0;

  var WEIGHT_TRANSFER  = 0.18;

  // ── Damage constants ─────────────────────────────────────────────────────────
  var PROP_IMPACT_DURATION   = 0.22;
  var DAMAGE_FLASH_DURATION  = 0.30;
  var HIT_COOLDOWN           = 0.18;
  var DAMAGE_PER_MS          = 4.2;

  // ── Car body base colour (white rally livery) ────────────────────────────────
  var BODY_BASE_R = 0xF2 / 255;
  var BODY_BASE_G = 0xF0 / 255;
  var BODY_BASE_B = 0xE8 / 255;

  // ── State ───────────────────────────────────────────────────────────────────
  var state = {
    position:     new THREE.Vector3(),
    velocity:     new THREE.Vector3(),
    yaw:          0,
    yawRate:      0,
    pitch:        0,
    roll:         0,
    speed:        0,
    localVelZ:    0,
    localVelX:    0,
    surfaceType:  null,
    isGrounded:   false,
    isFlipped:    false,
    flipTimer:    0,
    currentSteer: 0,
    impactTimer:  0,
    currentGear:  0,
    shiftTimer:   0,
    engineRPM:    RPM_IDLE,
    tractionGrip: 1.0,
    health:       100,
    damageFlash:  0,
    isWrecked:    false,
  };

  var hitCooldowns = {};

  // ── Winch state ──────────────────────────────────────────────────────────────
  var winchState = {
    active:     false,
    targetId:   null,
    restLength: 10.0,
  };

  var wheels = [];
  for (var wi = 0; wi < 4; wi++) {
    wheels.push({
      compressionY: 0,
      velocity:     0,
      isGrounded:   false,
      spinAngle:    0,
      steerAngle:   0,
      contactY:     0,
      load:         0,
      group:        null,
      mesh:         null,
    });
  }

  var vehicleGroup    = null;
  var bodyMeshRef     = null;
  var bodyColorMeshes = [];   // all white-body panels — updated together for damage tint

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t)    { return a + (b - a) * t; }

  function sampleTorqueCurve(rpmNorm) {
    rpmNorm = clamp(rpmNorm, 0, 1);
    var idx = rpmNorm * (TORQUE_CURVE.length - 1);
    var lo  = Math.floor(idx);
    var hi  = Math.min(lo + 1, TORQUE_CURVE.length - 1);
    var t   = idx - lo;
    return TORQUE_CURVE[lo] * (1 - t) + TORQUE_CURVE[hi] * t;
  }

  // ── Mesh construction — Retro Rally Car ──────────────────────────────────────
  function buildMesh(scene) {
    vehicleGroup    = new THREE.Group();
    bodyColorMeshes = [];

    // Palette
    var C_WHITE  = 0xF2F0E8;
    var C_RED    = 0xCC1A1A;
    var C_BLACK  = 0x111111;
    var C_CHROME = 0xB8B8B8;
    var C_SILVER = 0x888888;
    var C_YELLOW = 0xFFD060;
    var C_GLASS  = 0x88AACC;
    var C_DARK   = 0x1a1a1a;
    var C_GREY   = 0x444444;
    var C_RUST   = 0x8B3A10;

    function mat(hex) {
      return new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
    }
    function matAlpha(hex, opacity) {
      return new THREE.MeshLambertMaterial({
        color: hex, transparent: true, opacity: opacity, flatShading: true,
      });
    }
    // Adds a mesh to vehicleGroup; if isBody=true, registers it for damage tinting
    function add(geo, material, px, py, pz, isBody) {
      var mesh = new THREE.Mesh(geo, material);
      if (px !== undefined) mesh.position.set(px, py, pz);
      vehicleGroup.add(mesh);
      if (isBody) bodyColorMeshes.push(mesh);
      return mesh;
    }

    // ─── LOWER BODY HULL ──────────────────────────────────────────────────────
    var lowerBody = add(
      new THREE.BoxGeometry(2.20, 0.52, 4.08), mat(C_WHITE), 0, -0.08, -0.04, true
    );
    bodyMeshRef = lowerBody;

    // Sill reinforcement strips
    [-1.11, 1.11].forEach(function(x) {
      add(new THREE.BoxGeometry(0.08, 0.52, 3.80), mat(C_BLACK), x, -0.08, -0.04);
    });

    // Red rally stripe (lower body band)
    add(new THREE.BoxGeometry(2.22, 0.13, 4.12), mat(C_RED), 0, -0.30, -0.04);

    // ─── WHEEL ARCH FLARES ────────────────────────────────────────────────────
    var archPositions = [[-1.18, 1.55], [1.18, 1.55], [-1.18, -1.55], [1.18, -1.55]];
    archPositions.forEach(function(o) {
      add(new THREE.BoxGeometry(0.13, 0.32, 1.05), mat(C_WHITE), o[0], -0.02, o[1], true);
      // Arch lip
      add(new THREE.BoxGeometry(0.14, 0.06, 1.08), mat(C_BLACK), o[0], -0.20, o[1]);
    });

    // ─── CABIN (upper body) ───────────────────────────────────────────────────
    var cabin = add(
      new THREE.BoxGeometry(1.78, 0.65, 2.08), mat(C_WHITE), 0, 0.58, -0.18, true
    );

    // ─── ROOF PANEL ───────────────────────────────────────────────────────────
    add(new THREE.BoxGeometry(1.80, 0.08, 2.10), mat(0xE0DDD5), 0, 0.92, -0.18, true);

    // ─── BONNET (hood) ────────────────────────────────────────────────────────
    add(new THREE.BoxGeometry(2.10, 0.09, 1.28), mat(C_WHITE), 0, 0.20, 1.62, true);
    // Power bulge (intake scoop)
    add(new THREE.BoxGeometry(0.44, 0.10, 0.78), mat(0xD8D5CC), 0, 0.25, 1.62, true);
    // Bonnet vents (louvres)
    [-0.28, 0, 0.28].forEach(function(x) {
      add(new THREE.BoxGeometry(0.10, 0.04, 0.48), mat(C_BLACK), x, 0.26, 1.62);
    });

    // ─── BOOT LID (trunk) ─────────────────────────────────────────────────────
    add(new THREE.BoxGeometry(2.10, 0.09, 0.88), mat(C_WHITE), 0, 0.20, -1.68, true);

    // ─── WINDSCREEN FRAME ─────────────────────────────────────────────────────
    // Top rail
    add(new THREE.BoxGeometry(1.80, 0.09, 0.07), mat(C_BLACK), 0, 0.90, 0.84);
    // Bottom rail
    add(new THREE.BoxGeometry(1.80, 0.07, 0.07), mat(C_BLACK), 0, 0.26, 0.82);
    // A-pillars
    [-0.86, 0.86].forEach(function(x) {
      add(new THREE.BoxGeometry(0.07, 0.65, 0.07), mat(C_BLACK), x, 0.58, 0.83);
    });
    // Windscreen glass
    add(
      new THREE.BoxGeometry(1.64, 0.56, 0.04),
      matAlpha(C_GLASS, 0.42),
      0, 0.60, 0.83
    );

    // ─── REAR WINDOW ──────────────────────────────────────────────────────────
    // Frame
    add(new THREE.BoxGeometry(1.72, 0.09, 0.07), mat(C_BLACK), 0, 0.90, -1.22);
    add(new THREE.BoxGeometry(1.72, 0.07, 0.07), mat(C_BLACK), 0, 0.26, -1.22);
    [-0.83, 0.83].forEach(function(x) {
      add(new THREE.BoxGeometry(0.07, 0.65, 0.07), mat(C_BLACK), x, 0.58, -1.22);
    });
    add(
      new THREE.BoxGeometry(1.58, 0.52, 0.04),
      matAlpha(C_GLASS, 0.38),
      0, 0.58, -1.22
    );

    // ─── SIDE WINDOWS ─────────────────────────────────────────────────────────
    [-0.90, 0.90].forEach(function(x) {
      add(
        new THREE.BoxGeometry(0.04, 0.52, 1.90),
        matAlpha(C_GLASS, 0.30),
        x, 0.58, -0.18
      );
    });

    // ─── RECTANGULAR HEADLIGHTS (twin, classic Escort style) ──────────────────
    [[-0.60, 2.08], [0.60, 2.08]].forEach(function(o) {
      // Surround
      add(new THREE.BoxGeometry(0.56, 0.30, 0.07), mat(C_BLACK), o[0], 0.14, o[1]);
      // Lens
      add(new THREE.BoxGeometry(0.48, 0.22, 0.06), mat(0xFFFACC), o[0], 0.14, o[1] + 0.01);
      // Inner divider (twin-headlight look)
      add(new THREE.BoxGeometry(0.04, 0.22, 0.07), mat(C_BLACK), o[0], 0.14, o[1] + 0.02);
    });

    // ─── FRONT GRILLE ─────────────────────────────────────────────────────────
    add(new THREE.BoxGeometry(1.08, 0.22, 0.06), mat(C_BLACK), 0, 0.14, 2.09);
    // Grille bars
    [-0.10, 0.10].forEach(function(y) {
      add(new THREE.BoxGeometry(1.06, 0.03, 0.05), mat(C_CHROME), 0, 0.14 + y, 2.10);
    });

    // ─── TAIL LIGHTS ──────────────────────────────────────────────────────────
    [[-0.68, -2.08], [0.68, -2.08]].forEach(function(o) {
      add(new THREE.BoxGeometry(0.48, 0.24, 0.07), mat(C_RED),   o[0],      0.10, o[1]);
      // Reverse lamp (inner strip, white)
      add(new THREE.BoxGeometry(0.18, 0.12, 0.06), mat(0xEEEECC), o[0] + (o[0] < 0 ? 0.15 : -0.15), 0.10, o[1] + 0.01);
    });
    // Centre brake strip
    add(new THREE.BoxGeometry(0.48, 0.10, 0.05), mat(C_RED), 0, 0.18, -2.08);

    // ─── FRONT BUMPER (chrome steel) ──────────────────────────────────────────
    add(new THREE.BoxGeometry(2.32, 0.20, 0.16), mat(C_CHROME), 0, -0.04, 2.15);
    // Bash plate / skid plate
    add(new THREE.BoxGeometry(2.22, 0.10, 0.14), mat(C_GREY), 0, -0.20, 2.15);
    // Tow hook
    add(new THREE.BoxGeometry(0.08, 0.24, 0.10), mat(C_BLACK), 0, -0.20, 2.22);

    // ─── REAR BUMPER ──────────────────────────────────────────────────────────
    add(new THREE.BoxGeometry(2.32, 0.20, 0.16), mat(C_CHROME), 0, -0.04, -2.15);
    // Tow hook rear
    add(new THREE.BoxGeometry(0.08, 0.22, 0.10), mat(C_BLACK), 0, -0.20, -2.22);

    // ─── ROOF RALLY LIGHT BAR ─────────────────────────────────────────────────
    // Mounting stanchions
    [-0.70, 0.70].forEach(function(x) {
      add(new THREE.BoxGeometry(0.06, 0.22, 0.06), mat(C_BLACK), x, 1.05, 0.08);
    });
    // Main horizontal bar
    add(new THREE.BoxGeometry(1.54, 0.09, 0.16), mat(C_BLACK), 0, 1.17, 0.08);
    // 4 lamp housings
    [-0.54, -0.18, 0.18, 0.54].forEach(function(x) {
      add(new THREE.BoxGeometry(0.28, 0.24, 0.20), mat(C_BLACK), x, 1.17, 0.20);
      add(new THREE.BoxGeometry(0.24, 0.20, 0.06), mat(C_YELLOW), x, 1.17, 0.31);
      // Lamp ring
      add(new THREE.BoxGeometry(0.26, 0.22, 0.03), mat(C_CHROME), x, 1.17, 0.30);
    });

    // ─── ROLL CAGE (visible through glass) ────────────────────────────────────
    // Main hoop
    add(new THREE.BoxGeometry(1.62, 0.06, 0.06), mat(C_SILVER), 0, 0.90, -0.20);
    [-0.78, 0.78].forEach(function(x) {
      add(new THREE.BoxGeometry(0.06, 0.64, 0.06), mat(C_SILVER), x, 0.58, -0.20);
    });
    // Front diagonal brace
    add(new THREE.BoxGeometry(0.06, 0.55, 0.06), mat(C_SILVER), -0.78, 0.65, 0.50);
    add(new THREE.BoxGeometry(0.06, 0.55, 0.06), mat(C_SILVER),  0.78, 0.65, 0.50);

    // ─── EXHAUST PIPE ─────────────────────────────────────────────────────────
    var exGeo = new THREE.CylinderGeometry(0.055, 0.065, 0.60, 8);
    var ex = new THREE.Mesh(exGeo, mat(C_GREY));
    ex.rotation.z = Math.PI / 2;
    ex.position.set(-1.14, -0.32, -1.82);
    vehicleGroup.add(ex);
    // Exhaust tip
    var exTipGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.06, 8);
    var exTip = new THREE.Mesh(exTipGeo, mat(C_CHROME));
    exTip.rotation.z = Math.PI / 2;
    exTip.position.set(-1.44, -0.32, -1.82);
    vehicleGroup.add(exTip);

    // ─── SIDE MIRRORS ─────────────────────────────────────────────────────────
    [[-1.12, 0.76], [1.12, 0.76]].forEach(function(o) {
      var side = o[0] < 0 ? -1 : 1;
      add(new THREE.BoxGeometry(0.16, 0.06, 0.06), mat(C_BLACK), o[0], 0.40, o[1]);
      add(new THREE.BoxGeometry(0.11, 0.14, 0.10), mat(C_BLACK), o[0] + side * 0.10, 0.44, o[1]);
    });

    // ─── MUD FLAPS ────────────────────────────────────────────────────────────
    [[-1.10, 0.98], [1.10, 0.98], [-1.10, -1.04], [1.10, -1.04]].forEach(function(o) {
      add(new THREE.BoxGeometry(0.07, 0.30, 0.28), mat(C_BLACK), o[0], -0.30, o[1]);
    });

    // ─── NUMBER PLATE / COMPETITION ROUNDEL ───────────────────────────────────
    // Front plate
    add(new THREE.BoxGeometry(0.62, 0.36, 0.04), mat(0xFFFFFF), 0, 0.14, 2.10);
    add(new THREE.BoxGeometry(0.58, 0.32, 0.03), mat(C_BLACK), 0, 0.14, 2.11);
    // Rear plate
    add(new THREE.BoxGeometry(0.62, 0.22, 0.04), mat(0xFFFFFF), 0, -0.02, -2.10);

    // ─── AERIAL ───────────────────────────────────────────────────────────────
    add(new THREE.BoxGeometry(0.03, 0.48, 0.03), mat(C_CHROME), 0.84, 1.14, -0.60);

    // ─── WHEELS (5-spoke alloys) ──────────────────────────────────────────────
    var tyreMat  = new THREE.MeshLambertMaterial({ color: C_DARK,   flatShading: true });
    var rimMat   = new THREE.MeshLambertMaterial({ color: 0xD0D0CC, flatShading: true });
    var spokeMat = new THREE.MeshLambertMaterial({ color: 0xAAAAAA, flatShading: true });
    var hubMat   = new THREE.MeshLambertMaterial({ color: C_RED,    flatShading: true });

    for (var i = 0; i < 4; i++) {
      var wGroup = new THREE.Group();

      // Tyre
      var tyreGeo  = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.34, 16);
      var tyreMesh = new THREE.Mesh(tyreGeo, tyreMat);
      tyreMesh.rotation.z = Math.PI / 2;
      wGroup.add(tyreMesh);

      // Tyre sidewall detail ring
      var swGeo = new THREE.CylinderGeometry(WHEEL_RADIUS - 0.02, WHEEL_RADIUS - 0.02, 0.36, 16);
      var sw = new THREE.Mesh(swGeo, new THREE.MeshLambertMaterial({ color: 0x2a2a2a, flatShading: true }));
      sw.rotation.z = Math.PI / 2;
      wGroup.add(sw);

      // Alloy rim face
      var rimGeo = new THREE.CylinderGeometry(0.30, 0.30, 0.28, 16);
      var rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.z = Math.PI / 2;
      wGroup.add(rim);

      // 5 spokes radiating from centre in Y-Z plane
      // (wheel axis is X after rotation.z = PI/2 on cylinder,
      //  so spokes rotate around X axis)
      for (var s = 0; s < 5; s++) {
        var angle = (s / 5) * Math.PI * 2;
        // Spoke as a thin box oriented vertically then rotated around X
        var spGeo = new THREE.BoxGeometry(0.26, 0.06, 0.06);
        var sp = new THREE.Mesh(spGeo, spokeMat);
        // Place spoke at radial offset in Y-Z, rotated around X
        sp.position.set(0, Math.sin(angle) * 0.14, Math.cos(angle) * 0.14);
        sp.rotation.x = angle;
        wGroup.add(sp);
      }

      // Hub cap (red centre)
      var hubGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.30, 8);
      var hub = new THREE.Mesh(hubGeo, hubMat);
      hub.rotation.z = Math.PI / 2;
      wGroup.add(hub);

      // Wheel nut ring
      var nutGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.32, 6);
      var nut = new THREE.Mesh(nutGeo, rimMat);
      nut.rotation.z = Math.PI / 2;
      wGroup.add(nut);

      wGroup.position.set(WHEEL_OFFSETS[i].x, WHEEL_REST_Y, WHEEL_OFFSETS[i].z);
      vehicleGroup.add(wGroup);
      wheels[i].group = wGroup;
      wheels[i].mesh  = tyreMesh;
    }

    scene.add(vehicleGroup);
  }

  // ── Damage helper ────────────────────────────────────────────────────────────
  function applyCarHit(impactSpeed, remoteId) {
    if (remoteId !== undefined) {
      var now = performance.now ? performance.now() / 1000 : Date.now() / 1000;
      if (hitCooldowns[remoteId] && now < hitCooldowns[remoteId]) return;
      hitCooldowns[remoteId] = now + HIT_COOLDOWN;
    }
    var damage = Math.min(impactSpeed * DAMAGE_PER_MS, 35);
    state.health      = Math.max(0, state.health - damage);
    state.isWrecked   = state.health <= 0;
    state.damageFlash = DAMAGE_FLASH_DURATION;
    state.impactTimer = PROP_IMPACT_DURATION;
    var vol = clamp(impactSpeed / 18, 0.2, 1.0);
    T2.Audio.playImpact(vol);
    if (T2.Effects && T2.Effects.spawnImpactBurst) {
      T2.Effects.spawnImpactBurst(
        { x: state.position.x, y: state.position.y + 0.3, z: state.position.z }, vol
      );
    }
    if (T2.Network && T2.Network.sendHit && remoteId !== undefined) {
      T2.Network.sendHit(remoteId, damage);
    }
  }

  // ── Suspension update ────────────────────────────────────────────────────────
  function updateSuspension(dt) {
    var yaw  = state.yaw;
    var cosY = Math.cos(yaw);
    var sinY = Math.sin(yaw);
    var pos  = state.position;

    for (var i = 0; i < 4; i++) {
      var wo = WHEEL_OFFSETS[i];
      var wx = wo.x * cosY + wo.z * sinY;
      var wz = -wo.x * sinY + wo.z * cosY;

      var worldWheelX = pos.x + wx;
      var worldWheelZ = pos.z + wz;
      var worldWheelY = pos.y + WHEEL_REST_Y - wheels[i].compressionY;

      var q       = T2.Terrain.query(worldWheelX, worldWheelZ);
      wheels[i].contactY = q.height;

      var currentLen = worldWheelY - WHEEL_RADIUS - wheels[i].contactY;
      wheels[i].currentCompression = Math.max(0, SPRING_REST - currentLen);
    }

    var ARB_FRONT = 35.0;
    var ARB_REAR  = 65.0;
    var rollFront = (wheels[0].currentCompression - wheels[1].currentCompression) * ARB_FRONT;
    var rollRear  = (wheels[2].currentCompression - wheels[3].currentCompression) * ARB_REAR;

    for (var i = 0; i < 4; i++) {
      if (wheels[i].currentCompression > 0) {
        var springForce = SPRING_K * wheels[i].currentCompression;

        if (wheels[i].currentCompression > 0.45) {
          springForce += (wheels[i].currentCompression - 0.45) * 800;
        }

        if (i === 0) springForce += rollFront;
        if (i === 1) springForce -= rollFront;
        if (i === 2) springForce += rollRear;
        if (i === 3) springForce -= rollRear;

        var isRebound    = wheels[i].velocity > 0;
        var currentDamper = isRebound ? SPRING_DAMPER * 1.5 : SPRING_DAMPER * 0.8;
        var damperForce  = currentDamper * wheels[i].velocity;

        var netForce    = springForce - damperForce;
        var accel       = netForce / WHEEL_MASS;

        wheels[i].velocity     += accel * dt;
        wheels[i].compressionY += wheels[i].velocity * dt;
        wheels[i].compressionY  = clamp(wheels[i].compressionY, -0.12, 0.50);
        wheels[i].isGrounded    = true;
        wheels[i].load          = Math.max(0, springForce);
      } else {
        wheels[i].velocity     -= 30 * dt;
        wheels[i].velocity      = Math.max(wheels[i].velocity, -4);
        wheels[i].compressionY += wheels[i].velocity * dt;
        wheels[i].compressionY  = clamp(wheels[i].compressionY, -0.12, 0.50);
        wheels[i].isGrounded    = false;
        wheels[i].load          = 0;
      }
      wheels[i].group.position.y = WHEEL_REST_Y - wheels[i].compressionY;
    }
  }

  // ── Rigid body update ────────────────────────────────────────────────────────
  function updateBody(dt) {
    var groundedCount = 0;
    for (var i = 0; i < 4; i++) {
      if (wheels[i].isGrounded) groundedCount++;
    }
    var isGrounded = groundedCount >= 2;
    state.isGrounded = isGrounded;

    var terrainQ = T2.Terrain.query(state.position.x, state.position.z);
    var friction = terrainQ.surfaceType.friction;
    state.surfaceType = terrainQ.surfaceType;

    var cFL = wheels[0].contactY, cFR = wheels[1].contactY;
    var cRL = wheels[2].contactY, cRR = wheels[3].contactY;
    var avgFront = (cFL + cFR) * 0.5;
    var avgRear  = (cRL + cRR) * 0.5;
    var avgLeft  = (cFL + cRL) * 0.5;
    var avgRight = (cFR + cRR) * 0.5;

    if (isGrounded) {
      state.pitch = lerp(state.pitch, Math.atan2(avgFront - avgRear, WHEELBASE), 8 * dt);
      state.roll  = lerp(state.roll,  Math.atan2(avgRight - avgLeft, 2.2),      8 * dt);
    } else {
      var pitchInput = (T2.Input.brake() ? 1 : 0) - (T2.Input.throttle() ? 1 : 0);
      var rollInput  = (T2.Input.steerRight() ? 1 : 0) - (T2.Input.steerLeft() ? 1 : 0);
      state.pitch += pitchInput * 1.5 * dt;
      state.roll  += rollInput * 2.5 * dt;
      state.pitch = lerp(state.pitch, 0, 0.5 * dt);
      state.roll  = lerp(state.roll, 0, 0.5 * dt);
    }

    if (!isGrounded) {
      state.velocity.y -= 9.81 * dt;
    } else {
      if (state.velocity.y < 0) state.velocity.y *= 0.3;
    }

    var cosY = Math.cos(state.yaw);
    var sinY = Math.sin(state.yaw);
    var fwdX = sinY, fwdZ = cosY;
    var rtX  = cosY, rtZ  = -sinY;

    state.localVelZ = state.velocity.x * fwdX + state.velocity.z * fwdZ;
    state.localVelX = state.velocity.x * rtX  + state.velocity.z * rtZ;
    state.speed     = Math.sqrt(
      state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z
    );

    var steerInput = 0;
    if (T2.Input.steerLeft())  steerInput = -1;
    if (T2.Input.steerRight()) steerInput =  1;
    var speedFactor    = 1.0 / (1.0 + Math.abs(state.speed) * 0.12);
    var targetSteer    = steerInput * MAX_STEER * speedFactor;
    state.currentSteer = lerp(state.currentSteer, targetSteer, 5 * dt);
    wheels[0].group.rotation.y = state.currentSteer;
    wheels[1].group.rotation.y = state.currentSteer;

    if (state.shiftTimer > 0) state.shiftTimer -= dt;
    var fwdSpeed = state.localVelZ;
    if (isGrounded && state.shiftTimer <= 0) {
      if (fwdSpeed > 0.3) {
        if (state.currentGear < NUM_GEARS - 1 && fwdSpeed > SHIFT_UP_SPEED[state.currentGear]) {
          state.currentGear++;
          state.shiftTimer = SHIFT_LOCKOUT;
        } else if (state.currentGear > 0 && fwdSpeed < SHIFT_DOWN_SPEED[state.currentGear - 1]) {
          state.currentGear--;
          state.shiftTimer = SHIFT_LOCKOUT * 0.5;
        }
      } else if (fwdSpeed < 0.5 && state.currentGear > 0) {
        state.currentGear = 0;
      }
    }

    var rpmLo = state.currentGear > 0 ? SHIFT_DOWN_SPEED[state.currentGear - 1] : 0;
    var rpmHi = state.currentGear < NUM_GEARS - 1 ? SHIFT_UP_SPEED[state.currentGear] : BASE_MAX_SPEED + 3;
    var rpmT  = clamp((Math.abs(fwdSpeed) - rpmLo) / Math.max(rpmHi - rpmLo, 0.1), 0, 1);
    var targetRPM = RPM_IDLE + (RPM_MAX - RPM_IDLE) * rpmT;

    var throttleInput = T2.Input.throttle() ? 1.0 : 0.0;

    if (throttleInput > 0 && state.tractionGrip < 0.95) {
      var slipRPM = (1.0 - state.tractionGrip) * (RPM_MAX - RPM_IDLE) * 0.5;
      targetRPM = Math.min(RPM_MAX, targetRPM + slipRPM);
    }

    var rpmDelta;
    if (throttleInput > 0) {
      rpmDelta = (targetRPM - state.engineRPM) * (1.0 / FLYWHEEL_INERTIA) * dt * throttleInput;
    } else {
      rpmDelta = (RPM_IDLE - state.engineRPM) * 3.0 * dt;
    }
    state.engineRPM = clamp(state.engineRPM + rpmDelta, RPM_IDLE, RPM_MAX);

    var MAX_SPEED   = BASE_MAX_SPEED * (0.5 + state.health / 200);
    var accelSign   = T2.Input.throttle() ? 1 : (T2.Input.brake() ? -1 : 0);
    var weightShift = accelSign * WEIGHT_TRANSFER * CAR_MASS * 9.81;
    var rearLoad    = Math.max(CAR_MASS * 9.81 * 0.5 + weightShift, 100);
    var frontLoad   = Math.max(CAR_MASS * 9.81 * 0.5 - weightShift, 100);

    var driveForce = 0;

    if (isGrounded) {
      if (T2.Input.throttle()) {
        var rpmNorm      = (state.engineRPM - RPM_IDLE) / (RPM_MAX - RPM_IDLE);
        var torqueFactor = sampleTorqueCurve(rpmNorm);
        var rawTorque    = PEAK_TORQUE_NM * torqueFactor * GEAR_RATIOS[state.currentGear];

        if (state.shiftTimer > 0) {
          rawTorque *= 0.2;
        }

        var requestedForce = rawTorque / WHEEL_RADIUS;
        var maxTyreForce   = MU_TYRE * rearLoad * friction;

        if (requestedForce <= maxTyreForce) {
          driveForce = requestedForce;
          state.tractionGrip = Math.min(1.0, state.tractionGrip + WHEELSPIN_BLEND * dt);
        } else {
          var gripRatio = maxTyreForce / requestedForce;
          state.tractionGrip = lerp(state.tractionGrip, gripRatio, WHEELSPIN_BLEND * dt);
          driveForce = requestedForce * state.tractionGrip;
        }

      } else if (T2.Input.brake()) {
        var brakeTorque    = PEAK_TORQUE_NM * 1.8;
        var requestedBrake = brakeTorque / WHEEL_RADIUS;
        var maxBrakeForce  = MU_TYRE * frontLoad * friction;
        if (state.localVelZ > 0.5) {
          driveForce = -Math.min(requestedBrake, maxBrakeForce);
        } else {
          driveForce = -(PEAK_TORQUE_NM * 0.7 * friction) / WHEEL_RADIUS;
        }
        state.tractionGrip = Math.min(1.0, state.tractionGrip + WHEELSPIN_BLEND * dt);

      } else {
        var engineBrakeForce = (state.engineRPM - RPM_IDLE) / (RPM_MAX - RPM_IDLE) * 800;
        if (Math.abs(fwdSpeed) > 0.3) {
          driveForce = -Math.sign(fwdSpeed) * engineBrakeForce * friction;
        }
        state.tractionGrip = Math.min(1.0, state.tractionGrip + WHEELSPIN_BLEND * dt);
      }
    }

    var driveAccel = driveForce / CAR_MASS;
    state.velocity.x += fwdX * driveAccel * dt;
    state.velocity.z += fwdZ * driveAccel * dt;

    var isHandbrake = T2.Input.handbrake();
    var slipRatio   = Math.abs(state.localVelX) / (Math.abs(state.localVelZ) + 1.0);
    var slideGripMult = 1.0 / (1.0 + Math.pow(slipRatio * 2.5, 2));
    var lateralBase   = isHandbrake ? 1.5 : 18.0;
    var lateralDamp   = friction * lateralBase * slideGripMult * dt;
    lateralDamp = clamp(lateralDamp, 0, 1);
    state.velocity.x -= rtX * state.localVelX * lateralDamp;
    state.velocity.z -= rtZ * state.localVelX * lateralDamp;

    if (state.speed > 0.05) {
      var drag = state.speed * state.speed * 0.025 + state.speed * friction * 0.28;
      if (state.surfaceType && state.surfaceType.name === 'DEEP WATER') {
        drag += state.speed * state.speed * 1.5 + state.speed * 4.0;
      } else if (state.surfaceType && state.surfaceType.name === 'WATER') {
        drag += state.speed * state.speed * 0.6 + state.speed * 1.5;
      }
      var dragDecel = drag / CAR_MASS;
      var invSpeed  = 1 / state.speed;
      state.velocity.x -= state.velocity.x * invSpeed * dragDecel * dt;
      state.velocity.z -= state.velocity.z * invSpeed * dragDecel * dt;
    }

    if (isGrounded && Math.abs(state.localVelZ) > 0.4) {
      var steerSign     = state.localVelZ > 0 ? 1 : -1;
      var targetYawRate = (state.localVelZ * Math.tan(state.currentSteer) / WHEELBASE) * steerSign;
      state.yawRate = lerp(state.yawRate, targetYawRate, 5 * dt);
    } else {
      state.yawRate *= Math.pow(0.1, dt);
    }
    state.yaw += state.yawRate * dt;

    var horizSpeed = Math.sqrt(
      state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z
    );
    if (horizSpeed > MAX_SPEED) {
      var scale = MAX_SPEED / horizSpeed;
      state.velocity.x *= scale;
      state.velocity.z *= scale;
    }

    state.position.x += state.velocity.x * dt;
    state.position.y += state.velocity.y * dt;
    state.position.z += state.velocity.z * dt;

    var groundedWheels = 0;
    var minContactY    = Infinity;
    for (var gi = 0; gi < 4; gi++) {
      if (wheels[gi].isGrounded) {
        if (wheels[gi].contactY < minContactY) minContactY = wheels[gi].contactY;
        groundedWheels++;
      }
    }
    if (groundedWheels > 0) {
      var wheelFloor = minContactY + WHEEL_RADIUS + 0.55;
      if (state.position.y < wheelFloor) {
        state.position.y = wheelFloor;
        if (state.velocity.y < 0) state.velocity.y = 0;
      }
    } else {
      var AIRBORNE_THRESHOLD = 0.25;
      var yawA  = state.yaw;
      var cosA  = Math.cos(yawA);
      var sinA  = Math.sin(yawA);
      var lowestWheelGround = Infinity;
      for (var ai = 0; ai < 4; ai++) {
        var awo = WHEEL_OFFSETS[ai];
        var awx = awo.x * cosA + awo.z * sinA;
        var awz = -awo.x * sinA + awo.z * cosA;
        var aqh = T2.Terrain.query(state.position.x + awx, state.position.z + awz).height;
        if (aqh < lowestWheelGround) lowestWheelGround = aqh;
      }
      var airborneFloor = lowestWheelGround + WHEEL_RADIUS + 0.30;
      if (state.position.y < airborneFloor - AIRBORNE_THRESHOLD) {
        state.position.y = airborneFloor;
        if (state.velocity.y < 0) state.velocity.y = 0;
      }
    }

    var propColliders = T2.Props.getColliders();
    for (var pi = 0; pi < propColliders.length; pi++) {
      var pc  = propColliders[pi];
      var pdx = state.position.x - pc.x;
      var pdz = state.position.z - pc.z;
      var d2  = pdx * pdx + pdz * pdz;
      var minD = CAR_COLLISION_RADIUS + pc.radius;
      if (d2 < minD * minD && d2 > 0.0001) {
        var d   = Math.sqrt(d2);
        var nx  = pdx / d;
        var nz  = pdz / d;
        state.position.x += nx * (minD - d);
        state.position.z += nz * (minD - d);
        var dot = state.velocity.x * nx + state.velocity.z * nz;
        if (dot < 0) {
          var restitution = 0.30;
          state.velocity.x -= (1 + restitution) * dot * nx;
          state.velocity.z -= (1 + restitution) * dot * nz;
          state.velocity.x *= 0.72;
          state.velocity.z *= 0.72;
          if (Math.abs(dot) > 0.8) {
            T2.Audio.playImpact(Math.min(Math.abs(dot) / 18, 1));
            state.impactTimer = PROP_IMPACT_DURATION;
          }
        }
        break;
      }
    }

    if (T2.Multiplayer && T2.Multiplayer.getColliders) {
      var carColliders = T2.Multiplayer.getColliders();
      for (var ci = 0; ci < carColliders.length; ci++) {
        var cc   = carColliders[ci];
        var cdx  = state.position.x - cc.x;
        var cdz  = state.position.z - cc.z;
        var cd2  = cdx * cdx + cdz * cdz;
        var cMinD = CAR_COLLISION_RADIUS + cc.radius;
        if (cd2 < cMinD * cMinD && cd2 > 0.0001) {
          var cd  = Math.sqrt(cd2);
          var cnx = cdx / cd;
          var cnz = cdz / cd;
          state.position.x += cnx * (cMinD - cd) * 0.5;
          state.position.z += cnz * (cMinD - cd) * 0.5;
          var cdot = state.velocity.x * cnx + state.velocity.z * cnz;
          if (cdot < 0) {
            var cRestitution = 0.25;
            state.velocity.x -= (1 + cRestitution) * cdot * cnx;
            state.velocity.z -= (1 + cRestitution) * cdot * cnz;
            state.velocity.x *= 0.78;
            state.velocity.z *= 0.78;
            if (Math.abs(cdot) > 1.5) applyCarHit(Math.abs(cdot), cc.id);
          }
          break;
        }
      }
    }

    if (state.impactTimer > 0) { state.impactTimer -= dt; if (state.impactTimer < 0) state.impactTimer = 0; }
    if (state.damageFlash > 0) { state.damageFlash -= dt; if (state.damageFlash < 0) state.damageFlash = 0; }

    state.position.x = clamp(state.position.x, -504, 504);
    state.position.z = clamp(state.position.z, -504, 504);

    var absRoll = Math.abs(state.roll);
    if (absRoll > 1.3) { state.flipTimer += dt; state.isFlipped = true; }
    else               { state.flipTimer = 0;   state.isFlipped = false; }

    if (T2.Input.isDown('KeyR')) {
      var groundAtReset = T2.Terrain.query(state.position.x, state.position.z).height;
      state.position.y  = groundAtReset + 2.5;
      state.velocity.set(0, 0, 0);
      state.yawRate      = 0;
      state.pitch        = 0;
      state.roll         = 0;
      state.flipTimer    = 0;
      state.isFlipped    = false;
      state.currentSteer = 0;
      state.currentGear  = 0;
      state.shiftTimer   = 0;
      state.engineRPM    = RPM_IDLE;
      state.tractionGrip = 1.0;
      state.health       = 100;
      state.damageFlash  = 0;
      state.isWrecked    = false;
      hitCooldowns       = {};
      for (var j = 0; j < 4; j++) {
        wheels[j].velocity     = 0;
        wheels[j].compressionY = 0;
        wheels[j].load         = 0;
      }
    }
  }

  // ── Winch spring force ───────────────────────────────────────────────────────
  function applyWinchForces(dt) {
    if (!winchState.active) return;
    var players = (T2.Multiplayer && T2.Multiplayer.getPlayers) ? T2.Multiplayer.getPlayers() : {};
    var target  = players[winchState.targetId];
    if (!target) {
      winchState.active   = false;
      winchState.targetId = null;
      return;
    }

    var dx   = target.position.x - state.position.x;
    var dy   = target.position.y - state.position.y;
    var dz   = target.position.z - state.position.z;
    var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist > winchState.restLength) {
      var k     = 800.0;
      var force = (dist - winchState.restLength) * k;
      state.velocity.x += (dx / dist) * force * dt / CAR_MASS;
      state.velocity.y += (dy / dist) * force * dt / CAR_MASS;
      state.velocity.z += (dz / dist) * force * dt / CAR_MASS;
    }
  }

  // ── Wheel spin visuals ───────────────────────────────────────────────────────
  function updateWheelSpin(dt) {
    var spinDelta = state.localVelZ * dt / WHEEL_RADIUS;
    for (var i = 0; i < 4; i++) {
      wheels[i].spinAngle += spinDelta;
      wheels[i].mesh.rotation.z = Math.PI / 2;
      wheels[i].mesh.rotation.x = wheels[i].spinAngle;
    }
  }

  // ── Apply state to Three.js scene graph ─────────────────────────────────────
  function applyToScene() {
    vehicleGroup.position.copy(state.position);
    vehicleGroup.rotation.set(state.pitch, state.yaw, state.roll, 'YXZ');

    if (state.impactTimer > 0) {
      var tf     = state.impactTimer / PROP_IMPACT_DURATION;
      var squash = 1.0 - 0.22 * (tf * tf);
      vehicleGroup.scale.set(1, squash, 1);
    } else {
      vehicleGroup.scale.set(1, 1, 1);
    }

    // ── Body colour: white livery with orange flash on hit, grey on damage ─────
    if (bodyColorMeshes.length > 0) {
      var r, g, b;
      if (state.damageFlash > 0) {
        // Flash from orange (hit) back to white
        var t = state.damageFlash / DAMAGE_FLASH_DURATION;
        r = lerp(BODY_BASE_R, 1.00, t);
        g = lerp(BODY_BASE_G, 0.40, t);
        b = lerp(BODY_BASE_B, 0.00, t);
      } else if (state.health < 40) {
        // Gradually darken toward charred grey as health drops
        var dmgT = (40 - state.health) / 40;
        r = lerp(BODY_BASE_R, 0.22, dmgT);
        g = lerp(BODY_BASE_G, 0.20, dmgT);
        b = lerp(BODY_BASE_B, 0.18, dmgT);
      } else {
        r = BODY_BASE_R;
        g = BODY_BASE_G;
        b = BODY_BASE_B;
      }
      for (var mi = 0; mi < bodyColorMeshes.length; mi++) {
        bodyColorMeshes[mi].material.color.setRGB(r, g, b);
      }
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  return {
    init: function (scene, spawnPos) {
      buildMesh(scene);
      state.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
      vehicleGroup.position.copy(state.position);
    },

    tick: function (dt) {
      updateSuspension(dt);
      updateBody(dt);
      applyWinchForces(dt);
      updateWheelSpin(dt);
      applyToScene();
    },

    getState:      function () { return state; },
    getGroup:      function () { return vehicleGroup; },
    getWinchState: function () { return winchState; },

    toggleWinch: function () {
      if (winchState.active) {
        winchState.active   = false;
        winchState.targetId = null;
        console.log('Winch detached');
      } else {
        var players     = (T2.Multiplayer && T2.Multiplayer.getPlayers) ? T2.Multiplayer.getPlayers() : {};
        var closestDist = 20.0;
        var closestId   = null;

        for (var wid in players) {
          var wp  = players[wid];
          var wdx = wp.position.x - state.position.x;
          var wdz = wp.position.z - state.position.z;
          var wd  = Math.sqrt(wdx * wdx + wdz * wdz);
          if (wd < closestDist) {
            closestDist = wd;
            closestId   = wid;
          }
        }

        if (closestId) {
          winchState.active   = true;
          winchState.targetId = closestId;
          console.log('Winch attached to player ' + closestId);
        }
      }
    },

    applyRemoteDamage: function (damage) {
      state.health     = Math.max(0, state.health - damage);
      state.isWrecked  = state.health <= 0;
      state.damageFlash = DAMAGE_FLASH_DURATION;
      state.impactTimer = PROP_IMPACT_DURATION;
      T2.Audio.playImpact(clamp(damage / 35, 0.2, 1.0));
      if (T2.Effects && T2.Effects.spawnImpactBurst) {
        T2.Effects.spawnImpactBurst(
          { x: state.position.x, y: state.position.y + 0.3, z: state.position.z },
          clamp(damage / 35, 0.2, 1.0)
        );
      }
    },
  };

})();
