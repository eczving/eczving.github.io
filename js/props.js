'use strict';
window.T2 = window.T2 || {};

// Static scene props: low-poly trees and rocks placed on the terrain.
// Each prop registers a circular collider used by vehicle.js for bounce/impact.
T2.Props = (function () {

  var TREE_COUNT   = 400;
  var ROCK_COUNT   = 280;
  var CLEAR_RADIUS = 22;   // keep spawn zone clear

  // Flat array of { x, z, radius } circles — queried by vehicle.js each frame
  var colliders = [];

  var MAT_TRUNK   = new THREE.MeshLambertMaterial({ color: 0x4a3020, flatShading: true });
  var MAT_CANOPY  = new THREE.MeshLambertMaterial({ color: 0x2a5020, flatShading: true });
  var MAT_ROCK    = new THREE.MeshLambertMaterial({ color: 0x706050, flatShading: true });

  // Seeded LCG for deterministic prop placement
  var lcgState = 98765;
  function lcgRand() {
    lcgState = ((lcgState * 1664525 + 1013904223) >>> 0);
    return lcgState / 4294967296;
  }

  function makeTree(x, y, z) {
    var group = new THREE.Group();

    // 5-sided trunk for low-poly look
    var trunkGeo = new THREE.CylinderGeometry(0.2, 0.45, 2.6, 5);
    var trunk = new THREE.Mesh(trunkGeo, MAT_TRUNK);
    trunk.position.y = 1.3;
    group.add(trunk);

    // 6-sided cone canopy
    var canopyGeo = new THREE.ConeGeometry(2.6, 4.2, 6);
    var canopy = new THREE.Mesh(canopyGeo, MAT_CANOPY);
    canopy.position.y = 2.6 + 2.1 + 0.5;  // trunk top + half-cone + small gap
    group.add(canopy);

    group.position.set(x, y, z);
    group.rotation.y = lcgRand() * Math.PI * 2;

    // Register trunk as collision circle (radius covers base of trunk + small buffer)
    colliders.push({ x: x, z: z, radius: 0.85 });

    return group;
  }

  function makeRock(x, y, z) {
    var r = 0.8 + lcgRand() * 1.7;
    var geo = new THREE.DodecahedronGeometry(r, 0);
    var mesh = new THREE.Mesh(geo, MAT_ROCK);
    mesh.position.set(x, y + r * 0.55, z);
    mesh.rotation.y = lcgRand() * Math.PI * 2;
    mesh.rotation.x = (lcgRand() - 0.5) * 0.4;
    mesh.scale.y = 0.55 + lcgRand() * 0.3;

    // Register rock as collision circle (use actual geometry radius)
    colliders.push({ x: x, z: z, radius: r * 0.88 });

    return mesh;
  }

  function isClear(x, z) {
    return (x * x + z * z) >= CLEAR_RADIUS * CLEAR_RADIUS;
  }

  function placeTrees(group) {
    // Stratified sampling: divide map into a grid and place one tree per cell
    var cellsPerSide = Math.ceil(Math.sqrt(TREE_COUNT));
    var cellSize = 980 / cellsPerSide;
    var placed = 0;

    for (var ci = 0; ci < cellsPerSide && placed < TREE_COUNT; ci++) {
      for (var cj = 0; cj < cellsPerSide && placed < TREE_COUNT; cj++) {
        var x = -490 + ci * cellSize + lcgRand() * cellSize;
        var z = -490 + cj * cellSize + lcgRand() * cellSize;
        if (!isClear(x, z)) continue;

        var q = T2.Terrain.query(x, z);
        var surf = q.surfaceType;
        if (surf === T2.Terrain.SURFACE.GRASS || surf === T2.Terrain.SURFACE.HIGHLAND) {
          if (q.height > 0.5) {
            group.add(makeTree(x, q.height, z));
            placed++;
          }
        }
      }
    }
  }

  function placeRocks(group) {
    var cellsPerSide = Math.ceil(Math.sqrt(ROCK_COUNT));
    var cellSize = 980 / cellsPerSide;
    var placed = 0;

    for (var ci = 0; ci < cellsPerSide && placed < ROCK_COUNT; ci++) {
      for (var cj = 0; cj < cellsPerSide && placed < ROCK_COUNT; cj++) {
        var x = -490 + ci * cellSize + lcgRand() * cellSize;
        var z = -490 + cj * cellSize + lcgRand() * cellSize;
        if (!isClear(x, z)) continue;

        var q = T2.Terrain.query(x, z);
        var surf = q.surfaceType;
        if (surf === T2.Terrain.SURFACE.ROCK ||
            surf === T2.Terrain.SURFACE.HIGH_ROCK ||
            surf === T2.Terrain.SURFACE.HIGHLAND) {
          if (q.height > 0.5) {
            group.add(makeRock(x, q.height, z));
            placed++;
          }
        }
      }
    }
  }

  return {
    init: function (scene) {
      colliders = [];   // reset on (re)init
      var group = new THREE.Group();
      placeTrees(group);
      placeRocks(group);
      scene.add(group);
    },

    // Returns flat array of { x, z, radius } — used by vehicle.js for collision
    getColliders: function () {
      return colliders;
    },
  };

})();
