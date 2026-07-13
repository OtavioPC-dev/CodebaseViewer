import type { APIRoute } from 'astro';
import { GraphBroadcaster } from '../../../server/stream.mjs';

// module-level singletons keyed by repo root
const broadcasters = new Map<string, GraphBroadcaster>();

function getBroadcaster(root: string): GraphBroadcaster {
  let b = broadcasters.get(root);
  if (!b) { b = new GraphBroadcaster(root); broadcasters.set(root, b); }
  return b;
}

// GET /api/stream?path=<repo>  -> Server-Sent Events of the graph JSON
export const GET: APIRoute = ({ url, request }) => {
  const q = url.searchParams.get('path');
  const target = q ? q : process.cwd();
  const b = getBroadcaster(target);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); } catch (_) {}
      };
      b.subscribe(send).then((unsub) => { cleanupUnsub = unsub; }).catch(() => {});
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); } catch (_) {}
      }, 15000);

      let cleanupUnsub: any = null;
      const cleanup = () => {
        clearInterval(ping);
        if (typeof cleanupUnsub === 'function') cleanupUnsub();
        try { controller.close(); } catch (_) {}
      };

      // close the stream when the client disconnects
      if (request.signal) {
        if (request.signal.aborted) cleanup();
        else request.signal.addEventListener('abort', cleanup, { once: true });
      }
    },
    cancel() {
      // also called on client abort
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
