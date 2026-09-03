/* dialog.js — small modal prompts, so renaming or removing a dataset does not
   fall back to window.prompt/confirm (unstyled, and blocked in some contexts). */
(function (global) {
  'use strict';

  function build(opts) {
    var back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
        '<h3 id="modal-title">' + esc(opts.title) + '</h3>' +
        (opts.text ? '<p class="modal-text">' + esc(opts.text) + '</p>' : '') +
        (opts.input
          ? '<label class="field"><span>' + esc(opts.label || '') + '</span>' +
            '<input type="text" id="modal-input" maxlength="80"></label>'
          : '') +
        '<div class="modal-actions">' +
          '<button type="button" class="btn" data-cancel>' + esc(opts.cancelText || 'Cancel') + '</button>' +
          '<button type="button" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-ok>' +
            esc(opts.confirmText || 'OK') + '</button>' +
        '</div>' +
      '</div>';
    return back;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function open(opts) {
    return new Promise(function (resolve) {
      var back = build(opts);
      document.body.appendChild(back);
      var input = back.querySelector('#modal-input');
      if (input) { input.value = opts.value || ''; }

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        else if (e.key === 'Enter' && (!input || document.activeElement === input)) {
          e.preventDefault(); confirm();
        }
      }
      function confirm() {
        if (!input) return close(true);
        var v = input.value.trim();
        if (!v) { input.focus(); return; }
        close(v);
      }

      back.querySelector('[data-ok]').addEventListener('click', confirm);
      back.querySelector('[data-cancel]').addEventListener('click', function () { close(null); });
      back.addEventListener('mousedown', function (e) { if (e.target === back) close(null); });
      document.addEventListener('keydown', onKey, true);

      requestAnimationFrame(function () {
        back.classList.add('is-open');
        if (input) { input.focus(); input.select(); }
        else back.querySelector('[data-ok]').focus();
      });
    });
  }

  global.YAD = global.YAD || {};
  global.YAD.dialog = {
    text: function (title, label, value, confirmText) {
      return open({ title: title, label: label, value: value, input: true, confirmText: confirmText || 'Save' });
    },
    confirm: function (title, text, confirmText, danger) {
      return open({ title: title, text: text, confirmText: confirmText || 'OK', danger: danger });
    }
  };
})(window);
