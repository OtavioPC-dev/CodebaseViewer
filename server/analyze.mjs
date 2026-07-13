// server/analyze.mjs
// Self-contained codebase analysis engine (Node-native tree-sitter).
// Multithreaded file parsing via worker_threads; cross-file resolution in main.
// Produces a graph model: file/definition/imported-external nodes + edges.
// Edge kinds: structure (file->def), calls (def->def, cross-file resolved),
//             imports (file->external module), io-in / io-out (data boundaries).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { analyzeFile, langForFile, SUPPORTED, setIoSeq, logoSlug } from './analyzers.mjs';

const ioSeq = new Map();
setIoSeq(ioSeq);

// Resolve an installed dependency version for an imported external module label.
function libVersion(label, root, pkgDeps) {
  if (label.startsWith('node:')) return null;
  let nmPath;
  if (label.startsWith('@')) {
    const [scope, name] = label.split('/');
    nmPath = path.join(root, 'node_modules', scope, name);
  } else {
    nmPath = path.join(root, 'node_modules', label);
  }
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(nmPath, 'package.json'), 'utf8'));
    return pj.version;
  } catch { }
  return pkgDeps[label] || null;
}

function walk(root, files = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', '__pycache__', '.astro',
           '.venv', 'venv', 'env', 'site-packages', 'vendor', 'bower_components',
           'target', '.tox', '.eggs', 'Pipfile'].includes(entry.name)) continue;
      walk(full, files);
    } else if (entry.isFile()) {
      if (SUPPORTED.has(path.extname(full))) files.push(full);
    }
  }
  return files;
}

// Run the per-file analysis across a worker pool. Falls back to inline
// (single thread) if workers cannot be created.
async function analyzeFiles(files, abs, onProgress) {
  const defs = [], edges = [], nodes = [];
  if (files.length === 0) return { defs, edges, nodes };

  const useWorkers = process.env.CV_NO_WORKERS !== '1' && files.length > 1;
  if (!useWorkers) {
    let done = 0;
    for (const f of files) {
      const r = analyzeFile(f, abs);
      defs.push(...r.defs); edges.push(...r.edges); nodes.push(...r.nodes);
      done++;
      if (onProgress) onProgress(done, files.length);
    }
    return { defs, edges, nodes };
  }

  const n = Math.max(1, Math.min(os.cpus().length, files.length));
  const batches = Array.from({ length: n }, () => []);
  files.forEach((f, i) => batches[i % n].push({ file: f, abs }));

  let done = 0;
  const results = await Promise.all(
    batches.map((batch) => new Promise((resolve) => {
      if (batch.length === 0) return resolve([]);
      const w = new Worker(new URL('./analyze.worker.mjs', import.meta.url));
      w.on('message', (m) => { resolve(m); w.terminate(); });
      w.on('error', (e) => { resolve(batch.map(() => ({ defs: [], edges: [], nodes: [], error: String(e) }))); w.terminate(); });
      w.postMessage(batch);
    }).then((r) => { done += batch.length; if (onProgress) onProgress(done, files.length); return r; })
    )
  );
  for (const batch of results) for (const r of batch) {
    defs.push(...r.defs); edges.push(...r.edges); nodes.push(...r.nodes);
  }
  return { defs, edges, nodes };
}

export async function analyze(repoPath, hooks = {}) {
  const { onPhase, onProgress } = hooks;
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(abs)) throw new Error(`path not found: ${abs}`);
  ioSeq.clear();
  let pkgDeps = {};
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
    pkgDeps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
  } catch { }

  if (onPhase) onPhase('walk');
  const files = walk(abs);
  if (onPhase) onPhase('parse');
  const { defs, edges, nodes } = await analyzeFiles(files, abs, onProgress);

  // ---- cross-file symbol resolution ----
  if (onPhase) onPhase('resolve');
  const byName = new Map();
  for (const d of defs) {
    if (!byName.has(d.name)) byName.set(d.name, []);
    byName.get(d.name).push(d);
  }
  const fileDefs = new Map();
  for (const d of defs) {
    if (!fileDefs.has(d.file)) fileDefs.set(d.file, []);
    fileDefs.get(d.file).push(d);
  }

  let resolved = 0;
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    const srcFile = e.source.includes('::') ? e.source.split('::')[0] : e.source;
    const candidates = byName.get(e.target);
    if (!candidates || candidates.length === 0) { e.resolved = false; continue; }
    let hit = candidates.find(c => c.file === srcFile);
    if (!hit && candidates.length === 1) hit = candidates[0];
    else if (!hit && candidates.length > 1) hit = candidates[0];
    if (hit) { e.target = hit.id; e.fromName = e.target; e.resolved = true; resolved++; }
    else e.resolved = false;
  }

  // ---- import resolution: relative specifier -> repo file; bare -> external ----
  const fileSet = new Set(nodes.filter(n => n.kind === 'file').map(n => n.id));
  const exts = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.astro', '.svelte', '.h', '.hpp', '.hh', '.hxx', '.c', '.cpp', '.cc', '.cxx'];
  const idxNames = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.jsx', '__init__.py'];
  const resolveRelative = (fromFile, spec) => {
    const baseDir = fromFile.split('/').slice(0, -1).join('/');
    let joined = spec.startsWith('.') ? path.posix.normalize(path.posix.join(baseDir, spec)) : spec;
    if (joined.startsWith('./')) joined = joined.slice(2);
    for (const e of exts) { const cand = joined + e; if (fileSet.has(cand)) return cand; }
    for (const idx of idxNames) { const cand = (joined ? joined + '/' : '') + idx; if (fileSet.has(cand)) return cand; }
    return null;
  };
  for (const e of edges) {
    if (e.kind !== 'imports' || !e.spec) continue;
    const fromFile = e.source;   // the file that declares the import
    const isRelative = e.spec.startsWith('.') || e.spec.startsWith('/');
    let targetFile = isRelative ? resolveRelative(fromFile, e.spec) : null;
    if (targetFile && targetFile !== fromFile) {
      // Direction = data flow: the imported module flows INTO the importing file.
      e.source = targetFile; e.target = fromFile; e.resolvedImport = true;
    } else {
      // C/C++ system includes (#include <foo.h>) and JS bare specs both map to external
      const label = e.spec.startsWith('@') ? e.spec.split('/').slice(0, 2).join('/')
        : (e.spec.startsWith('<') ? e.spec.replace(/[<>]/g, '') : e.spec.split('/')[0]);
      if (!label || label === '.' || label === '..') { e.target = fromFile; e.resolvedImport = true; delete e.spec; continue; }
      const extId = `external::${label}`;
      if (!nodes.some(n => n.id === extId)) {
        const ver = label.startsWith('node:') ? null : libVersion(label, abs, pkgDeps);
        const extLabel = ver ? `${label}@${ver}` : label;
        const slug = logoSlug(label, null);
        nodes.push({ id: extId, kind: 'external', label, version: ver || null, display: extLabel, logo: slug || undefined });
      }
      // dependency -> file
      e.source = extId; e.target = fromFile; e.resolvedImport = false;
    }
    delete e.spec;
  }

  const ioNodes = nodes.filter((n) => n.kind === 'io-input' || n.kind === 'io-output').length;
  return {
    meta: { repo: abs, files: files.length, defs: defs.length, edges: edges.length, resolved, io: ioNodes },
    nodes,
    edges,
  };
}

// when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || process.cwd();
  const g = await analyze(target);
  console.log(JSON.stringify(g.meta, null, 2));
  fs.writeFileSync(path.join(process.cwd(), 'graph.json'), JSON.stringify(g));
  console.log('wrote graph.json');
}
