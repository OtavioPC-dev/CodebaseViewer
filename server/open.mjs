// server/open.mjs
// Native "open in host" bridge. The browser can't touch the filesystem, so the
// Astro server (running locally as the user) shells out to a configured opener.
// Every path is validated to stay inside the analyzed repo root before launch.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function binExists(name) {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try { if (fs.existsSync(path.join(dir, name))) return true; } catch {}
  }
  return false;
}

// Resolve which opener to use. Precedence: $CV_OPEN override > code > $EDITOR > xdg-open.
function chooseStrategy() {
  if (process.env.CV_OPEN) return process.env.CV_OPEN;
  if (binExists('code')) return 'code';
  if (process.env.EDITOR) return 'editor';
  return 'xdg';
}

function desktopEnv() {
  const d = (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase();
  if (d.includes('kde')) return 'kde';
  if (d.includes('gnome') || d.includes('unity')) return 'gnome';
  if (d.includes('xfce')) return 'xfce';
  return 'other';
}

// Build the argv for a given strategy. Returns null if not applicable.
function buildArgs(strategy, abs, line, col) {
  switch (strategy) {
    case 'code':
      return line ? ['code', '--goto', `${abs}:${line}:${col || 1}`] : ['code', abs];
    case 'editor': {
      const e = process.env.EDITOR || 'vi';
      return line ? [e, `+${line}`, abs] : [e, abs];
    }
    case 'fm': {
      const dir = path.dirname(abs);
      switch (desktopEnv()) {
        case 'kde': return ['dolphin', '--select', abs];
        case 'gnome': return ['nautilus', '--select', abs];
        case 'xfce': return ['thunar', abs];
        default: return ['xdg-open', dir];
      }
    }
    case 'xdg':
      return ['xdg-open', abs];
    default:
      return null;
  }
}

// Launch the opener for a repo file. Returns { ok, method, cmd } or throws.
// `strategy` (optional) is the user's explicit choice; if omitted we fall back
// to the configured/default opener.
export function openPath({ file, line, col, root, strategy }) {
  // `file` is a repo-relative path (e.g. "server/analyze.mjs").
  const rootAbs = path.resolve(root || process.cwd());
  const abs = path.resolve(rootAbs, file);
  // hard guard: target must live inside the repo root (no traversal escapes).
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error('path escapes repo root: ' + file);
  }
  if (!fs.existsSync(abs)) throw new Error('file not found: ' + abs);

  const strat = strategy || chooseStrategy();
  const argv = buildArgs(strat, abs, line, col);
  if (!argv) throw new Error('unknown open strategy: ' + strat);
  const bin = argv[0];
  const args = argv.slice(1);
  try {
    // detached so the server doesn't wait; ignores stdout/stderr
    const child = execFile(bin, args, { detached: true, stdio: 'ignore' }, () => {});
    child.unref();
  } catch (e) {
    throw new Error(`failed to launch ${bin}: ${e.message}`);
  }
  return { ok: true, method: strat, cmd: [bin, ...args].join(' ') };
}
