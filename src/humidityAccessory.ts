import { PlatformAccessory, Service } from 'homebridge';

import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';


export class HumidityAccessory implements SensorAccessory {
  private service: Service;

  constructor(
    private readonly platform: AmbientWeatherSensorsPlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
      .setCharacteristic(this.platform.Characteristic.Model, 'Humidity Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    // get the HumiditySensor service if it exists, otherwise create a new HumiditySensor service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.HumiditySensor)
                || this.accessory.addService(this.platform.Service.HumiditySensor);

    // set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    if (typeof accessory.context.device.value === 'number') {
      this.setValue(accessory.context.device.value);
    }
  }

  /**
   * Push a fresh raw AWN humidity reading (0-100 %) into the HomeKit
   * characteristic. Called by the platform's poll tick.
   */
  setValue(rawValue: number): void {
    this.platform.log.debug(`SET CurrentRelativeHumidity: ${rawValue}%`);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, rawValue);
  }
}
