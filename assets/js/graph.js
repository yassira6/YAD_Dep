/* graph.js — layered SVG dependency graph with pan / zoom.
   Dependencies sit to the left of the codes that consume them, so a change
   entered anywhere flows visually left → right. */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var NODE_W = 132, GAP_X = 78, GAP_Y = 13;

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    if (attrs) for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function Graph(svg, handlers) {
    this.svg = svg;
    this.handlers = handlers || {};
    this.k = 1; this.tx = 0; this.ty = 0;
    this.layout = null;
    this.defs = el('defs', null, svg);
    ['edge-arrow #94a3b8', 'edge-arrow-live var(--accent)', 'edge-arrow-cycle var(--warn)'].forEach(function (spec) {
      var parts = spec.split(' ');
      var m = el('marker', { id: parts[0], viewBox: '0 0 8 8', refX: 7, refY: 4,
                             markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, this.defs);
      el('path', { d: 'M0,0 L8,4 L0,8 z', fill: parts[1] === '#94a3b8' ? 'var(--line-strong)' : parts[1] }, m);
    }, this);
    this.viewport = el('g', { class: 'viewport' }, svg);
    this.edgeLayer = el('g', null, this.viewport);
    this.nodeLayer = el('g', null, this.viewport);
    this.bind();
  }

  Graph.prototype.bind = function () {
    var self = this, svg = this.svg, drag = null;

    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = svg.getBoundingClientRect();
      self.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(0.998, e.deltaY));
    }, { passive: false });

    /* Panning listens on the window rather than capturing the pointer on the
       <svg>: pointer capture would retarget the follow-up click to the <svg>,
       and node clicks would never fire. */
    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, moved: false };
      global.addEventListener('pointermove', onMove);
      global.addEventListener('pointerup', onUp);
      global.addEventListener('pointercancel', onUp);
    });

    function onMove(e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true;
        svg.classList.add('is-panning');
      }
      if (!drag.moved) return;
      self.tx += dx; self.ty += dy;
      drag.x = e.clientX; drag.y = e.clientY;
      self.apply();
    }

    function onUp(e) {
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      svg.classList.remove('is-panning');
      global.removeEventListener('pointermove', onMove);
      global.removeEventListener('pointerup', onUp);
      global.removeEventListener('pointercancel', onUp);
      if (!moved && e.target === svg && self.handlers.onBackground) self.handlers.onBackground();
    }
  };

  Graph.prototype.apply = function () {
    this.viewport.setAttribute('transform', 'translate(' + this.tx + ',' + this.ty + ') scale(' + this.k + ')');
  };

  Graph.prototype.zoomAt = function (px, py, factor) {
    var k2 = Math.max(0.12, Math.min(3.2, this.k * factor));
    this.tx = px - (px - this.tx) * (k2 / this.k);
    this.ty = py - (py - this.ty) * (k2 / this.k);
    this.k = k2;
    this.apply();
  };

  Graph.prototype.zoom = function (factor) {
    var r = this.svg.getBoundingClientRect();
    this.zoomAt(r.width / 2, r.height / 2, factor);
  };

  Graph.prototype.fit = function (padding) {
    if (!this.layout || !this.layout.nodes.length) return;
    var b = this.layout.bounds, r = this.svg.getBoundingClientRect();
    var pad = padding === undefined ? 40 : padding;
    var w = Math.max(1, b.w), h = Math.max(1, b.h);
    this.k = Math.max(0.12, Math.min(1.35, Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h)));
    this.tx = (r.width - w * this.k) / 2 - b.x * this.k;
    this.ty = (r.height - h * this.k) / 2 - b.y * this.k;
    this.apply();
  };

  Graph.prototype.centreOn = function (code, scale) {
    var pos = this.layout && this.layout.byCode[code];
    if (!pos) return;
    var r = this.svg.getBoundingClientRect();
    if (scale) this.k = Math.max(0.12, Math.min(2.4, scale));
    this.tx = r.width / 2 - (pos.x + pos.w / 2) * this.k;
    this.ty = r.height / 2 - (pos.y + pos.h / 2) * this.k;
    this.apply();
  };

  /* ── layout ────────────────────────────────────────────────────────── */

  function computeLayout(model, visible, showDesc) {
    var h = showDesc ? 50 : 38;

    /* Group by rank, then renumber the ranks that are actually in use. Filtering
       (externals hidden, impacted-only) empties whole columns, and keeping their
       gaps would push the remaining nodes off-centre and shrink them. */
    var byRank = {};
    visible.forEach(function (code) {
      var r = model.nodes.get(code).rank || 0;
      (byRank[r] || (byRank[r] = [])).push(code);
    });
    var ranks = Object.keys(byRank).map(Number).sort(function (a, b) { return a - b; });
    var layers = ranks.map(function (r) { return byRank[r]; });

    layers.forEach(function (layer) {
      layer.sort(function (a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); });
    });

    // barycentre sweeps — fewer crossings, stable output
    var pos = {};
    function reindex() { layers.forEach(function (l) { l.forEach(function (c, i) { pos[c] = i; }); }); }
    reindex();
    function bary(code, neighbours) {
      var vals = [];
      neighbours.forEach(function (nb) { if (pos[nb] !== undefined) vals.push(pos[nb]); });
      if (!vals.length) return pos[code];
      return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    }
    for (var pass = 0; pass < 5; pass++) {
      var forward = pass % 2 === 0;
      var seq = forward ? layers : layers.slice().reverse();
      seq.forEach(function (layer) {
        var scored = layer.map(function (code) {
          var n = model.nodes.get(code);
          var nb = (forward ? n.deps : n.dependents).filter(function (c) { return pos[c] !== undefined; });
          return { code: code, s: bary(code, nb) };
        });
        scored.sort(function (a, b) { return a.s - b.s; });
        layer.length = 0;
        scored.forEach(function (s) { layer.push(s.code); });
        reindex();
      });
    }

    var nodes = [], byCode = {};
    var step = h + GAP_Y;
    var maxCount = layers.reduce(function (m, l) { return Math.max(m, l.length); }, 1);
    var fullH = maxCount * step;
    layers.forEach(function (layer, col) {
      var offset = (fullH - layer.length * step) / 2;
      layer.forEach(function (code, i) {
        var item = { code: code, x: col * (NODE_W + GAP_X), y: offset + i * step, w: NODE_W, h: h };
        nodes.push(item); byCode[code] = item;
      });
    });

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    });
    var bounds = nodes.length
      ? { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
      : { x: 0, y: 0, w: 1, h: 1 };

    return { nodes: nodes, byCode: byCode, bounds: bounds, layers: layers, nodeH: h };
  }

  function edgePath(a, b) {
    var x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
    if (x2 < x1 + 12) {                       // back-edge: route around
      var midY = Math.min(a.y, b.y) - 26;
      return 'M' + x1 + ',' + y1 + ' C' + (x1 + 60) + ',' + midY + ' ' + (x2 - 60) + ',' + midY + ' ' + x2 + ',' + y2;
    }
    var dx = Math.max(28, (x2 - x1) * 0.55);
    return 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
  }

  function trim(text, max) {
    text = String(text || '');
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  /* ── render ────────────────────────────────────────────────────────── */

  Graph.prototype.render = function (model, state) {
    var self = this;
    var fmt = global.YAD.engine.fmtNum;
    state = state || {};
    var result = state.result;
    var visible = [];

    model.nodes.forEach(function (n, code) {
      if (!state.showExternals && n.external) return;
      if (state.impactedOnly && result) {
        var row = result.byCode[code];
        if (!row || (!row.changed && !row.overridden)) return;
      }
      visible.push(code);
    });
    var visibleSet = new Set(visible);

    var layout = computeLayout(model, visible, state.showDescriptions);
    this.layout = layout;

    while (this.edgeLayer.firstChild) this.edgeLayer.removeChild(this.edgeLayer.firstChild);
    while (this.nodeLayer.firstChild) this.nodeLayer.removeChild(this.nodeLayer.firstChild);

    if (!visible.length) {
      var g = el('g', null, this.nodeLayer);
      el('text', { x: 20, y: 40, fill: 'var(--text-faint)', 'font-size': 14 }, g)
        .textContent = 'Nothing to show with the current filters.';
      return;
    }

    var focusSet = null;
    if (state.selected && visibleSet.has(state.selected)) {
      focusSet = new Set([state.selected]);
      global.YAD.engine.upstream(model, state.selected).forEach(function (c) { focusSet.add(c); });
      global.YAD.engine.downstream(model, state.selected).forEach(function (c) { focusSet.add(c); });
    }

    // edges — one path per pair, even when several terms share the same operand
    model.nodes.forEach(function (n, code) {
      if (!visibleSet.has(code)) return;
      var target = layout.byCode[code];
      var seen = {};
      n.terms.forEach(function (t) {
        if (!t.code || !visibleSet.has(t.code)) return;
        if (seen[t.code]) { seen[t.code].ops.push(t.op); return; }
        var source = layout.byCode[t.code];
        if (!source) return;
        seen[t.code] = { ops: [t.op] };

        var srcNode = model.nodes.get(t.code);
        var negative = t.op === '-';
        var live = false;
        if (result) {
          var rs = result.byCode[t.code], rt = result.byCode[code];
          live = !!(rs && rt && (rs.changed || rs.overridden) && (rt.changed || rt.overridden));
        }
        var cyc = n.inCycle && srcNode && srcNode.inCycle && n.scc === srcNode.scc;

        var cls = 'edge' + (negative ? ' op-minus' : '') + (cyc ? ' is-cycle' : '') + (live ? ' is-live' : '');
        if (focusSet && (!focusSet.has(code) || !focusSet.has(t.code))) cls += ' dim';
        var marker = live ? 'edge-arrow-live' : (cyc ? 'edge-arrow-cycle' : 'edge-arrow');
        var p = el('path', { class: cls, d: edgePath(source, target), 'marker-end': 'url(#' + marker + ')' }, self.edgeLayer);
        seen[t.code].el = p;
      });
      Object.keys(seen).forEach(function (src) {
        if (!seen[src].el) return;
        var syms = seen[src].ops.map(function (o) {
          return o === '-' ? '−' : o === '*' ? '×' : o === '/' ? '÷' : o;
        }).join(' ');
        el('title', null, seen[src].el).textContent = code + ' uses ' + src + '  (' + syms + ')';
      });
    });

    // nodes
    layout.nodes.forEach(function (item) {
      var n = model.nodes.get(item.code);
      var row = result ? result.byCode[item.code] : null;
      var cls = 'node';
      if (n.external) cls += ' is-external';
      if (n.inCycle) cls += ' is-cycle';
      if (row && row.overridden) cls += ' is-source';
      else if (row && row.changed) cls += isFinite(row.delta) && row.delta < 0 ? ' is-down' : ' is-up';
      if (state.selected === item.code) cls += ' is-selected';
      if (state.hits && state.hits.has(item.code)) cls += ' is-hit';
      if (focusSet && !focusSet.has(item.code)) cls += ' dim';

      var g = el('g', { class: cls, transform: 'translate(' + item.x + ',' + item.y + ')' }, self.nodeLayer);
      el('rect', { class: 'n-box', width: item.w, height: item.h, rx: 7 }, g);
      el('text', { class: 'n-label', x: 9, y: 15 }, g).textContent = trim(item.code, 14);

      var shown = row ? row.simulated : n.base;
      el('text', { class: 'n-val', x: item.w - 9, y: 15, 'text-anchor': 'end' }, g)
        .textContent = n.external && !isFinite(shown) ? 'ext' : fmt(shown, 2);

      if (row && row.changed && isFinite(row.delta)) {
        var t = el('text', { class: 'n-delta', x: 9, y: 29,
                             fill: row.delta < 0 ? 'var(--down)' : 'var(--up)' }, g);
        t.textContent = (row.delta > 0 ? '+' : '−') + fmt(Math.abs(row.delta), 2) +
                        (row.unstable ? ' ≈' : '');
      } else if (state.showDescriptions === false && n.type) {
        el('text', { class: 'n-desc', x: 9, y: 29 }, g).textContent = trim(n.type, 18);
      }

      if (state.showDescriptions) {
        el('text', { class: 'n-desc', x: 9, y: item.h - 8 }, g)
          .textContent = trim(n.description || (n.external ? 'external code' : n.type), 22);
      }

      el('title', null, g).textContent = item.code + (n.description ? ' — ' + n.description : '') +
        (n.terms.length ? '\n= ' + global.YAD.engine.formulaText(n) : '') +
        (row && row.changed ? '\n' + fmt(row.baseline) + ' → ' + fmt(row.simulated) : '');

      g.addEventListener('click', function (e) {
        e.stopPropagation();
        if (self.handlers.onSelect) self.handlers.onSelect(item.code);
      });
      g.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        if (self.handlers.onActivate) self.handlers.onActivate(item.code);
      });
    });
  };

  global.YAD = global.YAD || {};
  global.YAD.Graph = Graph;
})(window);
