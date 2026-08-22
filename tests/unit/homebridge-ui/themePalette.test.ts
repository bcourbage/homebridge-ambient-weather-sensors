/**
 * Theme-palette regression suite for the custom-UI page (PR #26
 * review): the page must stay legible under BOTH HB UI X themes, so
 * every rendered color has to come from the scoped palette — including
 * colors created from JavaScript, the escape hatch the original
 * one-off check missed (an inline `style.color = '#666'` bypassed the
 * `#awn` cascade entirely and sat at ~2.3:1 on the dark surfaces).
 *
 * Three invariants, enforced against the shipped HTML:
 *   1. No JS-assigned or attribute-inline colors anywhere in the page.
 *   2. Every `color`/`background` declaration in the #awn rules uses a
 *      palette variable.
 *   3. All palette foreground/background pairs meet WCAG AA 4.5:1 in
 *      BOTH the light and dark palettes.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const html = readFileSync(
  path.resolve(__dirname, '../../../homebridge-ui/public/index.html'),
  'utf8',
);
const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];

function palette(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,6})/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const light = palette(/#awn \{([\s\S]*?)\}/.exec(css)![1]);
const dark = palette(/body\.dark-mode #awn \{([\s\S]*?)\}/.exec(css)![1]);

function luminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  const chan = (c: string): number => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(h.slice(0, 2)) + 0.7152 * chan(h.slice(2, 4)) + 0.0722 * chan(h.slice(4, 6));
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

describe('custom-UI theme palette', () => {
  it('the page JS never assigns inline colors (the cascade escape hatch)', () => {
    // style.color / style.background / style.backgroundColor from JS,
    // and setProperty with a color property.
    expect(script).not.toMatch(/\.style\.(color|background|backgroundColor)\s*=/);
    expect(script).not.toMatch(/setProperty\(\s*['"](color|background)/);
    // Color values inside JS-built markup strings (style="...color...").
    expect(script).not.toMatch(/style\s*=\s*\\?["'][^"']*(color|background)/i);
  });

  it('the body follows a LIVE theme switch despite HB UI X\'s frozen injected body colors (beta.13 smoke F5)', () => {
    // HB UI X injects the load-time theme's body colors as !important
    // inline style and never re-sends them on a theme switch; these
    // class-keyed higher-specificity rules must exist to out-rank it
    // in BOTH directions.
    expect(html).toMatch(/body\.dark-mode\s*\{[^}]*background-color:\s*#242424\s*!important[^}]*color:\s*#FFFFFF\s*!important/);
    expect(html).toMatch(/body:not\(\.dark-mode\)\s*\{[^}]*background-color:\s*#FFFFFF\s*!important[^}]*color:\s*#000000\s*!important/);
  });

  it('every CSS variable the Angular component styles reference is defined in the page palette (review #47 P2-3)', () => {
    // A var() referencing an undefined variable is silently invalid —
    // the sticky action column shipped transparent this way. The
    // component styles may only use variables the #awn palette (or
    // the body theme rules) actually define.
    const componentSource = readFileSync(
      path.resolve(__dirname, '../../../homebridge-ui/app-src/awn-root.component.ts'), 'utf8');
    const stylesMatch = componentSource.match(/styles:\s*`([\s\S]*?)`/);
    expect(stylesMatch).not.toBeNull();
    const referenced = new Set([...stylesMatch![1].matchAll(/var\((--[a-z-]+)\)/g)].map(m => m[1]));
    expect(referenced.size).toBeGreaterThan(0);
    const defined = new Set([...css.matchAll(/(--[a-z-]+)\s*:/g)].map(m => m[1]));
    for (const v of referenced) {
      expect(defined.has(v), `component styles reference undefined variable ${v}`).toBe(true);
    }
  });

  it('the static markup carries no inline color styles', () => {
    const markup = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '');
    for (const m of markup.matchAll(/style\s*=\s*"([^"]*)"/g)) {
      expect(m[1], m[0]).not.toMatch(/color|background/i);
    }
  });

  it('every color/background declaration in #awn rules uses a palette variable', () => {
    for (const rule of css.matchAll(/(#awn[^{]*)\{([^}]*)\}/g)) {
      const [, selector, block] = rule;
      if (selector.trim() === '#awn') continue; // the palette definition itself
      for (const decl of block.matchAll(/(?:^|;)\s*(background|color)\s*:\s*([^;]+)/g)) {
        expect(decl[2], `${selector.trim()} { ${decl[1]} }`).toContain('var(');
      }
    }
  });

  it('the hover rule actually uses --btn-hover (keeps the pair list honest)', () => {
    expect(css).toMatch(/#awn button:hover \{ background: var\(--btn-hover\)/);
  });

  it('all palette fg/bg pairs meet WCAG AA 4.5:1 in both themes', () => {
    const pairs: Array<[string, string | null]> = [
      ['fg', null], ['fg-sub', null], ['fg-empty', null],
      ['fg', 'panel-bg'], ['fg', 'code-bg'],
      ['warn-fg', 'warn-bg'], ['error-fg', 'error-bg'], ['info-fg', 'info-bg'],
      ['on-fg', 'on-bg'], ['off-fg', 'off-bg'],
      ['btn-fg', 'btn-bg'], ['btn-fg', 'btn-hover'],
    ];
    const backdrop = { light: '#ffffff', dark: '#242424' };
    for (const [name, pal] of [['light', light], ['dark', dark]] as const) {
      for (const [fg, bg] of pairs) {
        expect(pal[fg], `${name}: --${fg} missing`).toBeDefined();
        const bgHex = bg ? pal[bg] : backdrop[name];
        expect(bg ? pal[bg] : bgHex, `${name}: --${bg} missing`).toBeDefined();
        const c = contrast(pal[fg], bgHex);
        expect(c, `${name}: ${fg} on ${bg ?? 'backdrop'} = ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('the flag-source label is palette-driven (the exact regression)', () => {
    expect(script).toContain("src.className = 'flag-source'");
    expect(css).toMatch(/#awn \.flag-source \{[^}]*color: var\(--fg-sub\)/);
  });
});
