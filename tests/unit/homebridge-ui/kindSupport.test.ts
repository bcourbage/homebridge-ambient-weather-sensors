/**
 * Kind header help vocabulary — drift guards (issue #50, PR #51
 * review finding 2).
 *
 * The compile-time guard lives in kind-support.ts itself: KIND_SUPPORT
 * is a Record over `Exclude<SensorKind, 'unrecognized'>`, so adding or
 * removing a kind fails the build until the table follows. These tests
 * add the VALUE-level guard the type system cannot: each `supported`
 * flag must agree with the runtime wrapper table, so a kind gaining or
 * losing a concrete wrapper flips CI red instead of leaving the header
 * copy claiming the wrong capability.
 */
import { describe, expect, it } from 'vitest';

import { KIND_HELP, KIND_SUPPORT } from '../../../homebridge-ui/app-src/kind-support';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT } from '../../../src/sensorMap/wrappers.js';

describe('kind-support vocabulary', () => {
  it('supported flags match the runtime wrapper table exactly', () => {
    const kindsWithWrappers = new Set(
      Object.keys(WRAPPER_FOR_KIND_AND_MEASUREMENT).map(key => key.split('|')[0]),
    );
    for (const [kind, entry] of Object.entries(KIND_SUPPORT)) {
      expect(entry.supported, `KIND_SUPPORT['${kind}'].supported`).toBe(kindsWithWrappers.has(kind));
    }
    // And the other direction: every kind that has a wrapper is in
    // the table (the Record type guarantees this at compile time for
    // SensorKind members; this catches a wrapper keyed off-vocabulary).
    for (const kind of kindsWithWrappers) {
      expect(KIND_SUPPORT[kind as keyof typeof KIND_SUPPORT], `wrapper kind '${kind}' missing from KIND_SUPPORT`).toBeDefined();
    }
  });

  it('the derived help copy lists every kind under the correct capability claim', () => {
    // Slice out the lists by their fixed anchors. A '. ' search is
    // safe as a sentence boundary here: no label contains a period
    // followed by a space (PM2.5's period is mid-token). The reserved
    // sentence uses singular/plural grammar and only appears when needed.
    const splitList = (list: string): string[] => list.split(' and ').flatMap(part => part.split(', '));
    const supportedAnchor = 'Currently supported kinds are ';
    const afterAnchor = KIND_HELP.slice(KIND_HELP.indexOf(supportedAnchor) + supportedAnchor.length);
    const supported = splitList(afterAnchor.slice(0, afterAnchor.indexOf('. ')));
    const reservedSentence = KIND_HELP.split('. ').find(s => s.endsWith(' reserved for future support'));
    const reserved = reservedSentence ? splitList(reservedSentence.replace(/ (?:is|are) reserved for future support$/, '')) : [];

    const entries = Object.values(KIND_SUPPORT);
    expect(new Set(supported)).toEqual(new Set(entries.filter(e => e.supported).map(e => e.label)));
    expect(new Set(reserved)).toEqual(new Set(entries.filter(e => !e.supported).map(e => e.label)));
    expect(KIND_HELP).toContain('Rows marked ? are unrecognized and do not create an accessory.');
  });
});
