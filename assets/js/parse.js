/* parse.js — turn an uploaded workbook (xlsx / xls / csv) into typed records.
   Header matching is case-insensitive and accepts common synonyms, so real-world
   files ("ID", "Depends On", "Op") load without being renamed first. */
(function (global) {
  'use strict';

  var ALIASES = {
    code:        ['code', 'codes', 'id', 'item', 'item code', 'itemcode', 'key', 'acode', 'a code', 'a_code'],
    value:       ['value', 'val', 'amount', 'qty', 'quantity', 'number', 'base', 'base value'],
    description: ['description', 'desc', 'label', 'name', 'title', 'text', 'comment'],
    type:        ['type', 'category', 'group', 'kind', 'class', 'classification'],
    operation:   ['operation', 'operations', 'op', 'operator', 'formula', 'calc', 'calculation', 'sign'],
    bcode:       ['bcode', 'b code', 'b_code', 'b-code', 'code b', 'dependson', 'depends on', 'depends_on',
                  'dependency', 'parent', 'parent code', 'source', 'ref', 'reference', 'related code', 'fk'],
    weight:      ['weight', 'factor', 'coefficient', 'coeff', 'multiplier', 'scalar', 'ratio']
  };

  var SCHEMAS = {
    values: { required: ['code'],              optional: ['value', 'description', 'type'] },
    deps:   { required: ['code', 'operation'], optional: ['bcode', 'weight'] }
  };

  function norm(h) {
    return String(h == null ? '' : h)
      .replace(/^﻿/, '')
      .replace(/[\s._-]+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /* Minimal RFC-4180 CSV/TSV reader — the offline fallback when SheetJS is
     unavailable, and the reason a plain .csv never needs the CDN at all. */
  function parseDelimited(text, delim) {
    text = text.replace(/^﻿/, '');
    if (!delim) {
      var head = text.slice(0, text.indexOf('\n') + 1 || text.length);
      delim = (head.split('\t').length > head.split(',').length) ? '\t' : ',';
    }
    var rows = [], row = [], field = '', quoted = false, i = 0;
    while (i < text.length) {
      var c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = ''; i++; continue;
      }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function isZip(bytes) {
    return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4B &&
           (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7);
  }

  function viaSheetJS(data, asText) {
    var wb = asText ? global.XLSX.read(data, { type: 'string' })
                    : global.XLSX.read(new Uint8Array(data), { type: 'array' });
    return wb.SheetNames.map(function (name) {
      return {
        name: name,
        rows: global.XLSX.utils.sheet_to_json(wb.Sheets[name], {
          header: 1, blankrows: false, defval: '', raw: true
        })
      };
    });
  }

  /* Reading order: text formats use the built-in delimited reader, and real
     workbooks use the built-in .xlsx reader. SheetJS is consulted only if it
     is present and the built-in path cannot handle the file (legacy .xls),
     so the page works with no network. */
  function readFile(file) {
    var lite = global.YAD && global.YAD.xlsxLite;
    var isText = /\.(csv|tsv|txt)$/i.test(file.name);
    var isLegacy = /\.xls$/i.test(file.name);

    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('The file could not be read.')); };
      reader.onload = function (e) { resolve(e.target.result); };
      if (isText) reader.readAsText(file); else reader.readAsArrayBuffer(file);
    }).then(function (data) {
      if (isText) return [{ name: file.name, rows: parseDelimited(String(data)) }];

      var bytes = new Uint8Array(data);

      if (isZip(bytes)) {
        if (lite && lite.supported) {
          return lite.read(data).catch(function (err) {
            if (typeof global.XLSX !== 'undefined') return viaSheetJS(data, false);
            throw new Error('This workbook could not be read (' + err.message +
                            '). Saving it as .csv will always work.');
          });
        }
        if (typeof global.XLSX !== 'undefined') return viaSheetJS(data, false);
        throw new Error('This browser cannot open .xlsx files directly. ' +
                        'Please save the sheet as .csv and upload that instead.');
      }

      if (isLegacy || !isText) {
        if (typeof global.XLSX !== 'undefined') return viaSheetJS(data, false);
        // Not a ZIP: most likely a legacy .xls, or a text file with an odd extension.
        var text = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 4e6)));
        if (isLegacy || /\u0000/.test(text.slice(0, 512))) {
          throw new Error('This looks like a legacy .xls file, which needs the optional ' +
                          'spreadsheet library (unavailable offline). Re-save it as .xlsx or .csv.');
        }
        return [{ name: file.name, rows: parseDelimited(text) }];
      }
      throw new Error('Unrecognised file format.');
    });
  }

  /* Locate the header row: the first row within the top 20 that resolves every
     required field. Files often carry a title banner above the real header. */
  function findHeader(rows, schema) {
    var limit = Math.min(rows.length, 20);
    for (var r = 0; r < limit; r++) {
      var map = mapRow(rows[r], schema);
      if (map) return { index: r, map: map };
    }
    return null;
  }

  function mapRow(cells, schema) {
    if (!cells) return null;
    var map = {}, used = {};
    var fields = schema.required.concat(schema.optional);
    for (var c = 0; c < cells.length; c++) {
      var h = norm(cells[c]);
      if (!h) continue;
      for (var f = 0; f < fields.length; f++) {
        var field = fields[f];
        if (map[field] !== undefined || used[c]) continue;
        if (ALIASES[field].indexOf(h) !== -1) { map[field] = c; used[c] = true; break; }
      }
    }
    for (var i = 0; i < schema.required.length; i++) {
      if (map[schema.required[i]] === undefined) return null;
    }
    return map;
  }

  function cellText(v) {
    if (v == null) return '';
    if (typeof v === 'number') return String(v);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).trim();
  }

  function extract(sheets, kind) {
    var schema = SCHEMAS[kind];
    for (var s = 0; s < sheets.length; s++) {
      var found = findHeader(sheets[s].rows, schema);
      if (!found) continue;
      var map = found.map, out = [];
      for (var r = found.index + 1; r < sheets[s].rows.length; r++) {
        var cells = sheets[s].rows[r], rec = { _row: r + 1 }, any = false;
        for (var field in map) {
          if (!Object.prototype.hasOwnProperty.call(map, field)) continue;
          var raw = cells[map[field]];
          rec[field] = cellText(raw);
          rec['_raw_' + field] = raw;
          if (rec[field] !== '') any = true;
        }
        if (any) out.push(rec);
      }
      return {
        sheet: sheets[s].name,
        sheetCount: sheets.length,
        columns: Object.keys(map),
        headerRow: found.index + 1,
        records: out
      };
    }
    var want = schema.required.concat(schema.optional).map(function (f) {
      return f.charAt(0).toUpperCase() + f.slice(1);
    });
    throw new Error('No sheet in this file has the required columns. Looked for: ' + want.join(', ') + '.');
  }

  global.YAD = global.YAD || {};
  global.YAD.parse = {
    readFile: readFile,
    extract: extract,
    parseDelimited: parseDelimited,
    aliases: ALIASES
  };
})(window);
