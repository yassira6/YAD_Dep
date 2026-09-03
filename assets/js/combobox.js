/* combobox.js — a searchable dropdown for picking a code.
 *
 * Replaces <input list="…"> because the native datalist cannot show a value and
 * a description per row, cannot be styled, and behaves inconsistently on mobile
 * browsers — where this control is most needed.
 *
 * The panel is positioned fixed rather than absolute: both places it is used sit
 * inside a scrolling container that would otherwise clip the list.
 */
(function (global) {
  'use strict';

  var MAX_ROWS = 60;
  var idSeq = 0;

  function Combobox(input, opts) {
    this.input = input;
    this.opts = opts || {};
    this.items = [];
    this.filtered = [];
    this.active = -1;
    this.open = false;
    this.id = 'combo-' + (++idSeq);

    var wrap = document.createElement('div');
    wrap.className = 'combo';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'combo-clear';
    clear.setAttribute('aria-label', 'Clear');
    clear.textContent = '×';
    clear.hidden = true;
    wrap.appendChild(clear);

    var panel = document.createElement('ul');
    panel.className = 'combo-list';
    panel.id = this.id;
    panel.setAttribute('role', 'listbox');
    panel.hidden = true;
    document.body.appendChild(panel);

    this.wrap = wrap;
    this.panel = panel;
    this.clearBtn = clear;

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', this.id);
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('autocomplete', 'off');

    this.bind();
  }

  Combobox.prototype.bind = function () {
    var self = this, input = this.input;

    input.addEventListener('focus', function () { self.show(); });
    input.addEventListener('click', function () { self.show(); });
    input.addEventListener('input', function () {
      self.clearBtn.hidden = !input.value;
      self.show();
      if (self.opts.onInput) self.opts.onInput(input.value);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!self.open) { self.show(); return; }
        self.move(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        if (self.open && self.active >= 0 && self.filtered[self.active]) {
          e.preventDefault();
          self.choose(self.filtered[self.active]);
        } else if (self.open) {
          self.hide();
        }
      } else if (e.key === 'Escape') {
        if (self.open) { e.stopPropagation(); self.hide(); }
      } else if (e.key === 'Tab') {
        self.hide();
      }
    });

    input.addEventListener('blur', function () {
      // let a click on a row land before the panel closes
      setTimeout(function () { if (!self.panel.contains(document.activeElement)) self.hide(); }, 140);
    });

    this.clearBtn.addEventListener('click', function () {
      input.value = '';
      self.clearBtn.hidden = true;
      if (self.opts.onInput) self.opts.onInput('');
      input.focus();
      self.show();
    });

    // mousedown fires before blur, so the selection is not lost
    this.panel.addEventListener('mousedown', function (e) { e.preventDefault(); });
    this.panel.addEventListener('click', function (e) {
      var li = e.target.closest('li[data-index]');
      if (!li) return;
      self.choose(self.filtered[parseInt(li.getAttribute('data-index'), 10)]);
    });

    this._reposition = function () {
      if (!self.open) return;
      var r = self.input.getBoundingClientRect();
      if (r.bottom < 0 || r.top > global.innerHeight) { self.hide(); return; }
      self.place(r);
    };
    global.addEventListener('scroll', this._reposition, true);
    global.addEventListener('resize', this._reposition);
  };

  Combobox.prototype.place = function (r) {
    var panel = this.panel;
    var below = global.innerHeight - r.bottom - 8;
    var above = r.top - 8;
    var flip = below < 180 && above > below;
    var maxH = Math.max(120, Math.min(320, flip ? above : below));
    panel.style.left = Math.round(r.left) + 'px';
    panel.style.width = Math.round(r.width) + 'px';
    panel.style.maxHeight = Math.round(maxH) + 'px';
    if (flip) {
      panel.style.top = 'auto';
      panel.style.bottom = Math.round(global.innerHeight - r.top + 4) + 'px';
    } else {
      panel.style.bottom = 'auto';
      panel.style.top = Math.round(r.bottom + 4) + 'px';
    }
  };

  function score(item, q) {
    var code = String(item.code).toLowerCase();
    var text = (item.search || '').toLowerCase();
    if (!q) return 0;
    if (code === q) return 100;
    if (code.indexOf(q) === 0) return 80 - Math.min(20, code.length);
    if (code.indexOf(q) !== -1) return 55;
    var at = text.indexOf(q);
    if (at !== -1) return 30 - Math.min(20, at / 8);
    return -1;
  }

  Combobox.prototype.show = function () {
    var self = this;
    this.items = (this.opts.items ? this.opts.items() : []) || [];
    var q = this.input.value.trim().toLowerCase();

    var list;
    if (!q) {
      list = this.items.slice();
    } else {
      list = this.items
        .map(function (it) { return { it: it, s: score(it, q) }; })
        .filter(function (x) { return x.s >= 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .map(function (x) { return x.it; });
    }
    this.total = list.length;
    this.filtered = list.slice(0, MAX_ROWS);
    this.active = this.filtered.length && q ? 0 : -1;
    this.render();

    this.open = true;
    this.panel.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.clearBtn.hidden = !this.input.value;
    this.place(this.input.getBoundingClientRect());
  };

  Combobox.prototype.render = function () {
    var self = this;
    if (!this.filtered.length) {
      this.panel.innerHTML = '<li class="combo-empty">No matching code</li>';
      return;
    }
    var html = this.filtered.map(function (it, i) {
      return '<li role="option" data-index="' + i + '" id="' + self.id + '-o' + i + '"' +
             (i === self.active ? ' class="is-active" aria-selected="true"' : '') + '>' +
             '<span class="combo-code">' + it.codeHtml + '</span>' +
             (it.valueHtml ? '<span class="combo-val">' + it.valueHtml + '</span>' : '') +
             (it.subHtml ? '<span class="combo-sub">' + it.subHtml + '</span>' : '') +
             '</li>';
    }).join('');
    if (this.total > this.filtered.length) {
      html += '<li class="combo-empty">+' + (this.total - this.filtered.length) + ' more — keep typing</li>';
    }
    this.panel.innerHTML = html;
    this.scrollToActive();
  };

  Combobox.prototype.move = function (dir) {
    if (!this.filtered.length) return;
    this.active = (this.active + dir + this.filtered.length) % this.filtered.length;
    var rows = this.panel.querySelectorAll('li[data-index]');
    rows.forEach(function (li, i) { li.classList.toggle('is-active', i === this.active); }, this);
    this.input.setAttribute('aria-activedescendant', this.id + '-o' + this.active);
    this.scrollToActive();
  };

  Combobox.prototype.scrollToActive = function () {
    var li = this.panel.querySelector('li.is-active');
    if (!li) return;
    var pt = this.panel.scrollTop, ph = this.panel.clientHeight;
    if (li.offsetTop < pt) this.panel.scrollTop = li.offsetTop;
    else if (li.offsetTop + li.offsetHeight > pt + ph) this.panel.scrollTop = li.offsetTop + li.offsetHeight - ph;
  };

  Combobox.prototype.choose = function (item) {
    if (!item) return;
    this.input.value = item.code;
    this.clearBtn.hidden = false;
    this.hide();
    if (this.opts.onChoose) this.opts.onChoose(item.code, item);
  };

  Combobox.prototype.hide = function () {
    this.open = false;
    this.panel.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  };

  Combobox.prototype.setValue = function (code) {
    this.input.value = code == null ? '' : code;
    this.clearBtn.hidden = !this.input.value;
  };

  global.YAD = global.YAD || {};
  global.YAD.Combobox = Combobox;
})(window);
