/* app.js — UI wiring: uploads, scenario building, tables, graph, export. */
(function (global) {
  'use strict';

  var E = global.YAD.engine, P = global.YAD.parse, DS = global.YAD.datasets, SIM = global.YAD.similarity;
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
    ui: { externals: false, impactedOnly: false, descriptions: true },
    view: { isolate: null, hidden: new Set() },  // isolate: {root, depth}
    similar: { basis: 'deps', minShared: 2, sameTypeOnly: false, search: '' },
    compare: { codes: [], basis: 'deps' }
  };
  var graph = null;
  var combos = {};
  var simCache = {};   // basis -> raw YAD.similarity.scan() result, reset on every model build

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
      data.name = file.name;
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

  function loadBundled(key) {
    var spec = global.YAD.sample[key];
    try {
      var values = P.extract([{ name: 'values', rows: P.parseDelimited(spec.values) }], 'values');
      var deps = P.extract([{ name: 'dependencies', rows: P.parseDelimited(spec.deps) }], 'deps');
      DS.add(spec.name, values.records, deps.records);
      openActive();
      toast('Loaded “' + spec.name + '”.');
    } catch (err) {
      toast('Could not load that dataset: ' + err.message);
    }
  }

  /* ── datasets ──────────────────────────────────────────────────────── */

  function renderDatasetBar() {
    var bar = $('dataset-bar');
    var sel = $('dataset-select');
    var list = DS.all();
    bar.hidden = list.length === 0;
    if (list.length) {
      sel.innerHTML = list.map(function (d) {
        return '<option value="' + esc(d.id) + '"' + (d.id === DS.activeId() ? ' selected' : '') + '>' +
               esc(d.name) + ' · ' + d.values.length + ' codes</option>';
      }).join('');
      $('btn-ds-remove').disabled = false;
    }
    renderDatasetHome();
  }

  /* The home screen's own picker — lets you jump straight into any
     previously uploaded dataset without touching the header switcher. */
  function renderDatasetHome() {
    var box = $('dataset-home');
    var grid = $('dataset-grid');
    var list = DS.all();
    box.hidden = list.length === 0;
    if (!list.length) { grid.innerHTML = ''; return; }

    grid.innerHTML = list.map(function (d) {
      return '<button type="button" class="dataset-card" data-id="' + esc(d.id) + '">' +
        '<span class="dc-name">' + esc(d.name) + '</span>' +
        '<span class="dc-meta">' + d.values.length + ' codes · ' + d.deps.length + ' dependency rows</span>' +
      '</button>';
    }).join('');
    grid.querySelectorAll('.dataset-card').forEach(function (btn) {
      btn.addEventListener('click', function () {
        DS.setActive(btn.getAttribute('data-id'));
        openActive();
      });
    });
  }

  /* Build and show whichever dataset is active. */
  function openActive() {
    var d = DS.active();
    if (!d) { showLoader(); return; }
    try {
      state.model = E.buildModel(d.values, d.deps);
    } catch (err) {
      toast('This dataset could not be built: ' + err.message);
      return;
    }
    state.overrides.clear();
    state.selected = null;
    state.hits = new Set();
    state.typeFilter = new Set();
    state.view = { isolate: null, hidden: new Set() };
    state.positions = DS.positions(d.id);

    $('loader').hidden = true;
    $('workspace').hidden = false;
    $('btn-home').hidden = false;
    renderDatasetBar();
    afterModelBuilt();
  }

  function showLoader() {
    $('workspace').hidden = true;
    $('loader').hidden = false;
    $('btn-home').hidden = true;
    $('btn-loader-cancel').hidden = DS.count() === 0;
    renderDatasetBar();
    $('dataset-bar').hidden = true;   // the home screen's own dataset cards replace it here
    ['dz-values', 'dz-deps'].forEach(function (id) {
      var z = $(id);
      z.classList.remove('is-ready', 'is-bad');
      z.querySelector('[data-status]').textContent = 'Drop a file here, or click to browse';
    });
    state.files = { values: null, deps: null };
    refreshBuildButton();
  }

  function renameActive() {
    var d = DS.active();
    if (!d) return;
    global.YAD.dialog.text('Rename dataset', 'Name', d.name).then(function (name) {
      if (!name) return;
      DS.rename(d.id, name);
      renderDatasetBar();
      toast('Renamed to “' + DS.active().name + '”.');
    });
  }

  function removeActive() {
    var d = DS.active();
    if (!d) return;
    global.YAD.dialog.confirm(
      'Remove dataset',
      '“' + d.name + '” (' + d.values.length + ' codes) will be removed from this browser. ' +
      'Your original files are untouched.',
      'Remove', true
    ).then(function (yes) {
      if (!yes) return;
      var name = d.name;
      DS.remove(d.id);
      if (DS.count()) openActive(); else showLoader();
      toast('Removed “' + name + '”.');
    });
  }

  /* ── build & render ────────────────────────────────────────────────── */

  /* Turn the two uploaded files into a new dataset, then open it. */
  function build() {
    if (!state.files.values || !state.files.deps) return;
    try {
      E.buildModel(state.files.values.records, state.files.deps.records);   // validate first
    } catch (err) {
      toast('The model could not be built: ' + err.message);
      return;
    }
    var name = (state.files.values.name || 'Dataset').replace(/\.[^.]+$/, '');
    DS.add(name, state.files.values.records, state.files.deps.records);
    openActive();
  }

  function afterModelBuilt() {

    simCache = {};
    state.compare = { codes: [], basis: state.compare.basis };

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
        onBackground: function () { selectNode(null); },
        onMoveNode: function (code, x, y) {
          DS.setPosition(DS.activeId(), code, x, y);   // state.positions is the same object
          $('btn-reset-layout').hidden = false;
        }
      });
    }

    renderTypeChips();
    renderLegend();
    renderViewChips();
    renderSimilar();
    renderCompareChips();
    renderCompareBody();
    $('btn-reset-layout').hidden = !Object.keys(state.positions || {}).length;
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
      showDescriptions: state.ui.descriptions,
      positions: state.positions,
      hidden: state.view.hidden,
      isolate: isolationSet()
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

  /* ── similarity: scan the whole model for overlapping codes ──────────
     "Overlap" means shared dependencies, not similar numbers — two codes
     that both read from the same three inputs are flagged even if their
     resulting values are nothing alike. See assets/js/similarity.js for the
     match (Jaccard) vs. containment distinction. */

  function similarityFor(basis) {
    if (!simCache[basis]) simCache[basis] = SIM.scan(state.model, { basis: basis, minShared: 1, limit: 4000 });
    return simCache[basis];
  }

  function meterCell(frac, hi) {
    var pct = Math.round(frac * 100);
    return '<span class="sim-meter"><span class="sim-meter-track">' +
           '<span class="sim-meter-fill' + (hi ? ' hi' : '') + '" style="width:' + pct + '%"></span></span>' +
           '<span class="sim-meter-val">' + pct + '%</span></span>';
  }

  function overlapCell(shared) {
    var limit = 6;
    if (!shared.length) return '<span class="muted">—</span>';
    var shown = shared.slice(0, limit).map(function (c) { return '<span class="dep">' + esc(c) + '</span>'; }).join('');
    var more = shared.length > limit ? '<span class="more">+' + (shared.length - limit) + ' more</span>' : '';
    return '<div class="sim-overlap">' + shown + more + '</div>';
  }

  function relationBadge(p) {
    if (p.identical) return '<span class="sim-badge identical">identical</span>';
    if (p.subset) {
      return '<span class="sim-badge subset">' +
             (p.onlyA === 0 ? esc(p.a) + ' is part of ' + esc(p.b) : esc(p.b) + ' is part of ' + esc(p.a)) +
             '</span>';
    }
    return '';
  }

  function basisLabel(basis) {
    return basis === 'upstream' ? 'the same full upstream chain'
         : basis === 'dependents' ? 'exactly the same dependents'
         : 'exactly the same direct dependencies';
  }

  function renderSimGroups(groups, basis) {
    var box = $('sim-groups');
    if (!groups.length) { box.innerHTML = ''; return; }
    var label = basisLabel(basis);
    box.innerHTML = groups.slice(0, 12).map(function (g) {
      return '<div class="sim-group-card">' +
        '<strong>' + g.codes.length + ' codes share ' + esc(label) + '</strong>' +
        '<div class="codes">' + g.codes.map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('') + '</div>' +
        '<button type="button" class="btn btn-sm" data-compare-group="' + esc(g.codes.join('|')) + '">Compare these</button>' +
      '</div>';
    }).join('') + (groups.length > 12
      ? '<p class="muted" style="padding:0 0 .7rem">+' + (groups.length - 12) + ' more identical groups — narrow the filters to see them.</p>'
      : '');

    box.querySelectorAll('[data-compare-group]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openCompare(btn.getAttribute('data-compare-group').split('|'));
      });
    });
  }

  function simSortVal(p, key) {
    switch (key) {
      case 'a': return p.a;
      case 'b': return p.b;
      case 'match': return p.jaccard;
      case 'contain': return p.containment;
      case 'shared': return p.sharedCount;
      default: return 0;
    }
  }

  function renderSimTable(pairs) {
    var sortKey = state.sort['sim-table'];
    var sorted = pairs;
    if (sortKey) {
      var dir = sortKey.dir;
      sorted = pairs.slice().sort(function (x, y) {
        var va = simSortVal(x, sortKey.key), vb = simSortVal(y, sortKey.key);
        if (typeof va === 'number' && typeof vb === 'number') return dir * (va - vb);
        return dir * String(va).localeCompare(String(vb), undefined, { numeric: true });
      });
    }
    var columns = [
      { key: 'a', label: 'Code A' },
      { key: 'b', label: 'Code B' },
      { key: 'match', label: 'Match' },
      { key: 'contain', label: 'Containment' },
      { key: 'shared', label: 'Shared' },
      { key: 'overlap', label: 'Overlap', sortable: false },
      { key: 'rel', label: '', sortable: false }
    ];
    var table = $('sim-table');
    var head = '<thead><tr>' + columns.map(function (c) {
      var arrow = sortKey && sortKey.key === c.key ? '<span class="arrow">' + (sortKey.dir > 0 ? '▲' : '▼') + '</span>' : '';
      return '<th' + (c.sortable === false ? ' class="no-sort"' : ' data-key="' + c.key + '"') + '>' + esc(c.label) + arrow + '</th>';
    }).join('') + '</tr></thead>';

    var body = sorted.length
      ? '<tbody>' + sorted.map(function (p) {
          return '<tr class="sim-row" data-a="' + esc(p.a) + '" data-b="' + esc(p.b) + '">' +
            '<td class="code">' + esc(p.a) + (p.nodeA.type ? ' <span class="muted">· ' + esc(p.nodeA.type) + '</span>' : '') + '</td>' +
            '<td class="code">' + esc(p.b) + (p.nodeB.type ? ' <span class="muted">· ' + esc(p.nodeB.type) + '</span>' : '') + '</td>' +
            '<td>' + meterCell(p.jaccard, p.jaccard >= 0.75) + '</td>' +
            '<td>' + meterCell(p.containment, p.containment >= 0.99) + '</td>' +
            '<td class="num">' + p.sharedCount + '</td>' +
            '<td>' + overlapCell(p.shared) + '</td>' +
            '<td>' + relationBadge(p) + '</td>' +
          '</tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td colspan="' + columns.length + '"><div class="empty-state">No overlapping codes match these filters.</div></td></tr></tbody>';

    table.innerHTML = head + body;

    table.querySelectorAll('th[data-key]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        var cur = state.sort['sim-table'];
        state.sort['sim-table'] = (cur && cur.key === key) ? { key: key, dir: -cur.dir } : { key: key, dir: -1 };
        renderSimTable(pairs);
      });
    });
    table.querySelectorAll('tr.sim-row').forEach(function (tr) {
      tr.addEventListener('click', function () {
        openCompare([tr.getAttribute('data-a'), tr.getAttribute('data-b')]);
      });
    });
  }

  function renderSimilar() {
    if (!state.model) return;
    var basis = state.similar.basis;
    var raw = similarityFor(basis);
    var minShared = state.similar.minShared;
    var sameType = state.similar.sameTypeOnly;
    var q = state.similar.search.trim().toLowerCase();

    var pairs = raw.pairs.filter(function (p) {
      if (p.sharedCount < minShared) return false;
      if (sameType && (p.nodeA.type || '') !== (p.nodeB.type || '')) return false;
      if (q) {
        var hay = (p.a + ' ' + p.b + ' ' + (p.nodeA.description || '') + ' ' + (p.nodeB.description || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    var groups = sameType
      ? raw.groups.filter(function (g) {
          var t = state.model.nodes.get(g.codes[0]).type || '';
          return g.codes.every(function (c) { return (state.model.nodes.get(c).type || '') === t; });
        })
      : raw.groups;

    renderSimGroups(groups, basis);
    renderSimTable(pairs);

    var parts = [raw.compared + ' code' + (raw.compared === 1 ? '' : 's') + ' with dependencies compared'];
    if (raw.hubs.length) {
      parts.push(raw.hubs.length + ' dependenc' + (raw.hubs.length === 1 ? 'y' : 'ies') +
                 ' used too widely to be distinguishing, excluded');
    }
    parts.push(pairs.length + ' of ' + raw.total + ' overlapping pair' + (raw.total === 1 ? '' : 's') + ' shown');
    if (raw.truncated) parts.push('scan capped at ' + raw.pairs.length + ' pairs — narrow the filters for the rest');
    $('sim-summary').textContent = parts.join(' · ');

    updateSimilarPill();
  }

  function updateSimilarPill() {
    var raw = similarityFor('deps');
    var strong = raw.pairs.filter(function (p) { return p.sharedCount >= 2 && p.jaccard >= 0.5; }).length;
    var pill = $('similar-count');
    if (raw.groups.length) {
      pill.textContent = raw.groups.length;
      pill.title = raw.groups.length + ' group(s) of codes with identical direct dependencies';
      pill.classList.add('hot');
    } else {
      pill.textContent = strong;
      pill.title = strong + ' pair(s) with 50%+ overlap and at least 2 shared dependencies';
      pill.classList.remove('hot');
    }
  }

  /* ── compare: a side-by-side breakdown of any number of chosen codes ── */

  function showSub(subId) {
    var pane = $('pane-similar');
    pane.querySelectorAll('.subtab').forEach(function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-sub') === subId);
    });
    pane.querySelectorAll('.sub').forEach(function (s) {
      s.classList.toggle('is-active', s.id === subId);
    });
  }

  function openCompare(codes) {
    var seen = {};
    var list = codes.filter(function (c) {
      if (!state.model.nodes.has(c) || seen[c]) return false;
      seen[c] = 1; return true;
    }).slice(0, 8);
    state.compare.codes = list;
    showTab('pane-similar');
    showSub('sub-compare');
    renderCompareChips();
    renderCompareBody();
  }

  function addCompareCode(code) {
    if (!state.model || !state.model.nodes.has(code)) return;
    if (state.compare.codes.indexOf(code) !== -1) { toast('“' + code + '” is already in the comparison.'); return; }
    if (state.compare.codes.length >= 8) { toast('Up to 8 codes can be compared at once.'); return; }
    state.compare.codes.push(code);
    renderCompareChips();
    renderCompareBody();
  }

  function removeCompareCode(code) {
    var i = state.compare.codes.indexOf(code);
    if (i === -1) return;
    state.compare.codes.splice(i, 1);
    renderCompareChips();
    renderCompareBody();
  }

  function renderCompareChips() {
    var ul = $('compare-chips');
    if (!state.compare.codes.length) {
      ul.innerHTML = '<li class="empty">Add two or more codes above to compare them.</li>';
      return;
    }
    ul.innerHTML = state.compare.codes.map(function (code) {
      return '<li class="compare-chip" data-code="' + esc(code) + '">' + esc(code) +
             '<button type="button" data-remove="' + esc(code) + '" aria-label="Remove ' + esc(code) + '">×</button></li>';
    }).join('') + (state.compare.codes.length === 1
      ? '<li class="empty">Add at least one more code.</li>' : '');
    ul.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeCompareCode(btn.getAttribute('data-remove')); });
    });
  }

  function renderCompareBody() {
    var box = $('compare-body');
    if (!state.model) { box.innerHTML = ''; return; }
    if (state.compare.codes.length < 2) {
      box.innerHTML = '<div class="compare-hint">Pick two or more codes above to see what they share.</div>';
      return;
    }

    var c = SIM.compare(state.model, state.compare.codes, state.compare.basis);
    var codes = c.codes;

    var summary = [
      stat('Compared', codes.length),
      stat('Union of deps', c.unionSize),
      stat('Shared by all', c.common.length, c.common.length ? 'up' : ''),
      stat('Avg. pairwise match', Math.round(c.averageMatch * 100) + '%')
    ].join('');

    var matrix = '<table class="compare-matrix"><thead><tr><th></th>' +
      codes.map(function (b) { return '<th>' + esc(b) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      codes.map(function (a) {
        return '<tr><th class="row-head">' + esc(a) + '</th>' + codes.map(function (b) {
          if (a === b) return '<td class="diag">—</td>';
          return '<td>' + Math.round(c.matrix[a][b] * 100) + '%</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>';

    var breakdownRows = c.rows.map(function (r) {
      var cls = r.all ? 'all-share' : (r.shared ? 'some-share' : '');
      return '<tr class="' + cls + '">' +
        '<td class="code">' + esc(r.code) + '</td>' +
        '<td class="wide">' + esc(r.node ? (r.node.description || '') : '') + '</td>' +
        codes.map(function (code) {
          var on = r.members.indexOf(code) !== -1;
          return '<td class="member"><span class="compare-dot' + (on ? ' on' : '') + '"></span></td>';
        }).join('') +
        '<td class="num">' + r.count + ' / ' + codes.length + '</td>' +
      '</tr>';
    }).join('');

    box.innerHTML =
      '<div class="compare-summary">' + summary + '</div>' +
      '<div class="compare-matrix-wrap">' + matrix + '</div>' +
      '<div class="compare-breakdown-head">' +
        '<h4>Dependency breakdown</h4>' +
        '<div class="compare-legend">' +
          '<span class="lg"><i style="background:var(--warn);border-color:var(--warn)"></i>shared by all</span>' +
          '<span class="lg"><i style="background:var(--accent);border-color:var(--accent)"></i>shared by some</span>' +
        '</div>' +
      '</div>' +
      (c.rows.length
        ? '<div class="table-wrap"><table class="compare-table"><thead><tr><th>Code</th><th>Description</th>' +
          codes.map(function (code) { return '<th class="member">' + esc(code) + '</th>'; }).join('') +
          '<th>Shared by</th></tr></thead><tbody>' + breakdownRows + '</tbody></table></div>'
        : '<div class="empty-state">None of these codes share any dependency — nothing in common on this basis.</div>');
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
      '<button class="btn btn-block btn-sm" type="button" data-sim>Simulate this code</button>' +
      '<div class="nc-actions">' +
        (state.view.isolate && state.view.isolate.root === code
          ? '<button class="btn btn-sm" type="button" data-unisolate>Exit isolation</button>'
          : '<button class="btn btn-sm" type="button" data-isolate>Isolate</button>') +
        '<button class="btn btn-sm" type="button" data-hide>Hide</button>' +
        (state.positions && state.positions[code]
          ? '<button class="btn btn-sm" type="button" data-unpin>Unpin</button>' : '') +
      '</div>';

    card.querySelector('.nc-close').addEventListener('click', function () { selectNode(null); });
    card.querySelector('[data-sim]').addEventListener('click', function () {
      if (combos.sim) combos.sim.setValue(code); else $('sim-code').value = code;
      previewCode(); $('sim-value').focus();
      if (global.innerWidth <= 900) {
        var side = document.querySelector('.sidebar');
        if (side && side.scrollIntoView) side.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    var iso = card.querySelector('[data-isolate]');
    if (iso) iso.addEventListener('click', function () { isolate(code, 'all'); });
    var unIso = card.querySelector('[data-unisolate]');
    if (unIso) unIso.addEventListener('click', clearIsolation);
    card.querySelector('[data-hide]').addEventListener('click', function () { hideCode(code); });
    var unpin = card.querySelector('[data-unpin]');
    if (unpin) unpin.addEventListener('click', function () {
      delete state.positions[code];
      DS.clearPositions(DS.activeId());
      Object.keys(state.positions).forEach(function (c) {
        DS.setPosition(DS.activeId(), c, state.positions[c].x, state.positions[c].y);
      });
      $('btn-reset-layout').hidden = !Object.keys(state.positions).length;
      renderGraph(); renderNodeCard();
    });

    card.querySelectorAll('.nc-list li[data-code]').forEach(function (li) {
      li.addEventListener('click', function () {
        var c = li.getAttribute('data-code');
        selectNode(c); graph.centreOn(c, Math.max(graph.k, 0.9));
      });
    });
  }

  /* Which codes an isolation shows: the chosen code plus its dependency chain,
     either the whole ancestry and all dependants, or a fixed number of hops. */
  function isolationSet() {
    var iso = state.view.isolate;
    if (!iso || !state.model || !state.model.nodes.has(iso.root)) return null;
    var set = new Set([iso.root]);
    if (iso.depth === 'all') {
      E.upstream(state.model, iso.root).forEach(function (c) { set.add(c); });
      E.downstream(state.model, iso.root).forEach(function (c) { set.add(c); });
      return set;
    }
    var frontier = [iso.root];
    for (var step = 0; step < iso.depth; step++) {
      var next = [];
      frontier.forEach(function (code) {
        var n = state.model.nodes.get(code);
        if (!n) return;
        n.deps.concat(n.dependents).forEach(function (c) {
          if (!set.has(c)) { set.add(c); next.push(c); }
        });
      });
      frontier = next;
    }
    return set;
  }

  function isolate(code, depth) {
    if (!state.model || !state.model.nodes.has(code)) return;
    state.view.isolate = { root: code, depth: depth || 'all' };
    state.selected = code;
    showTab('pane-graph');
    renderViewChips();
    renderGraph();
    renderNodeCard();
    setTimeout(function () { if (graph) graph.fit(); }, 20);
  }

  function clearIsolation() {
    state.view.isolate = null;
    renderViewChips();
    renderGraph();
    renderNodeCard();
    setTimeout(function () { if (graph) graph.fit(); }, 20);
  }

  function hideCode(code) {
    state.view.hidden.add(code);
    if (state.selected === code) state.selected = null;
    renderViewChips();
    renderGraph();
    renderNodeCard();
  }

  function renderViewChips() {
    var box = $('view-chips');
    var iso = state.view.isolate;
    var hidden = state.view.hidden;
    if (!iso && !hidden.size) { box.hidden = true; box.innerHTML = ''; return; }

    var html = '';
    if (iso) {
      var shown = isolationSet();
      html += '<span class="vchip">' +
        '<strong>Isolated:</strong> ' + esc(iso.root) +
        ' <select data-depth aria-label="Isolation depth">' +
          '<option value="1"' + (iso.depth === 1 ? ' selected' : '') + '>direct links</option>' +
          '<option value="2"' + (iso.depth === 2 ? ' selected' : '') + '>2 hops</option>' +
          '<option value="all"' + (iso.depth === 'all' ? ' selected' : '') + '>full chain</option>' +
        '</select>' +
        '<span class="vchip-count">' + (shown ? shown.size : 0) + ' shown</span>' +
        '<button type="button" data-clear-iso aria-label="Exit isolation">×</button></span>';
    }
    if (hidden.size) {
      html += '<span class="vchip"><strong>Hidden:</strong> ' + hidden.size +
              ' <button type="button" data-clear-hidden aria-label="Show hidden codes">×</button></span>';
    }
    box.innerHTML = html;
    box.hidden = false;

    var depth = box.querySelector('[data-depth]');
    if (depth) depth.addEventListener('change', function () {
      var v = depth.value;
      isolate(iso.root, v === 'all' ? 'all' : parseInt(v, 10));
    });
    var ci = box.querySelector('[data-clear-iso]');
    if (ci) ci.addEventListener('click', clearIsolation);
    var ch = box.querySelector('[data-clear-hidden]');
    if (ch) ch.addEventListener('click', function () {
      state.view.hidden = new Set();
      renderViewChips(); renderGraph();
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
    download('fajr-simulation.csv', lines.join('\n'));
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
    $('btn-demo').addEventListener('click', function () { loadBundled('sample'); });
    $('btn-demo100').addEventListener('click', function () { loadBundled('demo'); });
    $('btn-loader-cancel').addEventListener('click', function () {
      if (DS.count()) openActive();
    });
    $('btn-home-logo').addEventListener('click', showLoader);
    $('btn-home').addEventListener('click', showLoader);

    $('dataset-select').addEventListener('change', function (e) {
      if (DS.setActive(e.target.value)) openActive();
    });
    $('btn-ds-rename').addEventListener('click', renameActive);
    $('btn-ds-remove').addEventListener('click', removeActive);
    $('btn-ds-add').addEventListener('click', showLoader);

    $('btn-reset-layout').addEventListener('click', function () {
      state.positions = {};
      DS.clearPositions(DS.activeId());
      $('btn-reset-layout').hidden = true;
      renderGraph();
      renderNodeCard();
      setTimeout(function () { graph.fit(); }, 20);
      toast('Layout reset.');
    });
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

    /* Compare picker: choosing a code adds it to the comparison and clears
       the box, ready for the next one — it is an "add" field, not a select. */
    combos.compareAdd = new global.YAD.Combobox($('compare-add'), {
      items: items,
      onChoose: function (code) {
        addCompareCode(code);
        combos.compareAdd.setValue('');
      }
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

    document.querySelectorAll('#pane-similar .subtab').forEach(function (t) {
      t.addEventListener('click', function () { showSub(t.getAttribute('data-sub')); });
    });
    $('sim-basis').addEventListener('change', function (e) { state.similar.basis = e.target.value; renderSimilar(); });
    $('sim-min-shared').addEventListener('change', function (e) {
      state.similar.minShared = parseInt(e.target.value, 10); renderSimilar();
    });
    $('sim-same-type').addEventListener('change', function (e) {
      state.similar.sameTypeOnly = e.target.checked; renderSimilar();
    });
    $('sim-search').addEventListener('input', function (e) { state.similar.search = e.target.value; renderSimilar(); });
    $('compare-basis').addEventListener('change', function (e) { state.compare.basis = e.target.value; renderCompareBody(); });
    $('btn-compare-clear').addEventListener('click', function () {
      if (!state.compare.codes.length) return;
      state.compare.codes = []; renderCompareChips(); renderCompareBody();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (state.view.isolate) clearIsolation();
      else if (state.selected) selectNode(null);
    });

    if (DS.load()) {
      openActive();
      if (!DS.persisted()) toast('Datasets could not be saved in this browser — they will be lost on reload.', 5000);
    } else {
      renderDatasetBar();
    }

    global.addEventListener('resize', function () {
      clearTimeout(global._fitTimer);
      global._fitTimer = setTimeout(function () { if (graph && graph.layout) graph.fit(); }, 200);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
