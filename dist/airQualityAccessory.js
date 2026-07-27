import { setupBatteryService } from './batteryService.js';
import { airQualityReading } from './nativeConversions.js';
export class AirQualityAccessory {
    constructor(platform, accessory) {
        this.platform = platform;
        this.accessory = accessory;
        this.variant = accessory.context.device.type === 'PM10' ? 'PM10' : 'PM2.5';
        this.accessory.getService(this.platform.Service.AccessoryInformation)
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
            .setCharacteristic(this.platform.Characteristic.Model, `${this.variant} Sensor`)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);
        this.service = this.accessory.getService(this.platform.Service.AirQualitySensor)
            || this.accessory.addService(this.platform.Service.AirQualitySensor);
        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);
        this.batterySetter = setupBatteryService(this.platform, this.accessory);
        if (typeof accessory.context.device.value === 'number') {
            this.setValue(accessory.context.device.value);
        }
    }
    setBatteryLow(batteryLow) {
        this.batterySetter?.(batteryLow);
    }
    /**
     * AWN reports particulate density in μg/m³ directly. HomeKit's
     * PM2_5Density and PM10Density characteristics take the same units,
     * so no conversion. We also derive an AirQuality enum from EPA-bucket
     * boundaries so the Home app's color-coded indicator and any
     * "air quality" based automation triggers fire sensibly.
     */
    setValue(rawValue) {
        const value = Math.max(0, rawValue);
        const { density, level } = airQualityReading(value, this.variant);
        this.platform.log.debug(`SET ${this.variant}Density: ${density} μg/m³ → AirQuality level ${level}`);
        if (this.variant === 'PM10') {
            this.service.updateCharacteristic(this.platform.Characteristic.PM10Density, density);
        }
        else {
            this.service.updateCharacteristic(this.platform.Characteristic.PM2_5Density, density);
        }
        this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, level);
    }
}
//# sourceMappingURL=airQualityAccessory.js.map