'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'f1_fiber_cable_management_app.html'), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!blocks.length) {
  console.error('no inline scripts found');
  process.exit(1);
}

blocks.forEach((block, index) => {
  const file = path.join(__dirname, `_script_${index}.js`);
  fs.writeFileSync(file, block[1]);
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  fs.unlinkSync(file);
});

console.log(`checked ${blocks.length} scripts`);
