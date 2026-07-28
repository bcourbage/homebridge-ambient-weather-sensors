import { setupBatteryService } from './batteryService.js';
import { airQualityReading } from './nativeConversions.js';
import { batteryOptionsFor } from './sensorMap/batterySeed.js';
export class AirQualityAccessory {
    constructor(platform, accessory, 
    // Row-driven (finding #4). The PM2.5-vs-PM10 variant now comes from
    // the row's measurement (the factory routed 'air-quality-pm25' vs
    // 'air-quality-pm10' here), removing the cross-source-of-truth with
    // `context.device.type` that has bitten upgrades before. Density is
    // reported in μg/m³ (canonical) so there is no unit conversion.
    row) {
        this.platform = platform;
        this.accessory = accessory;
        this.variant = row
            ? (row.measurement === 'pm10' ? 'PM10' : 'PM2.5')
            : (accessory.context.device.type === 'PM10' ? 'PM10' : 'PM2.5');
        this.accessory.getService(this.platform.Service.AccessoryInformation)
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
            .setCharacteristic(this.platform.Characteristic.Model, `${this.variant} Sensor`)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);
        this.service = this.accessory.getService(this.platform.Service.AirQualitySensor)
            || this.accessory.addService(this.platform.Service.AirQualitySensor);
        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);
        this.batterySetter = setupBatteryService(this.platform, this.accessory, batteryOptionsFor(row, accessory));
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