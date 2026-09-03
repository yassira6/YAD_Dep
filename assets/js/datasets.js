/* datasets.js — the store behind the dataset switcher.
   Several datasets live side by side: each keeps its own parsed rows, its name,
   and any node positions the user has dragged. They persist in localStorage so
   a reload does not mean re-uploading, and fall back to memory-only if the
   browser refuses to store them. */
(function (global) {
  'use strict';

  var KEY = 'yad-datasets-v1';
  var items = [];
  var activeId = null;
  var persistOk = true;

  function uid() { return 'ds-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

  /* Only the columns the model needs are stored — the parser's scratch fields
     would double the size for no benefit. */
  function slimValues(rows) {
    return rows.map(function (r) {
      return { code: r.code, value: r.value, description: r.description, type: r.type, _row: r._row };
    });
  }
  function slimDeps(rows) {
    return rows.map(function (r) {
      return { code: r.code, operation: r.operation, bcode: r.bcode, weight: r.weight, _row: r._row };
    });
  }

  function save() {
    if (!persistOk) return false;
    try {
      global.localStorage.setItem(KEY, JSON.stringify({ activeId: activeId, items: items }));
      return true;
    } catch (e) {
      persistOk = false;          // quota, private mode, or storage disabled
      return false;
    }
  }

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return false;
      items = data.items.filter(function (d) { return d && d.id && Array.isArray(d.values) && Array.isArray(d.deps); });
      activeId = items.some(function (d) { return d.id === data.activeId; }) ? data.activeId
               : (items[0] ? items[0].id : null);
      return items.length > 0;
    } catch (e) {
      return false;
    }
  }

  function uniqueName(name) {
    var base = String(name || 'Dataset').trim().slice(0, 80) || 'Dataset';
    var taken = {}, n = base, i = 2;
    items.forEach(function (d) { taken[d.name] = 1; });
    while (taken[n]) { n = base + ' (' + i + ')'; i++; }
    return n;
  }

  var api = {
    all: function () { return items; },
    get: function (id) { return items.filter(function (d) { return d.id === id; })[0] || null; },
    activeId: function () { return activeId; },
    active: function () { return api.get(activeId); },
    count: function () { return items.length; },
    persisted: function () { return persistOk; },

    add: function (name, valueRows, depRows) {
      var d = {
        id: uid(),
        name: uniqueName(name),
        createdAt: Date.now(),
        values: slimValues(valueRows),
        deps: slimDeps(depRows),
        positions: {}
      };
      items.push(d);
      activeId = d.id;
      save();
      return d;
    },

    rename: function (id, name) {
      var d = api.get(id);
      if (!d) return null;
      var wanted = String(name).trim().slice(0, 80);
      if (!wanted || wanted === d.name) return d;
      var others = items.filter(function (x) { return x.id !== id; });
      var taken = {}, final = wanted, i = 2;
      others.forEach(function (x) { taken[x.name] = 1; });
      while (taken[final]) { final = wanted + ' (' + i + ')'; i++; }
      d.name = final;
      save();
      return d;
    },

    remove: function (id) {
      var i = items.findIndex(function (d) { return d.id === id; });
      if (i === -1) return null;
      items.splice(i, 1);
      if (activeId === id) activeId = items.length ? items[Math.max(0, i - 1)].id : null;
      save();
      return activeId;
    },

    setActive: function (id) {
      if (!api.get(id)) return false;
      activeId = id;
      save();
      return true;
    },

    positions: function (id) {
      var d = api.get(id);
      return (d && d.positions) || {};
    },
    setPosition: function (id, code, x, y) {
      var d = api.get(id);
      if (!d) return;
      (d.positions || (d.positions = {}))[code] = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
      save();
    },
    clearPositions: function (id) {
      var d = api.get(id);
      if (!d) return;
      d.positions = {};
      save();
    },

    load: load,
    save: save
  };

  global.YAD = global.YAD || {};
  global.YAD.datasets = api;
})(window);
