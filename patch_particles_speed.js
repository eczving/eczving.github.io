const fs = require('fs');
let content = fs.readFileSync('js/effects.js', 'utf8');

const searchBatch = `    for (var i = 0; i < 2 && particles.length < MAX_PARTICLES; i++) {
      var wo = REAR_OFFSETS[i];
      var wx = px + wo.ox * cosY + wo.oz * sinY + (Math.random() - 0.5) * cfg.spread;
      var wz = pz - wo.ox * sinY + wo.oz * cosY + (Math.random() - 0.5) * cfg.spread;
      particles.push({
        x: wx, y: py, z: wz,
        vx: (Math.random() - 0.5) * cfg.kick,
        vy: cfg.upMin + Math.random() * (cfg.upMax - cfg.upMin),
        vz: (Math.random() - 0.5) * cfg.kick,`;

const replaceBatch = `    for (var i = 0; i < 4 && particles.length < MAX_PARTICLES; i++) {
      var wo = REAR_OFFSETS[i % 2];
      var wx = px + wo.ox * cosY + wo.oz * sinY + (Math.random() - 0.5) * cfg.spread;
      var wz = pz - wo.ox * sinY + wo.oz * cosY + (Math.random() - 0.5) * cfg.spread;
      particles.push({
        x: wx, y: py, z: wz,
        vx: (Math.random() - 0.5) * cfg.kick - sinY * vs.speed * 0.1,
        vy: cfg.upMin + Math.random() * (cfg.upMax - cfg.upMin),
        vz: (Math.random() - 0.5) * cfg.kick - cosY * vs.speed * 0.1,`;

content = content.replace(searchBatch, replaceBatch);

// And we can make them spawn faster
const searchTick = `      var spawnInterval = 1.0 / (cfg.rate * Math.min(speed / 8.0, 1.5));`;
const replaceTick = `      var spawnInterval = 1.0 / (cfg.rate * Math.max(1.0, speed / 5.0));`;

content = content.replace(searchTick, replaceTick);

fs.writeFileSync('js/effects.js', content);
