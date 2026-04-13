'use strict';
window.T2 = window.T2 || {};

// Three camera modes: chase (default), cockpit, top-down.
// C key cycles between them (rising-edge detection — no repeat on hold).
T2.Camera = (function () {

  var MODES = ['chase', 'cockpit', 'topdown'];
  var modeIndex = 0;

  // Smoothed camera position and target (for chase and top-down lag)
  var camPos    = new THREE.Vector3();
  var camTarget = new THREE.Vector3();
  var initialised = false;

  // Reusable scratchpad vectors to avoid GC pressure in the update loop
  var tmp          = new THREE.Vector3();
  var targetOffset = new THREE.Vector3();
  var targetLookAt = new THREE.Vector3();

  var cWasDown = false;  // for rising-edge detection on C key

  var worldUp = new THREE.Vector3(0, 1, 0);

  function lerp3(out, a, b, t) {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
  }

  return {
    init: function () {
      modeIndex   = 0;
      initialised = false;
    },

    tick: function (dt, camera) {
      var group = T2.Vehicle.getGroup();

      // Rising-edge detection for C key
      var cNow = T2.Input.camera();
      if (cNow && !cWasDown) {
        modeIndex = (modeIndex + 1) % MODES.length;
      }
      cWasDown = cNow;

      var mode = MODES[modeIndex];

      if (mode === 'chase') {
        // Camera sits behind and above the car, target is just ahead
        tmp.set(0, 3.5, -9.0);
        group.localToWorld(tmp);
        targetOffset.copy(tmp);

        tmp.set(0, 0.6, 5.0);
        group.localToWorld(tmp);
        targetLookAt.copy(tmp);

        if (!initialised) {
          camPos.copy(targetOffset);
          camTarget.copy(targetLookAt);
          initialised = true;
        }

        lerp3(camPos,    camPos,    targetOffset, Math.min(1, 3.5 * dt));
        lerp3(camTarget, camTarget, targetLookAt, Math.min(1, 5.0 * dt));

        camera.position.copy(camPos);
        camera.lookAt(camTarget);

      } else if (mode === 'cockpit') {
        // Rigid mount inside the cabin
        tmp.set(0, 1.15, 1.5);
        group.localToWorld(tmp);
        camera.position.copy(tmp);

        tmp.set(0, 0.9, 20);
        group.localToWorld(tmp);
        camera.lookAt(tmp);

        // Sync smoothed values so switching back to chase is seamless
        camPos.copy(camera.position);

      } else if (mode === 'topdown') {
        var vp = T2.Vehicle.getGroup().position;

        if (!initialised) {
          camPos.x = vp.x;
          camPos.z = vp.z;
          initialised = true;
        }

        camPos.x += (vp.x - camPos.x) * Math.min(1, 2.0 * dt);
        camPos.z += (vp.z - camPos.z) * Math.min(1, 2.0 * dt);

        camera.position.set(camPos.x, 65, camPos.z);
        camera.up.set(0, 0, -1);  // top-down needs explicit up vector
        camera.lookAt(camPos.x, 0, camPos.z);
        camera.up.set(0, 1, 0);   // restore for other modes
      }
    },

    getMode: function () {
      return MODES[modeIndex];
    },
  };

})();
