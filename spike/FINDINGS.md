# Spike Findings — Analysis Engine (2026-07-13)

## Hypothesis under test
Can we extract structure + a useful proxy for "data flow" from arbitrary
codebases using static parsing (tree-sitter), without per-language hand-rolled logic?

## Result: CONFIRMED (with scope caveats)
- Native `tree-sitter` on Node 22 installs cleanly; grammar versions must align
  with the `tree-sitter` core (0.25.0 family tested).
- JS/TS and Python both parse with real signal:
  - diario_oficial_scraper (Python, 11 files): 36 import edges, 611 call edges,
    61 defs (functions/classes).
  - Self (JS, 1 file): 60 call edges.
- Call edges correctly attribute call sites to files and capture real targets
  (e.g. `os.path.join`, `read_file`, `extract_text_from_pdf`).
- This is the RISKIEST assumption in the whole project; it now has evidence.

## What we can do cheaply (v1 scope)
- Module/import structure graph (file -> dependency).
- Intra-file call edges (definition -> called target) as a proxy "flow" view.

## What is DEFERRED (and what it costs)
1. **Cross-file call resolution.** Current edges point at a *name string*, not a
   resolved definition. Linking `read_file` (call) to its def across files needs a
   symbol table: collect defs repo-wide, then resolve call targets by name + scope
   (modules/packages, classes for methods, imports/aliases). Medium effort, pure
   data-structure work, no new parsing tech.
2. **True data / value / state flow.** Knowing "X calls Y" is NOT "data flows A->B".
   Real data-flow (which values cross which boundaries, mutation, async) needs
   semantic analysis per language family (control-flow graphs, SSA, type
   resolution). This is the expensive part and is NOT generically solvable by
   tree-sitter alone. Treat as a later phase, possibly language-scoped.
3. **Full language coverage.** Only JS/TS + Python grammars installed. Other
   languages = add a grammar package + a per-language analyzer function. The
   architecture supports it; it's incremental work.

## Recommendation
Build the graph model + D3/Astro frontend on top of THIS engine. Ship v1 with
intra-file call edges + import structure. Add cross-file symbol resolution as the
next milestone (it's what makes "data flow" actually meaningful). Defer true
data-flow analysis.

## Stack confirmed by user
- App: served (local server + web frontend)
- Output: interactive HTML
- Stack: Astro v7 + Svelte + D3 (all-JS; analysis engine in Node via tree-sitter)
