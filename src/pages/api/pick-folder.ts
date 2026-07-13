import type { APIRoute } from 'astro';
import { spawnSync } from 'node:child_process';

// GET /api/pick-folder -> opens a native folder picker and returns the chosen path.
// Uses zenity (Linux). Falls back to kdialog / osascript when available.
export const GET: APIRoute = async () => {
  const env = { ...process.env };
  let out = '';
  // 1) zenity (preferred; works on Wayland + X11)
  try {
    const r = spawnSync('zenity', ['--file-selection', '--directory', '--title=Select a codebase folder'], { encoding: 'utf8', timeout: 60000, env });
    if (r.status === 0 && r.stdout) out = r.stdout.trim();
  } catch { /* ignore */ }
  // 2) kdialog fallback
  if (!out) {
    try {
      const r = spawnSync('kdialog', ['--getexistingdirectory', '/'], { encoding: 'utf8', timeout: 60000, env });
      if (r.status === 0 && r.stdout) out = r.stdout.trim();
    } catch { /* ignore */ }
  }
  // 3) macOS fallback
  if (!out && process.platform === 'darwin') {
    try {
      const r = spawnSync('osascript', ['-e', 'POSIX path of (choose folder)'], { encoding: 'utf8', timeout: 60000 });
      if (r.status === 0 && r.stdout) out = r.stdout.trim();
    } catch { /* ignore */ }
  }
  if (!out) return new Response(JSON.stringify({ path: null }), { headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ path: out }), { headers: { 'Content-Type': 'application/json' } });
};
