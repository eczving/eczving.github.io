const fs = require('fs');

let content = fs.readFileSync('js/effects.js', 'utf8');

// 1. Increase MAX_PARTICLES
content = content.replace(
  'var MAX_PARTICLES = 350;',
  'var MAX_PARTICLES = 2500;'
);

// 2. Enhance FX_CONFIG for MUD and GRASS
const searchConfig = `  var FX_CONFIG = {
    'DEEP WATER': { r: 0.26, g: 0.50, b: 0.83, rate: 12, upMin: 2.0, upMax: 4.5, spread: 1.8, kick: 2.5, decay: 0.90 },
    'WATER':      { r: 0.37, g: 0.67, b: 0.91, rate:  9, upMin: 1.5, upMax: 3.5, spread: 1.4, kick: 2.0, decay: 0.90 },
    'MUD':        { r: 0.48, g: 0.33, b: 0.12, rate:  7, upMin: 1.0, upMax: 2.8, spread: 1.0, kick: 1.5, decay: 1.00 },
    'GRASS':      { r: 0.24, g: 0.56, b: 0.11, rate:  5, upMin: 0.6, upMax: 1.8, spread: 0.8, kick: 1.2, decay: 1.10 },
    'HIGHLAND':   { r: 0.63, g: 0.50, b: 0.29, rate:  5, upMin: 0.5, upMax: 1.5, spread: 0.7, kick: 1.0, decay: 1.10 },`;

const replaceConfig = `  var FX_CONFIG = {
    'DEEP WATER': { r: 0.26, g: 0.50, b: 0.83, rate: 30, upMin: 2.0, upMax: 5.5, spread: 2.5, kick: 3.5, decay: 0.70 },
    'WATER':      { r: 0.37, g: 0.67, b: 0.91, rate: 25, upMin: 1.5, upMax: 4.5, spread: 2.0, kick: 3.0, decay: 0.75 },
    'MUD':        { r: 0.48, g: 0.33, b: 0.12, rate: 40, upMin: 2.0, upMax: 4.5, spread: 1.8, kick: 3.5, decay: 0.60 },
    'GRASS':      { r: 0.24, g: 0.56, b: 0.11, rate: 20, upMin: 1.5, upMax: 3.5, spread: 1.5, kick: 2.5, decay: 0.80 },
    'HIGHLAND':   { r: 0.63, g: 0.50, b: 0.29, rate: 10, upMin: 0.8, upMax: 2.5, spread: 1.0, kick: 1.5, decay: 1.00 },`;

content = content.replace(searchConfig, replaceConfig);

// 3. Only spawn wheel spray when grounded
const searchTick = `    // Wheel spray
    var MIN_SPEED = 2.0;
    if (cfg && speed > MIN_SPEED) {`;

const replaceTick = `    // Wheel spray
    var MIN_SPEED = 2.0;
    if (cfg && speed > MIN_SPEED && vs.isGrounded !== false) {`;

content = content.replace(searchTick, replaceTick);

fs.writeFileSync('js/effects.js', content);
