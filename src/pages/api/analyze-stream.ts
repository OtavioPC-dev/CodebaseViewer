import type { APIRoute } from 'astro';
import { analyze } from '../../../server/analyze.mjs';

// GET /api/analyze-stream?path=<repo>
// Streams progress events then the full graph:
//   data: {"phase":"walk"|"parse"|"resolve"}
//   data: {"phase":"parse","done":N,"total":M}
//   data: GRAPH <graph JSON>
//   data: {"error":"..."}
export const GET: APIRoute = ({ url, request }) => {
  const q = url.searchParams.get('path');
  const target = q ? q : process.cwd();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch (_) {}
      };
      const sendGraph = (g: any) => {
        try { controller.enqueue(encoder.encode(`data: GRAPH ${JSON.stringify(g)}\n\n`)); } catch (_) {}
      };
      try {
        const g = await analyze(target, {
          onPhase: (p: string) => send({ phase: p }),
          onProgress: (done: number, total: number) => send({ phase: 'parse', done, total }),
        });
        sendGraph(g);
      } catch (e) {
        send({ error: String(e) });
      }
      try { controller.close(); } catch (_) {}
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
};
