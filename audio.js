'use strict';
window.T2 = window.T2 || {};

// Web Audio engine: procedural sounds via the Web Audio API.
// Engine tone: two layered oscillators + low-pass filter pitched by speed/throttle.
// Impact sound: white-noise burst + low thud tone triggered on prop collisions.
// Audio context is created on first user gesture to comply with browser autoplay policy.
T2.Audio = (function () {

  var ctx          = null;
  var engineGain   = null;
  var engineOsc1   = null;   // sawtooth — main rumble
  var engineOsc2   = null;   // sine    — sub-bass body
  var engineFilter = null;
  var ready        = false;

  // Gear-change tracking for the volume-dip effect
  var lastGear   = -1;
  var shiftDip   = 0;    // seconds remaining in the shift dip
  var SHIFT_DIP_DUR = 0.16;  // total dip duration

  // Terrain rolling sound — looping filtered noise shaped per surface
  var terrainNoiseSrc = null;
  var terrainFilter   = null;
  var terrainGain     = null;
  var lastSurfaceName = '';

  // Per-surface filter profile: type, cutoff frequency (Hz), Q, max gain
  var TERRAIN_SOUND = {
    'DEEP WATER': { type: 'bandpass', freq:  380, q: 1.5, gain: 0.15 },
    'WATER':      { type: 'bandpass', freq:  560, q: 1.2, gain: 0.12 },
    'MUD':        { type: 'lowpass',  freq:  160, q: 2.0, gain: 0.13 },
    'GRASS':      { type: 'bandpass', freq: 2200, q: 0.9, gain: 0.06 },
    'HIGHLAND':   { type: 'bandpass', freq: 1500, q: 1.1, gain: 0.07 },
    'ROCK':       { type: 'highpass', freq: 2600, q: 0.7, gain: 0.10 },
    'HIGH ROCK':  { type: 'highpass', freq: 3000, q: 0.6, gain: 0.08 },
    'SNOW':       { type: 'lowpass',  freq: 1100, q: 1.3, gain: 0.09 },
  };

  function boot() {
    if (ready) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();

      // Master engine gain node (starts silent)
      engineGain = ctx.createGain();
      engineGain.gain.value = 0;
      engineGain.connect(ctx.destination);

      // Low-pass filter for engine timbre shaping
      engineFilter = ctx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 280;
      engineFilter.Q.value = 1.8;
      engineFilter.connect(engineGain);

      // Primary oscillator — sawtooth engine body
      engineOsc1 = ctx.createOscillator();
      engineOsc1.type = 'sawtooth';
      engineOsc1.frequency.value = 48;
      engineOsc1.connect(engineFilter);
      engineOsc1.start();

      // Secondary oscillator — sub-bass (quieter, half frequency)
      var subGain = ctx.createGain();
      subGain.gain.value = 0.38;
      subGain.connect(engineGain);

      engineOsc2 = ctx.createOscillator();
      engineOsc2.type = 'sine';
      engineOsc2.frequency.value = 24;
      engineOsc2.connect(subGain);
      engineOsc2.start();

      // ── Terrain rolling sound ─────────────────────────────────────────────
      // Two-second white-noise loop shaped by a BiquadFilter per terrain type.
      var terrainBufLen  = Math.floor(ctx.sampleRate * 2.0);
      var terrainBuf     = ctx.createBuffer(1, terrainBufLen, ctx.sampleRate);
      var terrainBufData = terrainBuf.getChannelData(0);
      for (var tni = 0; tni < terrainBufLen; tni++) {
        terrainBufData[tni] = Math.random() * 2 - 1;
      }

      terrainNoiseSrc = ctx.createBufferSource();
      terrainNoiseSrc.buffer = terrainBuf;
      terrainNoiseSrc.loop   = true;

      terrainFilter = ctx.createBiquadFilter();
      terrainFilter.type            = 'bandpass';
      terrainFilter.frequency.value = 1000;
      terrainFilter.Q.value         = 1.0;

      terrainGain = ctx.createGain();
      terrainGain.gain.value = 0;

      terrainNoiseSrc.connect(terrainFilter);
      terrainFilter.connect(terrainGain);
      terrainGain.connect(ctx.destination);
      terrainNoiseSrc.start();

      ready = true;
    } catch (e) {
      // Web Audio blocked or unsupported — game stays silent
    }
  }

  function resumeCtx() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  // Water-entry splash — bandpass noise burst, volume/pitch scale with speed
  function playSplash(speedMs) {
    if (!ready) return;
    var intensity = Math.min(1.0, speedMs / 15.0);

    var bufLen = Math.floor(ctx.sampleRate * 0.5);
    var buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    var data   = buffer.getChannelData(0);
    for (var i = 0; i < bufLen; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufLen, 0.8);
    }

    var src  = ctx.createBufferSource();
    src.buffer = buffer;

    var filt = ctx.createBiquadFilter();
    filt.type            = 'bandpass';
    filt.frequency.value = 700 + intensity * 500;
    filt.Q.value         = 1.4;

    var gn = ctx.createGain();
    gn.gain.value = 0.28 + intensity * 0.32;

    src.connect(filt);
    filt.connect(gn);
    gn.connect(ctx.destination);
    src.start();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  return {

    // Called once during game init — registers the first-gesture boot handler
    init: function () {
      var evts = ['keydown', 'mousedown', 'touchstart', 'pointerdown'];
      evts.forEach(function (ev) {
        document.addEventListener(ev, function onFirst() {
          boot();
          document.removeEventListener(ev, onFirst);
        });
      });
    },

    // Called every frame — vehicleState from T2.Vehicle.getState(), dt in seconds
    tick: function (vehicleState, dt) {
      if (!ready) return;
      resumeCtx();

      var throttle = T2.Input.throttle();
      var brake    = T2.Input.brake();

      // Use the gear-accurate RPM exported by vehicle.js (range 850–6200)
      var rpm     = vehicleState.engineRPM || 850;
      var rpmNorm = (rpm - 850) / (6200 - 850);  // 0..1

      // Gear-change dip: brief volume drop to simulate clutch disengagement
      var gear = vehicleState.currentGear || 0;
      if (lastGear >= 0 && gear !== lastGear) {
        shiftDip = SHIFT_DIP_DUR;
      }
      lastGear = gear;
      if (shiftDip > 0) shiftDip = Math.max(0, shiftDip - dt);
      // dipFactor: 0.4 at start of dip, eases back to 1.0
      var dipFactor = shiftDip > 0 ? (0.40 + 0.60 * (1 - shiftDip / SHIFT_DIP_DUR)) : 1.0;

      // Oscillator frequency tracks RPM: ~42 Hz at idle, ~175 Hz at redline
      var baseFreq = 42 + rpmNorm * 133 + (throttle ? 14 : 0);
      engineOsc1.frequency.setTargetAtTime(baseFreq,       ctx.currentTime, 0.06);
      engineOsc2.frequency.setTargetAtTime(baseFreq * 0.5, ctx.currentTime, 0.06);

      // Volume: quiet at idle, louder under load, dipped on gear change
      var targetGain = (0.10 + rpmNorm * 0.10 + (throttle ? 0.05 : 0)) * dipFactor;
      if (brake && vehicleState.localVelZ > 1) targetGain += 0.015 * dipFactor;
      engineGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.04);

      // Filter cutoff rises with RPM — brighter high-rev tone
      var cutoff = 200 + rpmNorm * 700 + (throttle ? 150 : 0);
      engineFilter.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.06);

      // ── Terrain rolling sound ─────────────────────────────────────────────
      var surfName = vehicleState.surfaceType ? vehicleState.surfaceType.name : '';
      var tSnd     = TERRAIN_SOUND[surfName];
      // Volume ramps in from 2 m/s, reaches full at 15 m/s
      var surfSpeedFactor = Math.min(1.0, Math.max(0.0, (vehicleState.speed - 2.0) / 13.0));

      if (surfName !== lastSurfaceName) {
        var wasWater = (lastSurfaceName === 'WATER' || lastSurfaceName === 'DEEP WATER');
        var isWater  = (surfName === 'WATER'        || surfName === 'DEEP WATER');
        if (isWater && !wasWater && vehicleState.speed > 2.0) {
          playSplash(vehicleState.speed);
        }
        if (tSnd) {
          terrainFilter.type = tSnd.type;
          terrainFilter.frequency.setTargetAtTime(tSnd.freq, ctx.currentTime, 0.12);
          terrainFilter.Q.setTargetAtTime(tSnd.q,            ctx.currentTime, 0.12);
        }
        lastSurfaceName = surfName;
      }

      var targetTerrainGain = tSnd ? tSnd.gain * surfSpeedFactor : 0;
      terrainGain.gain.setTargetAtTime(targetTerrainGain, ctx.currentTime, 0.10);
    },

    // Triggered on prop collisions — intensity 0..1 scales volume and pitch
    playImpact: function (intensity) {
      if (!ready) return;
      resumeCtx();
      intensity = Math.max(0, Math.min(1, intensity));

      // White-noise burst (body impact texture)
      var bufLen = Math.floor(ctx.sampleRate * 0.14);
      var buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      var data   = buffer.getChannelData(0);
      for (var i = 0; i < bufLen; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufLen, 1.6);
      }

      var noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = buffer;

      var noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.value = 260 + intensity * 520;

      var noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.30 + intensity * 0.35;

      noiseSrc.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      noiseSrc.start();

      // Low thud tone (structural impact)
      var thudOsc  = ctx.createOscillator();
      thudOsc.type = 'sine';
      thudOsc.frequency.value = 58 + intensity * 45;

      var thudGain = ctx.createGain();
      thudGain.gain.setValueAtTime(0.45 + intensity * 0.30, ctx.currentTime);
      thudGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20);

      thudOsc.connect(thudGain);
      thudGain.connect(ctx.destination);
      thudOsc.start();
      thudOsc.stop(ctx.currentTime + 0.20);
    },

  };

})();
