import { PlatformAccessory, Service } from 'homebridge';

import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';


export class TemperatureAccessory implements SensorAccessory {
  private service: Service;

  constructor(
    private readonly platform: AmbientWeatherSensorsPlatform,
    private readonly accessory: PlatformAccessory,
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

    // Seed the characteristic with whatever value is cached on the accessory
    // so HomeKit has something sensible to display until the first poll tick.
    if (typeof accessory.context.device.value === 'number') {
      this.setValue(accessory.context.device.value);
    }
  }

  private fahrenheitToCelsius(temperature: number): number {
    return (temperature - 32) * 5 / 9;
  }

  /**
   * Push a fresh raw AWN reading (in °F) into the HomeKit characteristic
   * after converting to °C. Called by the platform's poll tick — wrappers
   * no longer poll on their own.
   */
  setValue(rawValue: number): void {
    const celsius = this.fahrenheitToCelsius(rawValue);
    this.platform.log.debug(`SET CurrentTemperature: ${rawValue}°F → ${celsius.toFixed(2)}°C`);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, celsius);
  }
}
