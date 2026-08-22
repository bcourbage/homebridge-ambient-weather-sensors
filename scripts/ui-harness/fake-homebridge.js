/**
 * Stand-in for the `window.homebridge` object HB UI X's ui.js creates
 * inside the custom-UI iframe (harness only, never shipped). Bridges
 * the page's IPC surface to the harness server, which runs the real
 * compiled handlers and HB UI X's real config-merge semantics.
 */
(function () {
  'use strict';
  async function post(path, payload) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload === undefined ? null : payload),
    });
    if (!res.ok) {
      throw new Error('harness request failed: ' + res.status);
    }
    return res.json();
  }
  // Twin of HB UI X's injectDefaultStyles: at iframe load it injects
  // the LOAD-TIME theme's body colors as !important inline style —
  // frozen, never re-sent on a live theme switch (the beta.13 smoke
  // F5 mechanism).
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var parentBody = window.parent.document.body;
      var dark = parentBody.classList.contains('dark-mode');
      document.body.classList.add(dark ? 'config-ui-x-dark' : 'config-ui-x-light');
      if (dark) {
        document.body.classList.add('dark-mode');
      }
      var frozen = document.createElement('style');
      frozen.textContent = 'body { height: unset !important; background-color: '
        + (dark ? '#242424' : '#FFFFFF') + ' !important; color: '
        + (dark ? '#FFFFFF' : '#000000') + ' !important; }';
      document.head.appendChild(frozen);
    } catch (e) { /* standalone open, no parent */ }
  });

  window.homebridge = {
    request: (path, payload) => post('/hb' + path, payload),
    getPluginConfig: () => post('/hb-config/get'),
    updatePluginConfig: (arr) => post('/hb-config/update', arr),
    savePluginConfig: () => post('/hb-config/save'),
    getCachedAccessories: async () => [],
    enableSaveButton: () => {},
    disableSaveButton: () => {},
    showSchemaForm: () => {},
    hideSchemaForm: () => {},
    toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
})();
