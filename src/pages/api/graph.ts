import type { APIRoute } from 'astro';
import { analyze } from '../../../server/analyze.mjs';

// GET /api/graph?path=<repo>  (default: this project's own root)
export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get('path');
  const target = q ? q : process.cwd();
  try {
    const graph = await analyze(target);
    return new Response(JSON.stringify(graph), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
