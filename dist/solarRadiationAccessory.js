export class SolarRadiationAccessory {
    constructor(platform, accessory) {
        this.platform = platform;
        this.accessory = accessory;
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
        if (typeof accessory.context.device.value === 'number') {
            this.setValue(accessory.context.device.value);
        }
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
        // to convert W/m² to lux we divide by 0.0079
        const lux = Math.round(rawValue / 0.0079);
        this.platform.log.debug(`SET CurrentAmbientLightLevel: ${rawValue} W/m² → ${lux} lx`);
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, lux);
    }
}
//# sourceMappingURL=solarRadiationAccessory.js.map