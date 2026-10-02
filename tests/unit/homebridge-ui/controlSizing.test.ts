// CSS contracts complement real-browser geometry checks: jsdom does
// not lay out native selects, so it cannot prove their pixel heights.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const html = readFileSync(path.join(root, 'homebridge-ui/public/index.html'), 'utf8');
const source = readFileSync(path.join(root, 'homebridge-ui/app-src/awn-root.component.ts'), 'utf8');
const pageCss = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
const componentCss = /styles:\s*`([\s\S]*?)`/.exec(source)![1];
const template = /template:\s*`([\s\S]*?)`/.exec(source)![1];
const dom = new JSDOM(`<style>${pageCss}</style><div id="awn">${template}</div>`);
const doc = dom.window.document;
function styleRules(list: CSSRuleList): CSSStyleRule[] {
  return [...list].flatMap(rule => {
    // Style rules can also have cssRules (CSS nesting). Include the
    // rule itself before walking its children, even when empty.
    const own = 'selectorText' in rule ? [rule as CSSStyleRule] : [];
    return 'cssRules' in rule ? [...own, ...styleRules((rule as CSSGroupingRule).cssRules)] : own;
  });
}
const rules = styleRules(doc.styleSheets[0].cssRules);
const fields = [...doc.querySelectorAll<HTMLInputElement>('select, textarea, input[type="text"], input[type="password"], input[type="number"]')];
const metricRule = rules.find(rule => rule.style.fontSize === '1rem')!;
const heightRule = rules.find(rule => rule.style.height === '2.25rem')!;
afterAll(() => dom.window.close());

describe('shared editor control sizing', () => {
  it('all actual Connection, Units, edit, assign and interpretation fields use one typography/chrome rule', () => {
    expect(fields.length).toBeGreaterThan(15);
    for (const section of ['.conn-grid', '.unit-families', '.editor-form', '.interpretation-panel']) {
      expect(doc.querySelector(`${section} select`), section).not.toBeNull();
    }
    for (const field of fields) {
      expect(field.matches(metricRule.selectorText), field.outerHTML).toBe(true);
    }
    expect(metricRule.style.fontFamily).toBe('inherit');
    expect(metricRule.style.fontWeight).toBe('400');
    expect(metricRule.style.lineHeight).toBe('1.5');
    expect(metricRule.style.boxSizing).toBe('border-box');
    expect(metricRule.style.padding).toBe('4px 8px');
    expect(metricRule.style.maxWidth).toBe('100%');
    expect(metricRule.selectorText.split(',').every(s => s.trim().startsWith('#awn '))).toBe(true);
  });

  it('all single-line fields share explicit height, including disabled and readonly variants', () => {
    for (const field of fields.filter(f => f.tagName !== 'TEXTAREA')) {
      expect(field.matches(heightRule.selectorText), field.outerHTML).toBe(true);
      field.setAttribute('disabled', '');
      field.setAttribute('readonly', '');
      expect(field.matches(heightRule.selectorText), field.outerHTML).toBe(true);
    }
  });

  it('keeps textarea multiline and does not resize checkboxes or buttons', () => {
    const textarea = doc.querySelector('textarea')!;
    expect(textarea.getAttribute('rows')).toBe('2');
    expect(textarea.matches(heightRule.selectorText)).toBe(false);
    const compact = [...doc.querySelectorAll('input[type="checkbox"], button')];
    expect(compact.length).toBeGreaterThan(10);
    for (const field of compact) {
      expect(field.matches(metricRule.selectorText)).toBe(false);
      expect(field.matches(heightRule.selectorText)).toBe(false);
    }
  });

  it('section styles cannot reintroduce independent control heights or fonts', () => {
    const styleDoc = new JSDOM(`<style>${componentCss}</style>`).window.document;
    for (const rule of styleRules(styleDoc.styleSheets[0].cssRules)) {
      if (!fields.some(field => field.matches(rule.selectorText))) continue;
      for (const property of ['font', 'font-size', 'font-family', 'line-height', 'height', 'padding', 'box-sizing']) {
        expect(rule.style.getPropertyValue(property), `${rule.selectorText}: ${property}`).toBe('');
      }
    }
    styleDoc.defaultView!.close();
  });

  it('also inspects metric overrides nested in responsive rules', () => {
    const nested = new JSDOM('<style>@media (max-width:540px) { .conn-grid select { font-size:12px; } }</style>');
    const overrides = styleRules(nested.window.document.styleSheets[0].cssRules)
      .filter(rule => fields.some(field => field.matches(rule.selectorText)));
    expect(overrides.map(rule => rule.style.getPropertyValue('font-size'))).toEqual(['12px']);
    nested.window.close();
  });

  it('preserves native control affordances and focus rings', () => {
    for (const rule of rules.filter(rule => fields.some(field => field.matches(rule.selectorText)))) {
      expect(rule.style.getPropertyValue('appearance')).not.toBe('none');
      expect(rule.style.getPropertyValue('-webkit-appearance')).not.toBe('none');
      expect(rule.style.getPropertyValue('outline')).not.toMatch(/^(none|0)\b/);
    }
  });
});
