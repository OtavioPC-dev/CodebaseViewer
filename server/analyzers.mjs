// server/analyzers.mjs
// Per-file analyzers + parser setup. Imported by both the main thread
// (fallback) and the worker pool (server/analyze.worker.mjs).

import fs from 'node:fs';
import path from 'node:path';
import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import PY from 'tree-sitter-python';
import JS from 'tree-sitter-javascript';
import CPP from 'tree-sitter-cpp';
import C from 'tree-sitter-c';

// ---- dependency logo resolution (Simple Icons slugs) ----
// Maps a module/package label to its Simple Icons brand slug so the client
// can lazily fetch the SVG from the CDN. Only popular/known libs get a slug;
// everything else returns null (rendered as plain text, no network).
const LOGO_MAP = {
  react: 'react', next: 'nextdotjs', vue: 'vuedotjs', nuxt: 'nuxt',
  svelte: 'svelte', astro: 'astro', vite: 'vite', webpack: 'webpack',
  rollup: 'rollup', esbuild: 'esbuild', typescript: 'typescript',
  javascript: 'javascript', tailwindcss: 'tailwindcss', express: 'express',
  axios: 'axios', lodash: 'lodash', redux: 'redux', graphql: 'graphql',
  jest: 'jest', mocha: 'mocha', eslint: 'eslint', prettier: 'prettier',
  django: 'django', flask: 'flask', fastapi: 'fastapi', numpy: 'numpy',
  pandas: 'pandas', scipy: 'scipy', matplotlib: 'matplotlib',
  django: 'django', flask: 'flask', fastapi: 'fastapi', numpy: 'numpy',
  python: 'python', node: 'nodedotjs', docker: 'docker', postgresql: 'postgresql',
  redis: 'redis', mongodb: 'mongodb', sqlite: 'sqlite', prisma: 'prisma',
  graphql: 'graphql', three: 'threedotjs', d3: 'd3', d3: 'd3',
};
const STD_NODE = new Set(['fs', 'path', 'os', 'http', 'https', 'crypto', 'util', 'events',
  'stream', 'buffer', 'child_process', 'net', 'dns', 'url', 'querystring', 'zlib',
  'tls', 'process', 'assert', 'perf_hooks', 'worker_threads', 'readline', 'tty']);
const STD_PY = new Set(['os', 'sys', 'json', 'pathlib', 'datetime', 're', 'math', 'time',
  'random', 'collections', 'itertools', 'functools', 'typing', 'argparse', 'subprocess',
  'io', 'threading', 'asyncio', 'enum', 'dataclasses', 'abc', 'copy', 'pickle', 'csv',
  'urllib', 'hashlib', 'base64', 'string', 'logging', 'warnings', 'inspect', 'glob',
  'tempfile', 'shutil', 'unittest', 'warnings', 'types', 'fractions', 'decimal',
  'heapq', 'bisect', 'array', 'weakref', 'contextlib', 'signal', 'mmap']);

export function logoSlug(label, lang) {
  if (!label) return null;
  let name = label.replace(/^node:/, '');          // node:fs -> fs
  if (name.startsWith('@')) name = name.split('/')[1] || name;  // @scope/name -> name
  name = name.split('/')[0].toLowerCase();
  if (STD_NODE.has(name) || STD_PY.has(name)) return null;
  if (LOGO_MAP[name]) return LOGO_MAP[name];
  // best-effort: normalize package name to a likely slug
  const norm = name.replace(/[^a-z0-9]/g, '');
  return norm || null;
}

const tsParser = new Parser(); tsParser.setLanguage(TS.typescript);
const tsxParser = new Parser(); tsxParser.setLanguage(TS.tsx);
const pyParser = new Parser(); pyParser.setLanguage(PY);
const jsParser = new Parser(); jsParser.setLanguage(JS);
const cppParser = new Parser(); cppParser.setLanguage(CPP);
const cParser = new Parser(); cParser.setLanguage(C);

export const SUPPORTED = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.astro', '.svelte', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h', '.hxx', '.c',
]);

export function langForFile(f) {
  const ext = path.extname(f);
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return ext === '.tsx' ? 'tsx' : 'ts';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'js';
  if (ext === '.py') return 'py';
  if (ext === '.astro' || ext === '.svelte') return 'js-embedded';
  if (['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h', '.hxx'].includes(ext)) return 'cpp';
  if (ext === '.c') return 'c';
  return null;
}

// ---- shared io boundary emission (used by all languages) ----
let ioSeq = new Map();
export function setIoSeq(m) { ioSeq = m; }

const ioSurfaceMap = {
  fopen: ['file', 'in'], fclose: ['file', 'out'], fcloseall: ['file', 'out'],
  fread: ['file', 'in'], fwrite: ['file', 'out'], fgets: ['file', 'in'], fputs: ['file', 'out'],
  fscanf: ['file', 'in'], fprintf: ['file', 'out'], fputs: ['file', 'out'],
  freopen: ['file', 'in'], fseek: ['file', 'out'], ftell: ['file', 'in'], rewind: ['file', 'in'],
  printf: ['console', 'out'], fprintf: ['console', 'out'], sprintf: ['console', 'out'],
  scanf: ['console', 'in'], perror: ['console', 'out'], puts: ['console', 'out'], putchar: ['console', 'out'],
  open: ['file', 'in'], read: ['file', 'in'], write: ['file', 'out'], close: ['file', 'out'],
  creat: ['file', 'out'], opendir: ['folder', 'in'], readdir: ['folder', 'in'], closedir: ['folder', 'out'],
  mkdir: ['folder', 'out'], rmdir: ['folder', 'out'], remove: ['file', 'out'], rename: ['file', 'out'],
  unlink: ['file', 'out'],
};

// Infer a human data type from a payload + surface (cheap heuristic).
function inferDataType(surface, detail) {
  if (!detail) return null;
  if (surface === 'file' || surface === 'folder') {
    const ext = detail.split('?')[0].split('#')[0].split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    const map = { json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', csv: 'csv',
      tsv: 'tsv', sql: 'sql', db: 'sqlite', sqlite: 'sqlite', sqlite3: 'sqlite', png: 'image', jpg: 'image',
      jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', mp4: 'video', mp3: 'audio', pdf: 'pdf',
      txt: 'text', md: 'text', log: 'text', env: 'env', html: 'html', htm: 'html', lock: 'lockfile' };
    if (map[ext]) return map[ext];
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'mjs', 'cjs', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'java'].includes(ext)) return 'code';
    return 'file';
  }
  if (surface === 'network') {
    if (/^wss?:\/\//i.test(detail)) return 'ws';
    if (/^https?:\/\//i.test(detail)) return 'http';
    if (/^(\/\/|localhost|[\w.-]+\.\w{2,})/i.test(detail)) return 'url';
    return 'request';
  }
  if (surface === 'database') return 'sql';
  if (surface === 'env') return 'env';
  if (surface === 'error') return 'log';
  if (surface === 'log') return 'log';
  if (surface === 'response') return 'http';
  if (surface === 'json') return 'json';
  if (surface === 'console') return 'log';
  if (surface === 'browser') return 'dom';
  return null;
}

const SENSITIVE_RE = /(key|token|secret|password|passwd|api_?key|auth|cookie|session|credential)/i;
function isSensitive(surface, detail, verb) {
  if (surface === 'env') return true;
  const s = `${verb} ${detail || ''}`;
  return SENSITIVE_RE.test(s);
}

// Attach payload + inferred type + sensitivity to a classifier result.
function decorate(c, arg0) {
  if (!c) return null;
  let detail = arg0 ? arg0.replace(/^['"`]|['"`]$/g, '').trim() : '';
  if (!detail) detail = null;
  const dataType = inferDataType(c.surface, detail);
  const sensitive = isSensitive(c.surface, detail, c.verb);
  return { ...c, detail, dataType, sensitive };
}

function classifyCppCall(full, arg0) {
  const m = String(full).split('(')[0];
  const dot = m.lastIndexOf('::');
  const name = (dot >= 0 ? m.slice(dot + 2) : m).toLowerCase();
  const hit = ioSurfaceMap[name];
  if (hit) return { dir: hit[1], surface: hit[0], verb: name };
  if (name === 'std::cout' || name === 'cout' || name === 'std::cerr' || name === 'cerr') return { dir: 'out', surface: 'console', verb: 'cout' };
  if (name === 'std::cin' || name === 'cin') return { dir: 'in', surface: 'console', verb: 'cin' };
  if (name === 'new') return null;
  if (name === 'delete' || name === 'delete[]') return null;
  return null;
}

// JS / TS / Python call classification (HTTP, fs, DB, console, DOM, …)
function classifyCall(full, arg0) {
  const m = String(full).split('(')[0];
  const dot = m.lastIndexOf('.');
  const obj = dot >= 0 ? m.slice(0, dot).toLowerCase() : '';
  const meth = (dot >= 0 ? m.slice(dot + 1) : m).toLowerCase();
  if (obj === 'requests') {
    if (['get', 'head', 'options'].includes(meth)) return { dir: 'in', surface: 'network', verb: 'requests.' + meth };
    if (['post', 'put', 'patch', 'delete'].includes(meth)) return { dir: 'out', surface: 'network', verb: 'requests.' + meth };
  }
  if (obj === 'os') {
    if (meth === 'listdir' || meth === 'walk' || meth === 'scandir') return { dir: 'in', surface: 'folder', verb: meth };
    if (meth === 'makedirs' || meth === 'mkdir' || meth === 'rename' || meth === 'remove') return { dir: 'out', surface: 'folder', verb: meth };
  }
  if (meth === 'fetch') return { dir: 'in', surface: 'network', verb: 'fetch' };
  if (obj === 'request') return { dir: 'in', surface: 'network', verb: 'request' };
  if (meth === 'response') return { dir: 'out', surface: 'response', verb: 'Response' };
  if (meth === 'enqueue' && (obj === 'controller' || obj.includes('controller'))) return { dir: 'out', surface: 'browser', verb: 'enqueue' };
  if (meth === 'send' && obj === 'res' || (meth === 'json' && obj === 'res') || (meth === 'render' && obj === 'res')) return { dir: 'out', surface: 'browser', verb: meth };
  if (meth === 'write' && (obj.includes('document') || obj.includes('el') || obj.includes('elem'))) return { dir: 'out', surface: 'browser', verb: 'write' };
  if (meth === 'innerhtml' || meth === 'textcontent' || meth === 'insertadjacenthtml' || meth === 'appendchild') return { dir: 'out', surface: 'browser', verb: meth };
  if (obj === 'location' && (meth === 'assign' || meth === 'replace' || meth === 'href')) return { dir: 'out', surface: 'browser', verb: meth };
  if (meth === 'readfile' || meth === 'readfilesync' || meth === 'createreadstream' || meth === 'readfileasstream' || meth === 'read') return { dir: 'in', surface: 'file', verb: meth };
  if (['readdir', 'readdirsync', 'readdirasync'].includes(meth)) return { dir: 'in', surface: 'folder', verb: meth };
  if (['req', 'request', 'ctx'].includes(obj) && ['json', 'body', 'query', 'params', 'args', 'form', 'data', 'files'].includes(meth)) return { dir: 'in', surface: 'network', verb: meth };
  if (/(db|sql|prisma|mongoose|knex|cursor)/.test(obj) && ['query', 'find', 'findone', 'get', 'select', 'raw', 'all', 'fetchone', 'fetchall'].includes(meth)) return { dir: 'in', surface: 'database', verb: meth };
  if (meth === 'input') return { dir: 'in', surface: 'form', verb: 'input' };
  if (meth === 'open') {
    const a = String(arg0 || '').replace(/['\"]/g, '').toLowerCase();
    if (/[wax+]/.test(a) && !a.includes('r')) return { dir: 'out', surface: 'file', verb: 'open' };
    return { dir: 'in', surface: 'file', verb: 'open' };
  }
  if (['res', 'response', 'ctx', 'reply'].includes(obj) && ['send', 'json', 'render', 'end', 'status', 'redirect', 'write', 'body'].includes(meth)) return { dir: 'out', surface: 'response', verb: meth };
  if (['writefile', 'writefilesync', 'appendfile', 'appendfilesync', 'createwritestream', 'writefileasstream'].includes(meth)) return { dir: 'out', surface: 'file', verb: meth };
  if (['mkdir', 'mkdirsync', 'mkdirp', 'cp', 'cpsync', 'copy', 'copysync', 'symlink'].includes(meth)) return { dir: 'out', surface: 'folder', verb: meth };
  if (/(db|sql|prisma|mongoose|knex|cursor)/.test(obj) && ['insert', 'insertone', 'update', 'updateone', 'save', 'create', 'put', 'delete', 'deleteone', 'remove', 'bulkwrite'].includes(meth)) return { dir: 'out', surface: 'database', verb: meth };
  if (obj === 'console' && ['error', 'warn', 'warnonce', 'trace', 'assert'].includes(meth)) return { dir: 'out', surface: 'error', verb: meth };
  if (obj === 'console' && ['log', 'info', 'debug'].includes(meth)) return { dir: 'out', surface: 'log', verb: meth };
  if (obj === 'json' && meth === 'stringify') return { dir: 'out', surface: 'json', verb: 'stringify' };
  if (obj === 'console' && meth === 'print') return { dir: 'out', surface: 'log', verb: 'print' };
  return null;
}

function emitBoundary(file, ownerId, full, arg0, nodes, edges, lang) {
  const raw = (lang === 'cpp' || lang === 'c') ? classifyCppCall(full, arg0) : classifyCall(full, arg0);
  const c = raw ? decorate(raw, arg0) : null;
  if (!c) return;
  const kind = c.dir === 'in' ? 'io-input' : 'io-output';
  // Aggregate-by-type surfaces: one node per owner+type, ignoring message text.
  const AGG = new Set(['error', 'log', 'response', 'json', 'console', 'browser']);
  const aggregate = AGG.has(c.surface);
  if (aggregate) {
    const id = `io::${c.dir}::${ownerId}::${c.surface}`;
    const existing = nodes.find((n) => n.id === id);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.label = `${c.surface} ×${existing.count}`;
      if (c.detail && (!existing.samples || existing.samples.length < 5)) existing.samples.push(c.detail);
      return;
    }
    const label = `${c.surface}`;
    nodes.push({ id, kind, label, file, surface: c.surface, dir: c.dir, owner: ownerId,
      count: 1, dataType: c.dataType, sensitive: c.sensitive, aggregate: true, _base: label,
      samples: c.detail ? [c.detail] : [] });
    edges.push({ source: ownerId, target: id, kind: c.dir === 'in' ? 'io-in' : 'io-out', surface: c.surface });
    return;
  }
  // Data surfaces: distinct payloads stay separate.
  const payloadText = c.detail ? c.detail : '';
  const typeText = c.dataType ? ` (${c.dataType})` : '';
  const label = `${c.verb} ${payloadText}${typeText}`.trim();
  const id = `io::${c.dir}::${ownerId}::${c.surface}::${c.verb}::${c.detail || ''}`;
  const existing = nodes.find((n) => n.id === id);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.label = `${existing._base} ×${existing.count}`;
    return;
  }
  nodes.push({
    id, kind, label, file, surface: c.surface, dir: c.dir, owner: ownerId,
    count: 1, payload: c.detail, dataType: c.dataType, sensitive: c.sensitive,
    _base: label,
  });
  edges.push({ source: ownerId, target: id, kind: c.dir === 'in' ? 'io-in' : 'io-out', surface: c.surface });
}

// ---- JS / TS / TSX ----
function analyzeJS(src, lang, file, defs, edges, nodes) {
  const parser = lang === 'ts' ? tsParser : lang === 'tsx' ? tsxParser : jsParser;
  const tree = parser.parse(src);
  const root = tree.rootNode;
  const visit = (node, scopeStack) => {
    let defName = null, defId = null, kind = null;
    if (['function_declaration', 'generator_function_declaration', 'function_expression', 'arrow_function'].includes(node.type)) {
      const id = node.childForFieldName('name');
      if (id) { defName = id.text; kind = 'function'; }
    } else if (node.type === 'class_declaration' || node.type === 'class_expression') {
      const id = node.childForFieldName('name');
      if (id) { defName = id.text; kind = 'class'; }
    } else if (node.type === 'method_definition') {
      const id = node.childForFieldName('name');
      if (id) { defName = id.text; kind = 'method'; }
    } else if (node.type === 'variable_declarator') {
      const id = node.childForFieldName('name');
      if (id && (node.parent?.type === 'variable_declaration')) {
        const init = node.childForFieldName('value');
        if (init && ['function_expression', 'arrow_function'].includes(init.type)) { defName = id.text; kind = 'function'; }
      }
    }
    if (defName && kind) {
      defId = `${file}::${defName}`;
      if (kind === 'method') { const cls = scopeStack.find(s => s.kind === 'class'); if (cls) defId = `${file}::${cls.name}.${defName}`; }
      defs.push({ id: defId, name: defName, kind, file, lang });
      nodes.push({ id: defId, kind, label: defName, file, lang, line: node.startPosition.row + 1, col: node.startPosition.column + 1 });
      edges.push({ source: file, target: defId, kind: 'structure' });
      scopeStack = [...scopeStack, { name: defName, kind }];
    }
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const strChild = node.namedChildren.find(c => c.type === 'string');
      if (strChild) edges.push({ source: file, kind: 'imports', spec: strChild.text.replace(/['"]/g, '') });
    } else if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      if (callee) {
        const full = callee.text;
        if (full === 'require' || callee.type === 'import') {
          const arg = node.childForFieldName('arguments')?.namedChildren?.find(c => c.type === 'string');
          if (arg) edges.push({ source: file, kind: 'imports', spec: arg.text.replace(/['"]/g, '') });
        }
        const name = full.split('(')[0].split('.').pop().split('[')[0];
        if (name && /^[A-Za-z_]\w*$/.test(name)) edges.push({ source: defId || file, target: name, kind: 'calls', raw: full });
        const args = node.childForFieldName('arguments');
        emitBoundary(file, defId || file, full, args?.namedChildren?.[0]?.text, nodes, edges, lang);
      }
    } else if (node.type === 'new_expression') {
      const callee = node.childForFieldName('constructor');
      if (callee) {
        const name = callee.text.split('(')[0].split('.').pop();
        if (name && /^[A-Za-z_]\w*$/.test(name)) edges.push({ source: defId || file, target: name, kind: 'calls', raw: callee.text });
        const args = node.childForFieldName('arguments');
        emitBoundary(file, defId || file, callee.text, args?.namedChildren?.[0]?.text, nodes, edges, lang);
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i), scopeStack);
  };
  visit(root, []);
}

// ---- Python ----
function analyzePY(src, file, defs, edges, nodes) {
  const tree = pyParser.parse(src);
  const root = tree.rootNode;
  const visit = (node, scopeStack) => {
    let defName = null, defId = null, kind = null;
    if (['function_definition', 'async_function_definition'].includes(node.type)) {
      const id = node.childForFieldName('name');
      if (id) { defName = id.text; kind = 'function'; }
    } else if (node.type === 'class_definition') {
      const id = node.childForFieldName('name');
      if (id) { defName = id.text; kind = 'class'; }
    }
    if (defName && kind) {
      defId = `${file}::${defName}`;
      if (kind === 'method') { const cls = scopeStack.find(s => s.kind === 'class'); if (cls) defId = `${file}::${cls.name}.${defName}`; }
      defs.push({ id: defId, name: defName, kind, file, lang: 'python' });
      nodes.push({ id: defId, kind, label: defName, file, lang: 'python', line: node.startPosition.row + 1, col: node.startPosition.column + 1 });
      edges.push({ source: file, target: defId, kind: 'structure' });
      scopeStack = [...scopeStack, { name: defName, kind }];
    }
    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      const modChild = node.namedChildren.find(c => c.type === 'dotted_name' || c.type === 'module' || c.type === 'relative_import');
      const spec = (modChild ? modChild.text : node.text).split(/\s/)[0].replace(/['"]/g, '');
      edges.push({ source: file, kind: 'imports', spec });
    } else if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn) {
        const name = fn.text.split('(')[0].split('.').pop().split('[')[0];
        if (name && /^[A-Za-z_]\w*$/.test(name)) edges.push({ source: defId || file, target: name, kind: 'calls', raw: fn.text });
        emitBoundary(file, defId || file, fn.text, node.childForFieldName('arguments')?.namedChildren?.[0]?.text, nodes, edges, 'py');
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i), scopeStack);
  };
  visit(root, []);
}

// ---- C / C++ ----
function nameFromDeclarator(decl) {
  if (!decl) return null;
  let t = decl.text;
  const paren = t.indexOf('(');
  if (paren >= 0) t = t.slice(0, paren);
  const name = t.split('::').pop().trim();
  return name && /^[A-Za-z_~]\w*$/.test(name) ? name : null;
}

function analyzeCPP(src, lang, file, defs, edges, nodes) {
  const parser = lang === 'c' ? cParser : cppParser;
  const tree = parser.parse(src);
  const root = tree.rootNode;
  const visit = (node, scopeStack) => {
    let defName = null, defId = null, kind = null;
    if (node.type === 'function_definition') {
      const decl = node.childForFieldName('declarator');
      const nm = nameFromDeclarator(decl);
      if (nm) { defName = nm; kind = 'function'; }
    } else if (node.type === 'class_specifier' || node.type === 'struct_specifier' || node.type === 'union_specifier') {
      const id = node.childForFieldName('name');
      if (id) { defName = id.text; kind = 'class'; }
    } else if (node.type === 'field_declaration' || node.type === 'declaration') {
      // method inside a class body, or a free function declared with a body via declaration
      const decl = node.childForFieldName('declarator');
      if (decl && decl.type === 'function_declarator') {
        const nm = nameFromDeclarator(decl);
        const isMethod = node.type === 'field_declaration' || scopeStack.find(s => s.kind === 'class');
        if (nm) { defName = nm; kind = isMethod ? 'method' : 'function'; }
      }
    } else if (node.type === 'namespace_definition') {
      const id = node.childForFieldName('name');
      if (id) { defName = id.text; kind = 'namespace'; }
    }
    if (defName && kind) {
      defId = `${file}::${defName}`;
      if (kind === 'method') { const cls = scopeStack.find(s => s.kind === 'class'); if (cls) defId = `${file}::${cls.name}.${defName}`; }
      defs.push({ id: defId, name: defName, kind, file, lang });
      nodes.push({ id: defId, kind, label: defName, file, lang, line: node.startPosition.row + 1, col: node.startPosition.column + 1 });
      edges.push({ source: file, target: defId, kind: 'structure' });
      if (kind === 'class' || kind === 'namespace') scopeStack = [...scopeStack, { name: defName, kind }];
      else if (kind === 'method') scopeStack = [...scopeStack, { name: defName, kind }];
    }
    if (node.type === 'preproc_include') {
      const str = node.namedChildren.find(c => c.type === 'string' || c.type === 'system_lib_string');
      if (str) {
        let spec = str.text.replace(/[<>"]/g, '');
        // strip local path portion for system includes
        edges.push({ source: file, kind: 'imports', spec });
      }
    } else if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      if (callee) {
        const full = callee.text;
        const name = full.split('(')[0].split('::').pop().split('.').pop().split('[')[0];
        if (name && /^[A-Za-z_]\w*$/.test(name)) edges.push({ source: defId || file, target: name, kind: 'calls', raw: full });
        emitBoundary(file, defId || file, full, node.childForFieldName('arguments')?.namedChildren?.[0]?.text, nodes, edges, lang);
      }
    } else if (node.type === 'new_expression') {
      const callee = node.childForFieldName('type');
      if (callee) {
        const name = callee.text.split('(')[0].split('::').pop().split('<')[0].trim();
        if (name && /^[A-Za-z_]\w*$/.test(name)) edges.push({ source: defId || file, target: name, kind: 'calls', raw: callee.text });
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i), scopeStack);
  };
  visit(root, []);
}

export function analyzeFile(f, abs) {
  const rel = path.relative(abs, f).split(path.sep).join('/');
  const lang = langForFile(f);
  const defs = [], edges = [], nodes = [];
  if (!lang) return { rel, defs, edges, nodes };
  let src = fs.readFileSync(f, 'utf8');
  if (!src.trim()) return { rel, defs, edges, nodes };
  nodes.push({ id: rel, kind: 'file', label: rel, lang });
  if (lang === 'js-embedded') {
    const { extractScript } = extractMod;
    src = extractScript(src);
    analyzeJS(src, 'js', rel, defs, edges, nodes);
  } else if (lang === 'py') analyzePY(src, rel, defs, edges, nodes);
  else if (lang === 'cpp' || lang === 'c') analyzeCPP(src, lang, rel, defs, edges, nodes);
  else analyzeJS(src, lang, rel, defs, edges, nodes);
  return { rel, defs, edges, nodes };
}

// embedded-script extractor (kept here to avoid circular import with analyze.mjs)
export const extractMod = {
  extractScript(src) {
    const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
    let m, out = '';
    while ((m = re.exec(src))) out += m[1] + '\n';
    return out.trim();
  },
};
