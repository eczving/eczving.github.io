'use strict';
window.T2 = window.T2 || {};

// Procedural low-poly terrain.
// Builds a 257x257 vertex grid (256x256 quads) over a 512x512 world unit area.
// Heights come from domain-warped fBm noise.
// Exposes T2.Terrain.query(wx, wz) → { height, normal, surfaceType }
// used by vehicle.js for wheel ground contact.
T2.Terrain = (function () {

  var SEGS = 512;          // quads per side
  var SIZE = 1024;         // world units
  var HALF = SIZE / 2;     // 512
  var VERTS = SEGS + 1;    // 513 vertices per side
  var HEIGHT_SCALE = 35;   // max height in world units
  var FREQ = 0.003;        // noise frequency scale (lower = bigger landscape features)

  // Flat heightmap array indexed [iz * VERTS + ix]
  var heightData = new Float32Array(VERTS * VERTS);

  // Surface type definitions with friction coefficients
  var SURFACE = {
    DEEP_WATER: { name: 'DEEP WATER', friction: 0.04,  color: '#1a3a5c' },
    WATER:      { name: 'WATER',      friction: 0.08,  color: '#2a5a8c' },
    MUD:        { name: 'MUD',        friction: 0.18,  color: '#9a8a6a' },
    GRASS:      { name: 'GRASS',      friction: 0.65,  color: '#4a7a3a' },
    HIGHLAND:   { name: 'HIGHLAND',   friction: 0.55,  color: '#6a5a4a' },
    ROCK:       { name: 'ROCK',       friction: 0.82,  color: '#7a7060' },
    HIGH_ROCK:  { name: 'HIGH ROCK',  friction: 0.72,  color: '#908870' },
    SNOW:       { name: 'SNOW',       friction: 0.28,  color: '#e8e8f0' },
  };

  // Convert raw height (world units) to surface type
  function surfaceForHeight(h) {
    var n = h / HEIGHT_SCALE;
    if (n < -0.15) return SURFACE.DEEP_WATER;
    if (n <  0.0)  return SURFACE.WATER;
    if (n <  0.04) return SURFACE.MUD;
    if (n <  0.28) return SURFACE.GRASS;
    if (n <  0.52) return SURFACE.HIGHLAND;
    if (n <  0.72) return SURFACE.ROCK;
    if (n <  0.88) return SURFACE.HIGH_ROCK;
    return SURFACE.SNOW;
  }

  // Convert height to RGB (0-1 range) for vertex colours
  function heightToRgb(h) {
    var s = surfaceForHeight(h);
    var hex = s.color.replace('#', '');
    return {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255,
    };
  }

  // Build the heightmap using domain-warped fBm
  function buildHeightmap() {
    for (var iz = 0; iz < VERTS; iz++) {
      for (var ix = 0; ix < VERTS; ix++) {
        var wx = (ix / SEGS - 0.5) * SIZE;  // world X in [-256, 256]
        var wz = (iz / SEGS - 0.5) * SIZE;  // world Z in [-256, 256]

        var sx = wx * FREQ;
        var sz = wz * FREQ;

        // Domain warp: sample two offset noise values to distort coordinates
        var warpX = T2.Noise.fbm(sx + 1.7, sz + 9.2, 4, 2.0, 0.5);
        var warpZ = T2.Noise.fbm(sx + 8.3, sz + 2.8, 4, 2.0, 0.5);

        var h = T2.Noise.fbm(sx + warpX * 0.5, sz + warpZ * 0.5, 6, 2.0, 0.5);

        // Flatten areas below waterline to create broad lakes/rivers
        if (h < -0.1) {
          h = -0.1 + (h + 0.1) * 0.3;
        }

        heightData[iz * VERTS + ix] = h * HEIGHT_SCALE;
      }
    }
  }

  // Build Three.js geometry with vertex colours and flat shading
  function buildMesh(scene) {
    var geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
    geo.rotateX(-Math.PI / 2);

    var positions = geo.attributes.position.array;
    var colors    = new Float32Array(positions.length);  // RGB per vertex

    // PlaneGeometry after rotateX: vertex order is row-major left-to-right,
    // front-to-back (ix=0..SEGS, iz=0..SEGS)
    for (var iz = 0; iz < VERTS; iz++) {
      for (var ix = 0; ix < VERTS; ix++) {
        var vi  = iz * VERTS + ix;
        var h   = heightData[vi];
        var rgb = heightToRgb(h);

        // Set Y (vertical) for this vertex
        positions[vi * 3 + 1] = h;

        colors[vi * 3 + 0] = rgb.r;
        colors[vi * 3 + 1] = rgb.g;
        colors[vi * 3 + 2] = rgb.b;
      }
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();

    var mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading:  true,
    });

    var mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
  }

  // Bilinear interpolation of heightmap at arbitrary world (wx, wz)
  function sampleHeight(wx, wz) {
    // Map world coords to grid coords [0, SEGS]
    var gx = (wx / SIZE + 0.5) * SEGS;
    var gz = (wz / SIZE + 0.5) * SEGS;

    gx = Math.max(0, Math.min(SEGS - 0.001, gx));
    gz = Math.max(0, Math.min(SEGS - 0.001, gz));

    var ix0 = Math.floor(gx) | 0;
    var iz0 = Math.floor(gz) | 0;
    var ix1 = ix0 + 1;
    var iz1 = iz0 + 1;
    var fx  = gx - ix0;
    var fz  = gz - iz0;

    var h00 = heightData[iz0 * VERTS + ix0];
    var h10 = heightData[iz0 * VERTS + ix1];
    var h01 = heightData[iz1 * VERTS + ix0];
    var h11 = heightData[iz1 * VERTS + ix1];

    return h00 * (1 - fx) * (1 - fz)
         + h10 * fx       * (1 - fz)
         + h01 * (1 - fx) * fz
         + h11 * fx       * fz;
  }

  // Estimate terrain normal via finite differences
  function sampleNormal(wx, wz) {
    var step = SIZE / SEGS;  // ~2 world units
    var hL = sampleHeight(wx - step, wz);
    var hR = sampleHeight(wx + step, wz);
    var hD = sampleHeight(wx, wz - step);
    var hU = sampleHeight(wx, wz + step);
    var normal = new THREE.Vector3(hL - hR, 2 * step, hD - hU);
    normal.normalize();
    return normal;
  }

  // Find a good spawn position: grass/highland, above water, near map centre
  function findSpawnPos() {
    var candidates = [
      {x:  30, z:  40},
      {x: -20, z:  30},
      {x:  50, z: -30},
      {x: -40, z: -20},
      {x:  10, z: -50},
    ];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var h = sampleHeight(c.x, c.z);
      if (h > 1.5) return { x: c.x, y: h + 2.5, z: c.z };
    }
    // Fallback: scan grid
    for (var sx = -100; sx <= 100; sx += 20) {
      for (var sz = -100; sz <= 100; sz += 20) {
        var sh = sampleHeight(sx, sz);
        if (sh > 1.5 && sh < 10) return { x: sx, y: sh + 2.5, z: sz };
      }
    }
    return { x: 0, y: 8, z: 0 };
  }

  return {
    init: function (scene) {
      buildHeightmap();
      buildMesh(scene);
    },

    // Primary API used by vehicle.js — O(1) heightmap lookup
    query: function (wx, wz) {
      var h = sampleHeight(wx, wz);
      return {
        height:      h,
        normal:      sampleNormal(wx, wz),
        surfaceType: surfaceForHeight(h),
      };
    },

    findSpawnPos: findSpawnPos,

    // Expose surface definitions so HUD can use colours
    SURFACE: SURFACE,
  };

})();
