// Spike: prove tree-sitter can extract structure + call edges from polyglot repos.
// Scope of THIS spike:
//   - Parse JS/TS and Python with native tree-sitter.
//   - Emit two edge types:
//       * import edges (module -> module dependency)  -> "structure"
//       * call edges   (definition -> call target)    -> intra-file proxy for "data flow"
//   - Cross-file call resolution is DEFERRED (needs a symbol table; noted in report).

const fs = require('fs');
const path = require('path');
const Parser = require('tree-sitter');
const JS = require('tree-sitter-javascript');
const PY = require('tree-sitter-python');

const LANGS = {
  '.js': { parser: new Parser(), lang: JS, name: 'javascript' },
  '.ts': { parser: new Parser(), lang: JS, name: 'typescript' }, // JS grammar parses TS loosely; TS grammar would be better
  '.jsx': { parser: new Parser(), lang: JS, name: 'javascript' },
  '.tsx': { parser: new Parser(), lang: JS, name: 'typescript' },
  '.py': { parser: new Parser(), lang: PY, name: 'python' },
};
for (const k of Object.keys(LANGS)) LANGS[k].parser.setLanguage(LANGS[k].lang);

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', 'venv', '.venv']);

function walk(root) {
  const files = [];
  (function rec(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) rec(full);
      } else if (LANGS[path.extname(entry.name)]) {
        files.push(full);
      }
    }
  })(root);
  return files;
}

// Collect call sites and definitions.
function analyzeJS(tree, srcPath) {
  const edges = [];
  const defs = [];
  const root = tree.rootNode;

  function visit(node) {
    // definitions
    if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
      const id = node.childForFieldName('name');
      if (id) defs.push({ id: srcPath + '::' + id.text, name: id.text, kind: 'function' });
    } else if (node.type === 'class_declaration') {
      const id = node.childForFieldName('name');
      if (id) defs.push({ id: srcPath + '::' + id.text, name: id.text, kind: 'class' });
    } else if (node.type === 'method_definition') {
      const id = node.childForFieldName('name');
      if (id) defs.push({ id: srcPath + '::' + id.text, name: id.text, kind: 'method' });
    }
    // calls
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      if (callee) {
        const name = callee.text.split('(')[0];
        edges.push({ from: srcPath, to: name, kind: 'call' });
      }
    }
    // imports (structure)
    if (node.type === 'import_statement' || node.type === 'call_expression') {
      // require('./x') -> call_expression with callee 'require'
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i));
  }
  visit(root);
  return { edges, defs };
}

function analyzePY(tree, srcPath) {
  const edges = [];
  const defs = [];
  const root = tree.rootNode;

  function visit(node) {
    if (node.type === 'function_definition' || node.type === 'async_function_definition') {
      const id = node.childForFieldName('name');
      if (id) defs.push({ id: srcPath + '::' + id.text, name: id.text, kind: 'function' });
    } else if (node.type === 'class_definition') {
      const id = node.childForFieldName('name');
      if (id) defs.push({ id: srcPath + '::' + id.text, name: id.text, kind: 'class' });
    }
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn) {
        const name = fn.text.split('(')[0];
        edges.push({ from: srcPath, to: name, kind: 'call' });
      }
    }
    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      edges.push({ from: srcPath, to: node.text.replace(/\n/g, ' ').slice(0, 60), kind: 'import' });
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i));
  }
  visit(root);
  return { edges, defs };
}

function run(repoPath) {
  const files = walk(repoPath);
  const graph = { nodes: [], edges: [], meta: { repo: repoPath, files: files.length } };
  for (const f of files) {
    const rel = path.relative(repoPath, f);
    const ext = path.extname(f);
    const { parser, lang, name } = LANGS[ext];
    const src = fs.readFileSync(f, 'utf8');
    let tree;
    try {
      tree = parser.parse(src);
    } catch (e) {
      console.error(`PARSE FAIL ${rel}: ${e.message}`);
      continue;
    }
    graph.nodes.push({ id: rel, kind: 'file', lang: name });
    const { edges, defs } = name === 'python' ? analyzePY(tree, rel) : analyzeJS(tree, rel);
    for (const d of defs) graph.nodes.push({ id: d.id, kind: d.kind, lang: name, file: rel, label: d.name });
    for (const e of edges) graph.edges.push({ ...e, file: rel });
  }
  return graph;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) { console.error('usage: node parse.js <repo-path>'); process.exit(1); }
  const g = run(target);
  const byKind = {};
  for (const e of g.edges) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  console.log(JSON.stringify({ meta: g.meta, edgeCounts: byKind, nodeCount: g.nodes.length, edgeCount: g.edges.length }, null, 2));
  fs.writeFileSync(path.join(__dirname, 'graph.json'), JSON.stringify(g, null, 2));
  console.log('wrote graph.json');
}

module.exports = { run, walk };
