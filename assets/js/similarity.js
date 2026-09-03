/* similarity.js -- how much two codes have in common.
 *
 * Codes are compared by the set of other codes they depend on, so "overlap"
 * means shared dependencies rather than similar numbers. Three bases are
 * offered because they answer different questions:
 *
 *   deps       what each code reads directly -- near-duplicate formulas
 *   upstream   everything it depends on transitively -- shared foundations
 *   dependents what reads each code -- codes that feed the same consumers
 *
 * Two measures are reported, because one number hides a real distinction:
 *
 *   match (Jaccard)  shared / union      -- how alike two codes are overall
 *   containment      shared / smaller    -- whether one sits inside the other
 *
 * A three-item code fully contained in a thirty-item one scores 10% match but
 * 100% containment, and only the pair of them tells the story.
 */
(function (global) {
  'use strict';

  var HUB_LIMIT = 400;      // a dependency shared by more codes than this is not distinguishing

  function buildSets(model, basis) {
    var sets = new Map();
    model.nodes.forEach(function (n, code) {
      var list;
      if (basis === 'upstream') {
        list = Array.from(global.YAD.engine.upstream(model, code));
      } else if (basis === 'dependents') {
        list = n.dependents.slice();
      } else {
        list = n.deps.slice();
      }
      list.sort(function (a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); });
      sets.set(code, list);
    });
    return sets;
  }

  function metrics(listA, listB) {
    var inB = Object.create(null);
    listB.forEach(function (c) { inB[c] = 1; });
    var shared = [];
    listA.forEach(function (c) { if (inB[c]) shared.push(c); });
    var union = listA.length + listB.length - shared.length;
    var onlyA = listA.length - shared.length;
    var onlyB = listB.length - shared.length;
    var smaller = Math.min(listA.length, listB.length);
    return {
      shared: shared,
      sharedCount: shared.length,
      onlyA: onlyA,
      onlyB: onlyB,
      union: union,
      jaccard: union ? shared.length / union : 0,
      containment: smaller ? shared.length / smaller : 0,
      identical: shared.length > 0 && onlyA === 0 && onlyB === 0,
      subset: shared.length > 0 && (onlyA === 0) !== (onlyB === 0)
    };
  }

  /* Every pair worth looking at. Candidate pairs come from an inverted index --
     only codes that share at least one dependency are ever compared, so a
     sparse model costs far less than its N^2 pair count. */
  function scan(model, opts) {
    opts = opts || {};
    var basis = opts.basis || 'deps';
    var minShared = opts.minShared || 1;
    var minScore = opts.minScore || 0;
    var sameTypeOnly = !!opts.sameTypeOnly;
    var limit = opts.limit || 500;

    var sets = buildSets(model, basis);
    var codes = [];
    sets.forEach(function (list, code) { if (list.length) codes.push(code); });
    codes.sort(function (a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); });

    var idOf = Object.create(null);
    codes.forEach(function (c, i) { idOf[c] = i; });

    var index = Object.create(null);
    codes.forEach(function (code) {
      sets.get(code).forEach(function (dep) {
        (index[dep] || (index[dep] = [])).push(code);
      });
    });

    var counts = new Map(), hubs = [];
    Object.keys(index).forEach(function (dep) {
      var users = index[dep];
      if (users.length > HUB_LIMIT) { hubs.push(dep); return; }
      for (var i = 0; i < users.length; i++) {
        for (var j = i + 1; j < users.length; j++) {
          var a = idOf[users[i]], b = idOf[users[j]];
          var key = a < b ? a * codes.length + b : b * codes.length + a;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    });

    var pairs = [];
    counts.forEach(function (sharedCount, key) {
      if (sharedCount < minShared) return;
      var a = codes[Math.floor(key / codes.length)];
      var b = codes[key % codes.length];
      var na = model.nodes.get(a), nb = model.nodes.get(b);
      if (sameTypeOnly && (na.type || '') !== (nb.type || '')) return;
      var m = metrics(sets.get(a), sets.get(b));
      if (m.jaccard < minScore) return;
      m.a = a; m.b = b; m.nodeA = na; m.nodeB = nb;
      pairs.push(m);
    });

    pairs.sort(function (x, y) {
      if (y.jaccard !== x.jaccard) return y.jaccard - x.jaccard;
      if (y.sharedCount !== x.sharedCount) return y.sharedCount - x.sharedCount;
      return String(x.a).localeCompare(String(y.a), undefined, { numeric: true });
    });

    return {
      basis: basis,
      pairs: pairs.slice(0, limit),
      total: pairs.length,
      truncated: pairs.length > limit,
      compared: codes.length,
      skipped: sets.size - codes.length,
      hubs: hubs,
      groups: duplicateGroups(sets, codes, model)
    };
  }

  /* Codes whose dependency set is exactly the same -- the strongest form of
     overlap, and usually worth a second look in the source data. */
  function duplicateGroups(sets, codes, model) {
    var byKey = Object.create(null);
    codes.forEach(function (code) {
      var key = sets.get(code).join('');
      (byKey[key] || (byKey[key] = [])).push(code);
    });
    var groups = [];
    Object.keys(byKey).forEach(function (key) {
      if (byKey[key].length < 2) return;
      groups.push({ codes: byKey[key], deps: key ? key.split('') : [], size: byKey[key].length });
    });
    groups.sort(function (a, b) { return b.size - a.size || b.deps.length - a.deps.length; });
    return groups;
  }

  /* A side-by-side comparison of any number of codes. */
  function compare(model, codes, basis) {
    var sets = buildSets(model, basis || 'deps');
    var seen = Object.create(null);
    var chosen = codes.filter(function (c) {
      if (!model.nodes.has(c) || seen[c]) return false;
      seen[c] = 1; return true;
    });
    var lists = {};
    chosen.forEach(function (c) { lists[c] = sets.get(c) || []; });

    var membership = Object.create(null);
    chosen.forEach(function (code) {
      lists[code].forEach(function (dep) {
        (membership[dep] || (membership[dep] = [])).push(code);
      });
    });

    var rows = Object.keys(membership).map(function (dep) {
      var n = model.nodes.get(dep);
      return {
        code: dep,
        members: membership[dep],
        count: membership[dep].length,
        shared: membership[dep].length > 1,
        all: membership[dep].length === chosen.length && chosen.length > 1,
        node: n || null
      };
    });
    rows.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
    });

    var pairs = [];
    for (var i = 0; i < chosen.length; i++) {
      for (var j = i + 1; j < chosen.length; j++) {
        var m = metrics(lists[chosen[i]], lists[chosen[j]]);
        m.a = chosen[i]; m.b = chosen[j];
        pairs.push(m);
      }
    }

    var common = rows.filter(function (r) { return r.all; }).map(function (r) { return r.code; });
    var sharedAny = rows.filter(function (r) { return r.shared; }).map(function (r) { return r.code; });
    var avg = pairs.length
      ? pairs.reduce(function (s, p) { return s + p.jaccard; }, 0) / pairs.length
      : 0;

    return {
      basis: basis || 'deps',
      codes: chosen,
      lists: lists,
      rows: rows,
      pairs: pairs,
      matrix: matrixOf(chosen, pairs),
      common: common,
      sharedAny: sharedAny,
      unionSize: rows.length,
      averageMatch: avg
    };
  }

  function matrixOf(codes, pairs) {
    var m = {};
    codes.forEach(function (a) { m[a] = {}; codes.forEach(function (b) { m[a][b] = a === b ? 1 : 0; }); });
    pairs.forEach(function (p) { m[p.a][p.b] = p.jaccard; m[p.b][p.a] = p.jaccard; });
    return m;
  }

  global.YAD = global.YAD || {};
  global.YAD.similarity = {
    scan: scan,
    compare: compare,
    metrics: metrics,
    buildSets: buildSets,
    HUB_LIMIT: HUB_LIMIT
  };
})(window);
