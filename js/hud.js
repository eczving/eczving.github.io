'use strict';
window.T2 = window.T2 || {};

// 2D canvas HUD rendered over the 3D scene.
// Elements: analog speedometer, surface type badge, camera mode label,
// flip/reset hint, and a minimal controls reference.
T2.HUD = (function () {

  var canvas, ctx;
  var W, H;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  // ── Speedometer ──────────────────────────────────────────────────────────────
  function drawSpeedo(speed) {
    var kph    = Math.abs(speed) * 3.6;
    var cx     = 110;
    var cy     = H - 110;
    var radius = 72;

    // Outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Tick marks (0–120 km/h, sweep 240°, start at 210°)
    var startAngle = (210 * Math.PI) / 180;
    var sweepAngle = (240 * Math.PI) / 180;

    for (var i = 0; i <= 12; i++) {
      var ang    = startAngle + (i / 12) * sweepAngle;
      var isMajor = (i % 3 === 0);
      var inner  = isMajor ? radius - 12 : radius - 7;
      var outer  = radius - 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * inner, cy + Math.sin(ang) * inner);
      ctx.lineTo(cx + Math.cos(ang) * outer, cy + Math.sin(ang) * outer);
      ctx.strokeStyle = isMajor ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)';
      ctx.lineWidth = isMajor ? 2 : 1;
      ctx.stroke();
    }

    // Speed labels at major ticks
    ctx.font = '9px Courier New';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var labels = ['0', '30', '60', '90', '120'];
    for (var li = 0; li <= 4; li++) {
      var lang = startAngle + (li / 4) * sweepAngle;
      var lx   = cx + Math.cos(lang) * (radius - 20);
      var ly   = cy + Math.sin(lang) * (radius - 20);
      ctx.fillText(labels[li], lx, ly);
    }

    // Needle
    var needleAng = startAngle + Math.min(1, kph / 120) * sweepAngle;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(needleAng) * 10, cy - Math.sin(needleAng) * 10);
    ctx.lineTo(cx + Math.cos(needleAng) * (radius - 10), cy + Math.sin(needleAng) * (radius - 10));
    ctx.strokeStyle = '#ff4030';
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Centre dot
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4030';
    ctx.fill();

    // Digital readout
    ctx.font = 'bold 16px Courier New';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((kph | 0) + ' km/h', cx, cy + radius + 14);
  }

  // ── Surface type badge ───────────────────────────────────────────────────────
  function drawSurface(surfaceType) {
    if (!surfaceType) return;
    var cx   = 110;
    var cy   = H - 196;
    var sw   = 10;

    // Coloured square
    ctx.fillStyle = surfaceType.color || '#888';
    ctx.fillRect(cx - 36, cy - 6, sw, sw);

    // Label
    ctx.font = '11px Courier New';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(surfaceType.name || '', cx - 22, cy - 1);
  }

  // ── Player count ─────────────────────────────────────────────────────────────
  function drawPlayerCount(count) {
    if (!count || count <= 1) return;
    ctx.font = '11px Courier New';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(count + ' PLAYERS', W - 16, 34);
  }

  // ── Camera mode ──────────────────────────────────────────────────────────────
  function drawCameraMode(mode) {
    var labels = { chase: 'CHASE', cockpit: 'COCKPIT', topdown: 'TOP-DOWN' };
    var label  = '[' + (labels[mode] || mode.toUpperCase()) + ']';

    ctx.font = '12px Courier New';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(label, W - 16, 16);
  }

  // ── Reset hint ───────────────────────────────────────────────────────────────
  function drawResetHint() {
    var blink = Math.sin(Date.now() / 280) > 0;
    if (!blink) return;

    ctx.font = 'bold 16px Courier New';
    ctx.fillStyle = 'rgba(255, 80, 50, 0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PRESS R TO RESET', W / 2, H / 2);
  }

  // ── Controls reference (tiny, bottom-right) ─────────────────────────────────
  function drawControls() {
    var lines = [
      'WASD / ARROWS  drive',
      'SPACE          handbrake',
      'C              camera',
      'R              reset',
    ];
    ctx.font = '9px Courier New';
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (var i = lines.length - 1; i >= 0; i--) {
      ctx.fillText(lines[i], W - 12, H - 12 - (lines.length - 1 - i) * 13);
    }
  }

  // ── Speed direction indicator ────────────────────────────────────────────────
  function drawGear(localVelZ) {
    var label = Math.abs(localVelZ) < 0.3 ? 'N' : (localVelZ >= 0 ? 'D' : 'R');
    ctx.font = 'bold 14px Courier New';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 50, H - 110);
  }

  return {
    init: function () {
      canvas = document.getElementById('hud-canvas');
      ctx    = canvas.getContext('2d');
      resize();
      window.addEventListener('resize', resize);
    },

    tick: function (vehicleState, cameraMode, playerCount) {
      ctx.clearRect(0, 0, W, H);

      drawSpeedo(vehicleState.speed);
      drawGear(vehicleState.localVelZ);
      drawSurface(vehicleState.surfaceType);
      drawCameraMode(cameraMode);
      drawPlayerCount(playerCount);
      drawControls();

      if (vehicleState.isFlipped) drawResetHint();
    },
  };

})();
