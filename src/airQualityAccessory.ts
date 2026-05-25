import { PlatformAccessory, Service } from 'homebridge';

import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';

/**
 * EPA AQI breakpoints for PM2.5 (24-hour averaged μg/m³) mapped to
 * HomeKit's AirQuality enum. We use these as approximate buckets even
 * for instantaneous readings — HomeKit only has 5 buckets, so any
 * mapping is necessarily coarse.
 *
 * Source: EPA's AQI category breakpoints for PM2.5
 *   0 - 12.0  : Good       → EXCELLENT
 *   12.1 - 35.4 : Moderate → GOOD
 *   35.5 - 55.4 : Unhealthy for sensitive groups → FAIR
 *   55.5 - 150.4 : Unhealthy → INFERIOR
 *   150.5+     : Very Unhealthy / Hazardous → POOR
 */
const PM25_BUCKETS_UG_M3: Array<{ max: number; level: number }> = [
  { max: 12.0, level: 1 },   // EXCELLENT
  { max: 35.4, level: 2 },   // GOOD
  { max: 55.4, level: 3 },   // FAIR
  { max: 150.4, level: 4 },  // INFERIOR
  { max: Infinity, level: 5 }, // POOR
];

/**
 * EPA AQI breakpoints for PM10 (24-hour averaged μg/m³).
 *   0 - 54   : Good       → EXCELLENT
 *   55 - 154 : Moderate   → GOOD
 *   155 - 254 : USG       → FAIR
 *   255 - 354 : Unhealthy → INFERIOR
 *   355+     : Very Unhealthy / Hazardous → POOR
 */
const PM10_BUCKETS_UG_M3: Array<{ max: number; level: number }> = [
  { max: 54, level: 1 },
  { max: 154, level: 2 },
  { max: 254, level: 3 },
  { max: 354, level: 4 },
  { max: Infinity, level: 5 },
];

function bucket(value: number, table: Array<{ max: number; level: number }>): number {
  for (const row of table) {
    if (value <= row.max) {
      return row.level;
    }
  }
  return 5; // POOR — fall-through safety
}

export class AirQualityAccessory implements SensorAccessory {
  private service: Service;
  private readonly variant: 'PM2.5' | 'PM10';

  constructor(
    private readonly platform: AmbientWeatherSensorsPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.variant = accessory.context.device.type === 'PM10' ? 'PM10' : 'PM2.5';

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
      .setCharacteristic(this.platform.Characteristic.Model, `${this.variant} Sensor`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    this.service = this.accessory.getService(this.platform.Service.AirQualitySensor)
                || this.accessory.addService(this.platform.Service.AirQualitySensor);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    if (typeof accessory.context.device.value === 'number') {
      this.setValue(accessory.context.device.value);
    }
  }

  /**
   * AWN reports particulate density in μg/m³ directly. HomeKit's
   * PM2_5Density and PM10Density characteristics take the same units,
   * so no conversion. We also derive an AirQuality enum from EPA-bucket
   * boundaries so the Home app's color-coded indicator and any
   * "air quality" based automation triggers fire sensibly.
   */
  setValue(rawValue: number): void {
    const value = Math.max(0, rawValue);
    const density = Math.round(value * 10) / 10; // 1 decimal place
    const aqLevel = this.variant === 'PM10'
      ? bucket(value, PM10_BUCKETS_UG_M3)
      : bucket(value, PM25_BUCKETS_UG_M3);

    this.platform.log.debug(`SET ${this.variant}Density: ${density} μg/m³ → AirQuality level ${aqLevel}`);

    if (this.variant === 'PM10') {
      this.service.updateCharacteristic(this.platform.Characteristic.PM10Density, density);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.PM2_5Density, density);
    }
    this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, aqLevel);
  }
}
