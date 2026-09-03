/* app.js — UI wiring: uploads, scenario building, tables, graph, export. */
(function (global) {
  'use strict';

  var E = global.YAD.engine, P = global.YAD.parse;
  var fmt = E.fmtNum;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    files: { values: null, deps: null },
    model: null,
    result: null,
    overrides: new Map(),
    selected: null,
    hits: new Set(),
    sort: {},
    typeFilter: new Set(),
    ui: { externals: false, impactedOnly: false, descriptions: true }
  };
  var graph = null;
  var combos = {};

  /* ── small helpers ─────────────────────────────────────────────────── */

  function toast(msg, ms) {
    var t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    requestAnimationFrame(function () { t.classList.add('show'); });
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, ms || 3200);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function download(name, text, mime) {
    var blob = new Blob(['﻿' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ── file loading ──────────────────────────────────────────────────── */

  function wireDropzone(zoneId, inputId, kind) {
    var zone = $(zoneId), input = $(inputId);
    var status = zone.querySelector('[data-status]');

    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () { if (input.files[0]) handleFile(input.files[0], kind, zone, status); });

    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('is-over'); });
    });
    zone.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f, kind, zone, status);
    });
  }

  function handleFile(file, kind, zone, status) {
    zone.classList.remove('is-ready', 'is-bad');
    status.textContent = 'Reading ' + file.name + '…';
    P.readFile(file).then(function (sheets) {
      var data = P.extract(sheets, kind);
      state.files[kind] = data;
      zone.classList.add('is-ready');
      var extra = data.sheetCount > 1 ? '  ·  sheet “' + data.sheet + '”' : '';
      status.textContent = '✓ ' + file.name + extra + '\n' + data.records.length +
                           ' rows  ·  columns: ' + data.columns.join(', ');
      refreshBuildButton();
    }).catch(function (err) {
      state.files[kind] = null;
      zone.classList.add('is-bad');
      status.textContent = '✗ ' + err.message;
      refreshBuildButton();
    });
  }

  function refreshBuildButton() {
    var ready = !!(state.files.values && state.files.deps);
    $('btn-build').disabled = !ready;
    $('build-hint').textContent = ready
      ? 'Ready — ' + state.files.values.records.length + ' codes and ' +
        state.files.deps.records.length + ' dependency rows.'
      : 'Both files are needed before the model can be built.';
  }

  function loadSample() {
    try {
      state.files.values = P.extract([{ name: 'values', rows: P.parseDelimited(global.YAD.sample.values) }], 'values');
      state.files.deps = P.extract([{ name: 'dependencies', rows: P.parseDelimited(global.YAD.sample.deps) }], 'deps');
      [['dz-values', 'values.csv'], ['dz-deps', 'dependencies.csv']].forEach(function (pair, i) {
        var zone = $(pair[0]);
        var kind = i === 0 ? 'values' : 'deps';
        zone.classList.remove('is-bad'); zone.classList.add('is-ready');
        zone.querySelector('[data-status]').textContent =
          '✓ ' + pair[1] + ' (sample)\n' + state.files[kind].records.length + ' rows';
      });
      refreshBuildButton();
      build();
    } catch (err) {
      toast('Could not load the sample data: ' + err.message);
    }
  }

  /* ── build & render ────────────────────────────────────────────────── */

  function build() {
    try {
      state.model = E.buildModel(state.files.values.records, state.files.deps.records);
    } catch (err) {
      toast('The model could not be built: ' + err.message);
      return;
    }
    state.overrides.clear();
    state.selected = null;
    state.typeFilter = new Set();

    $('loader').hidden = true;
    $('workspace').hidden = false;
    $('btn-reset').hidden = false;

    state.codeItems = Array.from(state.model.nodes.keys()).sort(function (a, b) {
      return String(a).localeCompare(String(b), undefined, { numeric: true });
    }).map(function (code) {
      var n = state.model.nodes.get(code);
      return {
        code: code,
        search: code + ' ' + n.description + ' ' + n.type,
        codeHtml: esc(code),
        valueHtml: n.external ? '<em>external</em>' : esc(fmt(n.base, 2)),
        subHtml: esc(n.description || n.type || '')
      };
    });

    if (!graph) {
      graph = new global.YAD.Graph($('graph'), {
        onSelect: function (code) { selectNode(code); },
        onActivate: function (code) {
          if (combos.sim) combos.sim.setValue(code); else $('sim-code').value = code;
          previewCode(); $('sim-value').focus();
        },
        onBackground: function () { selectNode(null); }
      });
    }

    renderTypeChips();
    renderLegend();
    $('opt-externals-label').textContent = state.model.stats.external
      ? 'External codes (' + state.model.stats.external + ')'
      : 'External codes';
    recompute();
    setTimeout(function () { graph.fit(); }, 30);
    var ext = state.model.stats.external;
    toast('Model built — ' + state.model.stats.known + ' codes, ' + state.model.stats.edges + ' dependency links.' +
          (ext ? ' ' + ext + ' referenced codes are missing from the values file; tick “External codes” to show them.' : ''),
          ext ? 6000 : 3200);
  }

  function recompute() {
    state.result = E.simulate(state.model, state.overrides);
    renderModelStats();
    renderImpact();
    renderFormulas();
    renderData();
    renderIssues();
    renderScenario();
    renderGraph();
    renderNodeCard();
  }

  function renderGraph() {
    if (!graph) return;
    graph.render(state.model, {
      result: state.overrides.size ? state.result : null,
      selected: state.selected,
      hits: state.hits,
      showExternals: state.ui.externals,
      impactedOnly: state.ui.impactedOnly && state.overrides.size > 0,
      showDescriptions: state.ui.descriptions
    });
  }

  function renderLegend() {
    $('graph-legend').innerHTML = [
      ['var(--accent)', 'var(--accent-soft)', 'changed code (source)'],
      ['var(--up)', 'var(--up-soft)', 'value increased'],
      ['var(--down)', 'var(--down-soft)', 'value decreased'],
      ['var(--ext)', 'var(--surface-2)', 'external (not in values file)'],
      ['var(--warn)', 'transparent', 'in a circular loop']
    ].map(function (l) {
      return '<span class="lg"><i style="border-color:' + l[0] + ';background:' + l[1] + '"></i>' + l[2] + '</span>';
    }).join('') + '<span class="lg">dashed link = subtracted</span>';
  }

  function renderModelStats() {
    var s = state.model.stats;
    $('model-stats').innerHTML = [
      stat('Codes', s.known), stat('External', s.external),
      stat('Links', s.edges), stat('With formula', s.withFormula),
      stat('Loops', s.cycles, s.cycles ? 'warn' : ''), stat('Types', s.types)
    ].join('');
  }

  function stat(k, v, cls) {
    return '<div class="stat ' + (cls || '') + '"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }

  /* ── simulation controls ───────────────────────────────────────────── */

  function previewCode() {
    var code = $('sim-code').value.trim();
    var box = $('sim-preview');
    if (!code) { box.textContent = 'Pick a code to see its current value.'; return; }
    var n = state.model && state.model.nodes.get(code);
    if (!n) { box.innerHTML = '<span class="down">“' + esc(code) + '” is not in this model.</span>'; return; }
    var down = E.downstream(state.model, code);
    box.innerHTML = (n.external
        ? '<strong>External code.</strong> No value of its own — an entry here is applied as the change to its contribution. '
        : '<strong>' + fmt(n.base) + '</strong> · ' + esc(n.type || 'no type') + '. ') +
      (down.size ? down.size + ' code' + (down.size === 1 ? '' : 's') + ' depend on it.'
                 : 'Nothing depends on it — a change here goes nowhere.');
  }

  function addChange() {
    if (!state.model) return;
    var code = $('sim-code').value.trim();
    var n = state.model.nodes.get(code);
    if (!n) { toast(code ? '“' + code + '” is not a code in this model.' : 'Pick a code first.'); return; }
    var raw = parseFloat($('sim-value').value);
    if (!isFinite(raw)) { toast('Enter a number.'); return; }

    var base = isFinite(n.base) ? n.base : 0;
    var mode = $('sim-mode').value;
    var target = mode === 'set' ? raw : mode === 'delta' ? base + raw : base * (1 + raw / 100);
    if (mode === 'pct' && !isFinite(n.base)) {
      toast('“' + code + '” has no baseline value, so a percentage change cannot be applied.');
      return;
    }
    state.overrides.set(code, target);
    $('sim-value').value = '';
    if (combos.sim) combos.sim.setValue(code);
    recompute();
    var impacted = state.result.impacted.length;
    toast(code + ' → ' + fmt(target) + '  ·  ' + impacted + ' code' + (impacted === 1 ? '' : 's') + ' affected');
  }

  function renderScenario() {
    var ul = $('scenario-list');
    if (!state.overrides.size) {
      ul.innerHTML = '<li class="empty">No changes yet — the graph shows the baseline.</li>';
      $('impact-summary-card').hidden = true;
      return;
    }
    ul.innerHTML = '';
    state.overrides.forEach(function (v, code) {
      var n = state.model.nodes.get(code);
      var from = isFinite(n.base) ? fmt(n.base) : 'external';
      var li = document.createElement('li');
      li.className = 'scenario-item';
      li.innerHTML = '<span class="si-code">' + esc(code) + '</span>' +
                     '<span class="si-txt">' + esc(from) + ' → ' + esc(fmt(v)) + '</span>' +
                     '<button type="button" title="Remove">×</button>';
      li.querySelector('button').addEventListener('click', function () {
        state.overrides.delete(code); recompute();
      });
      ul.appendChild(li);
    });

    var r = state.result;
    var up = r.impacted.filter(function (x) { return x.delta > 0; }).length;
    var down = r.impacted.filter(function (x) { return x.delta < 0; }).length;
    var est = r.impacted.filter(function (x) { return x.unstable; }).length;
    $('impact-summary-card').hidden = false;
    $('impact-stats').innerHTML = [
      stat('Affected', r.impacted.length),
      stat('Net change', fmt(r.totalDelta, 2), r.totalDelta > 0 ? 'up' : r.totalDelta < 0 ? 'down' : ''),
      stat('Increased', up, up ? 'up' : ''),
      stat('Decreased', down, down ? 'down' : ''),
      est ? stat('Estimates', est, 'warn') : '',
      stat('Untouched', state.model.stats.known - r.impacted.length - state.overrides.size)
    ].join('');
  }

  /* ── generic table ─────────────────────────────────────────────────── */

  function renderTable(tableId, columns, rows) {
    var table = $(tableId);
    var sort = state.sort[tableId];
    if (sort) {
      var col = columns.filter(function (c) { return c.key === sort.key; })[0];
      if (col && col.sortVal) {
        rows = rows.slice().sort(function (a, b) {
          var va = col.sortVal(a), vb = col.sortVal(b);
          if (typeof va === 'number' && typeof vb === 'number') {
            if (isNaN(va)) va = -Infinity; if (isNaN(vb)) vb = -Infinity;
            return sort.dir * (va - vb);
          }
          return sort.dir * String(va).localeCompare(String(vb), undefined, { numeric: true });
        });
      }
    }

    var head = '<thead><tr>' + columns.map(function (c) {
      var arrow = sort && sort.key === c.key ? '<span class="arrow">' + (sort.dir > 0 ? '▲' : '▼') + '</span>' : '';
      return '<th' + (c.sortVal ? ' data-key="' + c.key + '"' : ' class="no-sort"') + '>' + esc(c.label) + arrow + '</th>';
    }).join('') + '</tr></thead>';

    var body = rows.length
      ? '<tbody>' + rows.map(function (r) {
          return '<tr data-code="' + esc(r.code || '') + '">' + columns.map(function (c) {
            return '<td class="' + (c.cls || '') + '">' + c.render(r) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td colspan="' + columns.length + '"><div class="empty-state">Nothing to show.</div></td></tr></tbody>';

    table.innerHTML = head + body;

    table.querySelectorAll('th[data-key]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        var cur = state.sort[tableId];
        state.sort[tableId] = (cur && cur.key === key) ? { key: key, dir: -cur.dir } : { key: key, dir: -1 };
        renderTable(tableId, columns, rows);
      });
    });
    table.querySelectorAll('tbody tr[data-code]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var code = tr.getAttribute('data-code');
        if (code) { selectNode(code); showTab('pane-graph'); graph.centreOn(code, Math.max(graph.k, 0.9)); }
      });
    });
  }

  function flagCell(r) {
    var out = [];
    if (r.overridden) out.push('<span class="tag t-src">changed</span>');
    if (r.node && r.node.external) out.push('<span class="tag t-ext">external</span>');
    if (r.unstableCore) out.push('<span class="tag t-cyc">in loop</span>');
    else if (r.unstable) out.push('<span class="tag t-cyc">estimate</span>');
    if (r.approx) out.push('<span class="tag t-appx">approx</span>');
    return out.join(' ');
  }

  function deltaCell(r) {
    if (!isFinite(r.delta) || Math.abs(r.delta) < 1e-12) return '<span class="muted">—</span>';
    var cls = r.delta > 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (r.delta > 0 ? '+' : '−') + fmt(Math.abs(r.delta)) + '</span>';
  }

  /* ── panes ─────────────────────────────────────────────────────────── */

  function renderImpact() {
    var r = state.result;
    var rows = state.overrides.size
      ? r.rows.filter(function (x) { return x.changed || x.overridden; })
      : [];
    $('impact-caption').textContent = state.overrides.size
      ? rows.length + ' of ' + state.model.stats.known + ' codes move. Click a row to centre it in the graph.'
      : 'Add a change to the scenario to see how it propagates.';

    var max = rows.reduce(function (m, x) { return Math.max(m, isFinite(x.delta) ? Math.abs(x.delta) : 0); }, 0) || 1;
    renderTable('impact-table', [
      { key: 'code', label: 'Code', cls: 'code', sortVal: function (r) { return r.code; },
        render: function (r) { return esc(r.code); } },
      { key: 'desc', label: 'Description', cls: 'wide', sortVal: function (r) { return r.node.description; },
        render: function (r) { return esc(r.node.description || ''); } },
      { key: 'type', label: 'Type', sortVal: function (r) { return r.node.type; },
        render: function (r) { return esc(r.node.type || ''); } },
      { key: 'base', label: 'Baseline', cls: 'num', sortVal: function (r) { return r.baseline; },
        render: function (r) { return fmt(r.baseline); } },
      { key: 'sim', label: 'Simulated', cls: 'num', sortVal: function (r) { return r.simulated; },
        render: function (r) { return '<strong>' + fmt(r.simulated) + '</strong>'; } },
      { key: 'delta', label: 'Change', cls: 'num', sortVal: function (r) { return isFinite(r.delta) ? Math.abs(r.delta) : -1; },
        render: deltaCell },
      { key: 'pct', label: '% change', cls: 'num', sortVal: function (r) { return isFinite(r.pct) ? Math.abs(r.pct) : -1; },
        render: function (r) {
          if (!isFinite(r.pct)) return '<span class="muted">—</span>';
          return '<span class="' + (r.pct > 0 ? 'up' : r.pct < 0 ? 'down' : '') + '">' +
                 (r.pct > 0 ? '+' : '') + fmt(r.pct, 1) + '%</span>';
        } },
      { key: 'bar', label: 'Magnitude',
        render: function (r) {
          var w = isFinite(r.delta) ? Math.max(2, Math.abs(r.delta) / max * 90) : 2;
          return '<span class="bar ' + (r.delta < 0 ? 'neg' : 'pos') + '" style="width:' + w + 'px"></span>';
        } },
      { key: 'flags', label: 'Notes', render: flagCell }
    ], rows);
  }

  function renderFormulas() {
    var q = $('formula-search').value.trim().toLowerCase();
    var rows = [];
    state.model.nodes.forEach(function (n, code) {
      if (!n.terms.length) return;
      if (q && (code + ' ' + n.description + ' ' + E.formulaText(n)).toLowerCase().indexOf(q) === -1) return;
      var r = state.result.byCode[code];
      rows.push({ code: code, node: n, row: r, formula: E.formulaText(n) });
    });
    renderTable('formula-table', [
      { key: 'code', label: 'Code', cls: 'code', sortVal: function (r) { return r.code; },
        render: function (r) { return esc(r.code); } },
      { key: 'formula', label: 'Formula', cls: 'formula', sortVal: function (r) { return r.formula; },
        render: function (r) { return esc(r.code) + ' = ' + esc(r.formula); } },
      { key: 'terms', label: 'Terms', cls: 'num', sortVal: function (r) { return r.node.terms.length; },
        render: function (r) { return r.node.terms.length; } },
      { key: 'declared', label: 'Declared', cls: 'num', sortVal: function (r) { return r.node.base; },
        render: function (r) { return fmt(r.node.base); } },
      { key: 'explained', label: 'Formula gives', cls: 'num', sortVal: function (r) { return r.node.explained; },
        render: function (r) { return fmt(r.node.explained); } },
      { key: 'residual', label: 'Residual', cls: 'num', sortVal: function (r) { return Math.abs(r.node.residual); },
        render: function (r) {
          return Math.abs(r.node.residual) < 1e-9 ? '<span class="muted">0</span>' : fmt(r.node.residual);
        } },
      { key: 'unres', label: 'Unresolved operands', cls: 'num',
        sortVal: function (r) { return r.node.terms.filter(function (t) { return t.code && state.model.nodes.get(t.code).external; }).length; },
        render: function (r) {
          var k = r.node.terms.filter(function (t) { return t.code && state.model.nodes.get(t.code).external; }).length;
          return k ? '<span class="tag t-ext">' + k + '</span>' : '<span class="muted">0</span>';
        } },
      { key: 'flags', label: 'Notes', render: function (r) { return flagCell(r.row || { node: r.node }); } }
    ], rows);
  }

  function renderData() {
    var q = $('data-search').value.trim().toLowerCase();
    var rows = [];
    state.model.nodes.forEach(function (n, code) {
      if (state.typeFilter.size && !state.typeFilter.has(n.type)) return;
      if (q && (code + ' ' + n.description + ' ' + n.type).toLowerCase().indexOf(q) === -1) return;
      rows.push({ code: code, node: n, row: state.result.byCode[code] });
    });
    renderTable('data-table', [
      { key: 'code', label: 'Code', cls: 'code', sortVal: function (r) { return r.code; },
        render: function (r) { return esc(r.code); } },
      { key: 'value', label: 'Value', cls: 'num', sortVal: function (r) { return r.node.base; },
        render: function (r) { return r.node.external ? '<span class="muted">—</span>' : fmt(r.node.base); } },
      { key: 'desc', label: 'Description', cls: 'wide', sortVal: function (r) { return r.node.description; },
        render: function (r) { return esc(r.node.description || ''); } },
      { key: 'type', label: 'Type', sortVal: function (r) { return r.node.type; },
        render: function (r) { return esc(r.node.type || ''); } },
      { key: 'deps', label: 'Depends on', cls: 'num', sortVal: function (r) { return r.node.deps.length; },
        render: function (r) { return r.node.deps.length; } },
      { key: 'used', label: 'Used by', cls: 'num', sortVal: function (r) { return r.node.dependents.length; },
        render: function (r) { return r.node.dependents.length; } },
      { key: 'flags', label: 'Notes', render: function (r) { return flagCell(r.row || { node: r.node }); } }
    ], rows);
  }

  function renderTypeChips() {
    var box = $('type-chips');
    box.innerHTML = '';
    state.model.types.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = t;
      b.addEventListener('click', function () {
        if (state.typeFilter.has(t)) state.typeFilter.delete(t); else state.typeFilter.add(t);
        b.classList.toggle('is-on');
        renderData();
      });
      box.appendChild(b);
    });
  }

  function renderIssues() {
    var issues = state.model.issues;
    var box = $('issue-list');
    var pill = $('issue-count');
    pill.textContent = issues.length;
    pill.classList.toggle('hot', issues.some(function (i) { return i.severity === 'error'; }));

    if (!issues.length) {
      box.innerHTML = '<div class="empty-state">No structural problems found — every dependency resolves, ' +
                      'and nothing is circular.</div>';
      return;
    }
    box.innerHTML = issues.map(function (i) {
      var ico = i.severity === 'error' ? '✕' : i.severity === 'warn' ? '!' : 'i';
      var codes = (i.codes || []).slice(0, 60).map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('');
      var more = (i.codes || []).length > 60 ? '<span>+' + ((i.codes.length) - 60) + ' more</span>' : '';
      return '<div class="issue sev-' + i.severity + '"><div class="issue-ico">' + ico + '</div><div>' +
             '<h4>' + esc(i.title) + '</h4><p>' + esc(i.text) + '</p>' +
             (codes ? '<div class="codes">' + codes + more + '</div>' : '') + '</div></div>';
    }).join('');
  }

  /* ── node card ─────────────────────────────────────────────────────── */

  function selectNode(code) {
    state.selected = code;
    renderGraph();
    renderNodeCard();
  }

  function renderNodeCard() {
    var card = $('node-card');
    if (!state.selected || !state.model.nodes.has(state.selected)) { card.hidden = true; return; }
    var code = state.selected;
    var n = state.model.nodes.get(code);
    var r = state.result.byCode[code];

    function chips(codes, label) {
      if (!codes.length) return '';
      return '<div class="nc-sec">' + label + ' (' + codes.length + ')</div><ul class="nc-list">' +
        codes.slice(0, 40).map(function (c) { return '<li data-code="' + esc(c) + '">' + esc(c) + '</li>'; }).join('') +
        (codes.length > 40 ? '<li class="muted">+' + (codes.length - 40) + '</li>' : '') + '</ul>';
    }

    var rows = [['Baseline', n.external ? '—' : fmt(n.base)]];
    if (state.overrides.size && r && (r.changed || r.overridden)) {
      rows.push(['Simulated', fmt(r.simulated)]);
      rows.push(['Change', (r.delta > 0 ? '+' : '') + fmt(r.delta)]);
      if (isFinite(r.pct)) rows.push(['% change', (r.pct > 0 ? '+' : '') + fmt(r.pct, 1) + '%']);
    }
    if (n.terms.length && Math.abs(n.residual) > 1e-9) rows.push(['Residual', fmt(n.residual)]);

    card.hidden = false;
    card.innerHTML =
      '<button class="nc-close" type="button" aria-label="Close">×</button>' +
      '<h4>' + esc(code) + '</h4>' +
      (n.type ? '<span class="nc-type">' + esc(n.type) + '</span>' : '') +
      '<p class="nc-desc">' + esc(n.description || (n.external ? 'Not present in the values file.' : '')) + '</p>' +
      (n.terms.length ? '<div class="nc-formula">' + esc(code) + ' = ' + esc(E.formulaText(n)) + '</div>' : '') +
      '<dl>' + rows.map(function (kv) { return '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>'; }).join('') + '</dl>' +
      (r ? '<div style="margin-bottom:.6rem">' + flagCell(r) + '</div>' : '') +
      chips(n.deps, 'Depends on') +
      chips(n.dependents, 'Used by') +
      '<button class="btn btn-block btn-sm" type="button" data-sim>Simulate this code</button>';

    card.querySelector('.nc-close').addEventListener('click', function () { selectNode(null); });
    card.querySelector('[data-sim]').addEventListener('click', function () {
      if (combos.sim) combos.sim.setValue(code); else $('sim-code').value = code;
      previewCode(); $('sim-value').focus();
      if (global.innerWidth <= 900) {
        var side = document.querySelector('.sidebar');
        if (side && side.scrollIntoView) side.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    card.querySelectorAll('.nc-list li[data-code]').forEach(function (li) {
      li.addEventListener('click', function () {
        var c = li.getAttribute('data-code');
        selectNode(c); graph.centreOn(c, Math.max(graph.k, 0.9));
      });
    });
  }

  function applyGraphSearch(text) {
    var q = String(text || '').trim().toLowerCase();
    state.hits = new Set();
    if (q && state.model) {
      state.model.nodes.forEach(function (n, code) {
        if ((code + ' ' + n.description + ' ' + n.type).toLowerCase().indexOf(q) !== -1) state.hits.add(code);
      });
    }
    renderGraph();
  }

  /* Bring a code into view: reveal it if a filter is hiding it, select it so its
     dependencies stay lit, and centre the graph on it. */
  function focusCode(code) {
    if (!state.model || !state.model.nodes.has(code)) return;
    var n = state.model.nodes.get(code);
    if (n.external && !state.ui.externals) {
      state.ui.externals = true;
      $('opt-externals').checked = true;
    }
    if (state.ui.impactedOnly) {
      var row = state.result && state.result.byCode[code];
      if (!row || (!row.changed && !row.overridden)) {
        state.ui.impactedOnly = false;
        $('opt-impacted').checked = false;
      }
    }
    state.hits = new Set([code]);
    showTab('pane-graph');
    selectNode(code);
    if (graph) {
      if (!graph.layout) graph.fit();
      graph.centreOn(code, Math.max(graph.k, 0.95));
    }
    if (global.innerWidth <= 900) {
      var wrap = document.querySelector('.graph-wrap');
      if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ── tabs ──────────────────────────────────────────────────────────── */

  function showTab(paneId) {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-pane') === paneId);
    });
    document.querySelectorAll('.pane').forEach(function (p) {
      p.classList.toggle('is-active', p.id === paneId);
    });
    if (paneId === 'pane-graph' && graph && !graph.layout) graph.fit();
  }

  /* ── export ────────────────────────────────────────────────────────── */

  function exportCsv() {
    var r = state.result;
    var header = ['Code', 'Description', 'Type', 'Baseline', 'Simulated', 'Change', 'PercentChange', 'Role', 'Notes'];
    var lines = [header.join(',')];
    var scenario = [];
    state.overrides.forEach(function (v, c) { scenario.push(c + '=' + v); });

    r.rows.filter(function (x) { return x.changed || x.overridden; }).forEach(function (x) {
      lines.push([
        x.code, x.node.description, x.node.type,
        isFinite(x.baseline) ? x.baseline : '',
        isFinite(x.simulated) ? x.simulated : '',
        isFinite(x.delta) ? x.delta : '',
        isFinite(x.pct) ? x.pct.toFixed(4) : '',
        x.overridden ? 'changed by scenario' : 'affected',
        [x.unstableCore ? 'in circular loop' : (x.unstable ? 'estimate (downstream of a loop)' : ''),
         x.approx ? 'approximate (unresolved operand in a × ÷ term)' : ''].filter(Boolean).join('; ')
      ].map(csvCell).join(','));
    });
    lines.push('');
    lines.push(csvCell('Scenario: ' + (scenario.join('; ') || 'none')));
    lines.push(csvCell('Exported: ' + new Date().toISOString()));
    download('yad-dep-simulation.csv', lines.join('\n'));
    toast('Results exported.');
  }

  /* ── boot ──────────────────────────────────────────────────────────── */

  function init() {
    var saved = null;
    try { saved = localStorage.getItem('yad-theme'); } catch (e) {}
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    else if (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }

    wireDropzone('dz-values', 'file-values', 'values');
    wireDropzone('dz-deps', 'file-deps', 'deps');

    $('btn-build').addEventListener('click', build);
    $('btn-demo').addEventListener('click', loadSample);
    $('btn-reset').addEventListener('click', function () { global.location.reload(); });
    $('btn-templates').addEventListener('click', function () {
      download('values-template.csv', global.YAD.sample.templates.values);
      setTimeout(function () { download('dependencies-template.csv', global.YAD.sample.templates.deps); }, 250);
      toast('Two template files downloaded.');
    });
    $('btn-theme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('yad-theme', next); } catch (e) {}
      if (graph && state.model) renderGraph();
    });

    $('btn-add-change').addEventListener('click', addChange);

    var items = function () { return state.codeItems || []; };

    /* Simulator picker: choosing a code previews it and moves on to the amount. */
    combos.sim = new global.YAD.Combobox($('sim-code'), {
      items: items,
      onInput: previewCode,
      onChoose: function (code) {
        previewCode();
        if (state.model && state.model.nodes.has(code)) {
          selectNode(code);
          if (graph && graph.layout) graph.centreOn(code, Math.max(graph.k, 0.85));
        }
        $('sim-value').focus();
      }
    });

    /* Graph picker: typing highlights matches, choosing one focuses it. */
    combos.find = new global.YAD.Combobox($('graph-search'), {
      items: items,
      onInput: applyGraphSearch,
      onChoose: focusCode
    });
    $('sim-value').addEventListener('keydown', function (e) { if (e.key === 'Enter') addChange(); });
    $('btn-clear-scenario').addEventListener('click', function () {
      if (!state.overrides.size) return;
      state.overrides.clear(); recompute(); toast('Scenario cleared.');
    });
    $('btn-export').addEventListener('click', exportCsv);

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { showTab(t.getAttribute('data-pane')); });
    });

    $('opt-externals').addEventListener('change', function (e) { state.ui.externals = e.target.checked; renderGraph(); });
    $('opt-impacted').addEventListener('change', function (e) { state.ui.impactedOnly = e.target.checked; renderGraph(); });
    $('opt-labels').addEventListener('change', function (e) { state.ui.descriptions = e.target.checked; renderGraph(); });
    $('btn-fit').addEventListener('click', function () { graph && graph.fit(); });
    $('btn-zoom-in').addEventListener('click', function () { graph && graph.zoom(1.25); });
    $('btn-zoom-out').addEventListener('click', function () { graph && graph.zoom(0.8); });

    $('formula-search').addEventListener('input', renderFormulas);
    $('data-search').addEventListener('input', renderData);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.selected) selectNode(null);
    });

    global.addEventListener('resize', function () {
      clearTimeout(global._fitTimer);
      global._fitTimer = setTimeout(function () { if (graph && graph.layout) graph.fit(); }, 200);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
