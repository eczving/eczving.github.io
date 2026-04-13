'use strict';
window.T2 = window.T2 || {};

// Orchestrator: initialises Three.js, wires up all modules, runs the game loop.
T2.Main = (function () {

  var renderer, scene, camera;
  var lastTime  = null;
  var started   = false;
  var cableLine = null;

  // ── Three.js scene setup ────────────────────────────────────────────────────
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: false });  // false = retro pixelated look
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = false;
    renderer.setClearColor(0x7090b8);  // sky blue

    // Insert Three.js canvas before the HUD canvas
    document.body.insertBefore(renderer.domElement, document.body.firstChild);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x8090a8, 150, 750);
    scene.background = new THREE.Color(0x7090b8);

    camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      900
    );

    // Lighting
    var ambient = new THREE.AmbientLight(0x607090, 0.55);
    scene.add(ambient);

    var sun = new THREE.DirectionalLight(0xfff0d0, 1.15);
    sun.position.set(200, 300, 100);
    scene.add(sun);

    // Subtle fill light from opposite direction
    var fill = new THREE.DirectionalLight(0x4060a0, 0.25);
    fill.position.set(-100, 50, -200);
    scene.add(fill);

    window.addEventListener('resize', function () {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    });
  }

  // ── Title screen dismiss ─────────────────────────────────────────────────────
  function initTitleScreen() {
    var titleEl = document.getElementById('title-screen');
    if (!titleEl) return;

    function dismiss() {
      if (started) return;
      started = true;
      titleEl.classList.add('hidden');
      // Remove after transition
      setTimeout(function () {
        titleEl.style.display = 'none';
      }, 1100);
    }

    document.addEventListener('keydown',  dismiss, { once: false });
    titleEl.addEventListener('click',     dismiss);
    titleEl.addEventListener('touchstart', dismiss);

    // Also kick off the game loop immediately so terrain renders behind the title
  }

  // ── Winch cable visual ───────────────────────────────────────────────────────
  function updateWinchVisuals() {
    if (!cableLine) return;
    var vState  = T2.Vehicle.getState();
    var winch   = T2.Vehicle.getWinchState();
    var players = T2.Multiplayer.getPlayers();

    if (winch.active && players[winch.targetId]) {
      var target    = players[winch.targetId];
      cableLine.visible = true;

      var positions = cableLine.geometry.attributes.position.array;
      positions[0]  = vState.position.x;
      positions[1]  = vState.position.y;
      positions[2]  = vState.position.z;
      positions[3]  = target.position.x;
      positions[4]  = target.position.y;
      positions[5]  = target.position.z;

      cableLine.geometry.attributes.position.needsUpdate = true;
    } else {
      cableLine.visible = false;
    }
  }

  // ── Game loop ────────────────────────────────────────────────────────────────
  function tick(now) {
    if (lastTime === null) lastTime = now;
    var dt = Math.min((now - lastTime) / 1000, 0.1);  // cap at 100 ms
    lastTime = now;

    T2.Vehicle.tick(dt);
    T2.Network.tick(T2.Vehicle.getState(), dt);
    T2.Multiplayer.tick(dt);
    T2.Audio.tick(T2.Vehicle.getState(), dt);
    T2.Effects.tick(T2.Vehicle.getState(), dt);
    T2.Camera.tick(dt, camera);
    T2.HUD.tick(T2.Vehicle.getState(), T2.Camera.getMode(), T2.Network.getPlayerCount());
    updateWinchVisuals();

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  // ── Entry point ──────────────────────────────────────────────────────────────
  function init() {
    initThree();

    // Build terrain first (vehicle needs terrain queries for spawn pos)
    T2.Terrain.init(scene);

    // Place props on terrain
    T2.Props.init(scene);

    // Find a good spawn position and start the vehicle there
    var spawn = T2.Terrain.findSpawnPos();
    T2.Vehicle.init(scene, spawn);

    T2.Effects.init(scene);

    T2.Camera.init();
    T2.HUD.init();
    T2.Audio.init();
    T2.Multiplayer.init(scene);
    T2.Network.init();

    // Winch cable line
    var cableMat = new THREE.LineBasicMaterial({ color: 0x222222, linewidth: 2 });
    var cableGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3()
    ]);
    cableLine = new THREE.Line(cableGeo, cableMat);
    cableLine.visible = false;
    scene.add(cableLine);

    initTitleScreen();

    requestAnimationFrame(tick);
  }

  return { init: init };

})();

document.addEventListener('DOMContentLoaded', function () {
  T2.Main.init();
});
