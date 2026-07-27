import { PlatformAccessory, Service } from 'homebridge';

import { setupBatteryService } from './batteryService.js';
import { co2Reading } from './nativeConversions.js';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
import { batteryOptionsFor } from './sensorMap/batterySeed.js';
import type { NumericSensorRow } from './sensorMap/types.js';

export class Co2Accessory implements SensorAccessory {
  private service: Service;
  private readonly batterySetter?: (low: boolean) => void;

  constructor(
    private readonly platform: AmbientWeatherSensorsPlatform,
    private readonly accessory: PlatformAccessory,
    // Row-driven (finding #4). CO₂ is reported in ppm (canonical), so
    // there is no unit conversion, and the 1000-ppm alert threshold
    // stays hardcoded per the design (CO₂ isn't a motion kind, so
    // row.threshold is contractually absent). The row supplies name +
    // battery ownership only.
    row?: NumericSensorRow,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
      .setCharacteristic(this.platform.Characteristic.Model, 'CO2 Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    this.service = this.accessory.getService(this.platform.Service.CarbonDioxideSensor)
                || this.accessory.addService(this.platform.Service.CarbonDioxideSensor);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      row?.name ?? accessory.context.device.displayName,
    );

    this.batterySetter = setupBatteryService(
      this.platform, this.accessory, batteryOptionsFor(row, accessory),
    );

    if (typeof accessory.context.device.value === 'number') {
      this.setValue(accessory.context.device.value);
    }
  }

  setBatteryLow(batteryLow: boolean): void {
    this.batterySetter?.(batteryLow);
  }

  /**
   * AWN reports CO2 in ppm directly. HomeKit's CarbonDioxideLevel is
   * also ppm, so no conversion. We also flip CarbonDioxideDetected
   * (NORMAL/ABNORMAL boolean characteristic) based on the
   * CO2_DETECTED_PPM threshold so HomeKit automations can react to
   * elevated levels.
   */
  setValue(rawValue: number): void {
    const { ppm, detected } = co2Reading(rawValue);
    const hapDetected = detected
      ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
      : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;

    this.platform.log.debug(`SET CarbonDioxideLevel: ${ppm} ppm (${detected ? 'abnormal' : 'normal'})`);
    this.service
      .updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, ppm)
      .updateCharacteristic(this.platform.Characteristic.CarbonDioxideDetected, hapDetected);
  }
}
