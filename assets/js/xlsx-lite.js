/* xlsx-lite.js — a small, dependency-free .xlsx reader.
 *
 * An .xlsx file is a ZIP of XML parts. This walks the ZIP central directory,
 * inflates the entries with the browser's native DecompressionStream, and reads
 * the sheet XML with DOMParser — so uploads work with no CDN, no bundler and no
 * network at all. SheetJS, if it happens to be on the page, is used only as a
 * fallback for formats this does not cover (legacy .xls).
 *
 * Values are returned as numbers, strings or booleans. Date-formatted cells come
 * back as their underlying serial number, which is what this application wants:
 * the columns it reads are codes, numbers and labels.
 */
(function (global) {
  'use strict';

  var supported = typeof global.DecompressionStream === 'function' &&
                  typeof global.DOMParser === 'function';

  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  function findEOCD(dv) {
    var max = Math.min(dv.byteLength, 66000);
    for (var i = dv.byteLength - 22; i >= dv.byteLength - max && i >= 0; i--) {
      if (u32(dv, i) === 0x06054b50) return i;
    }
    return -1;
  }

  function inflate(bytes, method) {
    if (method === 0) return Promise.resolve(bytes);
    if (method !== 8) return Promise.reject(new Error('unsupported ZIP compression method ' + method));
    var stream = new global.DecompressionStream('deflate-raw');
    var writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Response(stream.readable).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  /* name -> Uint8Array for every entry we are asked for */
  function readZip(arrayBuffer, wanted) {
    var dv = new DataView(arrayBuffer);
    var bytes = new Uint8Array(arrayBuffer);
    var eocd = findEOCD(dv);
    if (eocd < 0) throw new Error('not a ZIP container');

    var count = u16(dv, eocd + 10);
    var cdOffset = u32(dv, eocd + 16);

    if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) {          // ZIP64
      for (var z = eocd - 20; z >= 0; z--) {
        if (u32(dv, z) === 0x07064b50) {
          var z64 = Number(dv.getBigUint64(z + 8, true));
          if (u32(dv, z64) === 0x06064b50) {
            count = Number(dv.getBigUint64(z64 + 32, true));
            cdOffset = Number(dv.getBigUint64(z64 + 48, true));
          }
          break;
        }
      }
    }

    var entries = [], p = cdOffset;
    for (var i = 0; i < count && p + 46 <= dv.byteLength; i++) {
      if (u32(dv, p) !== 0x02014b50) break;
      var method = u16(dv, p + 10);
      var compSize = u32(dv, p + 20);
      var nameLen = u16(dv, p + 28);
      var extraLen = u16(dv, p + 30);
      var commentLen = u16(dv, p + 32);
      var localOffset = u32(dv, p + 42);
      var name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));

      if (compSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {  // ZIP64 extra field
        var ex = p + 46 + nameLen, exEnd = ex + extraLen;
        while (ex + 4 <= exEnd) {
          var hid = u16(dv, ex), hsz = u16(dv, ex + 2), q = ex + 4;
          if (hid === 0x0001) {
            if (u32(dv, p + 24) === 0xFFFFFFFF) q += 8;               // uncompressed
            if (compSize === 0xFFFFFFFF) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (localOffset === 0xFFFFFFFF) localOffset = Number(dv.getBigUint64(q, true));
            break;
          }
          ex += 4 + hsz;
        }
      }
      entries.push({ name: name, method: method, compSize: compSize, localOffset: localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    var out = {};
    var jobs = entries.filter(function (e) { return wanted(e.name); }).map(function (e) {
      if (u32(dv, e.localOffset) !== 0x04034b50) return Promise.resolve();
      var nameLen = u16(dv, e.localOffset + 26);
      var extraLen = u16(dv, e.localOffset + 28);
      var start = e.localOffset + 30 + nameLen + extraLen;
      return inflate(bytes.subarray(start, start + e.compSize), e.method).then(function (data) {
        out[e.name] = data;
      });
    });
    return Promise.all(jobs).then(function () { return out; });
  }

  function xml(bytes) {
    if (!bytes) return null;
    var text = new TextDecoder('utf-8').decode(bytes);
    var doc = new global.DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('malformed XML inside the workbook');
    return doc;
  }

  function tagged(doc, name) {
    return Array.prototype.slice.call(doc.getElementsByTagName('*')).filter(function (el) {
      return el.localName === name;
    });
  }
  function child(el, name) {
    for (var i = 0; i < el.children.length; i++) if (el.children[i].localName === name) return el.children[i];
    return null;
  }
  function textOf(el) {
    if (!el) return '';
    var out = '';
    var walk = el.getElementsByTagName('*');
    var found = false;
    for (var i = 0; i < walk.length; i++) {
      if (walk[i].localName === 't') { out += walk[i].textContent; found = true; }
    }
    return found ? out : el.textContent;
  }

  function colIndex(ref) {
    var n = 0;
    for (var i = 0; i < ref.length; i++) {
      var c = ref.charCodeAt(i);
      if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
      else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
      else break;
    }
    return n - 1;
  }

  function readSheet(doc, shared) {
    var rows = [];
    var rowEls = tagged(doc, 'row');
    var autoRow = 0;
    rowEls.forEach(function (rowEl) {
      var rIdx = rowEl.getAttribute('r') ? parseInt(rowEl.getAttribute('r'), 10) - 1 : autoRow;
      autoRow = rIdx + 1;
      var cells = [];
      var autoCol = 0;
      Array.prototype.slice.call(rowEl.children).forEach(function (c) {
        if (c.localName !== 'c') return;
        var ref = c.getAttribute('r');
        var ci = ref ? colIndex(ref) : autoCol;
        autoCol = ci + 1;
        var t = c.getAttribute('t');
        var value = '';
        if (t === 's') {
          var vi = parseInt(textOf(child(c, 'v')) || '-1', 10);
          value = shared[vi] !== undefined ? shared[vi] : '';
        } else if (t === 'inlineStr') {
          value = textOf(child(c, 'is'));
        } else if (t === 'str') {
          value = textOf(child(c, 'v'));
        } else if (t === 'b') {
          value = textOf(child(c, 'v')) === '1';
        } else if (t === 'e') {
          value = textOf(child(c, 'v'));
        } else {
          var raw = textOf(child(c, 'v'));
          if (raw === '') value = '';
          else { var n = parseFloat(raw); value = isNaN(n) ? raw : n; }
        }
        while (cells.length < ci) cells.push('');
        cells[ci] = value;
      });
      while (rows.length < rIdx) rows.push([]);
      rows[rIdx] = cells;
    });
    return rows.filter(function (r) {
      return r && r.some(function (c) { return c !== '' && c !== undefined && c !== null; });
    });
  }

  function read(arrayBuffer) {
    if (!supported) return Promise.reject(new Error('this browser cannot unzip workbooks natively'));
    return Promise.resolve().then(function () {
      return readZip(arrayBuffer, function (name) {
        return name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' ||
               name === 'xl/sharedStrings.xml' || /^xl\/(worksheets|chartsheets)\/.*\.xml$/.test(name);
      });
    }).then(function (files) {
      var wbDoc = xml(files['xl/workbook.xml']);
      if (!wbDoc) throw new Error('no workbook part — is this really an .xlsx file?');

      var shared = [];
      var ssDoc = xml(files['xl/sharedStrings.xml']);
      if (ssDoc) tagged(ssDoc, 'si').forEach(function (si) { shared.push(textOf(si)); });

      var rels = {};
      var relDoc = xml(files['xl/_rels/workbook.xml.rels']);
      if (relDoc) {
        tagged(relDoc, 'Relationship').forEach(function (r) {
          rels[r.getAttribute('Id')] = r.getAttribute('Target');
        });
      }

      var sheets = [];
      tagged(wbDoc, 'sheet').forEach(function (s, i) {
        var name = s.getAttribute('name') || ('Sheet' + (i + 1));
        var rid = s.getAttribute('r:id') ||
                  s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        var target = rels[rid];
        var path = null;
        if (target) {
          path = target.charAt(0) === '/' ? target.slice(1)
               : (target.indexOf('xl/') === 0 ? target : 'xl/' + target.replace(/^\.\//, ''));
        }
        if (!path || !files[path]) {
          var guess = 'xl/worksheets/sheet' + (i + 1) + '.xml';
          path = files[guess] ? guess : null;
        }
        if (!path) return;
        sheets.push({ name: name, rows: readSheet(xml(files[path]), shared) });
      });

      if (!sheets.length) throw new Error('the workbook contains no readable sheets');
      return sheets;
    });
  }

  global.YAD = global.YAD || {};
  global.YAD.xlsxLite = { read: read, supported: supported };
})(window);
