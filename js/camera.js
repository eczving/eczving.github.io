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

      // Helper: local point → world point using vehicle group transform
      var tmp = new THREE.Vector3();

      if (mode === 'chase') {
        // Free-look orbit camera: right-click and drag to orbit around the car.
        var vState   = T2.Vehicle.getState();
        var carPos   = vState.position;
        var speed    = vState.speed;

        // Distance grows slightly with speed
        var distance = 10.0 + (speed * 0.1);
        var height   = 3.0;

        // Spherical-to-Cartesian using mouse orbit angles
        var orbitX = T2.Input.mouseOrbit.x;
        var orbitY = T2.Input.mouseOrbit.y;

        var offsetX = Math.sin(orbitX) * Math.cos(orbitY) * distance;
        var offsetY = Math.sin(orbitY) * distance + height;
        var offsetZ = Math.cos(orbitX) * Math.cos(orbitY) * distance;

        if (!initialised) {
          camPos.set(carPos.x + offsetX, carPos.y + offsetY, carPos.z + offsetZ);
          initialised = true;
        }

        camera.position.set(
          carPos.x + offsetX,
          carPos.y + offsetY,
          carPos.z + offsetZ
        );
        camera.lookAt(carPos.x, carPos.y + 1.0, carPos.z);

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
