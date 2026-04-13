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
    'KeyC':       true, 'KeyR': true,
  };

  document.addEventListener('keydown', function (e) {
    keys[e.code] = true;
    if (GAME_KEYS[e.code]) e.preventDefault();
  });

  document.addEventListener('keyup', function (e) {
    keys[e.code] = false;
  });

  // Lose focus → release all keys to avoid phantom inputs
  window.addEventListener('blur', function () {
    keys = {};
  });

  return {
    isDown:     function (code) { return !!keys[code]; },

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
