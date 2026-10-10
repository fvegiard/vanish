import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runScan, clean, report, resultMarkdown, Finding, Kind } from './scan';

// Zero trace: userData lives in %TEMP% and is removed on quit. No registry,
// no %APPDATA% folders, no installer — unzip and run.
const userData = path.join(os.tmpdir(), `vanish-run-${process.pid}`);
app.setPath('userData', userData);

function isPackagedArgv(): string[] {
  return app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
}

function parseKinds(args: string[]): Kind[] | undefined {
  const i = args.indexOf('--kind');
  if (i === -1) return undefined;
  return args[i + 1]?.split(',') as Kind[];
}

function cleanupSelf() {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Sweep run-dirs left by dead instances (crash / force-kill). A dir is stale
// when its PID no longer exists. Runs at startup, before anything else.
function sweepStaleRuns(): void {
  const tmp = os.tmpdir();
  let entries: string[] = [];
  try { entries = fs.readdirSync(tmp).filter(n => n.startsWith('vanish-run-')); } catch { return; }
  for (const name of entries) {
    const pid = parseInt(name.slice('vanish-run-'.length), 10);
    if (!pid || pid === process.pid) continue;
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (!alive) { try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); } catch { /* locked or gone */ } }
  }
}
sweepStaleRuns();

// process.stdout.write is async on pipes; app.exit() can truncate it.
// fs.writeSync is synchronous — deterministic CLI output, fallback to stream.
function w(fd: number, s: string): void {
  try { fs.writeSync(fd, s); return; } catch { /* fall through to stream */ }
  try { (fd === 1 ? process.stdout : process.stderr).write(s); } catch { /* ignore */ }
}

function cli(args: string[]): void {
  const cmd = args[0];
  const rootIdx = args.indexOf('--root');
  const root = rootIdx !== -1 ? args[rootIdx + 1] : undefined;
  try {
    if (cmd === 'scan' || cmd === 'clean') {
      const findings = runScan(root);
      if (args.includes('--json')) w(1, JSON.stringify(findings, null, 2) + '\n');
      else w(1, report(findings));
      if (cmd === 'clean' && args.includes('--execute')) {
        const r = clean(findings, { execute: true, kinds: parseKinds(args) });
        w(1, '\n' + resultMarkdown(r));
      }
    } else {
      w(1, `vanish — zero-trace uninstaller\n\nusage:\n  vanish scan [--json] [--root DIR]   markdown (or json) report, dry-run\n  vanish clean --execute [--kind ...]  apply the plan (default: dry-run)\n  vanish                              open the one-click window\n`);
    }
  } catch (e: any) {
    w(2, `VANISH_ERROR: ${e.name}: ${e.message}\n`);
  } finally {
    cleanupSelf();
    app.exit(0);
  }
}

function gui(): void {
  app.whenReady().then(() => {
    ipcMain.handle('vanish:scan', () => {
      const findings = runScan();
      return { md: report(findings), findings };
    });
    ipcMain.handle('vanish:clean', (_e, kinds?: Kind[]) => {
      const findings = runScan();
      return resultMarkdown(clean(findings, { execute: true, kinds }));
    });
    const win = new BrowserWindow({
      width: 920, height: 680, title: 'Vanish',
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Vanish</title>
<style>body{font-family:Consolas,monospace;background:#111;color:#ddd;margin:12px}
button{font-family:inherit;font-size:14px;padding:6px 14px;margin-right:8px;cursor:pointer}
pre{white-space:pre-wrap;font-size:12px}</style></head><body>
<button id="scan">Scan</button><button id="clean">Clean (execute)</button>
<pre id="out">Click Scan.</pre>
<script>
const out = document.getElementById('out');
document.getElementById('scan').onclick = async () => { out.textContent = 'scanning...'; out.textContent = (await window.vanish.scan()).md; };
document.getElementById('clean').onclick = async () => {
  if (!confirm('Delete everything in the current plan? This cannot be undone.')) return;
  out.textContent = 'cleaning...'; out.textContent = await window.vanish.clean();
};
</script></body></html>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
  app.on('will-quit', cleanupSelf);
}

const args = isPackagedArgv();
if (args.length && args[0] !== '--') cli(args);
else gui();