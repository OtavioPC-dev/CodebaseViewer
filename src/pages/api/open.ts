import type { APIRoute } from 'astro';
import { openPath } from '../../../server/open.mjs';

// POST /api/open  { file, line?, col?, root? }
// Launches a native host opener (editor / file manager) for a repo file.
// `root` is the analyzed repo's absolute path (from graph.meta.repo).
export const POST: APIRoute = async ({ request }) => {
  let body: any = {};
  try { body = await request.json(); } catch {}
  const { file, line, col, root, strategy } = body;
  if (!file || typeof file !== 'string') {
    return new Response(JSON.stringify({ error: 'missing file' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const res = openPath({ file, line: line ? Number(line) : undefined, col: col ? Number(col) : 1, root, strategy });
    return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
