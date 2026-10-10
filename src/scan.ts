import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export type Kind = 'version-folder' | 'orphan-uninstall';

export interface Finding {
  app: string;
  kind: Kind;
  path: string;
  detail: string;
  sizeBytes: number;
  action: 'delete-folder' | 'delete-key';
  hive?: 'HKCU' | 'HKLM';
}

const VER_RE = /^\d+(\.\d+){0,3}(-[A-Za-z0-9.]+)?$/;

function dirSize(p: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) total += dirSize(fp);
      else { try { total += fs.statSync(fp).size; } catch { /* unreadable file */ } }
    }
  } catch { /* unreadable dir */ }
  return total;
}

function verKey(v: string): number[] {
  return v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
}

function cmpVer(a: string, b: string): number {
  const ka = verKey(a), kb = verKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] || 0) - (kb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Rule 1: versioned pkg folders — <root>\<app>\pkg\<platform>\<version>
// When an app keeps >= 2 versions, all but the highest are update leftovers.
export function scanVersionFolders(root: string): Finding[] {
  const findings: Finding[] = [];
  let apps: string[] = [];
  try { apps = fs.readdirSync(root); } catch { return findings; }
  for (const appName of apps) {
    const pkgDir = path.join(root, appName, 'pkg');
    let platforms: string[] = [];
    try { platforms = fs.readdirSync(pkgDir); } catch { continue; }
    for (const plat of platforms) {
      const platDir = path.join(pkgDir, plat);
      let versions: string[] = [];
      try {
        versions = fs.readdirSync(platDir)
          .filter(v => VER_RE.test(v) && fs.statSync(path.join(platDir, v)).isDirectory());
      } catch { continue; }
      if (versions.length < 2) continue;
      versions.sort(cmpVer);
      const keep = versions[versions.length - 1];
      for (const v of versions.slice(0, -1)) {
        const fp = path.join(platDir, v);
        findings.push({
          app: appName, kind: 'version-folder', path: fp,
          detail: `keep ${keep}`, sizeBytes: dirSize(fp), action: 'delete-folder',
        });
      }
    }
  }
  return findings;
}

const UNINSTALL_ROOTS: Array<{ hive: 'HKCU' | 'HKLM'; key: string }> = [
  { hive: 'HKCU', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  { hive: 'HKLM', key: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  { hive: 'HKLM', key: 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
];

// One recursive query per hive root instead of one spawn per subkey —
// measured: per-key spawns cost ~7s on a real machine, batched ~0.2s.
function regQueryAll(key: string): string | null {
  try {
    return execSync(`reg query "${key}" /s`, {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { return null; }
}

// Candidate paths an uninstall entry points at. If none of them exist on disk,
// the entry is an orphan (BCU's "red row" pattern).
function candidatePaths(vals: Record<string, string>): string[] {
  const cands: string[] = [];
  const il = vals['InstallLocation'];
  if (il && /^[A-Za-z]:\\/.test(il.trim())) cands.push(il.trim());
  for (const name of ['DisplayIcon', 'UninstallString']) {
    const v = vals[name];
    if (!v) continue;
    if (/msiexec/i.test(v)) continue;
    const m = v.match(/([A-Za-z]:\\[^"]*?\.(exe|dll|ico))/i);
    if (m) cands.push(m[1]);
  }
  return cands;
}

const LONG_HIVE: Record<string, string> = { HKCU: 'HKEY_CURRENT_USER', HKLM: 'HKEY_LOCAL_MACHINE' };

export function scanOrphanUninstalls(): Finding[] {
  const findings: Finding[] = [];
  for (const { hive, key } of UNINSTALL_ROOTS) {
    const out = regQueryAll(key);
    if (!out) continue;
    // reg query prints long hive names (HKEY_CURRENT_USER\...), we store short (HKCU\...)
    const prefix = LONG_HIVE[hive] + key.slice(hive.length);
    // /s output: key line at column 0, indented value lines, blank line between blocks
    let current: string | null = null;
    let vals: Record<string, string> = {};
    const flush = () => {
      if (!current) return;
      const cands = candidatePaths(vals);
      if (cands.length && !cands.some(c => fs.existsSync(c))) {
        findings.push({
          app: current.split('\\').pop() || current,
          kind: 'orphan-uninstall', path: key + current.slice(prefix.length),
          detail: `points to missing: ${cands.join(', ')}`,
          sizeBytes: 0, action: 'delete-key', hive,
        });
      }
    };
    for (const line of out.split('\r\n')) {
      if (!line.trim()) { flush(); current = null; vals = {}; continue; }
      if (!line.startsWith('    ')) {
        flush();
        const l = line.trim();
        current = l.startsWith(prefix + '\\') ? l : null;
        vals = {};
      } else if (current) {
        const m = line.trim().match(/^(.+?)\s{2,}REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
        if (m) vals[m[1]] = m[2];
      }
    }
    flush();
  }
  return findings;
}

export function runScan(root?: string): Finding[] {
  const local = root || process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return [...scanVersionFolders(local), ...scanOrphanUninstalls()];
}

export interface CleanResult { done: string[]; skipped: string[]; errors: string[] }

export function clean(findings: Finding[], opts: { execute: boolean; kinds?: Kind[] }): CleanResult {
  const r: CleanResult = { done: [], skipped: [], errors: [] };
  if (!opts.execute) return r;
  for (const f of findings) {
    if (opts.kinds && !opts.kinds.includes(f.kind)) continue;
    try {
      if (f.action === 'delete-folder') {
        fs.rmSync(f.path, { recursive: true, force: true });
        r.done.push(`deleted folder ${f.path} (${(f.sizeBytes / 1048576).toFixed(1)} MB)`);
      } else if (f.action === 'delete-key' && f.hive === 'HKCU') {
        execSync(`reg delete "${f.path}" /f`, { stdio: 'pipe' });
        r.done.push(`deleted key ${f.path}`);
      } else {
        r.skipped.push(`${f.path} (needs elevation)`);
      }
    } catch (e: any) {
      r.errors.push(`${f.path}: ${e.message}`);
    }
  }
  return r;
}

export function report(findings: Finding[]): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const vf = findings.filter(f => f.kind === 'version-folder');
  const ou = findings.filter(f => f.kind === 'orphan-uninstall');
  const mb = vf.reduce((s, f) => s + f.sizeBytes, 0) / 1048576;
  let md = `# Vanish scan — ${now}\n\n`;
  md += `**${findings.length} finding(s), ${mb.toFixed(1)} MB reclaimable.** Dry-run: nothing was deleted. Run \`vanish clean --execute\` to apply.\n\n`;
  md += `## Version-folder leftovers (${vf.length}, ${mb.toFixed(1)} MB)\n\n`;
  if (vf.length) {
    md += `| app | path | size MB | keep |\n|---|---|---|---|\n`;
    for (const f of vf) md += `| ${f.app} | ${f.path} | ${(f.sizeBytes / 1048576).toFixed(1)} | ${f.detail} |\n`;
  } else md += `_none_\n`;
  md += `\n## Orphan uninstall entries (${ou.length})\n\n`;
  if (ou.length) {
    md += `| hive | key | points to |\n|---|---|---|\n`;
    for (const f of ou) md += `| ${f.hive} | ${f.key || f.path} | ${f.detail} |\n`;
  } else md += `_none_\n`;
  return md;
}

export function resultMarkdown(r: CleanResult): string {
  let md = `## Clean result\n\n`;
  md += `- done: ${r.done.length}\n- skipped: ${r.skipped.length}\n- errors: ${r.errors.length}\n`;
  for (const d of r.done) md += `  - ${d}\n`;
  for (const s of r.skipped) md += `  - SKIPPED ${s}\n`;
  for (const e of r.errors) md += `  - ERROR ${e}\n`;
  return md;
}