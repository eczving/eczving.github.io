'use strict';
window.T2 = window.T2 || {};

// Keyboard state tracker. Stateless — other modules query isDown() each frame.
// Prevents browser default scroll behaviour on game keys.
T2.Input = (function () {

  var keys = {};

  var GAME_KEYS = {
    'ArrowUp':    true, 'ArrowDown':  true,
    'ArrowLeft':  true, 'ArrowRight': true,
    'Space':      true, 'KeyW': true, 'KeyS': true,
    'KeyA':       true, 'KeyD': true,
    'KeyC':       true, 'KeyR': true, 'KeyT': true,
  };

  document.addEventListener('keydown', function (e) {
    keys[e.code] = true;
    if (GAME_KEYS[e.code]) e.preventDefault();
    if (e.code === 'KeyT' && T2.Vehicle && T2.Vehicle.toggleWinch) {
      T2.Vehicle.toggleWinch();
    }
  });

  document.addEventListener('keyup', function (e) {
    keys[e.code] = false;
  });

  // Lose focus → release all keys to avoid phantom inputs
  window.addEventListener('blur', function () {
    keys = {};
  });

  // ── Mouse orbit (right-click drag to orbit around car) ───────────────────────
  var mouseOrbit = { x: 0, y: 0 };
  var isDragging = false;

  document.addEventListener('mousedown', function (e) {
    if (e.button === 2) isDragging = true;
  });
  document.addEventListener('mouseup', function (e) {
    if (e.button === 2) isDragging = false;
  });
  document.addEventListener('mousemove', function (e) {
    if (isDragging) {
      mouseOrbit.x -= e.movementX * 0.01;
      // Restrict vertical angle so we don't go under the map
      mouseOrbit.y = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, mouseOrbit.y - e.movementY * 0.01));
    }
  });
  // Prevent the context menu from popping up when right-clicking
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  return {
    isDown:     function (code) { return !!keys[code]; },
    mouseOrbit: mouseOrbit,

    // Grouped convenience queries
    throttle:   function () { return !!(keys['ArrowUp']    || keys['KeyW']); },
    brake:      function () { return !!(keys['ArrowDown']   || keys['KeyS']); },
    steerLeft:  function () { return !!(keys['ArrowLeft']   || keys['KeyA']); },
    steerRight: function () { return !!(keys['ArrowRight']  || keys['KeyD']); },
    handbrake:  function () { return !!keys['Space']; },
    camera:     function () { return !!keys['KeyC']; },
    reset:      function () { return !!keys['KeyR']; },
    anyKey:     function () {
      for (var k in keys) { if (keys[k]) return true; }
      return false;
    },
  };

})();
