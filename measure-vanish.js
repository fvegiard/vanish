// Measures packaged Vanish.exe launch: spawn with stdio pipe, time to exit.
const { spawn } = require('child_process');
const exe = process.argv[2];
const args = process.argv.slice(3);
const t0 = Date.now();
const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
p.stdout.on('data', d => out += d);
p.stderr.on('data', d => out += d);
p.on('exit', code => {
  console.log(`EXIT=${code} MS=${Date.now() - t0}`);
  console.log(out.split('\n').slice(0, 4).join('\n'));
});