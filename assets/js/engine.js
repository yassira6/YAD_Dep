/* engine.js — model building, formula evaluation and scenario solving.
 *
 * Design note (this is what makes the tool work on real files):
 * Real dependency exports rarely form a tidy tree of inputs and outputs. In the
 * sample data every code carries a formula, many BCodes point outside the values
 * file, and 8 -> 7 -> 6 -> 8 is circular. Recomputing everything from scratch
 * would therefore invent numbers.
 *
 * So the declared Value is treated as the authoritative baseline, and each code
 * stores a residual:
 *
 *     residual(C) = declaredValue(C) - evaluate(formula(C) with declared operands)
 *
 * The residual absorbs whatever the formula does not explain (unresolved
 * operands, rounding, deliberate adjustments) and is held constant. A scenario
 * then re-evaluates
 *
 *     value(C) = evaluate(formula(C) with current operands) + residual(C)
 *
 * which reproduces the file exactly with no changes applied, and propagates a
 * change exactly for + and - formulas. Multiplicative terms whose operand is
 * unresolved are approximations, and every code affected by one is flagged.
 */
(function (global) {
  'use strict';

  var OPS = {
    '+': '+', 'add': '+', 'plus': '+', 'sum': '+', 'p': '+',
    '-': '-', 'sub': '-', 'subtract': '-', 'minus': '-', 'less': '-', 'm': '-', '−': '-', '–': '-',
    '*': '*', 'x': '*', 'mul': '*', 'multiply': '*', 'times': '*', 'prod': '*', '×': '*', '·': '*',
    '/': '/', 'div': '/', 'divide': '/', 'over': '/', '÷': '/', ':': '/',
    '^': '^', 'pow': '^', 'power': '^', '**': '^',
    '%': '%', 'mod': '%', 'modulo': '%'
  };
  var PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
  var MULTIPLICATIVE = { '*': 1, '/': 1, '%': 1, '^': 1 };
  var MAX_ITERATIONS = 400;
  var EPS = 1e-9;

  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    var s = String(v).trim().replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '');
    if (s === '') return NaN;
    var neg = /^\(.*\)$/.test(s);          // (1 234) accounting negatives
    if (neg) s = s.slice(1, -1);
    var pct = /%$/.test(s);
    if (pct) s = s.slice(0, -1);
    s = s.replace(/^[^\d.+-]+/, '');       // strip a currency prefix
    var n = parseFloat(s);
    if (!isFinite(n)) return NaN;
    if (pct) n /= 100;
    return neg ? -n : n;
  }

  /* "*0.5" -> { op:'*', factor:0.5 } ; "add" -> { op:'+' } ; "3" -> { op:'+', factor:3 } */
  function parseOperation(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === '') return { op: '+', factor: null, ok: false, raw: s };
    var lower = s.toLowerCase();
    if (OPS[lower]) return { op: OPS[lower], factor: null, ok: true, raw: s };

    var m = /^([+\-*/^%×÷−–:]|\*\*)?\s*([a-z]+)?\s*([-+]?[\d.,]+(?:[eE][-+]?\d+)?)?\s*$/.exec(lower);
    if (m && (m[1] || m[2] || m[3])) {
      var sym = m[1] ? OPS[m[1]] : (m[2] ? OPS[m[2]] : null);
      var factor = m[3] !== undefined && m[3] !== '' ? num(m[3]) : null;
      if (sym || factor !== null) {
        return { op: sym || '+', factor: (factor !== null && isFinite(factor)) ? factor : null,
                 ok: !!(sym || factor !== null), raw: s };
      }
    }
    return { op: '+', factor: null, ok: false, raw: s };
  }

  function fmtNum(n, digits) {
    if (n == null || !isFinite(n)) return '—';
    var d = digits === undefined ? 4 : digits;
    var r = Math.abs(n) >= 1e12 ? n.toExponential(3)
          : (Math.round(n * 1e10) / 1e10).toLocaleString(undefined, { maximumFractionDigits: d });
    return r;
  }

  /* ── model ─────────────────────────────────────────────────────────── */

  function buildModel(valueRecords, depRecords) {
    var nodes = new Map();
    var issues = [];
    var dupes = [];

    valueRecords.forEach(function (r) {
      var code = String(r.code || '').trim();
      if (!code) return;
      if (nodes.has(code)) { dupes.push(code); return; }
      var v = num(r._raw_value !== undefined ? r._raw_value : r.value);
      nodes.set(code, {
        code: code,
        base: v,
        baseText: r.value === undefined ? '' : String(r.value),
        description: r.description || '',
        type: r.type || '',
        external: false,
        terms: [],
        deps: [],        // codes this one reads
        dependents: [],  // codes that read this one
        residual: 0,
        approx: false,
        scc: -1,
        rank: 0,
        row: r._row
      });
    });

    if (dupes.length) {
      issues.push({ severity: 'error', title: 'Duplicate codes in the values file',
        text: 'A code must appear once — the first occurrence was kept and the later rows ignored.',
        codes: unique(dupes) });
    }

    var nonNumeric = [];
    nodes.forEach(function (n) { if (!isFinite(n.base)) nonNumeric.push(n.code); });
    if (nonNumeric.length) {
      issues.push({ severity: 'warn', title: 'Values that are not numbers',
        text: 'These codes have a blank or non-numeric Value, so they are treated as unknown and cannot be used in arithmetic.',
        codes: nonNumeric });
    }

    function external(code) {
      if (nodes.has(code)) return nodes.get(code);
      var n = {
        code: code, base: NaN, baseText: '', description: 'Referenced by a dependency row but absent from the values file.',
        type: '', external: true, terms: [], deps: [], dependents: [],
        residual: 0, approx: false, scc: -1, rank: 0, row: null
      };
      nodes.set(code, n);
      return n;
    }

    var badOps = [], selfRefs = [], emptyTerms = [], externals = [];

    depRecords.forEach(function (r) {
      var code = String(r.code || '').trim();
      if (!code) return;
      var target = nodes.get(code);
      if (!target) { target = external(code); target.orphanFormula = true; }

      var parsed = parseOperation(r._raw_operation !== undefined && typeof r._raw_operation === 'number'
                                  ? String(r._raw_operation) : r.operation);
      if (!parsed.ok) badOps.push(code + ' → "' + (r.operation || '') + '"');

      var bcode = String(r.bcode == null ? '' : r.bcode).trim();
      var weight = r.weight !== undefined && r.weight !== '' ? num(r.weight) : NaN;
      if (!isFinite(weight)) weight = null;

      var term = {
        op: parsed.op,
        code: bcode || null,
        literal: null,
        weight: weight !== null ? weight : (bcode ? parsed.factor : null),
        row: r._row,
        raw: parsed.raw
      };

      if (!bcode) {
        var lit = parsed.factor;
        if (lit === null || !isFinite(lit)) { emptyTerms.push(code + ' (row ' + r._row + ')'); return; }
        term.literal = lit;
        term.weight = null;
      } else if (bcode === code) {
        selfRefs.push(code);
      }

      if (term.code) {
        var src = nodes.get(term.code) || external(term.code);
        if (src.external) externals.push(src.code);
        if (target.deps.indexOf(term.code) === -1) target.deps.push(term.code);
        if (src.dependents.indexOf(code) === -1) src.dependents.push(code);
      }
      target.terms.push(term);
    });

    if (badOps.length) {
      issues.push({ severity: 'warn', title: 'Operations that could not be read',
        text: 'These rows had an operation this tool does not recognise, so they were treated as “+”. Supported: + − × ÷ ^ %.',
        codes: unique(badOps).slice(0, 40) });
    }
    if (emptyTerms.length) {
      issues.push({ severity: 'warn', title: 'Dependency rows with no operand',
        text: 'These rows have neither a BCode nor a number in the operation, so they contribute nothing and were skipped.',
        codes: unique(emptyTerms).slice(0, 40) });
    }
    if (selfRefs.length) {
      issues.push({ severity: 'error', title: 'Codes that reference themselves',
        text: 'A code appears as its own BCode. Its value cannot be resolved independently and is held at the declared value.',
        codes: unique(selfRefs) });
    }
    if (externals.length) {
      issues.push({ severity: 'warn', title: 'BCodes missing from the values file',
        text: 'These are referenced as dependencies but have no row in the values file, so they have no value of their own. ' +
              'They are shown as dashed “external” nodes and held constant — their contribution stays inside each residual. ' +
              'You can still simulate one: enter a value and it is applied as the change to its contribution.',
        codes: unique(externals) });
    }
    var orphanFormulas = [];
    nodes.forEach(function (n) { if (n.orphanFormula) orphanFormulas.push(n.code); });
    if (orphanFormulas.length) {
      issues.push({ severity: 'error', title: 'Dependency rows for unknown codes',
        text: 'These codes have a formula in the dependency file but no row in the values file, so they have no baseline value.',
        codes: unique(orphanFormulas) });
    }

    var model = { nodes: nodes, issues: issues, types: [], sccOrder: [], cycles: [] };
    analyseStructure(model);
    computeResiduals(model);

    if (model.cycles.length) {
      issues.push({ severity: 'warn', title: 'Circular dependencies',
        text: 'These groups of codes depend on each other in a loop. They are solved by iteration; where the loop does not ' +
              'settle, the affected codes are flagged as unstable in the results rather than given a made-up number.',
        codes: model.cycles.map(function (c) {
          var loop = c.path.join(' → ') + ' → ' + c.path[0];
          return c.members.length > c.path.length
            ? loop + '   (group of ' + c.members.length + ': ' + c.members.join(', ') + ')'
            : loop;
        }) });
    }

    var mismatched = [];
    nodes.forEach(function (n) {
      if (!n.terms.length || n.external) return;
      if (isFinite(n.residual) && materialResidual(n)) mismatched.push(n.code);
    });
    if (mismatched.length) {
      issues.push({ severity: 'info', title: 'Declared value differs from the formula',
        text: 'For these codes the formula over the resolvable operands does not reproduce the declared Value. ' +
              'The difference is kept as a constant residual, so the baseline still matches your file exactly. ' +
              'This is expected when a formula references codes outside the values file.',
        codes: mismatched });
    }

    var typeSet = {};
    nodes.forEach(function (n) { if (n.type) typeSet[n.type] = 1; });
    model.types = Object.keys(typeSet).sort();
    model.stats = statsFor(model);
    return model;
  }

  function unique(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  /* Source spreadsheets round their numbers, so a residual of a few parts per
     million is noise rather than a real disagreement with the formula. */
  function materialResidual(node) {
    if (!node.terms.length || !isFinite(node.residual)) return false;
    return Math.abs(node.residual) > 1e-6 * Math.max(1, Math.abs(node.base));
  }

  function statsFor(model) {
    var s = { total: 0, external: 0, withFormula: 0, leaves: 0, edges: 0, cycles: model.cycles.length, types: model.types.length };
    model.nodes.forEach(function (n) {
      s.total++;
      if (n.external) s.external++;
      if (n.terms.length) s.withFormula++; else s.leaves++;
      s.edges += n.deps.length;
    });
    s.known = s.total - s.external;
    return s;
  }

  /* ── structure: strongly connected components + layering ───────────── */

  function analyseStructure(model) {
    var nodes = model.nodes;
    var index = 0, stack = [], onStack = {}, idx = {}, low = {}, comps = [];

    nodes.forEach(function (_, code) { if (idx[code] === undefined) strongConnect(code); });

    function strongConnect(v) {
      // iterative Tarjan — real files nest deeply enough to blow a recursive stack
      var work = [{ v: v, i: 0 }];
      idx[v] = low[v] = index++; stack.push(v); onStack[v] = true;
      while (work.length) {
        var frame = work[work.length - 1];
        var node = nodes.get(frame.v);
        var deps = node ? node.deps : [];
        if (frame.i < deps.length) {
          var w = deps[frame.i++];
          if (idx[w] === undefined) {
            idx[w] = low[w] = index++; stack.push(w); onStack[w] = true;
            work.push({ v: w, i: 0 });
          } else if (onStack[w]) {
            low[frame.v] = Math.min(low[frame.v], idx[w]);
          }
        } else {
          work.pop();
          if (work.length) {
            var parent = work[work.length - 1].v;
            low[parent] = Math.min(low[parent], low[frame.v]);
          }
          if (low[frame.v] === idx[frame.v]) {
            var comp = [], w2;
            do { w2 = stack.pop(); onStack[w2] = false; comp.push(w2); } while (w2 !== frame.v);
            comps.push(comp);
          }
        }
      }
    }

    comps.forEach(function (comp, i) {
      comp.forEach(function (code) {
        var n = nodes.get(code);
        if (n) { n.scc = i; n.inCycle = comp.length > 1 || (n.deps.indexOf(code) !== -1); }
      });
    });
    model.components = comps;
    model.cycles = comps.filter(function (c) {
      if (c.length > 1) return true;
      var n = nodes.get(c[0]);
      return n && n.deps.indexOf(c[0]) !== -1;
    }).map(function (c) {
      var members = c.slice().sort(function (a, b) {
        return String(a).localeCompare(String(b), undefined, { numeric: true });
      });
      return { members: members, path: findCyclePath(c, nodes) };
    });

    // topological order of the condensation (dependencies first)
    var compDeps = comps.map(function () { return {}; });
    var indeg = comps.map(function () { return 0; });
    var adj = comps.map(function () { return []; });
    comps.forEach(function (comp, ci) {
      comp.forEach(function (code) {
        var n = nodes.get(code);
        if (!n) return;
        n.deps.forEach(function (d) {
          var dn = nodes.get(d);
          if (!dn || dn.scc === ci || dn.scc < 0) return;
          if (!compDeps[ci][dn.scc]) { compDeps[ci][dn.scc] = 1; adj[dn.scc].push(ci); indeg[ci]++; }
        });
      });
    });
    var indeg0 = indeg.slice();
    var queue = [], order = [];
    indeg.forEach(function (d, i) { if (d === 0) queue.push(i); });
    while (queue.length) {
      var c = queue.shift(); order.push(c);
      adj[c].forEach(function (nx) { if (--indeg[nx] === 0) queue.push(nx); });
    }
    comps.forEach(function (_, i) { if (order.indexOf(i) === -1) order.push(i); });
    model.sccOrder = order;

    // layer = longest path through the condensation, so dependencies sit left
    var compRank = comps.map(function () { return 0; });
    order.forEach(function (ci) {
      adj[ci].forEach(function (nx) { compRank[nx] = Math.max(compRank[nx], compRank[ci] + 1); });
    });

    /* Pull pure inputs rightwards, next to whatever consumes them. Without this
       every code that nothing feeds — in a typical export, every BCode missing
       from the values file — is pinned to column 0, which stacks dozens of
       unrelated boxes into one tall ribbon and stretches their edges across the
       whole canvas. A source may sit just left of its earliest consumer. */
    for (var oi = order.length - 1; oi >= 0; oi--) {
      var ci = order[oi];
      if (indeg0[ci] !== 0 || !adj[ci].length) continue;
      var earliest = Infinity;
      adj[ci].forEach(function (nx) { earliest = Math.min(earliest, compRank[nx]); });
      if (isFinite(earliest)) compRank[ci] = Math.max(0, earliest - 1);
    }
    comps.forEach(function (comp, ci) {
      comp.forEach(function (code) { var n = nodes.get(code); if (n) n.rank = compRank[ci]; });
    });
    model.maxRank = compRank.length ? Math.max.apply(null, compRank) : 0;
  }

  /* One concrete loop inside a strongly connected component, following
     "depends on" edges, so the issue panel can show a real path rather than
     just a bag of codes. */
  function findCyclePath(comp, nodes) {
    var inComp = {}, visited = {}, stack = [], onStack = {}, found = null;
    comp.forEach(function (c) { inComp[c] = 1; });

    function dfs(v) {
      if (found) return;
      visited[v] = 1; stack.push(v); onStack[v] = 1;
      var n = nodes.get(v);
      var deps = n ? n.deps : [];
      for (var i = 0; i < deps.length && !found; i++) {
        var d = deps[i];
        if (!inComp[d]) continue;
        if (onStack[d]) { found = stack.slice(stack.indexOf(d)); break; }
        if (!visited[d]) dfs(d);
      }
      stack.pop(); delete onStack[v];
    }
    for (var i = 0; i < comp.length && !found; i++) if (!visited[comp[i]]) dfs(comp[i]);
    return found || comp.slice();
  }

  /* ── evaluation ────────────────────────────────────────────────────── */

  function operandValue(term, get) {
    var v, resolved = true;
    if (term.code) {
      v = get(term.code);
      if (v === undefined || v === null || !isFinite(v)) {
        resolved = false;
        v = MULTIPLICATIVE[term.op] ? 1 : 0;  // identity: the term drops out
      }
    } else {
      v = term.literal;
    }
    if (resolved && term.weight != null && isFinite(term.weight)) v *= term.weight;
    return { v: v, resolved: resolved };
  }

  function evalTerms(terms, get, info) {
    if (!terms.length) return NaN;
    var vals = [], ops = [];
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var o = operandValue(t, get);
      if (!o.resolved && info) {
        info.unresolved = true;
        if (MULTIPLICATIVE[t.op]) info.approx = true;
      }
      var v = o.v;
      if (i === 0) {
        if (t.op === '-') v = -v;             // leading sign
      } else {
        ops.push(t.op);
      }
      vals.push(v);
    }
    return reduce(vals, ops);
  }

  function reduce(vals, ops) {
    // ^ first (right-associative), then × ÷ %, then + −
    var v = vals.slice(), o = ops.slice(), i;
    for (i = o.length - 1; i >= 0; i--) {
      if (o[i] === '^') { v.splice(i, 2, Math.pow(v[i], v[i + 1])); o.splice(i, 1); }
    }
    for (i = 0; i < o.length; ) {
      if (o[i] === '*' || o[i] === '/' || o[i] === '%') {
        var a = v[i], b = v[i + 1], r;
        r = o[i] === '*' ? a * b : (o[i] === '/' ? (b === 0 ? NaN : a / b) : (b === 0 ? NaN : a % b));
        v.splice(i, 2, r); o.splice(i, 1);
      } else i++;
    }
    var acc = v[0];
    for (i = 0; i < o.length; i++) acc = o[i] === '-' ? acc - v[i + 1] : acc + v[i + 1];
    return acc;
  }

  function computeResiduals(model) {
    var nodes = model.nodes;
    var declared = function (code) {
      var n = nodes.get(code);
      return n && isFinite(n.base) ? n.base : undefined;
    };
    nodes.forEach(function (n) {
      if (!n.terms.length) { n.residual = 0; n.explained = NaN; return; }
      var info = {};
      var explained = evalTerms(n.terms, declared, info);
      n.explained = explained;
      n.approx = !!info.approx;
      n.hasUnresolved = !!info.unresolved;
      n.residual = (isFinite(n.base) && isFinite(explained)) ? n.base - explained : 0;
      if (!isFinite(n.base)) n.residual = 0;
    });
  }

  /* ── solving ───────────────────────────────────────────────────────── */

  /* overrides: Map code -> absolute value. Returns values, plus per-code flags. */
  function solve(model, overrides) {
    var nodes = model.nodes;
    var values = new Map();
    var approx = new Set();
    var unstable = new Set();
    var unstableCore = new Set();
    overrides = overrides || new Map();

    nodes.forEach(function (n, code) {
      if (overrides.has(code)) values.set(code, overrides.get(code));
      else values.set(code, isFinite(n.base) ? n.base : NaN);
    });

    var get = function (code) {
      var v = values.get(code);
      return (v === undefined || !isFinite(v)) ? undefined : v;
    };

    function valueOf(n) {
      if (overrides.has(n.code)) return overrides.get(n.code);
      if (!n.terms.length) return isFinite(n.base) ? n.base : NaN;
      var info = {};
      var r = evalTerms(n.terms, get, info);
      if (info.approx) approx.add(n.code);
      if (!isFinite(r)) return isFinite(n.base) ? n.base : NaN;
      return r + n.residual;
    }

    var comps = model.components || [];
    model.sccOrder.forEach(function (ci) {
      var comp = comps[ci];
      if (!comp) return;
      var cyclic = comp.length > 1 || (function () {
        var n = nodes.get(comp[0]);
        return n && n.deps.indexOf(comp[0]) !== -1;
      })();

      if (!cyclic) {
        var n0 = nodes.get(comp[0]);
        if (n0) values.set(comp[0], valueOf(n0));
        return;
      }

      /* A feedback loop only has a well-defined answer when it settles.
         Sweep once to get a first-order estimate (the loop cut at its entry),
         then keep sweeping: if the values converge, use them; if they run away
         — a loop whose gain is 1 or more never settles — fall back to the
         single-pass estimate and label those codes rather than reporting a
         number that grew out of the iteration count. */
      var scale = 1;
      comp.forEach(function (c) {
        var n = nodes.get(c);
        if (n && isFinite(n.base)) scale = Math.max(scale, Math.abs(n.base));
      });
      var tol = EPS * scale;
      var limit = scale * 1e6;

      function sweep() {
        var maxDelta = 0;
        for (var i = 0; i < comp.length; i++) {
          var n = nodes.get(comp[i]);
          if (!n) continue;
          var before = values.get(comp[i]);
          var after = valueOf(n);
          values.set(comp[i], after);
          if (isFinite(before) && isFinite(after)) maxDelta = Math.max(maxDelta, Math.abs(after - before));
          else if (isFinite(before) !== isFinite(after)) maxDelta = Infinity;
        }
        return maxDelta;
      }

      var firstDelta = sweep();
      var firstPass = comp.map(function (c) { return values.get(c); });
      var converged = firstDelta <= tol;

      for (var it = 1; !converged && it < MAX_ITERATIONS; it++) {
        var maxDelta = sweep();
        if (maxDelta <= tol) { converged = true; break; }
        var blown = comp.some(function (c) {
          var v = values.get(c);
          return isFinite(v) ? Math.abs(v) > limit : true;
        });
        if (blown || !isFinite(maxDelta)) break;
      }

      if (!converged) {
        comp.forEach(function (c, i) { values.set(c, firstPass[i]); });
        comp.forEach(function (c) { unstableCore.add(c); unstable.add(c); });
      }
    });

    // codes downstream of an approximation or an unstable loop inherit the flag
    propagateFlag(model, approx);
    propagateFlag(model, unstable);

    return { values: values, approx: approx, unstable: unstable, unstableCore: unstableCore };
  }

  function propagateFlag(model, set) {
    if (!set.size) return;
    var queue = Array.from(set);
    while (queue.length) {
      var code = queue.shift();
      var n = model.nodes.get(code);
      if (!n) continue;
      n.dependents.forEach(function (d) { if (!set.has(d)) { set.add(d); queue.push(d); } });
    }
  }

  /* Baseline vs scenario. Codes are ranked by absolute change. */
  function simulate(model, overrides) {
    var base = solve(model, new Map());
    var sim = solve(model, overrides);
    var rows = [];
    model.nodes.forEach(function (n, code) {
      var b = base.values.get(code), s = sim.values.get(code);
      var changed = (isFinite(b) && isFinite(s)) ? Math.abs(s - b) > 1e-9 : (isFinite(b) !== isFinite(s));
      var delta = (isFinite(b) && isFinite(s)) ? s - b : NaN;
      rows.push({
        code: code, node: n, baseline: b, simulated: s, delta: delta,
        pct: (isFinite(delta) && isFinite(b) && Math.abs(b) > 1e-12) ? (delta / Math.abs(b)) * 100 : NaN,
        changed: changed,
        overridden: overrides.has(code),
        approx: sim.approx.has(code),
        unstable: sim.unstable.has(code),
        unstableCore: sim.unstableCore.has(code)
      });
    });
    rows.sort(function (a, b) {
      var da = isFinite(a.delta) ? Math.abs(a.delta) : -1;
      var db = isFinite(b.delta) ? Math.abs(b.delta) : -1;
      if (db !== da) return db - da;
      return String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
    });
    var impacted = rows.filter(function (r) { return r.changed && !r.overridden; });
    return {
      base: base, sim: sim, rows: rows,
      byCode: rows.reduce(function (m, r) { m[r.code] = r; return m; }, {}),
      impacted: impacted,
      totalDelta: impacted.reduce(function (s, r) { return s + (isFinite(r.delta) ? r.delta : 0); }, 0)
    };
  }

  /* Which codes can a change reach at all (structural reachability)? */
  function downstream(model, code) {
    var seen = new Set(), queue = [code];
    while (queue.length) {
      var c = queue.shift();
      var n = model.nodes.get(c);
      if (!n) continue;
      n.dependents.forEach(function (d) { if (!seen.has(d)) { seen.add(d); queue.push(d); } });
    }
    return seen;
  }
  function upstream(model, code) {
    var seen = new Set(), queue = [code];
    while (queue.length) {
      var c = queue.shift();
      var n = model.nodes.get(c);
      if (!n) continue;
      n.deps.forEach(function (d) { if (!seen.has(d)) { seen.add(d); queue.push(d); } });
    }
    return seen;
  }

  function formulaText(node) {
    if (!node.terms.length) return '';
    return node.terms.map(function (t, i) {
      var operand = t.code !== null ? t.code : fmtNum(t.literal);
      if (t.weight != null && isFinite(t.weight) && t.code !== null) operand = fmtNum(t.weight) + '·' + operand;
      var sym = t.op === '*' ? ' × ' : t.op === '/' ? ' ÷ ' : ' ' + t.op + ' ';
      if (i === 0) return (t.op === '-' ? '−' : '') + operand;
      return sym + operand;
    }).join('').replace(/\s+/g, ' ').trim();
  }

  global.YAD = global.YAD || {};
  global.YAD.engine = {
    buildModel: buildModel,
    solve: solve,
    simulate: simulate,
    downstream: downstream,
    upstream: upstream,
    formulaText: formulaText,
    materialResidual: materialResidual,
    parseOperation: parseOperation,
    num: num,
    fmtNum: fmtNum
  };
})(window);
