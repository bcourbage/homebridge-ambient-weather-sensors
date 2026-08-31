/**
 * The custom UI runs in an iframe that HB UI X fills with its OWN
 * stylesheets (plugin-ui-utils mirrors the parent document's styles
 * at iframe init). Those sheets bundle Bootstrap, so any class name
 * this app shares with Bootstrap gets Bootstrap's rules on top of
 * ours — for properties we never set, Bootstrap's value simply wins.
 *
 * That is not hypothetical: the save-confirmation card was named
 * ".modal", Bootstrap's `.modal { display: none; position: fixed }`
 * hid it entirely, and the editor appeared frozen with every control
 * disabled (beta.14 smoke #6, reproduced against a real HB UI X
 * 5.28). This test pins EVERY class name used by the plugin page —
 * component template and index.html alike — against the actual class
 * inventory of the bundled `bootstrap` package (a devDependency kept
 * on the same major HB UI X ships), so a future rename into the
 * foreign namespace fails here instead of on a user's screen.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '../../../..');

/** Every class Bootstrap's compiled CSS targets. */
function bootstrapClassInventory(): Set<string> {
  const css = readFileSync(
    path.join(repo, 'node_modules', 'bootstrap', 'dist', 'css', 'bootstrap.css'),
    'utf8',
  );
  const names = new Set<string>();
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) {
    names.add(m[1]);
  }
  return names;
}

/** Static class names in class="..." attributes (interpolations skipped). */
function classesIn(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/class="([^"]*)"/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (token && !token.includes('{{') && !token.includes('}}')) {
        names.add(token);
      }
    }
  }
  return names;
}

/**
 * Class names produced by bindings rather than literal class="..."
 * attributes; keep in sync with the component (state-icon states,
 * layer dots, change kinds).
 */
const DYNAMIC_CLASSES = ['on', 'off', 'global', 'station', 'added', 'removed', 'modified'];

describe('plugin UI class names vs Bootstrap namespace', () => {
  const bootstrap = bootstrapClassInventory();

  it('the inventory parse actually captured Bootstrap', () => {
    // Guards the guard: an empty or mis-parsed inventory would pass
    // everything vacuously.
    expect(bootstrap.size).toBeGreaterThan(500);
    expect(bootstrap.has('modal')).toBe(true);
    expect(bootstrap.has('row')).toBe(true);
  });

  for (const file of ['homebridge-ui/app-src/awn-root.component.ts', 'homebridge-ui/public/index.html']) {
    it(`${file} uses no Bootstrap class names`, () => {
      const used = classesIn(readFileSync(path.join(repo, file), 'utf8'));
      const collisions = [...used].filter(c => bootstrap.has(c));
      expect(collisions).toEqual([]);
    });
  }

  it('dynamically bound class names avoid Bootstrap too', () => {
    expect(DYNAMIC_CLASSES.filter(c => bootstrap.has(c))).toEqual([]);
  });
});
