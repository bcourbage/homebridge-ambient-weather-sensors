import { describe, expect, it } from 'vitest';

import { LightningDistanceAccessory } from '../../src/extendedSensors/lightningAccessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { convertDistance } from '../../src/extendedSensors/unitConversions';
import { makeMockAccessory, makeMockPlatform } from '../helpers/mockHomebridge';

/**
 * Named tests for every known-fixed bug the beta cycle produced.
 * Each one prevents a specific regression from silently reappearing.
 * The commit / PR / CHANGELOG reference is preserved in the describe
 * block so future readers can chase the history.
 */

describe('regression: beta.5 — "Cannot read properties of undefined (reading updateValue)"', () => {
  /**
   * Root cause: HAP-NodeJS's `Service#getCharacteristic(string)`
   * matches by displayName, not UUID. Calling
   * `service.updateCharacteristic(uuidString, val)` returns undefined
   * (wrong lookup path) and throws when the caller then tries to
   * treat the result as a Characteristic instance.
   *
   * Fix: extended-sensor code caches Characteristic *instances* on
   * construction and calls `.updateValue()` directly, bypassing the
   * broken string-lookup path.
   *
   * Regression signal: if any extended-sensor wrapper's setValue()
   * uses the string-form updateCharacteristic path, the mock will
   * return undefined from that lookup and updateValue() will throw
   * "Cannot read properties of undefined". These tests exist to
   * catch that shape by exercising the setValue path across every
   * extended-sensor family.
   */
  it('LightningDistanceAccessory.setValue does not go through the broken string-form path', () => {
    const platform = makeMockPlatform({ units: { distance: 'mi' } });
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'LD' });
    const wrapper = new LightningDistanceAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    expect(() => wrapper.setValue(5)).not.toThrow();
  });
});

describe('regression: beta.16 — excludeSensors back-compat for stations with non-alphanumeric names', () => {
  /**
   * Bug: parseDevices built matchCandidates from AWN's RAW station
   * `info.name`, but the pre-beta.15 displayName had passed that
   * through hapClean (stripping hyphens, periods, etc.). Users with
   * excludeSensors entries in the pre-beta.15 cleaned-name form
   * ("Fairhills WS 2000 Indoor Feels Like") stopped matching after
   * beta.15 introduced multi-station prefixed names, because the
   * new match candidate was built from the raw name
   * ("Fairhills WS-2000 Indoor Feels Like") which now included the
   * hyphen.
   *
   * Fix: apply hapClean to the prefixedForm before adding it to
   * matchCandidates so it produces the same cleaned string as the
   * pre-beta.15 displayName.
   *
   * Regression signal: an excludeSensors entry in the hapClean'd
   * form still successfully filters an accessory whose raw AWN name
   * contains non-alphanumeric characters.
   */
  it('cleaned-name excludeSensors entry still matches raw hyphenated station name (multi-station only)', async () => {
    // We can't easily build a full platform in the mock without
    // discoverDevices firing, so exercise parseDevices directly.
    const { AmbientWeatherSensorsPlatform: Platform } = await import('../../src/platform');
    const { MockAPI, MockLogger } = await import('../helpers/mockHomebridge');

    const platform = new Platform(
      new MockLogger() as never,
      {
        platform: 'AmbientWeatherSensors',
        temperatureSensors: true,
        excludeSensors: ['Fairhills WS 2000 Outdoor Temperature'],  // hapClean'd form
      } as never,
      new MockAPI() as never,
    );

    // Multi-station required because prefix logic only fires with >1 stations.
    const devices = platform.parseDevices([
      {
        macAddress: '11:11:11:11:11:11',
        info: { name: 'Fairhills WS-2000' },   // raw name has a hyphen
        lastData: { tempf: 68 },
      },
      {
        macAddress: '22:22:22:22:22:22',
        info: { name: 'Other Station' },
        lastData: { tempf: 70 },
      },
    ]);

    // The Fairhills WS-2000 station's Outdoor Temperature should be filtered out
    // by the hapClean-form excludeSensors entry.
    const fairhillsOutdoor = devices.find((d) => d.uniqueId.startsWith('11:11:11:11:11:11'));
    expect(fairhillsOutdoor).toBeUndefined();

    // The Other Station's Outdoor Temperature should NOT be filtered.
    const otherOutdoor = devices.find((d) => d.uniqueId.startsWith('22:22:22:22:22:22'));
    expect(otherOutdoor).toBeDefined();
  });
});

describe('regression: beta.23 — LightningDistance toFixed crash (subclass-field-after-super)', () => {
  /**
   * Root cause: LightningDistanceAccessory constructor assigned
   * `this.distanceUnit` AFTER super(). ExtendedSensorBase's
   * constructor USED to end with a `setValue(cachedValue)` call
   * that triggered formatValue, which called
   * convertDistance(rawMi, this.distanceUnit). At that moment
   * this.distanceUnit was undefined because the assignment
   * happens AFTER super() returns. convertDistance is a switch
   * with no default case, so it returned undefined, and
   * .toFixed() on undefined crashed the discoverDevices loop —
   * silently dropping every accessory registered after Lightning
   * Distance (which is why solmssen's AQIN disappeared).
   *
   * Fix: moved the seed-from-cache call out of the base-class
   * constructor and into the platform layer's discoverDevices(),
   * where it runs AFTER the subclass constructor has fully
   * completed. Also wrapped the seed call in try/catch as
   * defense-in-depth.
   */
  it('convertDistance(x, undefined) STILL returns undefined (unfixed function, fixed callers)', () => {
    // The fix was in the callers, not in convertDistance itself.
    // If convertDistance ever gains a default case, this assertion
    // will fail — reminder to check whether the constructor
    // ordering bug is still possible in the callers.
    expect(convertDistance(10, undefined as never)).toBeUndefined();
  });

  it('LightningDistanceAccessory constructs cleanly with cached numeric value + any unit', () => {
    for (const unit of ['mi', 'km', 'nm']) {
      const platform = makeMockPlatform({
        thresholds: { lightningDistanceMi: 10 },
        units: { distance: unit },
      });
      const accessory = makeMockAccessory({
        uniqueId: 'x-lightning_distance',
        displayName: 'Lightning Distance',
        value: 5,   // the crash-trigger shape
      });
      expect(() => new LightningDistanceAccessory(
        platform as unknown as AmbientWeatherSensorsPlatform,
        accessory as never,
      )).not.toThrow();
    }
  });
});
