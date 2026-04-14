const fs = require('fs');

let content = fs.readFileSync('js/vehicle.js', 'utf8');

// 1. Add isGrounded to state
content = content.replace(
  '    surfaceType:  null,',
  '    surfaceType:  null,\n    isGrounded:   false,'
);

// 2. Update state.isGrounded in updateBody
content = content.replace(
  '    var isGrounded = groundedCount >= 2;',
  '    var isGrounded = groundedCount >= 2;\n    state.isGrounded = isGrounded;'
);

// 3. Add hydrodynamic drag in updateBody
// Search for drag calculation
const searchStr = `    if (state.speed > 0.05) {
      var drag      = state.speed * state.speed * 0.025 + state.speed * friction * 0.28;
      var dragDecel = drag / CAR_MASS;`;

const replaceStr = `    if (state.speed > 0.05) {
      var drag      = state.speed * state.speed * 0.025 + state.speed * friction * 0.28;
      if (state.surfaceType && state.surfaceType.name === 'DEEP WATER') {
        drag += state.speed * state.speed * 1.5 + state.speed * 4.0;
      } else if (state.surfaceType && state.surfaceType.name === 'WATER') {
        drag += state.speed * state.speed * 0.6 + state.speed * 1.5;
      }
      var dragDecel = drag / CAR_MASS;`;

content = content.replace(searchStr, replaceStr);

fs.writeFileSync('js/vehicle.js', content);
