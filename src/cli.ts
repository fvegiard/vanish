// Plain-Node CLI entry (no electron) — same engine as the packaged exe.
// Test: node dist/cli.js scan [--json] [--root DIR]
import * as fs from 'fs';
import { runScan, clean, report, resultMarkdown, Kind } from './scan';

function w(fd: number, s: string): void {
  try { fs.writeSync(fd, s); return; } catch { /* fall through */ }
  try { (fd === 1 ? process.stdout : process.stderr).write(s); } catch { /* ignore */ }
}

const args = process.argv.slice(2);
const cmd = args[0];
const rootIdx = args.indexOf('--root');
const root = rootIdx !== -1 ? args[rootIdx + 1] : undefined;
try {
  if (cmd === 'scan' || cmd === 'clean') {
    const findings = runScan(root);
    if (args.includes('--json')) w(1, JSON.stringify(findings, null, 2) + '\n');
    else w(1, report(findings));
    if (cmd === 'clean' && args.includes('--execute')) {
      const ki = args.indexOf('--kind');
      const kinds = ki !== -1 ? (args[ki + 1]?.split(',') as Kind[]) : undefined;
      const r = clean(findings, { execute: true, kinds });
      w(1, '\n' + resultMarkdown(r));
    }
  } else {
    w(1, `vanish — zero-trace uninstaller\n\nusage:\n  vanish scan [--json] [--root DIR]   markdown (or json) report, dry-run\n  vanish clean --execute [--kind ...]  apply the plan (default: dry-run)\n  vanish                              open the one-click window\n`);
  }
} catch (e: any) {
  w(2, `VANISH_ERROR: ${e.name}: ${e.message}\n`);
  process.exit(1);
}
process.exit(0);