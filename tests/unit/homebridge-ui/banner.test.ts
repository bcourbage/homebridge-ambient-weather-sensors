/**
 * The consolidated page's static contract (beta.17, GA #56/#65):
 * exactly one functional save path. The native footer Save is
 * disabled SYNCHRONOUSLY, before any asynchronous initialization, and
 * nothing on the page can re-enable it or summon the schema form.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const html = readFileSync(
  path.join(__dirname, '..', '..', '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');

describe('single-save page contract', () => {
  it('disableSaveButton is the first statement, before any await or request', () => {
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    const disableAt = script.indexOf('homebridge.disableSaveButton()');
    expect(disableAt).toBeGreaterThan(-1);
    for (const asyncMarker of ['await ', 'homebridge.request', 'getPluginConfig', 'setTimeout', 'then(']) {
      const at = script.indexOf(asyncMarker);
      if (at !== -1) {
        expect(at, `${asyncMarker} before the disable`).toBeGreaterThan(disableAt);
      }
    }
  });

  it('never enables the native Save and never shows the schema form', () => {
    expect(html).not.toContain('homebridge.enableSaveButton');
    expect(html).not.toContain('showSchemaForm()');
  });

  it('tells the user the in-page Save is the save path', () => {
    expect(html).toContain('Save changes with the Save button on this page');
    expect(html).toContain('disabled by design');
  });

  it('the preview-era chrome is gone', () => {
    for (const gone of ['Sensor-map v2.0 preview', 'Discovered stations', 'id="statusBanner"', 'id="discovery"', 'id="notices"', 'renderDiscovery']) {
      expect(html, gone).not.toContain(gone);
    }
  });
});
