import { PlatformAccessory } from 'homebridge';

import { AmbientWeatherSensorsPlatform } from '../platform.js';
import { ExtendedDisplayMode, ExtendedSensorBase } from './extendedSensorBase.js';
import { convertPressure, PressureUnit } from './unitConversions.js';

/**
 * Barometric pressure accessory. AWN reports two values:
 *   - `baromrelin` — relative pressure (corrected to sea level)
 *   - `baromabsin` — absolute pressure (raw, at station altitude)
 *
 * For users at low elevations the two are nearly identical; at
 * altitude they diverge significantly (Denver's absolute is ~25 inHg
 * while sea-level-corrected relative is ~30 inHg). We expose both
 * as independent accessories and let the user enable whichever they
 * find meaningful — most users want relative since that's what
 * weather forecasts and almanacs use.
 *
 * Threshold default (29.5 inHg ≈ 999 hPa) triggers MotionDetected
 * when pressure drops below — this is the conventional "low pressure
 * system incoming" threshold. Above ~30.5 inHg is "high pressure"
 * (fair weather), below ~29.5 is "low pressure" (storms likely).
 *
 * Intensity bucket / pressure trend is deferred to v1.5.x — it
 * requires a small ring buffer of recent readings to detect
 * Rising / Falling / Steady, which is more state than the current
 * base class carries.
 */
abstract class PressureLikeAccessory extends ExtendedSensorBase {
  private readonly pressureUnit: PressureUnit;

  constructor(
    platform: AmbientWeatherSensorsPlatform,
    accessory: PlatformAccessory,
    sensorLabel: string,
    awnKey: string,
  ) {
    const displayMode: ExtendedDisplayMode =
      platform.config.extendedDisplayMode === 'embed' ? 'embed' : 'static';
    const pressureUnit: PressureUnit = (platform.config.units?.pressure as PressureUnit) || 'inHg';

    // Pressure trigger fires when readings drop *below* the threshold
    // — opposite of wind/UV/rain. The configured threshold value is
    // in AWN's native unit (inHg); default 29.5 inHg ≈ 999 hPa is the
    // conventional "low pressure system incoming" boundary.
    const thresholdInHg = (platform.config.thresholds?.pressureInHg as number) ?? 29.5;

    super(platform, accessory, {
      sensorLabel,
      awnKey,
      threshold: thresholdInHg,
      triggerDirection: 'below',
      displayMode,
    });

    this.pressureUnit = pressureUnit;
  }

  protected formatValue(rawInHg: number): string {
    const converted = convertPressure(rawInHg, this.pressureUnit);
    const unitLabel = this.pressureUnit;
    // hPa values are whole-number-ish (~1013); inHg readings are
    // two-decimal (~29.92).
    const precision = this.pressureUnit === 'hPa' ? 0 : 2;
    return `${converted.toFixed(precision)} ${unitLabel}`;
  }

  // Intensity bucket deferred — pressure trend requires history.
  // Leave formatIntensity at its default (returns undefined) so the
  // Intensity characteristic is not added to the tile.
}

export class PressureRelativeAccessory extends PressureLikeAccessory {
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory) {
    super(platform, accessory, 'Pressure (Sea Level)', 'baromrelin');
  }
}

export class PressureAbsoluteAccessory extends PressureLikeAccessory {
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory) {
    super(platform, accessory, 'Pressure (Station)', 'baromabsin');
  }
}
