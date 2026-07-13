// server/stream.mjs
// Watches a repo directory, re-analyzes on change, and broadcasts the graph
// to SSE subscribers. Scoped to the given root (default process.cwd()).
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from './analyze.mjs';

export class GraphBroadcaster {
  constructor(root) {
    this.root = path.resolve(root);
    this.subs = new Set();
    this.watcher = null;
    this.timer = null;
    this.busy = false;
  }

  async current() {
    return await analyze(this.root);
  }

  async subscribe(sub) {
    this.subs.add(sub);
    // push initial snapshot immediately
    try { sub(JSON.stringify(await this.current())); } catch (_) {}
    if (!this.watcher) this.start();
    return () => {
      this.subs.delete(sub);
      if (this.subs.size === 0) this.stop();
    };
  }

  async broadcast() {
    if (this.busy) return;
    this.busy = true;
    try {
      const g = await this.current();
      const payload = JSON.stringify(g);
      for (const sub of this.subs) {
        try { sub(payload); } catch (_) {}
      }
    } catch (e) {
      // analysis failed (e.g. transient parse error) — skip this tick
      console.error('[stream] analyze failed:', e.message);
    } finally {
      this.busy = false;
    }
  }

  start() {
    // recursive watch; debounce bursts of events (save storms)
    const onChange = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.broadcast(), 300);
    };
    this.watcher = fs.watch(this.root, { recursive: true }, (_e, name) => {
      // ignore transient/dot files and our own server modules
      if (name && (name.startsWith('.') || name.endsWith('~'))) return;
      if (name && name.startsWith('server' + path.sep)) return;
      onChange();
    });
    this.watcher.on('error', (e) => console.error('[stream] watch error:', e.message));
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  }
}
