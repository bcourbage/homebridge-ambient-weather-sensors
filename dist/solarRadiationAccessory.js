import { setupBatteryService } from './batteryService.js';
import { solarWm2ToLux } from './nativeConversions.js';
import { batteryOptionsFor } from './sensorMap/batterySeed.js';
import { toCanonical } from './sensorMap/unitConversions.js';
export class SolarRadiationAccessory {
    constructor(platform, accessory, 
    // Row-driven (finding #4). The canonical unit is lux; toCanonical is
    // solarWm2ToLux for the AWN-native `sourceUnit: 'wm2'` and a no-op
    // for a custom sensor reporting lux directly.
    row) {
        this.platform = platform;
        this.accessory = accessory;
        this.row = row;
        // set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
            .setCharacteristic(this.platform.Characteristic.Model, 'Solar Radiation Sensor')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);
        // get the LightSensor service if it exists, otherwise create a new LightSensor service
        // you can create multiple services for each accessory
        this.service = this.accessory.getService(this.platform.Service.LightSensor)
            || this.accessory.addService(this.platform.Service.LightSensor);
        // set the service name, this is what is displayed as the default name on the Home app
        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);
        const char = this.service.getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel);
        // allow setting lux to zero, because you know... it's dark at night
        char.setProps({
            minValue: 0,
            maxValue: 200000,
        });
        this.batterySetter = setupBatteryService(this.platform, this.accessory, batteryOptionsFor(row, accessory));
        if (typeof accessory.context.device.value === 'number') {
            this.setValue(accessory.context.device.value);
        }
    }
    setBatteryLow(batteryLow) {
        this.batterySetter?.(batteryLow);
    }
    /**
     * Push a fresh raw AWN solar-radiation reading (W/m²) into the HomeKit
     * LightSensor characteristic after converting to lux. Called by the
     * platform's poll tick.
     *
     * AWN reports solar radiation in W/m²; HomeKit's LightSensor accepts
     * lux. The standard conversion factor of 1 W/m² ≈ 127 lux assumes
     * sunlight's spectral distribution (the AWN sensor's design point).
     * Documented in the README so users can do the reverse math from the
     * HomeKit reading if they want W/m² back.
     */
    setValue(rawValue) {
        const lux = this.row
            ? toCanonical(this.row.measurement, this.row.sourceUnit, rawValue)
            : solarWm2ToLux(rawValue);
        // Preserve flag-off log identity (finding-#4 review): the legacy
        // (row-absent) path keeps the exact v1.7 "W/m² → lx" string; the
        // unit-neutral form is used only for row-driven construction.
        this.platform.log.debug(this.row
            ? `SET CurrentAmbientLightLevel: ${rawValue} → ${lux} lx`
            : `SET CurrentAmbientLightLevel: ${rawValue} W/m² → ${lux} lx`);
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, lux);
    }
}
//# sourceMappingURL=solarRadiationAccessory.js.map