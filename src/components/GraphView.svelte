<script lang="ts">
  // Interactive codebase graph. A LIVE d3 force simulation drives positions
  // (rAF tick loop) so dragging reheats the layout and links reflow — the
  // Obsidian model. Two modes:
  //   force : every node is a circle.
  //   class : classes and files are UE5-blueprint-style boxes; each method /
  //           function is a row with an input pin (left) and output pin
  //           (right); call/structure edges are bezier wires between pins.
  import * as d3 from 'd3';
  import { onMount, onDestroy, untrack } from 'svelte';

  let { graph, streamUrl = '' }: { graph: any; streamUrl?: string } = $props();
  let liveGraph = $state(graph);

  // ---- lazy dependency logos (Simple Icons CDN, fetched only when visible) ----
  const logoBad = new Set<string>();           // slugs that 404'd — never refetch
  function logoUrl(slug: string) { return `https://cdn.simpleicons.org/${slug}`; }
  function onLogoError(slug: string) { logoBad.add(slug); }
  let repoPath = $state(liveGraph?.meta?.repo || '');
  let loadError = $state('');
  let loadBusy = $state(false);
  let loadPhase = $state('');      // walk | parse | resolve | done
  let loadDone = $state(0);
  let loadTotal = $state(0);
  let loadES: EventSource | null = null;

  async function loadRepo(path: string) {
    const p = (path || '').trim();
    if (!p) return;
    loadBusy = true; loadError = ''; loadPhase = 'starting'; loadDone = 0; loadTotal = 0;
    if (loadES) { loadES.close(); loadES = null; }
    if (es) { es.close(); es = null; }
    try {
      const src = new EventSource(`/api/analyze-stream?path=${encodeURIComponent(p)}`);
      loadES = src;
      src.onmessage = (ev) => {
        const raw = ev.data;
        if (raw.startsWith('GRAPH ')) {
          const data = JSON.parse(raw.slice(6));
          liveGraph = data;
          repoPath = data.meta?.repo || p;
          loadPhase = 'done';
          src.close(); loadES = null; loadBusy = false;
          // re-point live stream at the new repo for file-watch updates
          es = new EventSource(`/api/stream?path=${encodeURIComponent(repoPath)}`);
          es.onmessage = (e) => { try { liveGraph = JSON.parse(e.data); } catch (_) {} };
          return;
        }
        const msg = JSON.parse(raw);
        if (msg.error) { loadError = msg.error; src.close(); loadES = null; loadBusy = false; return; }
        if (msg.phase === 'parse') { loadPhase = 'parse'; loadDone = msg.done; loadTotal = msg.total; }
        else loadPhase = msg.phase;
      };
      src.onerror = () => {
        if (loadPhase !== 'done') { loadError = 'stream error'; loadBusy = false; }
        try { src.close(); } catch (_) {} loadES = null;
      };
    } catch (e) {
      loadError = String(e);
      loadBusy = false;
    }
  }
  async function pickFolder() {
    try {
      const res = await fetch('/api/pick-folder');
      const data = await res.json();
      if (data.path) { repoPath = data.path; await loadRepo(data.path); }
    } catch (e) {
      loadError = String(e);
    }
  }

  const kindColor: Record<string, string> = {
    file: '#60a5fa', function: '#34d399', class: '#fbbf24', method: '#a78bfa', external: '#9ca3af',
    'io-input': '#22c55e', 'io-output': '#ef4444',
  };
  const ioColor = (dir: string) => (dir === 'in' ? '#22c55e' : '#ef4444');
  const ioGlyph = (surface: string) => ({
    network: '⇄', file: 'F', folder: '▣', database: 'DB', browser: '↗',
    form: '▭', console: '›', error: '!', log: 'L', response: '↩', json: '{}',
  }[surface] || '◆');
  const edgeColor: Record<string, string> = { structure: '#4b5563', calls: '#3b82f6', imports: '#f59e0b', 'io-in': '#22c55e', 'io-out': '#ef4444' };
  const HEADER = 22;
  const ROWH = 16;

  let filters: Record<string, boolean> = $state({ structure: true, calls: true, imports: true, 'io-in': true, 'io-out': true });
  // node-kind visibility (io = io-input + io-output)
  let kindFilters: Record<string, boolean> = $state({ file: true, class: true, function: true, method: true, external: true, io: true });
  let search = $state('');
  let selected: any = $state(null);
  let hovered: string | null = $state(null);
  let mode: 'force' | 'class' = $state('force');

  // ---- native "open in host" bridge ----
  const repoRoot: string = liveGraph?.meta?.repo || process.cwd?.() || '';
  let openMenu: any = $state(null); // { node, x, y }
  let openBusy = $state(false);
  let openError = $state('');
  let openNote = $state('');

  async function requestOpen(strategy: 'code' | 'editor' | 'fm' | 'xdg', node: any) {
    openBusy = true; openError = '';
    try {
      const t = openTarget(node);
      const r = await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: t.file, line: t.line, col: t.col, root: repoRoot, strategy }),
      });
      const data = await r.json();
      if (!r.ok) { openError = data.error || 'open failed'; return; }
      openNote = 'launched → ' + (data.cmd || data.method);
    } catch (e) {
      openError = String(e);
    } finally {
      openBusy = false;
    }
  }
  function openTarget(node: any) {
    // file nodes carry path in `id`, not `file`; everything else uses `file`.
    const file = node?.file || (node?.kind === 'file' ? node.id : null);
    return file ? { file, line: node.line, col: node.col } : null;
  }
  // Build the per-entry list for an IO node's right drawer.
  function ioEntries(node: any) {
    if (!node || !node.kind?.startsWith('io-')) return [];
    if (node.aggregate && node.samples) {
      return node.samples.map((s: string, i: number) => ({ snippet: s, line: node.lines?.[i] ?? null, file: node.file }));
    }
    return [{ snippet: node.payload || node.label, line: node.line ?? null, file: node.file }];
  }

  // ---- static data-flow tracer: animate a "data token" along call edges ----
  let trace: any = $state(null);          // active trace or null
  const FLOW_CAP = 12;                    // stop a path after this many hops
  let flowMode: 'single' | 'all' = $state('single');
  let flowPaused = $state(false);
  let flowPos = $state(-1);               // current edge index in trace.edges
  let flowTimer: any = null;

  function nodeLabelById(id: string) {
    const n = liveGraph.nodes.find((x: any) => x.id === id);
    return n ? (n.label || n.id) : id;
  }
  function outCalls(id: string): string[] {
    const ids = new Set(liveGraph.nodes.map((n: any) => n.id));
    return liveGraph.edges
      .filter((e: any) => e.kind === 'calls' && e.source === id && ids.has(e.target))
      .map((e: any) => e.target);
  }
  // Walk the data flow: from the IO owner, follow ALL `calls` edges (file-scoped),
  // and collect every reachable function plus the outputs they own. Stop at a
  // depth limit (FLOW_CAP) or when a branch hits an output-owning node.
  // Cross-file hop: when the triggering input is a network request (fetch/…),
  // bridge to the API route file it targets so the route's outputs are reached.
  function routeFileForRequest(ioNode: any): string | null {
    if (!ioNode || ioNode.surface !== 'network') return null;
    const raw = String(ioNode.payload || ioNode.label || '');
    const m = raw.match(/\/api\/[\w\-/]+/);
    if (!m) return null;
    const path = m[0].replace(/\/+$/, '');            // e.g. /api/pick-folder
    // Match a route file node whose id contains that path (…/pages/api/pick-folder.ts)
    const hit = liveGraph.nodes.find(
      (n: any) => n.kind === 'file' && n.id.replace(/\\/g, '/').includes('pages' + path + '.')
    );
    return hit ? hit.id : null;
  }
  function buildPaths(owner: string, ioNode?: any): { edges: string[]; outputs: any[]; bridges: string[] } {
    const edges: string[] = [];
    const bridges: string[] = [];
    const visited = new Set<string>([owner]);
    const queue: string[] = [owner];
    // Seed a cross-file network hop if this input targets an API route.
    const routeFile = ioNode ? routeFileForRequest(ioNode) : null;
    if (routeFile && !visited.has(routeFile)) {
      visited.add(routeFile);
      const bridge = owner + '>' + routeFile;
      edges.push(bridge);
      bridges.push(bridge);
      queue.push(routeFile);
    }
    let depth = 0;
    while (queue.length && depth < FLOW_CAP) {
      const cur = queue.shift()!;
      for (const next of outCalls(cur)) {
        if (visited.has(next)) continue;
        visited.add(next);
        edges.push(cur + '>' + next);
        // expand further only if this callee might call more (has no own output yet)
        const ownsOut = liveGraph.nodes.some((n: any) => n.kind === 'io-output' && n.owner === next);
        if (!ownsOut) queue.push(next);
      }
      depth++;
    }
    const outputs = liveGraph.nodes
      .filter((n: any) => n.kind === 'io-output' && visited.has(n.owner))
      .map((o: any) => ({ label: o.label, file: o.file, line: o.line, surface: o.surface, owner: o.owner }));
    return { edges, outputs, bridges };
  }
  function runTrace(ioNode: any) {
    const owner = ioNode.owner || ioNode.id;
    const { edges, outputs, bridges } = buildPaths(owner, ioNode);
    const intrace = new Set<string>();
    intrace.add(owner);
    edges.forEach((k) => { const [s] = k.split('>'); intrace.add(s); intrace.add(k.split('>')[1]); });
    trace = { input: { id: ioNode.id, label: ioNode.label }, order: intrace, edges, outputs, owner, mode: flowMode, bridges };
    flowPos = -1;
    flowPaused = false;
    startFlow();
  }
  function startFlow() {
    if (flowTimer) clearInterval(flowTimer);
    if (trace && trace.edges.length && !flowPaused) {
      flowTimer = setInterval(() => {
        if (flowPaused) return;
        if (flowPos >= trace.edges.length - (flowMode === 'single' ? 1 : 0) && flowMode === 'single') {
          // single: advance one edge per tick; loop back to start when done
          flowPos = (flowPos + 1) % trace.edges.length;
        } else if (flowMode === 'all') {
          if (flowPos < trace.edges.length - 1) flowPos++;
          else if (flowPos >= trace.edges.length - 1) flowPos = trace.edges.length - 1;
        } else {
          flowPos++;
        }
      }, 600);
    }
  }
  function toggleFlowMode() {
    flowMode = flowMode === 'single' ? 'all' : 'single';
    if (trace) { trace = { ...trace, mode: flowMode }; startFlow(); }
  }
  function togglePause() { flowPaused = !flowPaused; }
  function clearTrace() {
    if (flowTimer) clearInterval(flowTimer);
    flowTimer = null; flowPos = -1; trace = null;
  }
  // which single edge is currently "lit" by the flowing token
  const curEdge = $derived(trace && flowPos >= 0 ? trace.edges[flowPos] : null);
  // ---- class-mode trace resolution ----
  // In class mode functions are member ROWS inside file/class boxes, so the raw
  // entity ids in trace.order must be mapped to the box (and member) that shows
  // them, otherwise nothing lights up.
  const traceClass = $derived.by(() => {
    const boxes = new Set<string>();
    const members = new Set<string>();
    if (!trace || view.mode !== 'class') return { boxes, members };
    const entToBox = new Map<string, string>();
    for (const b of view.boxes as any[]) if (b.entity) entToBox.set(b.entity.id, b.id);
    for (const id of trace.order as Set<string>) {
      if (entToBox.has(id)) boxes.add(entToBox.get(id)!);
      else if (view.memberIndex.has(id)) { const mi = view.memberIndex.get(id); members.add(id); boxes.add(mi.boxId); }
      else boxes.add(id); // standalone or file/route id used directly
    }
    return { boxes, members };
  });
  // current-hop endpoints mapped to boxes + member rows (the animated "train")
  const curClass = $derived.by(() => {
    const boxes = new Set<string>();
    const members = new Set<string>();
    if (!curEdge || view.mode !== 'class') return { boxes, members };
    const entToBox = new Map<string, string>();
    for (const b of view.boxes as any[]) if (b.entity) entToBox.set(b.entity.id, b.id);
    for (const id of curEdge.split('>')) {
      if (entToBox.has(id)) boxes.add(entToBox.get(id)!);
      else if (view.memberIndex.has(id)) { members.add(id); boxes.add(view.memberIndex.get(id).boxId); }
      else boxes.add(id);
    }
    return { boxes, members };
  });
  function boxIntrace(id: string) { return traceClass.boxes.has(id); }
  function boxCur(id: string) { return curClass.boxes.has(id); }
  function memberIntrace(mid: string) { return traceClass.members.has(mid); }
  function memberCur(mid: string) { return curClass.members.has(mid); }
  // Resolve a raw node id to the element that actually has a rendered position:
  // in class mode that's the box (box::<id>) or the member's box; in force mode
  // it's the node id itself.
  function posIdFor(id: string): string {
    if (view.mode !== 'class') return id;
    if (positions['box::' + id]) return 'box::' + id;
    if (view.memberIndex.has(id)) return view.memberIndex.get(id).boxId;
    return id;
  }
  // an edge is part of the active trace trail
  function edgeActiveFn(e: any) {
    if (!trace) return false;
    const key = e.source + '>' + e.target;
    if (!trace.edges.includes(key)) return false;
    const idx = trace.edges.indexOf(key);
    return flowMode === 'all' ? true : idx <= flowPos;
  }
  function openClicked(node: any, ev: MouseEvent) {
    openError = ''; openNote = '';
    openMenu = { node, x: ev.clientX, y: ev.clientY };
  }
  function closeOpenMenu() { openMenu = null; }
  // left click: select only (inspect panel). right click: open host menu.
  function nodeClick(node: any, ev: MouseEvent) {
    if (downPos?.moved) return;           // it was a drag, not a click
    ev.stopPropagation();                  // don't let it bubble to the SVG background
    selected = node;                       // keep inspect panel in sync
    if (node.kind === 'io-input') runTrace(node);   // start the data-flow animation
    else if (trace) clearTrace();          // clicking elsewhere dismisses the trace overlay
  }
  function nodeRightClick(node: any, ev: MouseEvent) {
    ev.preventDefault();
    if (downPos?.moved) return;
    selected = node;
    if (!openTarget(node)) return;        // only repo files can be opened
    openClicked(node, ev);
  }

  // Obsidian-style force controls
  let centerForce = $state(0.08);   // pull toward centre (forceX/Y strength)
  let repelForce = $state(400);     // node repulsion (charge = -repelForce)
  let linkForce = $state(0.4);      // link strength
  let linkDistance = $state(70);    // link rest length

  let svgEl: SVGSVGElement;
  let wrapEl: HTMLDivElement;
  let vw = $state(1000);
  let vh = $state(700);
  let transformStr = $state('translate(0,0) scale(1)');
  let zoomT = { x: 0, y: 0, k: 1 };
  let zoomCtl: any = null;

  // live simulation state
  let sim: any = null;
  let simById = new Map<string, any>();
  let positions = $state<Record<string, { x: number; y: number }>>({});
  let dragId: string | null = null;

  function radiusFor(kind: string) { return kind === 'file' ? 9 : kind === 'class' ? 8 : kind === 'external' ? 6 : 5; }

  // node visibility under kindFilters (box = its entity kind; io = io-in/out)
  function kindVisible(kind: string) {
    if (kind.startsWith('io-')) return kindFilters.io;
    return kindFilters[kind] !== false;
  }

  // A node is "present" (rendered) when:
  //  - its kind is enabled, AND
  //  - if it is an IO node, it is connected to the focused node (selected or hovered).
  // So IO clutter stays hidden until you select/hover its owner.
  function present(id: string) {
    if (visById.get(id) === false) return false;
    const k = view.kindById.get(id);
    if (!k || !k.startsWith('io-')) return true;
    // IO: if the user explicitly enabled the IO filter, always show.
    if (kindFilters.io) return true;
    // During an active trace, reveal all IO (inputs + reached outputs).
    if (trace) return true;
    const f = hovered || (selected ? selected.id : null);
    if (!f) return false;
    const nb = view.neighbors.get(f);
    return !!nb && nb.has(id);
  }

  // ---------------- topology (pure, no positions) ----------------
  const view = $derived.by(() => {
    const q = search.toLowerCase();
    const all = liveGraph.nodes;
    const edgesRaw = liveGraph.edges
      .filter((e: any) => filters[e.kind])
      .filter((e: any) => !q || (e.source + e.target).toLowerCase().includes(q));

    if (mode === 'force') {
      const byId = new Map(all.map((n: any) => [n.id, n]));
      const valid = edgesRaw.filter((e: any) => byId.has(e.source) && byId.has(e.target));
      const used = new Set<string>();
      for (const e of valid) { used.add(e.source); used.add(e.target); }
      const simNodes = all.filter((n: any) => used.has(n.id) || n.kind.startsWith('io-'))
        .map((n: any) => ({ ...n, _r: radiusFor(n.kind) + 4 }));
      const seen = new Set<string>();
      const simLinks: any[] = [];
      for (const e of valid) {
        const k = e.source + '>' + e.target + ':' + e.kind;
        if (seen.has(k)) continue; seen.add(k);
        simLinks.push({ source: e.source, target: e.target, kind: e.kind });
      }
      const neighbors = new Map<string, Set<string>>();
      for (const e of valid) {
        if (!neighbors.has(e.source)) neighbors.set(e.source, new Set());
        if (!neighbors.has(e.target)) neighbors.set(e.target, new Set());
        neighbors.get(e.source)!.add(e.target);
        neighbors.get(e.target)!.add(e.source);
      }
      const kindById = new Map(simNodes.map((n: any) => [n.id, n.kind]));
      return { mode: 'force', simNodes, simLinks, renderEdges: simLinks, neighbors,
               boxes: [], memberIndex: new Map(), standalones: simNodes, kindById } as any;
    }

    // ---- class mode ---- (topology full; visibility applied at render via kindVisible)
    const classes = all.filter((n: any) => n.kind === 'class');
    const methods = all.filter((n: any) => n.kind === 'method');
    const files = all.filter((n: any) => n.kind === 'file');

    const classGroups = new Map<string, any>();
    for (const c of classes) classGroups.set(c.id, { entity: c, kind: 'class', rows: [] });
    const grouped = new Set<string>();
    for (const m of methods) {
      const dot = m.id.indexOf('.', m.id.indexOf('::') + 2);
      const classId = dot >= 0 ? m.id.slice(0, dot) : null;
      const g = classId ? classGroups.get(classId) : null;
      if (g) { g.rows.push(m); grouped.add(m.id); }
    }
    const fileGroups = new Map<string, any>();
    for (const f of files) fileGroups.set(f.id, { entity: f, kind: 'file', rows: [] });
    const libs = all.filter((n: any) => n.kind === 'external' && n.version);
    const libGroups = new Map<string, any>();
    for (const l of libs) libGroups.set(l.id, { entity: l, kind: 'lib', rows: [] });
    for (const n of all) {
      // module members: top-level functions, ungrouped methods, and classes
      // (a class also gets its own detail box, but appears as a module row too).
      const isLoose = n.kind === 'function' || (n.kind === 'method' && !grouped.has(n.id)) || n.kind === 'class';
      if (isLoose) { const g = fileGroups.get(n.file); if (g) g.rows.push(n); }
    }

    const boxes: any[] = [];
    const boxByEntityId = new Map<string, string>();
    const memberIndex = new Map<string, any>();
    const addBox = (g: any) => {
      if (!g.entity) return;
      if (g.kind === 'file' && g.rows.length === 0) return; // method-less file -> standalone
      const w = g.kind === 'class' ? 168 : g.kind === 'lib' ? 150 : 196;
      const h = HEADER + Math.max(g.rows.length, 0) * ROWH + 8;
      const id = 'box::' + g.entity.id;
      const hw = w / 2, hh = h / 2;
      const label = g.kind === 'class' ? g.entity.label
        : g.kind === 'lib' ? (g.entity.display || g.entity.label)
        : (g.entity.label || g.entity.id).split('/').pop();
      const box = { id, kind: g.kind, entity: g.entity,
        label, rows: g.rows, w, h, hw, hh, _r: Math.max(hw, hh) };
      boxes.push(box);
      boxByEntityId.set(g.entity.id, id);
      g.rows.forEach((m: any, i: number) => memberIndex.set(m.id, { boxId: id, row: i, hw, hh }));
    };
    for (const g of classGroups.values()) addBox(g);
    for (const g of fileGroups.values()) addBox(g);
    for (const g of libGroups.values()) addBox(g);

    const boxedFileIds = new Set([...boxByEntityId.keys()].filter((k) => fileGroups.has(k) && boxByEntityId.get(k)));
    const standalones = all.filter((n: any) =>
      (n.kind === 'external' && !boxByEntityId.has(n.id)) || n.kind.startsWith('io-') || (n.kind === 'file' && !boxByEntityId.has(n.id))
    ).map((n: any) => ({ ...n, _r: radiusFor(n.kind) + 4 }));
    const standaloneIds = new Set(standalones.map((n: any) => n.id));

    const resolveNode = (id: string): string | null => {
      // an entity with its own box (class detail box, module box) wins over a
      // membership row, so class-level edges dock on the class box.
      if (boxByEntityId.has(id)) return boxByEntityId.get(id)!;
      if (memberIndex.has(id)) return memberIndex.get(id).boxId;
      if (standaloneIds.has(id)) return id;
      return null;
    };

    const renderEdges: any[] = [];
    const okEdge: any[] = [];
    for (const e of edgesRaw) {
      const s = resolveNode(e.source), t = resolveNode(e.target);
      if (!s || !t || s === t) continue;
      renderEdges.push({ source: e.source, target: e.target, sNode: s, tNode: t, kind: e.kind });
      okEdge.push({ source: s, target: t, kind: e.kind });
    }
    const seen = new Set<string>();
    const simLinks: any[] = [];
    for (const e of okEdge) {
      const k = e.source + '>' + e.target;
      if (seen.has(k)) continue; seen.add(k);
      simLinks.push({ source: e.source, target: e.target, kind: e.kind });
    }
    const simNodes = [...boxes.map((b) => ({ ...b })), ...standalones];
    const neighbors = new Map<string, Set<string>>();
    for (const e of simLinks) {
      if (!neighbors.has(e.source)) neighbors.set(e.source, new Set());
      if (!neighbors.has(e.target)) neighbors.set(e.target, new Set());
      neighbors.get(e.source)!.add(e.target);
      neighbors.get(e.target)!.add(e.source);
    }
    return { mode: 'class', simNodes, simLinks, renderEdges, neighbors, boxes, memberIndex, standalones, boxByEntityId,
             kindById: new Map(simNodes.map((n: any) => [n.id, n.kind])) };
  });

  // Visibility per node id under kindFilters. SEPARATE derived (does not feed the
  // layout $effect) so toggling a kind hides/shows nodes + their edges WITHOUT
  // rebuilding the force simulation or destroying relationships.
  const visById = $derived.by(() => {
    const m = new Map<string, boolean>();
    for (const n of liveGraph.nodes) m.set(n.id, kindVisible(n.kind));
    return m;
  });

  // ---------------- layout (force: live sim; other modes: static one-shot) ----------------
  $effect(() => {
    const v = view;                       // track topology + mode
    const W = vw, H = vh;                  // track size
    const cx = W / 2, cy = H / 2;
    const prev = untrack(() => positions);
    const cf = untrack(() => centerForce), rf = untrack(() => repelForce);
    const lf = untrack(() => linkForce), ld = untrack(() => linkDistance);

    if (sim) { sim.on('tick', null); sim.stop(); sim = null; }

    const simNodes = v.simNodes.map((n: any) => {
      const p = prev[n.id];
      return { ...n, x: p?.x ?? cx + (Math.random() - 0.5) * 120, y: p?.y ?? cy + (Math.random() - 0.5) * 120 };
    });
    simById = new Map(simNodes.map((n: any) => [n.id, n]));
    const simLinks = v.simLinks.map((e: any) => ({ ...e }));

    if (v.mode === 'force') {
      // LIVE simulation — drag reheats, links reflow.
      sim = d3.forceSimulation(simNodes)
        .force('x', d3.forceX(cx).strength(cf))
        .force('y', d3.forceY(cy).strength(cf))
        .force('charge', d3.forceManyBody().strength(-rf))
        .force('link', d3.forceLink(simLinks).id((d: any) => d.id).distance(ld).strength(lf))
        .force('collide', d3.forceCollide().radius((d: any) => d._r).iterations(2))
        .on('tick', () => {
          const p: Record<string, { x: number; y: number }> = {};
          for (const n of simNodes) p[n.id] = { x: n.x, y: n.y };
          positions = p;
        });
      sim.alpha(0.9).restart();
      return () => { if (sim) { sim.on('tick', null); sim.stop(); sim = null; } };
    }

    // STATIC modes (class, …): solve once, then freeze. No simulation runs;
    // dragging just moves nodes directly.
    const hasPrev = simNodes.every((n: any) => prev[n.id]);
    if (!hasPrev) {
      const solver = d3.forceSimulation(simNodes)
        .force('x', d3.forceX(cx).strength(0.06))
        .force('y', d3.forceY(cy).strength(0.06))
        .force('charge', d3.forceManyBody().strength(-500))
        .force('link', d3.forceLink(simLinks).id((d: any) => d.id).distance(120).strength(0.5))
        .force('collide', d3.forceCollide().radius((d: any) => d._r + 6).iterations(3))
        .stop();
      solver.tick(300);
    }
    const p: Record<string, { x: number; y: number }> = {};
    for (const n of simNodes) p[n.id] = { x: n.x, y: n.y };
    positions = p;
  });

  // live force-parameter updates (force mode only — no-op when static)
  $effect(() => {
    const cf = centerForce, rf = repelForce, lf = linkForce, ld = linkDistance;
    if (!sim) return;
    sim.force('x')?.strength(cf);
    sim.force('y')?.strength(cf);
    sim.force('charge')?.strength(-rf);
    sim.force('link')?.strength(lf).distance(ld);
    sim.alpha(Math.max(sim.alpha(), 0.4)).restart();
  });

  // ---------------- L→R dataflow relayout (layered / Sugiyama-lite) ----------------
  // Assign each node a column by longest-path from sources, order rows within a
  // column by neighbour barycentre, then place columns left→right. Static only.
  function arrangeDataflow() {
    const v = view;
    if (v.mode === 'force') return;
    const ids = v.simNodes.map((n: any) => n.id);
    const idSet = new Set(ids);
    // reverse edge direction for layering: a module that is *imported/called*
    // (the source of data/control) sits leftmost, consumers flow rightward.
    const links = v.simLinks
      .map((e: any) => ({ s: typeof e.target === 'object' ? e.target.id : e.target,
                          t: typeof e.source === 'object' ? e.source.id : e.source }))
      .filter((e: any) => idSet.has(e.s) && idSet.has(e.t) && e.s !== e.t);

    const outAdj = new Map<string, string[]>();
    const indeg = new Map<string, number>();
    for (const id of ids) { outAdj.set(id, []); indeg.set(id, 0); }
    for (const e of links) { outAdj.get(e.s)!.push(e.t); indeg.set(e.t, (indeg.get(e.t) || 0) + 1); }

    // longest-path layering with cycle tolerance (Kahn; leftovers get max+1)
    const col = new Map<string, number>();
    const q = ids.filter((id) => (indeg.get(id) || 0) === 0);
    for (const id of q) col.set(id, 0);
    const deg = new Map(indeg);
    let head = 0;
    while (head < q.length) {
      const u = q[head++];
      const cu = col.get(u) || 0;
      for (const w of outAdj.get(u)!) {
        col.set(w, Math.max(col.get(w) ?? 0, cu + 1));
        deg.set(w, (deg.get(w) || 0) - 1);
        if ((deg.get(w) || 0) === 0) q.push(w);
      }
    }
    let maxCol = 0;
    for (const id of ids) { if (!col.has(id)) col.set(id, 0); maxCol = Math.max(maxCol, col.get(id) ?? 0); }
    // Dataflow rails: inputs always leftmost (col 0), outputs always rightmost.
    // Code boxes keep their dataflow order but start at col 1 so inputs own col 0.
    const ioNodes = v.simNodes.filter((n: any) => n.kind?.startsWith('io-'));
    if (ioNodes.length) {
      maxCol += 2;
      for (const id of ids) if (!id.startsWith('io::')) col.set(id, (col.get(id) ?? 0) + 1);
      for (const n of ioNodes) col.set(n.id, n.kind === 'io-input' ? 0 : maxCol);
    }
    const columns: string[][] = Array.from({ length: maxCol + 1 }, () => []);
    for (const id of ids) columns[col.get(id)!].push(id);

    // order within columns by barycentre of already-placed left neighbours (a few sweeps)
    const order = new Map<string, number>();
    columns.forEach((c) => c.forEach((id, i) => order.set(id, i)));
    const inAdj = new Map<string, string[]>();
    for (const id of ids) inAdj.set(id, []);
    for (const e of links) inAdj.get(e.t)!.push(e.s);
    for (let sweep = 0; sweep < 4; sweep++) {
      for (let c = 1; c < columns.length; c++) {
        const col2 = columns[c];
        const bary = new Map<string, number>();
        for (const id of col2) {
          const preds = inAdj.get(id)!.filter((s) => col.get(s) === c - 1);
          const b = preds.length ? preds.reduce((a, s) => a + (order.get(s) || 0), 0) / preds.length : (order.get(id) || 0);
          bary.set(id, b);
        }
        col2.sort((a, b) => (bary.get(a)! - bary.get(b)!));
        col2.forEach((id, i) => order.set(id, i));
      }
    }

    // place: column x by cumulative widest box, row y centred per column
    const colGap = 90;
    const rowGap = 26;
    const boxW = (id: string) => { const b = v.boxes.find((x: any) => x.id === id); return b ? b.w : (v.standalones.find((s: any) => s.id === id)?.kind?.startsWith('io-') ? 108 : 2 * (v.standalones.find((s: any) => s.id === id)?._r ?? 12)); };
    const boxH = (id: string) => { const b = v.boxes.find((x: any) => x.id === id); return b ? b.h : (v.standalones.find((s: any) => s.id === id)?.kind?.startsWith('io-') ? 26 : 2 * (v.standalones.find((s: any) => s.id === id)?._r ?? 12)); };
    const colWidth = columns.map((c) => Math.max(40, ...c.map(boxW)));
    const colX: number[] = [];
    let x = 80;
    for (let c = 0; c < columns.length; c++) { colX[c] = x + colWidth[c] / 2; x += colWidth[c] + colGap; }

    const pos: Record<string, { x: number; y: number }> = {};
    for (let c = 0; c < columns.length; c++) {
      const col2 = columns[c];
      const totalH = col2.reduce((a, id) => a + boxH(id) + rowGap, -rowGap);
      let y = Math.max(60, vh / 2 - totalH / 2);
      for (const id of col2) {
        const h = boxH(id);
        pos[id] = { x: colX[c], y: y + h / 2 };
        const node = simById.get(id); if (node) { node.x = pos[id].x; node.y = pos[id].y; }
        y += h + rowGap;
      }
    }
    positions = pos;
  }

  // ---------------- geometry ----------------
  function memberAnchor(id: string, out: boolean) {
    // entity with its own box (class detail box / module box) -> header socket.
    if (view.boxByEntityId && view.boxByEntityId.has(id)) {
      const bid = view.boxByEntityId.get(id)!;
      const b = view.boxes.find((x: any) => x.id === bid);
      const p = positions[bid]; if (!p || !b) return null;
      const y = p.y - b.hh + HEADER / 2;
      return { x: out ? p.x + b.hw : p.x - b.hw, y };
    }
    // membership row (method / function inside a box) -> that row's pin.
    const m = view.memberIndex.get(id);
    if (m) {
      const p = positions[m.boxId]; if (!p) return null;
      const y = p.y - m.hh + HEADER + (m.row + 0.5) * ROWH;
      return { x: out ? p.x + m.hw : p.x - m.hw, y };
    }
    const p = positions[id]; if (!p) return null;
    return { x: p.x, y: p.y };
  }

  function centerX(id: string) {
    if (view.boxByEntityId && view.boxByEntityId.has(id)) {
      const p = positions[view.boxByEntityId.get(id)!]; return p?.x ?? 0;
    }
    const p = positions[id]; return p?.x ?? 0;
  }

  function wirePath(e: any) {
    // Draw every wire left→right regardless of logical src/tgt: the leftward
    // node exits on its right face, the rightward node enters on its left face.
    const ax = centerX(e.source), bx = centerX(e.target);
    const leftId = ax <= bx ? e.source : e.target;
    const rightId = ax <= bx ? e.target : e.source;
    const a = memberAnchor(leftId, true);   // exit right face of left node
    const b = memberAnchor(rightId, false); // enter left face of right node
    if (!a || !b) return null;
    const c = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return { d: `M${a.x},${a.y} C${a.x + c},${a.y} ${b.x - c},${b.y} ${b.x},${b.y}`, a, b };
  }

  function forceEdge(e: any) {
    const sid = typeof e.source === 'object' ? e.source.id : e.source;
    const tid = typeof e.target === 'object' ? e.target.id : e.target;
    const sp = positions[sid];
    const tp = positions[tid];
    if (!sp || !tp) return null;
    // Inset the target endpoint by the target node's radius (+ arrowhead) so the
    // arrowhead lands at the node's edge instead of hidden under it.
    const tkind = view.kindById?.get(tid);
    const inset = (tkind && tkind.startsWith('io-')) ? 16 : radiusFor(tkind || '') + 7;
    const dx = tp.x - sp.x, dy = tp.y - sp.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    return { x1: sp.x, y1: sp.y, x2: tp.x - ux * inset, y2: tp.y - uy * inset };
  }

  function edgeActive(e: any) {
    if (!hovered) return true;
    const s = e.sNode ?? (typeof e.source === 'object' ? e.source.id : e.source);
    const t = e.tNode ?? (typeof e.target === 'object' ? e.target.id : e.target);
    return s === hovered || t === hovered;
  }
  function nodeActive(id: string) {
    if (!hovered) return true;
    if (id === hovered) return true;
    const nb = view.neighbors.get(hovered);
    return !!nb && nb.has(id);
  }

  // ---------------- drag ----------------
  function clientToGraph(ev: PointerEvent) {
    const pt = svgEl.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const loc = pt.matrixTransform(ctm.inverse());
    return { x: (loc.x - zoomT.x) / zoomT.k, y: (loc.y - zoomT.y) / zoomT.k };
  }
  function onDown(ev: PointerEvent, id: string) {
    ev.stopPropagation();
    dragId = id;
    downPos = { x: ev.clientX, y: ev.clientY, moved: false };
    try { (ev.currentTarget as Element)?.setPointerCapture?.(ev.pointerId); } catch (_) {}
    if (sim) sim.alphaTarget(0.3).restart();   // force mode: reheat
  }
  function onMove(ev: PointerEvent) {
    if (downPos && Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) > 4) downPos.moved = true;
    if (!dragId) return;
    const g = clientToGraph(ev);
    if (sim) {
      // force mode: pin the dragged node, let the sim relax the rest
      const node = simById.get(dragId);
      if (node) { node.fx = g.x; node.fy = g.y; }
    } else {
      // static mode: move only the dragged node, no simulation
      const node = simById.get(dragId);
      if (node) { node.x = g.x; node.y = g.y; }
      positions = { ...positions, [dragId]: { x: g.x, y: g.y } };
    }
  }
  function onUp() {
    if (dragId && sim) {
      const node = simById.get(dragId);
      if (node) { node.fx = null; node.fy = null; }
      sim.alphaTarget(0);
    }
    downPos = null;
    dragId = null;
  }
  let downPos: { x: number; y: number; moved: boolean } | null = null;

  // ---------------- live data + zoom ----------------
  let es: EventSource | null = null;
  onMount(() => {
    const svg = d3.select(svgEl);
    zoomCtl = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 6])
      .filter((ev: any) => {
        if (ev.type === 'wheel') return true;
        // a node drag is in progress (onDown already fired) — never pan/zoom
        if (downPos) return false;
        const t = ev.target;
        // never pan/zoom when grabbing an interactive node (circle, boxes, IO, rows, labels)
        return !(t && t.closest && t.closest('circle, g.uml, g.io, rect, text'));
      })
      .on('zoom', (ev) => { transformStr = ev.transform.toString(); zoomT = { x: ev.transform.x, y: ev.transform.y, k: ev.transform.k }; });
    svg.call(zoomCtl);
    const initStream = repoPath ? `/api/stream?path=${encodeURIComponent(repoPath)}` : streamUrl;
    if (initStream) {
      es = new EventSource(initStream);
      es.onmessage = (ev) => { try { liveGraph = JSON.parse(ev.data); } catch (_) {} };
    }
  });
  onDestroy(() => {
    if (es) { es.close(); es = null; }
    if (sim) { sim.on('tick', null); sim.stop(); }
    if (zoomCtl && svgEl) d3.select(svgEl).on('.zoom', null);
  });
  function zoomBy(f: number) { if (svgEl && zoomCtl) d3.select(svgEl).transition().duration(200).call(zoomCtl.scaleBy, f); }
  function resetZoom() { if (svgEl && zoomCtl) { d3.select(svgEl).transition().duration(200).call(zoomCtl.transform, d3.zoomIdentity); transformStr = 'translate(0,0) scale(1)'; zoomT = { x: 0, y: 0, k: 1 }; } }
  function reheat() { if (sim) sim.alpha(0.9).restart(); }
</script>

<div class="graph-wrap" bind:this={wrapEl} bind:clientWidth={vw} bind:clientHeight={vh}>
  <div class="repobar">
    <input class="repoinput" placeholder="absolute path to a codebase…" bind:value={repoPath}
           onkeydown={(ev) => { if (ev.key === 'Enter') loadRepo(repoPath); }} />
    <button type="button" disabled={loadBusy} onclick={() => loadRepo(repoPath)}>{loadBusy ? 'loading…' : 'Load'}</button>
    <button type="button" disabled={loadBusy} onclick={pickFolder}>Browse…</button>
    {#if loadError}<span class="reperr">{loadError}</span>{/if}
    {#if liveGraph?.meta?.repo}<span class="reposhow">{liveGraph.meta.repo}</span>{/if}
  </div>
  {#if loadPhase && loadPhase !== 'done'}
    <div class="loadbar">
      <div class="loadmsg">
        {loadPhase === 'walk' ? 'Scanning files…'
         : loadPhase === 'parse' ? `Parsing files… ${loadDone}/${loadTotal}`
         : loadPhase === 'resolve' ? 'Resolving symbols…'
         : 'Starting…'}
      </div>
      <div class="loadtrack">
        <div class="loadfill" style="width:{loadTotal ? Math.round(100 * loadDone / loadTotal) : (loadPhase === 'resolve' ? 100 : 5)}%"></div>
      </div>
    </div>
  {/if}
  <div class="controls">
    <input placeholder="filter nodes…" bind:value={search} />
    <label><input type="checkbox" bind:checked={filters.structure} /> structure</label>
    <label><input type="checkbox" bind:checked={filters.calls} /> calls</label>
    <label><input type="checkbox" bind:checked={filters.imports} /> imports</label>
    <label><input type="checkbox" bind:checked={filters['io-in']} /> io-in</label>
    <label><input type="checkbox" bind:checked={filters['io-out']} /> io-out</label>
    <span class="sep">|</span>
    <label><input type="checkbox" bind:checked={kindFilters.file} /> files</label>
    <label><input type="checkbox" bind:checked={kindFilters.class} /> classes</label>
    <label><input type="checkbox" bind:checked={kindFilters.function} /> functions</label>
    <label><input type="checkbox" bind:checked={kindFilters.method} /> methods</label>
    <label><input type="checkbox" bind:checked={kindFilters.external} /> libraries</label>
    <label><input type="checkbox" bind:checked={kindFilters.io} /> IO</label>
    <span class="mode">
      <button type="button" class:on={mode === 'force'} onclick={() => (mode = 'force')}>force</button>
      <button type="button" class:on={mode === 'class'} onclick={() => (mode = 'class')}>class</button>
    </span>
    <span class="zoom">
      <button type="button" onclick={() => zoomBy(1.3)} aria-label="zoom in">+</button>
      <button type="button" onclick={() => zoomBy(1 / 1.3)} aria-label="zoom out">−</button>
      <button type="button" onclick={resetZoom}>reset</button>
      {#if mode === 'force'}<button type="button" onclick={reheat}>reheat</button>{/if}
      {#if mode !== 'force'}<button type="button" onclick={arrangeDataflow}>⇥ arrange L→R</button>{/if}
    </span>
  </div>

  {#if mode === 'force'}
    <div class="forces">
      <label>center<input type="range" min="0" max="0.5" step="0.01" bind:value={centerForce} /><b>{centerForce.toFixed(2)}</b></label>
      <label>repel<input type="range" min="0" max="1200" step="20" bind:value={repelForce} /><b>{repelForce}</b></label>
      <label>link force<input type="range" min="0" max="1" step="0.05" bind:value={linkForce} /><b>{linkForce.toFixed(2)}</b></label>
      <label>link dist<input type="range" min="10" max="300" step="5" bind:value={linkDistance} /><b>{linkDistance}</b></label>
    </div>
  {/if}

  <svg bind:this={svgEl} class="graph" class:tracing={!!trace} viewBox="0 0 {vw} {vh}" preserveAspectRatio="xMidYMid meet"
       onpointermove={onMove} onpointerup={onUp} onpointerleave={onUp} onclick={() => { if (trace) clearTrace(); }}>
    <defs>
      <marker id="bridgehead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#f472b6" />
      </marker>
      <marker id="ah-calls" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#3b82f6" />
      </marker>
      <marker id="ah-imports" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#f59e0b" />
      </marker>
      <marker id="ah-io-in" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#22c55e" />
      </marker>
      <marker id="ah-io-out" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#ef4444" />
      </marker>
      <marker id="ah-structure" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#4b5563" />
      </marker>
    </defs>
    <g transform={transformStr}>
      {#if trace && trace.bridges}
        {#each trace.bridges as bk}
          {@const bs = bk.split('>')[0]}
          {@const bt = bk.split('>')[1]}
          {@const pa = positions[posIdFor(bs)]}
          {@const pb = positions[posIdFor(bt)]}
          {#if pa && pb}
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                  class="bridge" class:cur-edge={curEdge === bk}
                  stroke-dasharray="6,5" marker-end="url(#bridgehead)" />
          {/if}
        {/each}
      {/if}
      {#if view.mode === 'force'}
        {#each view.renderEdges as e}
          {@const g = forceEdge(e)}
          {#if g && present(e.source) && present(e.target)}
            <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={edgeColor[e.kind] || '#555'} stroke-width={hovered && edgeActive(e) ? 2.5 : 1}
                  stroke-dasharray={e.kind === 'structure' ? '3,3' : null} class:dim={hovered && !edgeActive(e)} class:hl={hovered && edgeActive(e)}
                  marker-end="url(#ah-{e.kind})"
                  class:intrace={edgeActiveFn(e)} class:cur-edge={curEdge === e.source + '>' + e.target} />
          {/if}
        {/each}
        {#each view.simNodes as n}
          {@const p = positions[n.id]}
          {#if p}
            {#if n.kind.startsWith('io-')}
              <g class="io {n.dir}" class:dim={hovered && !nodeActive(n.id)} class:hl={hovered === n.id}
                 role="button" tabindex="0" style="cursor:grab{!present(n.id) ? ';display:none' : ''}"
                 class:intrace={trace && trace.order.has(n.id)} class:cur-node={curEdge && (curEdge.startsWith(n.id + '>') || curEdge.endsWith('>' + n.id))}
                 onpointerdown={(ev) => onDown(ev, n.id)}
                 onclick={(ev) => nodeClick(n, ev)}
                 oncontextmenu={(ev) => nodeRightClick(n, ev)}
                 onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') (selected = n); }}
                 onmouseenter={() => (hovered = n.id)} onmouseleave={() => (hovered = null)}>
                <title>{n.label} [{n.kind}]{n.dataType ? ' · ' + n.dataType : ''}{n.sensitive ? ' · SENSITIVE' : ''}{n.owner ? ' | used by ' + n.owner : ''}{n.count > 1 ? ' · ×' + n.count : ''}{n.samples && n.samples.length ? '\n' + n.samples.join('\n') : ''}</title>
                <rect x={p.x - 54} y={p.y - 13} width="108" height="26" rx="6"
                      fill={n.dir === 'in' ? '#052e16' : '#450a0a'} stroke={ioColor(n.dir)} stroke-width="1.5" />
                <text x={p.x - 44} y={p.y + 4} font-size="12" fill={ioColor(n.dir)}>{ioGlyph(n.surface)}</text>
                <text x={p.x - 30} y={p.y + 4} font-size="10" fill="#e2e8f0">{(n.surface || '') + (n.dir === 'in' ? ' ▸in' : ' ◂out')}</text>
              </g>
            {:else}
              <circle cx={p.x} cy={p.y} r={radiusFor(n.kind)} fill={kindColor[n.kind] || '#fff'} stroke="#111" stroke-width="1"
                    role="button" tabindex="0" style="cursor:grab{!present(n.id) ? ';display:none' : ''}"
                    class:dim={hovered && !nodeActive(n.id)} class:hl={hovered === n.id}
                    class:intrace={trace && trace.order.has(n.id)} class:cur-node={curEdge && (curEdge.startsWith(n.id + '>') || curEdge.endsWith('>' + n.id))}
                    onpointerdown={(ev) => onDown(ev, n.id)}
                    onclick={(ev) => nodeClick(n, ev)}
                    oncontextmenu={(ev) => nodeRightClick(n, ev)}
                    onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') (selected = n); }}
                    onmouseenter={() => (hovered = n.id)} onmouseleave={() => (hovered = null)}>
                <title>{n.label || n.id} [{n.kind}]{n.file ? ' | ' + n.file : ''}</title>
              </circle>
              {#if n.kind === 'external' && n.logo && !logoBad.has(n.logo)}
                <image x={p.x - 8} y={p.y - 8} width="16" height="16" href={logoUrl(n.logo)}
                       style={!present(n.id) ? 'display:none' : ''} onerror={() => onLogoError(n.logo)} />
              {/if}
              {#if n.kind === 'file' || n.kind === 'external'}
                <text x={p.x + 11} y={p.y + 3} font-size="10" fill="#cbd5e1" style={!present(n.id) ? 'display:none' : ''} class:dim={hovered && !nodeActive(n.id)}>{(n.label || n.id).split('/').pop()}</text>
              {/if}
            {/if}
          {/if}
        {/each}
      {:else}
        {#each view.renderEdges as e}
          {@const w = wirePath(e)}
          {#if w && present(e.source) && present(e.target)}
            <path d={w.d} fill="none" stroke={edgeColor[e.kind] || '#555'} stroke-width={hovered && edgeActive(e) ? 3 : 1.5}
                  stroke-dasharray={e.kind === 'structure' ? '4,3' : null} class:dim={hovered && !edgeActive(e)} class:hl={hovered && edgeActive(e)}
                  class:intrace={edgeActiveFn(e)} class:cur-edge={curEdge === e.source + '>' + e.target} />
            <circle cx={w.a.x} cy={w.a.y} r={hovered && edgeActive(e) ? 4 : 2.5} fill={edgeColor[e.kind] || '#555'} class:dim={hovered && !edgeActive(e)} class:hl={hovered && edgeActive(e)}
                  class:intrace={edgeActiveFn(e)} class:cur-edge={curEdge === e.source + '>' + e.target} />
            <circle cx={w.b.x} cy={w.b.y} r={hovered && edgeActive(e) ? 4 : 2.5} fill={edgeColor[e.kind] || '#555'} class:dim={hovered && !edgeActive(e)} class:hl={hovered && edgeActive(e)}
                  class:intrace={edgeActiveFn(e)} class:cur-edge={curEdge === e.source + '>' + e.target} />
          {/if}
        {/each}
        {#each view.boxes as b}
          {@const p = positions[b.id]}
          {#if p}
            <g class="uml {b.kind}" class:dim={hovered && !nodeActive(b.id)} class:hl={hovered === b.id}
               class:intrace={(trace && trace.order.has(b.id)) || boxIntrace(b.id)} class:cur-node={(curEdge && (curEdge.startsWith(b.id + '>') || curEdge.endsWith('>' + b.id))) || boxCur(b.id)}
               role="button" tabindex="0" style="cursor:grab{!present(b.entity.id) ? ';display:none' : ''}"
               onpointerdown={(ev) => onDown(ev, b.id)}
               onclick={(ev) => nodeClick(b.entity, ev)}
               oncontextmenu={(ev) => nodeRightClick(b.entity, ev)}
               onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') (selected = b.entity); }}
               onmouseenter={() => (hovered = b.id)} onmouseleave={() => (hovered = null)}>
              <title>{b.label} [{b.kind}]{b.entity?.file ? ' | ' + b.entity.file : ''}</title>
              <rect x={p.x - b.hw} y={p.y - b.hh} width={b.w} height={b.h} rx="6"
                    fill={b.kind === 'class' ? '#1c1408' : b.kind === 'lib' ? '#0a1f17' : '#08111f'}
                    stroke={b.kind === 'class' ? '#fbbf24' : b.kind === 'lib' ? '#34d399' : '#60a5fa'} stroke-width="1.5" />
              <text x={p.x - b.hw + 8} y={p.y - b.hh + 15} font-size="12" font-weight="600"
                    fill={b.kind === 'class' ? '#fbbf24' : b.kind === 'lib' ? '#34d399' : '#60a5fa'}>{b.label}</text>
              <line x1={p.x - b.hw} y1={p.y - b.hh + HEADER} x2={p.x + b.hw} y2={p.y - b.hh + HEADER} stroke="#334155" />
              <circle cx={p.x - b.hw} cy={p.y - b.hh + HEADER / 2} r="3.5" fill="#0b1020" stroke={b.kind === 'class' ? '#fbbf24' : '#60a5fa'} stroke-width="2" />
              <circle cx={p.x + b.hw} cy={p.y - b.hh + HEADER / 2} r="3.5" fill="#0b1020" stroke={b.kind === 'class' ? '#fbbf24' : '#60a5fa'} stroke-width="2" />
              {#each b.rows as m, i}
                {@const ry = p.y - b.hh + HEADER + (i + 0.5) * ROWH}
                {@const mid = view.memberIndex.get(m.id)?.boxId || m.id}
                <rect x={p.x - b.hw} y={ry - ROWH / 2} width={b.w} height={ROWH}
                      fill={memberCur(m.id) ? 'rgba(251,191,36,.22)' : memberIntrace(m.id) ? 'rgba(59,130,246,.18)' : 'transparent'} style="cursor:pointer"
                      class:dim={hovered && hovered !== mid && !nodeActive(mid)}
                      class:row-intrace={memberIntrace(m.id)} class:row-cur={memberCur(m.id)}
                      onclick={(ev) => { ev.stopPropagation(); nodeClick(m, ev); }}
                      oncontextmenu={(ev) => { ev.stopPropagation(); nodeRightClick(m, ev); }}
                      onmouseenter={() => (hovered = mid)} onmouseleave={() => (hovered = null)} />
                <text x={p.x - b.hw + 12} y={ry + 3.5} font-size="11" fill={memberCur(m.id) ? '#fbbf24' : memberIntrace(m.id) ? '#bfdbfe' : '#cbd5e1'} pointer-events="none">{m.label}</text>
                <circle cx={p.x - b.hw} cy={ry} r="3" fill="#0b1020" stroke={b.kind === 'class' ? '#fbbf24' : '#60a5fa'} stroke-width="1.5" pointer-events="none" />
                <circle cx={p.x + b.hw} cy={ry} r="3" fill="#0b1020" stroke={b.kind === 'class' ? '#fbbf24' : '#60a5fa'} stroke-width="1.5" pointer-events="none" />
              {/each}
            </g>
          {/if}
        {/each}
        {#each view.standalones as n}
          {@const p = positions[n.id]}
          {#if p}
            {#if n.kind.startsWith('io-')}
              <g class="io {n.dir}" class:dim={hovered && !nodeActive(n.id)} class:hl={hovered === n.id}
                 role="button" tabindex="0" style="cursor:grab{!present(n.id) ? ';display:none' : ''}"
                 class:intrace={trace && trace.order.has(n.id)} class:cur-node={curEdge && (curEdge.startsWith(n.id + '>') || curEdge.endsWith('>' + n.id))}
                 onpointerdown={(ev) => onDown(ev, n.id)}
                 onclick={(ev) => nodeClick(n, ev)}
                 oncontextmenu={(ev) => nodeRightClick(n, ev)}
                 onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') (selected = n); }}
                 onmouseenter={() => (hovered = n.id)} onmouseleave={() => (hovered = null)}>
                <title>{n.label} [{n.kind}]{n.dataType ? ' · ' + n.dataType : ''}{n.sensitive ? ' · SENSITIVE' : ''}{n.owner ? ' | used by ' + n.owner : ''}{n.count > 1 ? ' · ×' + n.count : ''}{n.samples && n.samples.length ? '\n' + n.samples.join('\n') : ''}</title>
                <rect x={p.x - 54} y={p.y - 13} width="108" height="26" rx="6"
                      fill={n.dir === 'in' ? '#052e16' : '#450a0a'} stroke={ioColor(n.dir)} stroke-width="1.5" />
                <text x={p.x - 44} y={p.y + 4} font-size="12" fill={ioColor(n.dir)}>{ioGlyph(n.surface)}</text>
                <text x={p.x - 30} y={p.y + 4} font-size="10" fill="#e2e8f0">{(n.surface || '') + (n.dir === 'in' ? ' ▸in' : ' ◂out')}</text>
              </g>
            {:else}
              <circle cx={p.x} cy={p.y} r={radiusFor(n.kind)} fill={kindColor[n.kind] || '#fff'} stroke="#111" stroke-width="1"
                    role="button" tabindex="0" style="cursor:grab{!present(n.id) ? ';display:none' : ''}"
                    class:dim={hovered && !nodeActive(n.id)} class:hl={hovered === n.id}
                    class:intrace={trace && trace.order.has(n.id)} class:cur-node={curEdge && (curEdge.startsWith(n.id + '>') || curEdge.endsWith('>' + n.id))}
                    onpointerdown={(ev) => onDown(ev, n.id)}
                    onclick={(ev) => nodeClick(n, ev)}
                    oncontextmenu={(ev) => nodeRightClick(n, ev)}
                    onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') (selected = n); }}
                    onmouseenter={() => (hovered = n.id)} onmouseleave={() => (hovered = null)}>
                <title>{n.label || n.id} [{n.kind}]{n.file ? ' | ' + n.file : ''}</title>
              </circle>
              {#if n.kind === 'external' && n.logo && !logoBad.has(n.logo)}
                <image x={p.x - 8} y={p.y - 8} width="16" height="16" href={logoUrl(n.logo)}
                       style={!present(n.id) ? 'display:none' : ''} onerror={() => onLogoError(n.logo)} />
              {/if}
              <text x={p.x + 11} y={p.y + 3} font-size="10" fill="#cbd5e1" style={!present(n.id) ? 'display:none' : ''} class:dim={hovered && !nodeActive(n.id)}>{(n.label || n.id).split('/').pop()}</text>
            {/if}
          {/if}
        {/each}
      {/if}
    </g>
  </svg>

  {#if selected}
    <div class="inspect">
      <strong>{selected.label || selected.id}</strong> <em>[{selected.kind}]</em>
      {#if selected.file || selected.kind === 'file'}<div class="path">{(selected.file || selected.id)}{#if selected.line}:{selected.line}{/if}</div>{/if}
    </div>
  {/if}

  {#if openMenu}
    <div class="openmenu-backdrop" role="presentation" onclick={closeOpenMenu} onkeydown={() => closeOpenMenu()}></div>
    <div class="openmenu" style="left:{openMenu.x}px; top:{openMenu.y}px">
      <div class="om-title">{openMenu.node.file || openMenu.node.id}{#if openMenu.node.line}:{openMenu.node.line}{/if}</div>
      <div class="om-sub">{openMenu.node.label} [{openMenu.node.kind}] — open with:</div>
      <button type="button" disabled={openBusy} onclick={() => requestOpen('code', openMenu.node)}>VS Code <span class="om-hint">editor @ line</span></button>
      <button type="button" disabled={openBusy} onclick={() => requestOpen('editor', openMenu.node)}>$EDITOR <span class="om-hint">env editor @ line</span></button>
      <button type="button" disabled={openBusy} onclick={() => requestOpen('fm', openMenu.node)}>File manager <span class="om-hint">folder, select file</span></button>
      <button type="button" disabled={openBusy} onclick={() => requestOpen('xdg', openMenu.node)}>xdg-open <span class="om-hint">default app</span></button>
      {#if openBusy}<div class="om-status">opening…</div>{/if}
      {#if openError}<div class="om-error">⚠ {openError}</div>{/if}
      {#if openNote}<div class="om-ok">✓ {openNote}</div>{/if}
    </div>
  {/if}

  {#if selected && selected.kind && selected.kind.startsWith('io-')}
    <aside class="iodrawer">
      <div class="iod-head">
        <span class="iod-kind" style="color:{selected.dir === 'in' ? '#22c55e' : '#ef4444'}">{selected.dir === 'in' ? 'IN' : 'OUT'}</span>
        <strong>{selected.label}</strong>
        {#if selected.dataType}<span class="iod-type">{selected.dataType}</span>{/if}
        {#if selected.aggregate}<span class="iod-count">×{selected.count}</span>{/if}
        <button type="button" class="iod-close" onclick={() => { selected = null; clearTrace(); }} aria-label="close">×</button>
      </div>
      <div class="iod-sub">used by {selected.owner}</div>

      {#if trace && trace.input.id === selected.id}
        <div class="iod-flow">
          <div class="iod-flow-title">data flow · {trace.edges.length} hops · {flowMode === 'single' ? 'one path' : 'entire path'}</div>
          <div class="iod-ctrls">
            <button type="button" class="iod-ctrl" onclick={toggleFlowMode}>{flowMode === 'single' ? 'show entire path' : 'one at a time'}</button>
            <button type="button" class="iod-ctrl" onclick={togglePause}>{flowPaused ? 'play' : 'pause'}</button>
            <button type="button" class="iod-ctrl" onclick={clearTrace}>stop</button>
          </div>
          <div class="iod-progress">
            {#each trace.edges as _, i}
              <span class="iod-pip" class:on={i <= flowPos} class:cur={i === flowPos}></span>
            {/each}
          </div>
          <div class="iod-flow-title">hops ({trace.edges.length})</div>
          <ol class="iod-steps">
            {#each trace.edges as k, i}
              {@const src = k.split('>')[0]}
              {@const tgt = k.split('>')[1]}
              {@const isBridge = trace.bridges && trace.bridges.includes(k)}
              <li class:on={i <= flowPos} class:cur={i === flowPos} class:done={i < flowPos} class:bridge-step={isBridge}>
                <span class="iod-step-n">{i + 1}</span>
                <span class="iod-step-from">{nodeLabelById(src)}</span>
                <span class="iod-step-arrow">{isBridge ? '⇢' : '→'}</span>
                <span class="iod-step-to">{nodeLabelById(tgt)}</span>
                {#if isBridge}<span class="iod-step-badge">network</span>{/if}
              </li>
            {/each}
          </ol>
          <div class="iod-flow-title">outputs ({trace.outputs.length})</div>
          <div class="iod-outs">
            {#each trace.outputs as o}
              <button type="button" class="iod-row" onclick={() => requestOpen('code', { file: o.file, line: o.line })} title="open at line {o.line}">
                <span class="iod-snippet">{o.label}</span>
                {#if o.line}<span class="iod-line">:{o.line}</span>{/if}
              </button>
            {/each}
            {#if trace.outputs.length === 0}<div class="iod-empty">no output node reached</div>{/if}
          </div>
        </div>
      {:else}
        <div class="iod-list">
          {#each ioEntries(selected) as e, i}
            <button type="button" class="iod-row" onclick={() => requestOpen('code', { file: e.file, line: e.line })} title="open at line {e.line}">
              <span class="iod-snippet">{e.snippet}</span>
              {#if e.line}<span class="iod-line">:{e.line}</span>{/if}
            </button>
          {/each}
          {#if ioEntries(selected).length === 0}<div class="iod-empty">no captured snippet</div>{/if}
        </div>
      {/if}
    </aside>
  {/if}
</div>

<style>
  .graph-wrap { position: relative; width: 100%; height: 100%; background: #0b1020; overflow: hidden; }
  .graph { width: 100%; height: 100%; display: block; cursor: grab; }
  .graph:active { cursor: grabbing; }
  .controls {
    position: absolute; top: 44px; left: 8px; z-index: 2;
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    background: rgba(15,23,42,.8); padding: 6px 10px; border-radius: 8px;
    font: 12px system-ui, sans-serif; color: #e2e8f0;
  }
  .controls input:not([type]) { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; border-radius: 4px; padding: 3px 6px; font: inherit; }
  .controls .sep { color: #475569; margin: 0 4px; }
  .repobar { position: absolute; top: 8px; left: 8px; z-index: 3; display: flex; gap: 6px; align-items: center;
             background: rgba(15,23,42,.85); padding: 6px 8px; border-radius: 8px; }
  .repobar .repoinput { width: 320px; background: #0b1020; border: 1px solid #334155; color: #e2e8f0;
                        border-radius: 4px; padding: 4px 8px; font: 12px system-ui; }
  .repobar button { background: #1d4ed8; color: #fff; border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; font: 12px system-ui; }
  .repobar button:disabled { opacity: .6; cursor: default; }
  .repobar .reperr { color: #f87171; font: 11px system-ui; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repobar .reposhow { color: #64748b; font: 11px system-ui; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .loadbar { position: absolute; top: 46px; left: 50%; transform: translateX(-50%); z-index: 5;
             width: 360px; background: rgba(15,23,42,.95); border: 1px solid #334155; border-radius: 8px;
             padding: 12px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
  .loadbar .loadmsg { color: #e2e8f0; font: 12px system-ui; margin-bottom: 8px; }
  .loadbar .loadtrack { height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; }
  .loadbar .loadfill { height: 100%; background: linear-gradient(90deg,#1d4ed8,#22d3ee); transition: width .2s ease; }
  .forces {
    position: absolute; top: 82px; left: 8px; z-index: 2;
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    background: rgba(15,23,42,.8); padding: 5px 10px; border-radius: 8px;
    font: 11px system-ui, sans-serif; color: #cbd5e1;
  }
  .forces label { display: inline-flex; align-items: center; gap: 5px; }
  .forces input[type="range"] { width: 90px; }
  .forces b { color: #93c5fd; min-width: 30px; font-variant-numeric: tabular-nums; }
  .mode { display: inline-flex; gap: 4px; }
  .mode button { background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 4px; padding: 3px 8px; cursor: pointer; font: 12px system-ui; }
  .mode button.on { background: #2563eb; color: #fff; border-color: #3b82f6; }
  .zoom { display: inline-flex; gap: 4px; }
  .zoom button { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 4px; padding: 0 8px; height: 22px; cursor: pointer; font: 13px system-ui; }
  .inspect {
    position: absolute; bottom: 8px; left: 8px; z-index: 2;
    background: rgba(15,23,42,.9); padding: 8px 12px; border-radius: 8px;
    font: 13px system-ui, sans-serif; color: #e2e8f0; max-width: 60%;
  }
  .inspect .path { color: #94a3b8; font-size: 11px; margin-top: 2px; word-break: break-all; }
  .openmenu-backdrop { position: absolute; inset: 0; z-index: 9; }
  .openmenu {
    position: fixed; z-index: 10; min-width: 220px;
    background: #0f172a; border: 1px solid #334155; border-radius: 8px;
    padding: 8px; font: 13px system-ui, sans-serif; color: #e2e8f0;
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
  }
  .openmenu .om-title { font-weight: 600; color: #60a5fa; margin-bottom: 2px; word-break: break-all; }
  .openmenu .om-sub { color: #94a3b8; font-size: 11px; margin-bottom: 8px; }
  .openmenu button {
    display: flex; align-items: baseline; gap: 8px; width: 100%;
    background: #1e293b; color: #e2e8f0; border: 1px solid #334155;
    border-radius: 5px; padding: 6px 9px; cursor: pointer; font: 13px system-ui;
    margin-bottom: 5px; text-align: left;
  }
  .iodrawer {
    position: absolute; top: 46px; right: 0; bottom: 0; z-index: 4;
    width: 320px; background: rgba(15,23,42,.96); border-left: 1px solid #334155;
    display: flex; flex-direction: column; font: 13px system-ui, sans-serif; color: #e2e8f0;
    box-shadow: -8px 0 24px rgba(0,0,0,.4);
  }
  .iod-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 4px; }
  .iod-head strong { font-size: 14px; }
  .iod-kind { font-weight: 700; font-size: 11px; letter-spacing: .5px; }
  .iod-type { background: #1e293b; border: 1px solid #334155; border-radius: 4px; padding: 1px 6px; font-size: 11px; color: #93c5fd; }
  .iod-count { color: #fbbf24; font-size: 12px; }
  .iod-close { margin-left: auto; background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; line-height: 1; }
  .iod-close:hover { color: #e2e8f0; }
  .iod-sub { padding: 0 14px 8px; color: #94a3b8; font-size: 11px; border-bottom: 1px solid #1e293b; }
  .iod-list { overflow-y: auto; padding: 8px; flex: 1; }
  .iod-row {
    display: flex; gap: 8px; width: 100%; text-align: left; cursor: pointer;
    background: #0f172a; border: 1px solid #1e293b; border-radius: 6px;
    padding: 8px 10px; margin-bottom: 6px; color: #cbd5e1; font: 12px ui-monospace, monospace;
  }
  .iod-row:hover { border-color: #3b82f6; background: #111c33; }
  .iod-snippet { flex: 1; word-break: break-all; white-space: pre-wrap; }
  .iod-line { color: #fbbf24; flex-shrink: 0; }
  .iod-empty { color: #64748b; padding: 12px; text-align: center; }
  .iod-trace-box { padding: 10px 14px; border-bottom: 1px solid #1e293b; display: flex; flex-direction: column; gap: 6px; }
  .iod-trace-label { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: .4px; }
  .iod-input { background: #0b1020; border: 1px solid #334155; border-radius: 5px; padding: 6px 8px; color: #e2e8f0; font: 13px system-ui; }
  .iod-input:focus { outline: none; border-color: #3b82f6; }
  .iod-trace-btn { background: #2563eb; color: #fff; border: none; border-radius: 5px; padding: 7px 10px; cursor: pointer; font: 13px system-ui; }
  .iod-trace-btn:hover { background: #1d4ed8; }
  .iod-clear { background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 5px; padding: 4px 8px; cursor: pointer; font: 12px system-ui; align-self: flex-end; }
  .iod-flow { overflow-y: auto; flex: 1; padding: 8px 12px; }
  .iod-flow-title { color: #93c5fd; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; margin: 10px 0 6px; }
  .iod-ctrls { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .iod-ctrl { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 5px; padding: 6px 9px; cursor: pointer; font: 12px system-ui; }
  .iod-ctrl:hover { background: #2563eb; border-color: #3b82f6; color: #fff; }
  .iod-progress { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
  .iod-pip { width: 10px; height: 6px; border-radius: 3px; background: #1e293b; transition: background .2s; }
  .iod-pip.on { background: #3b82f6; }
  .iod-pip.cur { background: #fbbf24; box-shadow: 0 0 5px #fbbf24; }
  .iod-steps { list-style: none; margin: 0; padding: 0; counter-reset: step; max-height: 38vh; overflow-y: auto; }
  .iod-steps li { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 5px; background: #0f172a; border: 1px solid #1e293b; margin-bottom: 4px; font: 12px system-ui; opacity: .45; transition: opacity .2s, border-color .2s; }
  .iod-steps li.on { opacity: 1; }
  .iod-steps li.cur { border-color: #fbbf24; background: #1c1505; box-shadow: 0 0 5px rgba(251,191,36,.5); }
  .iod-steps li.done { opacity: .8; border-color: #1d4ed8; }
  .iod-step-n { background: #1e293b; color: #93c5fd; border-radius: 50%; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; }
  .iod-step-from { color: #cbd5e1; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .iod-step-arrow { color: #64748b; }
  .iod-step-to { color: #93c5fd; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .iod-step-label { flex: 1; color: #cbd5e1; }
  .iod-step-kind { color: #64748b; font-size: 10px; }
  .iod-steps li.bridge-step { border-left: 2px solid #f472b6; }
  .iod-step-badge { font-size: 9px; color: #f472b6; background: #3b0a28; border-radius: 4px; padding: 1px 5px; flex-shrink: 0; }
  .iod-outs { display: flex; flex-direction: column; gap: 6px; }
  /* data-flow trace: dim everything not on the trace path.
     IMPORTANT: do NOT dim generic <g> wrappers — that would multiply opacity
     onto the bright path inside them and make it invisible. Only dim leaf
     node/edge elements, plus non-traced class boxes explicitly. */
  .graph.tracing .io.intrace, .graph.tracing circle.intrace, .graph.tracing .uml.intrace, .graph.tracing g.intrace { opacity: 1; }
  .graph.tracing .io:not(.intrace), .graph.tracing circle:not(.intrace), .graph.tracing .uml:not(.intrace),
  .graph.tracing line:not(.intrace), .graph.tracing path:not(.intrace) { opacity: .12; transition: opacity .25s; }
  .graph.tracing line.intrace, .graph.tracing path.intrace {
    stroke: #3b82f6 !important; stroke-width: 2.5; opacity: 1; filter: drop-shadow(0 0 4px rgba(59,130,246,.9));
  }
  .graph.tracing line.cur-edge, .graph.tracing path.cur-edge {
    stroke: #fbbf24 !important; stroke-width: 4; filter: drop-shadow(0 0 6px rgba(251,191,36,.95));
  }
  .graph.tracing .cur-node { filter: drop-shadow(0 0 6px rgba(251,191,36,.95)); }
  /* virtual cross-file hop (e.g. fetch → API route file) */
  .bridge { stroke: #f472b6; stroke-width: 2.5; opacity: 1; filter: drop-shadow(0 0 5px rgba(244,114,182,.8)); }
  .bridge.cur-edge { stroke: #fbbf24; stroke-width: 4; filter: drop-shadow(0 0 6px rgba(251,191,36,.95)); }
  .openmenu button:hover:not(:disabled) { background: #2563eb; border-color: #3b82f6; }
  .openmenu button:disabled { opacity: .5; cursor: default; }
  .openmenu .om-hint { color: #64748b; font-size: 10px; margin-left: auto; }
  .openmenu .om-status { color: #93c5fd; font-size: 11px; margin-top: 2px; }
  .openmenu .om-error { color: #f87171; font-size: 11px; margin-top: 2px; word-break: break-all; }
  .openmenu .om-ok { color: #34d399; font-size: 11px; margin-top: 2px; word-break: break-all; }
  .dim { opacity: 0.12; }
  .hl { stroke: #fff; stroke-width: 2; }
</style>
