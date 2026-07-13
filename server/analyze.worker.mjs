// server/analyze.worker.mjs
// Worker entry: receives a batch of {file, abs} and returns analyzed partials.
import { parentPort } from 'node:worker_threads';
import { analyzeFile } from './analyzers.mjs';

parentPort.on('message', (batch) => {
  const out = [];
  for (const { file, abs } of batch) {
    try {
      out.push(analyzeFile(file, abs));
    } catch (e) {
      out.push({ rel: file, defs: [], edges: [], nodes: [], error: String(e) });
    }
  }
  parentPort.postMessage(out);
});
