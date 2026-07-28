import { PlatformAccessory, Service } from 'homebridge';

import { setupBatteryService } from './batteryService.js';
import { fahrenheitToCelsius } from './nativeConversions.js';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
import { batteryOptionsFor } from './sensorMap/batterySeed.js';
import { toCanonical } from './sensorMap/unitConversions.js';
import type { NumericSensorRow } from './sensorMap/types.js';


export class TemperatureAccessory implements SensorAccessory {
  private service: Service;
  private readonly batterySetter?: (low: boolean) => void;

  constructor(
    private readonly platform: AmbientWeatherSensorsPlatform,
    private readonly accessory: PlatformAccessory,
    // Row-driven (finding #4): when the platform's v2 path constructs
    // this wrapper it passes the resolved row, and the source-unit /
    // battery knobs are read from it. When absent (the v1.6.0 live
    // construction path, still gated behind `_sensorMapV2`), the wrapper
    // falls back to the legacy config/context behavior so the shipping
    // path stays byte-identical. NOTE: the tile Name stays platform-owned
    // (context.device.displayName) so a row never silently renames a
    // multi-station customer's accessory (finding-#4 review P2-D).
    private readonly row?: NumericSensorRow,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
      .setCharacteristic(this.platform.Characteristic.Model, 'Temperature Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    // get the TemperatureSensor service if it exists, otherwise create a new TemperatureSensor service
    this.service = this.accessory.getService(this.platform.Service.TemperatureSensor)
                || this.accessory.addService(this.platform.Service.TemperatureSensor);

    // set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    // Attach a Battery sub-service driven by the corresponding batt*
    // field for this sensor's physical probe. Returns undefined (and
    // skips the sub-service) when AWN doesn't report a battery for
    // the probe — see batteryService.ts. Row-driven: the graph is a
    // property of `row.hasBatterySubService`, not of telemetry.
    this.batterySetter = setupBatteryService(
      this.platform, this.accessory, batteryOptionsFor(row, accessory),
    );

    // Seed the characteristic with whatever value is cached on the accessory
    // so HomeKit has something sensible to display until the first poll tick.
    if (typeof accessory.context.device.value === 'number') {
      this.setValue(accessory.context.device.value);
    }
  }

  setBatteryLow(batteryLow: boolean): void {
    this.batterySetter?.(batteryLow);
  }

  /**
   * Push a fresh raw AWN reading into the HomeKit characteristic after
   * converting to °C (HAP's `CurrentTemperature` unit). Row-driven: the
   * conversion goes through `toCanonical`, which is `fahrenheitToCelsius`
   * for the AWN-native `sourceUnit: 'fahrenheit'` and a no-op for a
   * custom sensor already reporting Celsius. The legacy path keeps the
   * hardcoded F→C. Called by the platform's poll tick.
   */
  setValue(rawValue: number): void {
    const celsius = this.row
      ? toCanonical(this.row.measurement, this.row.sourceUnit, rawValue)
      : fahrenheitToCelsius(rawValue);
    // Preserve flag-off log identity (finding-#4 review): the legacy
    // (row-absent) path keeps the exact v1.7 "°F → °C" string; the
    // unit-neutral form is used only for row-driven construction (where
    // the source unit may not be fahrenheit).
    this.platform.log.debug(this.row
      ? `SET CurrentTemperature: ${rawValue} → ${celsius.toFixed(2)}°C`
      : `SET CurrentTemperature: ${rawValue}°F → ${celsius.toFixed(2)}°C`);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, celsius);
  }
}
