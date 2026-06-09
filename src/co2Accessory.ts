import { PlatformAccessory, Service } from 'homebridge';

import { setupBatteryService } from './batteryService.js';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';

// ppm threshold above which HomeKit's CarbonDioxideDetected boolean
// flips to "abnormal". 1000 ppm is the conventional indoor-air-quality
// guideline (ASHRAE 62.1) — well-ventilated spaces typically read
// 400-1000 ppm, and >1000 indicates measurable build-up.
const CO2_DETECTED_PPM = 1000;

export class Co2Accessory implements SensorAccessory {
  private service: Service;
  private readonly batterySetter?: (low: boolean) => void;

  constructor(
    private readonly platform: AmbientWeatherSensorsPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
      .setCharacteristic(this.platform.Characteristic.Model, 'CO2 Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    this.service = this.accessory.getService(this.platform.Service.CarbonDioxideSensor)
                || this.accessory.addService(this.platform.Service.CarbonDioxideSensor);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    this.batterySetter = setupBatteryService(this.platform, this.accessory);

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
    const ppm = Math.max(0, Math.round(rawValue));
    const detected = ppm >= CO2_DETECTED_PPM
      ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
      : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;

    this.platform.log.debug(`SET CarbonDioxideLevel: ${ppm} ppm (${ppm >= CO2_DETECTED_PPM ? 'abnormal' : 'normal'})`);
    this.service
      .updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, ppm)
      .updateCharacteristic(this.platform.Characteristic.CarbonDioxideDetected, detected);
  }
}
