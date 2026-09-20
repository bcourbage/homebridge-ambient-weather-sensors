import { setupBatteryService } from './batteryService.js';
import { batteryOptionsFor } from './sensorMap/batterySeed.js';
/**
 * The fixed HAP alert-state boundary for CarbonMonoxideDetected
 * (sensor-map.md §19.3): 400 ppm is the floor of UL 2034's SHORTEST
 * alarm window — the concentration at which every UL 2034 window
 * alarms. Like Co2Accessory's 1000 ppm, this is a documented HAP
 * alert-state semantic, deliberately NOT user-configurable
 * (`row.threshold` stays motion-only per §3.7).
 */
export const CO_DETECTED_PPM = 400;
/**
 * Carbon monoxide accessory (§19.3). No AWN field reports CO; this
 * wrapper exists for explicit custom assignments (kind `co`,
 * measurement `co`, ppm). The level is always written; the detected
 * alert flips at the fixed boundary above.
 */
export class CoAccessory {
    constructor(platform, accessory, row) {
        this.platform = platform;
        this.accessory = accessory;
        this.accessory.getService(this.platform.Service.AccessoryInformation)
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
            .setCharacteristic(this.platform.Characteristic.Model, 'CO Sensor')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);
        this.service = this.accessory.getService(this.platform.Service.CarbonMonoxideSensor)
            || this.accessory.addService(this.platform.Service.CarbonMonoxideSensor);
        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);
        this.batterySetter = setupBatteryService(this.platform, this.accessory, batteryOptionsFor(row, accessory));
        if (typeof accessory.context.device.value === 'number') {
            this.setValue(accessory.context.device.value);
        }
    }
    setBatteryLow(batteryLow) {
        this.batterySetter?.(batteryLow);
    }
    setValue(rawValue) {
        const detected = rawValue >= CO_DETECTED_PPM;
        const hapDetected = detected
            ? this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
            : this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
        this.platform.log.debug(`SET CarbonMonoxideLevel: ${rawValue} ppm (${detected ? 'abnormal' : 'normal'})`);
        this.service
            .updateCharacteristic(this.platform.Characteristic.CarbonMonoxideLevel, rawValue)
            .updateCharacteristic(this.platform.Characteristic.CarbonMonoxideDetected, hapDetected);
    }
}
//# sourceMappingURL=coAccessory.js.map