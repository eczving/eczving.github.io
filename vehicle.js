'use strict';
window.T2 = window.T2 || {};

// Vehicle physics and 3D mesh.
// Spring-mass suspension (4 wheels) + simplified bicycle-model rigid body.
// All physics in SI-ish units (world units ≈ metres, dt in seconds).
//
// PHYSICS IMPROVEMENTS:
//  - Terrain grounding: car floor is clamped per-wheel, not at body centre.
//    Eliminates the "sucked into terrain" bug on slopes and rough ground.
//  - Engine torque curve: torque peaks at mid-RPM, drops at redline.
//    Replaces the flat multiplier that gave Mario Kart-style instant acceleration.
//  - Flywheel inertia: RPM ramps up/down realistically; releasing throttle
//    lets RPM fall, engine-braking kicks in.
//  - Traction / slip model: drive force is gated by a slip ratio. Spinning
//    wheels lose traction; grip is terrain-surface dependent.
//  - Weight transfer: braking loads the front, acceleration loads the rear.
//    Front/rear grip split changes dynamically.
//  - Speed-sensitive steering: already present, coefficients tightened.
//  - Airborne: car can now leave the ground when cresting terrain at speed.
//    The airborne floor uses the lowest wheel-position terrain sample, not
//    the body centre, so the floor drops away behind a crest instead of
//    chasing the car upward. A 0.25 m penetration threshold prevents
//    floating-point jitter from snapping the car back on flat ground.
//
// DAMAGE MODEL (unchanged):
//  - state.health (0-100): drains on car-vs-car collisions, proportional to
//    impact speed. No health bar — you feel it in the handling.
//  - Speed is capped at MAX_SPEED * (0.5 + health/200) so a fully-wrecked
//    car limps at ~50% of normal top speed.
//  - Visual feedback: brief orange body-tint (damageFlash) + squash animation.
//  - R-reset restores health to 100 (old-school respawn).
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

  // Suspension — stiffer spring, more damping for off-road feel
  var SPRING_K            = 80;      // was 55 — firmer for terrain responsiveness
  var SPRING_DAMPER       = 10;      // was 7
  var SPRING_REST         = 0.5;
  var WHEEL_MASS          = 40;

  var MAX_STEER           = 0.50;    // radians (~28°)
  var CAR_COLLISION_RADIUS = 1.4;

  // ── Gearbox ─────────────────────────────────────────────────────────────────
  var NUM_GEARS        = 5;
  var RPM_IDLE         = 850;
  var RPM_MAX          = 6200;
  var GEAR_RATIOS      = [1.65, 1.28, 1.00, 0.80, 0.65]; // torque multipliers
  var SHIFT_UP_SPEED   = [5.5, 10.0, 15.5, 21.0];
  var SHIFT_DOWN_SPEED = [3.2,  7.5, 12.0, 17.5];
  var SHIFT_LOCKOUT    = 0.55;

  // ── Engine torque curve ─────────────────────────────────────────────────────
  // Sampled at 0, 20, 40, 60, 80, 100% of RPM band.
  // Values are multipliers on peak torque (1.0 = peak).
  // Shape: builds from idle, peaks around 55% RPM, drops off at redline.
  var TORQUE_CURVE     = [0.55, 0.78, 0.95, 1.00, 0.88, 0.65];
  var PEAK_TORQUE_NM   = 280;    // Nm at peak (realistic for a 1.4t off-roader)
  var FLYWHEEL_INERTIA = 0.22;   // kg·m² — controls how fast RPM climbs

  // ── Traction model ──────────────────────────────────────────────────────────
  // Maximum slip ratio before traction drops sharply (0.10 = 10%)
  var SLIP_THRESHOLD   = 0.12;
  // Drive wheels: rear-wheel drive (indices 2, 3)
  var DRIVE_WHEELS     = [2, 3];
  // Weight transfer coefficient: how much of braking/accel load shifts
  var WEIGHT_TRANSFER  = 0.18;   // fraction of Mg that shifts front↔rear

  // ── Damage constants ─────────────────────────────────────────────────────────
  var PROP_IMPACT_DURATION   = 0.22;
  var DAMAGE_FLASH_DURATION  = 0.30;
  var HIT_COOLDOWN           = 0.18;
  var DAMAGE_PER_MS          = 4.2;

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
    isFlipped:    false,
    flipTimer:    0,
    currentSteer: 0,
    impactTimer:  0,
    currentGear:  0,
    shiftTimer:   0,
    engineRPM:    RPM_IDLE,
    // Traction state
    wheelSlipFL:  0,
    wheelSlipFR:  0,
    wheelSlipRL:  0,
    wheelSlipRR:  0,
    // Damage
    health:       100,
    damageFlash:  0,
    isWrecked:    false,
  };

  var hitCooldowns = {};

  // Per-wheel suspension state
  var wheels = [];
  for (var wi = 0; wi < 4; wi++) {
    wheels.push({
      compressionY: 0,
      velocity:     0,
      isGrounded:   false,
      spinAngle:    0,
      steerAngle:   0,
      contactY:     0,
      load:         0,    // vertical load on this wheel (N)
      group:        null,
      mesh:         null,
    });
  }

  var vehicleGroup = null;
  var bodyMeshRef  = null;

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t)    { return a + (b - a) * t; }

  // Sample the engine torque curve for a given RPM (0-1 normalised)
  function sampleTorqueCurve(rpmNorm) {
    rpmNorm = clamp(rpmNorm, 0, 1);
    var idx = rpmNorm * (TORQUE_CURVE.length - 1);
    var lo  = Math.floor(idx);
    var hi  = Math.min(lo + 1, TORQUE_CURVE.length - 1);
    var t   = idx - lo;
    return TORQUE_CURVE[lo] * (1 - t) + TORQUE_CURVE[hi] * t;
  }

  function makeMaterial(hex) {
    return new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
  }

  // ── Mesh construction ────────────────────────────────────────────────────────
  function buildMesh(scene) {
    vehicleGroup = new THREE.Group();

    var bodyGeo  = new THREE.BoxGeometry(2.2, 0.6, 4.2);
    var bodyMat  = makeMaterial(0xc83820);
    var bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.y = 0;
    vehicleGroup.add(bodyMesh);
    bodyMeshRef = bodyMesh;

    var cabinGeo  = new THREE.BoxGeometry(1.8, 0.7, 2.2);
    var cabinMesh = new THREE.Mesh(cabinGeo, makeMaterial(0xa02810));
    cabinMesh.position.set(0, 0.65, -0.25);
    vehicleGroup.add(cabinMesh);

    var bGeo    = new THREE.BoxGeometry(2.3, 0.28, 0.32);
    var bumperF = new THREE.Mesh(bGeo, makeMaterial(0x282828));
    bumperF.position.set(0, -0.1, 2.28);
    vehicleGroup.add(bumperF);

    var bumperR = new THREE.Mesh(bGeo, makeMaterial(0x282828));
    bumperR.position.set(0, -0.1, -2.28);
    vehicleGroup.add(bumperR);

    var rackGeo  = new THREE.BoxGeometry(1.6, 0.08, 1.8);
    var rackMesh = new THREE.Mesh(rackGeo, makeMaterial(0x181818));
    rackMesh.position.set(0, 1.04, -0.25);
    vehicleGroup.add(rackMesh);

    var tyreMat = makeMaterial(0x1a1a1a);
    var hubMat  = makeMaterial(0x707070);

    for (var i = 0; i < 4; i++) {
      var wGroup   = new THREE.Group();
      var tyreGeo  = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.32, 12);
      var tyreMesh = new THREE.Mesh(tyreGeo, tyreMat);
      tyreMesh.rotation.z = Math.PI / 2;
      wGroup.add(tyreMesh);

      var hubGeo  = new THREE.CylinderGeometry(0.18, 0.18, 0.34, 6);
      var hubMesh = new THREE.Mesh(hubGeo, hubMat);
      hubMesh.rotation.z = Math.PI / 2;
      wGroup.add(hubMesh);

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
        { x: state.position.x, y: state.position.y + 0.3, z: state.position.z },
        vol
      );
    }

    if (T2.Network && T2.Network.sendHit && remoteId !== undefined) {
      T2.Network.sendHit(remoteId, damage);
    }
  }

  // ── Suspension update ────────────────────────────────────────────────────────
  function updateSuspension(dt) {
    var totalUpForce = 0;
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
      var groundY = q.height;
      wheels[i].contactY = groundY;

      var currentLen = worldWheelY - WHEEL_RADIUS - groundY;

      if (currentLen < SPRING_REST) {
        var compression = SPRING_REST - currentLen;
        var springForce = SPRING_K * compression;
        var damperForce = SPRING_DAMPER * wheels[i].velocity;
        var netForce    = springForce - damperForce;
        var accel       = netForce / WHEEL_MASS;

        wheels[i].velocity     += accel * dt;
        wheels[i].compressionY += wheels[i].velocity * dt;
        wheels[i].compressionY  = clamp(wheels[i].compressionY, -0.12, 0.50);
        wheels[i].isGrounded    = true;
        wheels[i].load          = springForce;
        totalUpForce           += springForce;
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

    return totalUpForce;
  }

  // ── Rigid body update ────────────────────────────────────────────────────────
  function updateBody(dt) {
    var groundedCount = 0;
    for (var i = 0; i < 4; i++) {
      if (wheels[i].isGrounded) groundedCount++;
    }
    var isGrounded = groundedCount >= 2;

    var terrainQ = T2.Terrain.query(state.position.x, state.position.z);
    var friction = terrainQ.surfaceType.friction;
    state.surfaceType = terrainQ.surfaceType;

    // ── Pitch / roll from terrain ─────────────────────────────────────────────
    var cFL = wheels[0].contactY, cFR = wheels[1].contactY;
    var cRL = wheels[2].contactY, cRR = wheels[3].contactY;
    var avgFront  = (cFL + cFR) * 0.5;
    var avgRear   = (cRL + cRR) * 0.5;
    var avgLeft   = (cFL + cRL) * 0.5;
    var avgRight  = (cFR + cRR) * 0.5;
    var targetPitch = Math.atan2(avgFront - avgRear, WHEELBASE);
    var targetRoll  = Math.atan2(avgRight - avgLeft, 2.2);
    state.pitch = lerp(state.pitch, targetPitch, 8 * dt);
    state.roll  = lerp(state.roll,  targetRoll,  8 * dt);

    // ── Gravity ───────────────────────────────────────────────────────────────
    if (!isGrounded) {
      state.velocity.y -= 9.81 * dt;
    } else {
      if (state.velocity.y < 0) state.velocity.y *= 0.3;
    }

    // ── Local velocity decomposition ──────────────────────────────────────────
    var cosY = Math.cos(state.yaw);
    var sinY = Math.sin(state.yaw);
    var fwdX = sinY, fwdZ = cosY;
    var rtX  = cosY, rtZ  = -sinY;

    state.localVelZ = state.velocity.x * fwdX + state.velocity.z * fwdZ;
    state.localVelX = state.velocity.x * rtX  + state.velocity.z * rtZ;
    state.speed     = Math.sqrt(
      state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z
    );

    // ── Steering (speed-sensitive, tighter ratio than before) ─────────────────
    var steerInput = 0;
    if (T2.Input.steerLeft())  steerInput = -1;
    if (T2.Input.steerRight()) steerInput =  1;
    // Exponential falloff: aggressive at low speed, precise at high
    var speedFactor    = 1.0 / (1.0 + Math.abs(state.speed) * 0.12);
    var targetSteer    = steerInput * MAX_STEER * speedFactor;
    state.currentSteer = lerp(state.currentSteer, targetSteer, 5 * dt);
    wheels[0].group.rotation.y = state.currentSteer;
    wheels[1].group.rotation.y = state.currentSteer;

    // ── Gearbox ───────────────────────────────────────────────────────────────
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

    // ── Engine RPM with flywheel inertia ──────────────────────────────────────
    // Target RPM based on vehicle speed in current gear band
    var rpmLo = state.currentGear > 0 ? SHIFT_DOWN_SPEED[state.currentGear - 1] : 0;
    var rpmHi = state.currentGear < NUM_GEARS - 1 ? SHIFT_UP_SPEED[state.currentGear] : BASE_MAX_SPEED + 3;
    var rpmT  = clamp((Math.abs(fwdSpeed) - rpmLo) / Math.max(rpmHi - rpmLo, 0.1), 0, 1);
    var targetRPM = RPM_IDLE + (RPM_MAX - RPM_IDLE) * rpmT;

    // Throttle lifts RPM toward target; releasing throttle drops it back
    var throttleInput = T2.Input.throttle() ? 1.0 : 0.0;
    var rpmDelta;
    if (throttleInput > 0) {
      // Climb toward target RPM, limited by flywheel inertia
      rpmDelta = (targetRPM - state.engineRPM) * (1.0 / FLYWHEEL_INERTIA) * dt * throttleInput;
    } else {
      // Engine brake: RPM falls toward idle when off throttle
      rpmDelta = (RPM_IDLE - state.engineRPM) * 3.0 * dt;
    }
    state.engineRPM = clamp(state.engineRPM + rpmDelta, RPM_IDLE, RPM_MAX);

    // ── Drive force via torque curve + traction ───────────────────────────────
    var MAX_SPEED = BASE_MAX_SPEED * (0.5 + state.health / 200);

    // Weight transfer: under braking front wheels get more load, rear less.
    // Under acceleration the opposite. This affects available traction.
    var accelSign   = T2.Input.throttle() ? 1 : (T2.Input.brake() ? -1 : 0);
    var weightShift = accelSign * WEIGHT_TRANSFER * CAR_MASS * 9.81;
    // Front axle load (per wheel), rear axle load (per wheel)
    var baseFrontLoad = CAR_MASS * 9.81 * 0.5 * 0.5;   // 50% front/rear, 2 wheels
    var baseRearLoad  = CAR_MASS * 9.81 * 0.5 * 0.5;
    var frontLoad = baseFrontLoad - weightShift * 0.5;
    var rearLoad  = baseRearLoad  + weightShift * 0.5;
    frontLoad = Math.max(frontLoad, 50);
    rearLoad  = Math.max(rearLoad,  50);

    var driveForce = 0;
    if (isGrounded) {
      if (T2.Input.throttle()) {
        // Torque curve: look up normalised RPM
        var rpmNorm     = (state.engineRPM - RPM_IDLE) / (RPM_MAX - RPM_IDLE);
        var torqueFactor = sampleTorqueCurve(rpmNorm);
        var rawTorque   = PEAK_TORQUE_NM * torqueFactor * GEAR_RATIOS[state.currentGear];

        // Traction: slip ratio = (wheel_surface_speed - car_speed) / car_speed
        // If wheel spins faster than the car, traction drops
        var wheelSurfSpeed = state.engineRPM / RPM_MAX * MAX_SPEED;
        var carSpd         = Math.max(Math.abs(fwdSpeed), 0.5);
        var slipRatio      = Math.abs(wheelSurfSpeed - carSpd) / carSpd;
        var tractionGrip   = slipRatio < SLIP_THRESHOLD
          ? 1.0
          : clamp(1.0 - (slipRatio - SLIP_THRESHOLD) * 4.0, 0.15, 1.0);

        // RWD: only rear wheels provide drive, weighted by rear load
        var rearTractionLoad = rearLoad / (CAR_MASS * 9.81 * 0.25);
        driveForce = rawTorque / WHEEL_RADIUS * friction * tractionGrip
                   * clamp(rearTractionLoad, 0.3, 1.5);

      } else if (T2.Input.brake()) {
        // Braking force uses front-biased weight transfer (front biased 70/30)
        if (state.localVelZ > 0.5) {
          driveForce = -PEAK_TORQUE_NM * 1.8 * friction
                     * clamp(frontLoad / (CAR_MASS * 9.81 * 0.25), 0.5, 1.5) / WHEEL_RADIUS;
        } else {
          // Reverse: limited torque
          driveForce = -PEAK_TORQUE_NM * 0.7 * friction / WHEEL_RADIUS;
        }
      } else {
        // Engine brake when coasting — gentle deceleration matching RPM drop
        var engineBrakeForce = (state.engineRPM - RPM_IDLE) / (RPM_MAX - RPM_IDLE) * 800;
        if (Math.abs(fwdSpeed) > 0.3) {
          driveForce = -Math.sign(fwdSpeed) * engineBrakeForce * friction;
        }
      }
    }

    var driveAccel = driveForce / CAR_MASS;
    state.velocity.x += fwdX * driveAccel * dt;
    state.velocity.z += fwdZ * driveAccel * dt;

    // ── Lateral damping (tyre grip) ───────────────────────────────────────────
    var isHandbrake = T2.Input.handbrake();
    var lateralDamp = isHandbrake ? friction * 1.5 * dt : friction * 14 * dt;
    lateralDamp     = clamp(lateralDamp, 0, 1);
    state.velocity.x -= rtX * state.localVelX * lateralDamp;
    state.velocity.z -= rtZ * state.localVelX * lateralDamp;

    // ── Aerodynamic drag + rolling resistance ─────────────────────────────────
    if (state.speed > 0.05) {
      // Aero drag scales quadratically; rolling resistance scales linearly
      var drag      = state.speed * state.speed * 0.025 + state.speed * friction * 0.28;
      var dragDecel = drag / CAR_MASS;
      var invSpeed  = 1 / state.speed;
      state.velocity.x -= state.velocity.x * invSpeed * dragDecel * dt;
      state.velocity.z -= state.velocity.z * invSpeed * dragDecel * dt;
    }

    // ── Yaw rate (bicycle model) ──────────────────────────────────────────────
    if (isGrounded && Math.abs(state.localVelZ) > 0.4) {
      var steerSign     = state.localVelZ > 0 ? 1 : -1;
      var targetYawRate = (state.localVelZ * Math.tan(state.currentSteer) / WHEELBASE) * steerSign;
      state.yawRate = lerp(state.yawRate, targetYawRate, 5 * dt);
    } else {
      state.yawRate *= Math.pow(0.1, dt);
    }
    state.yaw += state.yawRate * dt;

    // ── Speed cap ─────────────────────────────────────────────────────────────
    var horizSpeed = Math.sqrt(
      state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z
    );
    if (horizSpeed > MAX_SPEED) {
      var scale = MAX_SPEED / horizSpeed;
      state.velocity.x *= scale;
      state.velocity.z *= scale;
    }

    // ── Integrate position ────────────────────────────────────────────────────
    state.position.x += state.velocity.x * dt;
    state.position.y += state.velocity.y * dt;
    state.position.z += state.velocity.z * dt;

    // ── Terrain grounding — per-wheel, not body centre ────────────────────────
    // Compute the average contact height of all grounded wheels and enforce
    // that the body sits at least that high. This is what prevents the car
    // from sinking into the mesh on slopes where the centre-of-car sample
    // is lower than where the wheels actually touch.
    var groundedWheels = 0;
    var avgContactY    = 0;
    var minContactY    = Infinity;
    for (var gi = 0; gi < 4; gi++) {
      if (wheels[gi].isGrounded) {
        avgContactY += wheels[gi].contactY;
        if (wheels[gi].contactY < minContactY) minContactY = wheels[gi].contactY;
        groundedWheels++;
      }
    }
    if (groundedWheels > 0) {
      avgContactY /= groundedWheels;
      // Body floor is at position.y - 0.6 (half body height).
      // We want the lowest grounded wheel contact + WHEEL_RADIUS to be the floor.
      var wheelFloor = minContactY + WHEEL_RADIUS + 0.55;
      if (state.position.y < wheelFloor) {
        state.position.y = wheelFloor;
        if (state.velocity.y < 0) state.velocity.y = 0;
      }
    } else {
      // ── Airborne — car has no grounded wheels ────────────────────────────────
      // Use the LOWEST terrain height sampled at all four wheel world positions
      // (not the body centre). On a hill crest the wheels have already passed
      // the peak, so their samples will be lower than the crest itself.
      // This means the floor drops away behind the car and does not chase it
      // upward, allowing the car to naturally leave the ground.
      //
      // The floor only fires when the car has genuinely penetrated the terrain
      // by more than AIRBORNE_PENETRATION_THRESHOLD metres. This prevents
      // floating-point noise on flat ground from snapping the car back every
      // tick, while still catching a real fall-through.
      var AIRBORNE_PENETRATION_THRESHOLD = 0.25;

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

      // Absolute floor: body bottom must not go below the lowest wheel ground
      // minus a small buffer (wheel radius + body half-height).
      var airborneFloor = lowestWheelGround + WHEEL_RADIUS + 0.30;
      if (state.position.y < airborneFloor - AIRBORNE_PENETRATION_THRESHOLD) {
        state.position.y = airborneFloor;
        if (state.velocity.y < 0) state.velocity.y = 0;
      }
    }

    // ── Prop collision ─────────────────────────────────────────────────────────
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
        var overlap = minD - d;
        state.position.x += nx * overlap;
        state.position.z += nz * overlap;
        var dot = state.velocity.x * nx + state.velocity.z * nz;
        if (dot < 0) {
          var restitution = 0.30;
          state.velocity.x -= (1 + restitution) * dot * nx;
          state.velocity.z -= (1 + restitution) * dot * nz;
          state.velocity.x *= 0.72;
          state.velocity.z *= 0.72;
          var impactSpeed = Math.abs(dot);
          if (impactSpeed > 0.8) {
            T2.Audio.playImpact(Math.min(impactSpeed / 18, 1));
            state.impactTimer = PROP_IMPACT_DURATION;
          }
        }
        break;
      }
    }

    // ── Car-vs-car collision ───────────────────────────────────────────────────
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
          var coverlap = cMinD - cd;
          state.position.x += cnx * coverlap * 0.5;
          state.position.z += cnz * coverlap * 0.5;
          var cdot = state.velocity.x * cnx + state.velocity.z * cnz;
          if (cdot < 0) {
            var cRestitution = 0.25;
            state.velocity.x -= (1 + cRestitution) * cdot * cnx;
            state.velocity.z -= (1 + cRestitution) * cdot * cnz;
            state.velocity.x *= 0.78;
            state.velocity.z *= 0.78;
            var cImpact = Math.abs(cdot);
            if (cImpact > 1.5) {
              applyCarHit(cImpact, cc.id);
            }
          }
          break;
        }
      }
    }

    // ── Timers ────────────────────────────────────────────────────────────────
    if (state.impactTimer > 0) {
      state.impactTimer -= dt;
      if (state.impactTimer < 0) state.impactTimer = 0;
    }
    if (state.damageFlash > 0) {
      state.damageFlash -= dt;
      if (state.damageFlash < 0) state.damageFlash = 0;
    }

    state.position.x = clamp(state.position.x, -504, 504);
    state.position.z = clamp(state.position.z, -504, 504);

    var absRoll = Math.abs(state.roll);
    if (absRoll > 1.3) {
      state.flipTimer += dt;
      state.isFlipped = true;
    } else {
      state.flipTimer = 0;
      state.isFlipped = false;
    }

    // ── Reset (R) ─────────────────────────────────────────────────────────────
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

    if (bodyMeshRef) {
      if (state.damageFlash > 0) {
        var t   = state.damageFlash / DAMAGE_FLASH_DURATION;
        var r = Math.round(lerp(0xc8, 0xff, t));
        var g = Math.round(lerp(0x38, 0x88, t));
        var b = Math.round(lerp(0x20, 0x00, t));
        bodyMeshRef.material.color.setRGB(r / 255, g / 255, b / 255);
      } else {
        if (state.health < 40) {
          var dmgT = (40 - state.health) / 40;
          var dr   = Math.round(lerp(0xc8, 0x60, dmgT));
          var dg   = Math.round(lerp(0x38, 0x10, dmgT));
          var db   = Math.round(lerp(0x20, 0x08, dmgT));
          bodyMeshRef.material.color.setRGB(dr / 255, dg / 255, db / 255);
        } else {
          bodyMeshRef.material.color.setHex(0xc83820);
        }
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
      updateWheelSpin(dt);
      applyToScene();
    },

    getState:  function () { return state; },
    getGroup:  function () { return vehicleGroup; },

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
