const fs = require('fs');
const path = require('path');

const runtimeDir = path.join(__dirname, 'runtime');
const partNames = fs.readdirSync(runtimeDir)
  .filter(name => /^index\.part\d+\.js$/.test(name))
  .sort();

if (!partNames.length) {
  throw new Error('Runtime parts are missing.');
}

const source = partNames
  .map(name => fs.readFileSync(path.join(runtimeDir, name), 'utf8'))
  .join('\n');

module._compile(source, path.join(__dirname, 'index.compiled.js'));
