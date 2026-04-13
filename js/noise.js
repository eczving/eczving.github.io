'use strict';
window.T2 = window.T2 || {};

// Value noise + fractal Brownian motion for terrain generation.
// No external dependencies — self-contained PRNG + permutation table.
T2.Noise = (function () {

  var perm = new Uint8Array(512);

  function seed(s) {
    var p = new Uint8Array(256);
    var i, j, tmp;
    for (i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates shuffle using a simple LCG
    var r = (s >>> 0) || 12345;
    for (i = 255; i > 0; i--) {
      r = ((r * 1664525 + 1013904223) >>> 0);
      j = r % (i + 1);
      tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (i = 0; i < 512; i++) perm[i] = p[i & 255];
  }

  // Quintic fade: 6t^5 - 15t^4 + 10t^3
  function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function lerp(a, b, t) {
    return a + t * (b - a);
  }

  // Pseudo-random float in [-1, 1] from integer coordinates
  function grad(ix, iy) {
    var h = perm[(ix & 255) + perm[iy & 255]] & 255;
    return (h / 127.5) - 1.0;
  }

  // 2D value noise, returns value in roughly [-1, 1]
  function noise2(x, y) {
    var ix = Math.floor(x) | 0;
    var iy = Math.floor(y) | 0;
    var fx = x - ix;
    var fy = y - iy;
    var u = fade(fx);
    var v = fade(fy);
    var a  = grad(ix,     iy);
    var b  = grad(ix + 1, iy);
    var c  = grad(ix,     iy + 1);
    var d  = grad(ix + 1, iy + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  // Fractal Brownian Motion: sum of noise octaves
  function fbm(x, y, octaves, lacunarity, gain) {
    octaves    = octaves    !== undefined ? octaves    : 6;
    lacunarity = lacunarity !== undefined ? lacunarity : 2.0;
    gain       = gain       !== undefined ? gain       : 0.5;
    var val = 0, amp = 0.5, freq = 1.0, max = 0;
    for (var i = 0; i < octaves; i++) {
      val += noise2(x * freq, y * freq) * amp;
      max += amp;
      amp  *= gain;
      freq *= lacunarity;
    }
    return val / max;
  }

  // Initialise with a fixed seed for reproducible terrain
  seed(42);

  return {
    seed:   seed,
    noise2: noise2,
    fbm:    fbm,
  };

})();
