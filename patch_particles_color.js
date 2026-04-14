const fs = require('fs');
let content = fs.readFileSync('js/effects.js', 'utf8');

// I am noticing that grass particle size and color is still very faint or blends completely with the terrain.
// Terep 2 uses big thick brown and green dirt chunks. Let's make the particles slightly bigger and darker to make them visible!
const searchConfig = `  var FX_CONFIG = {
    'DEEP WATER': { r: 0.26, g: 0.50, b: 0.83, rate: 30, upMin: 2.0, upMax: 5.5, spread: 2.5, kick: 3.5, decay: 0.70 },
    'WATER':      { r: 0.37, g: 0.67, b: 0.91, rate: 25, upMin: 1.5, upMax: 4.5, spread: 2.0, kick: 3.0, decay: 0.75 },
    'MUD':        { r: 0.48, g: 0.33, b: 0.12, rate: 40, upMin: 2.0, upMax: 4.5, spread: 1.8, kick: 3.5, decay: 0.60 },
    'GRASS':      { r: 0.24, g: 0.56, b: 0.11, rate: 20, upMin: 1.5, upMax: 3.5, spread: 1.5, kick: 2.5, decay: 0.80 },
    'HIGHLAND':   { r: 0.63, g: 0.50, b: 0.29, rate: 10, upMin: 0.8, upMax: 2.5, spread: 1.0, kick: 1.5, decay: 1.00 },`;

const replaceConfig = `  var FX_CONFIG = {
    'DEEP WATER': { r: 0.26, g: 0.50, b: 0.83, rate: 30, upMin: 2.0, upMax: 5.5, spread: 2.5, kick: 3.5, decay: 0.70, size: 0.5 },
    'WATER':      { r: 0.37, g: 0.67, b: 0.91, rate: 25, upMin: 1.5, upMax: 4.5, spread: 2.0, kick: 3.0, decay: 0.75, size: 0.4 },
    'MUD':        { r: 0.38, g: 0.26, b: 0.10, rate: 40, upMin: 2.0, upMax: 4.5, spread: 1.8, kick: 3.5, decay: 0.60, size: 0.7 },
    'GRASS':      { r: 0.18, g: 0.45, b: 0.08, rate: 35, upMin: 1.5, upMax: 3.5, spread: 1.5, kick: 3.0, decay: 0.80, size: 0.6 },
    'HIGHLAND':   { r: 0.53, g: 0.40, b: 0.20, rate: 15, upMin: 0.8, upMax: 2.5, spread: 1.0, kick: 1.5, decay: 1.00, size: 0.4 },`;

content = content.replace(searchConfig, replaceConfig);

// We should also use the custom size if available, wait! PointsMaterial size is global...
// We can't change size per particle in standard PointsMaterial unless we write a custom shader.
// BUT we CAN make the points material bigger in general!

content = content.replace('size:            0.38,', 'size:            0.85,');

fs.writeFileSync('js/effects.js', content);
