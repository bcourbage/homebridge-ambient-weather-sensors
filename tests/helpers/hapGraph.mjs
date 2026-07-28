/**
 * Real-HAP graph-parity harness (finding-#4 review, P1-C).
 *
 * Constructs accessory wrappers against REAL @homebridge/hap-nodejs
 * Service/Characteristic objects — not the lightweight mock — so the
 * captured graph carries the behavior-affecting HAP metadata the mock
 * cannot model: full CharacteristicProps (format, perms, unit, min/max/
 * step, valid values), service subtype / primary / hidden flags, linked
 * services, optional-characteristic sets, and stock characteristic
 * defaults. Used both to GENERATE the v1.7.0 golden fixtures
 * (genGraphFixtures.mjs) and to compare HEAD's builds against them
 * (graphParity.test.ts), so the two are byte-comparable by construction.
 *
 * Plain ESM (.mjs) so the standalone fixture generator and the vitest
 * test can share one serializer.
 */

import hap from '@homebridge/hap-nodejs';

const { Accessory, Service, Characteristic, uuid } = hap;

// A stable, HAP-valid accessory name so AccessoryInformation.Name (which
// the wrappers don't override) is identical across every build.
const ACCESSORY_NAME = 'Parity Accessory';

/** Minimal PlatformAccessory shim backed by a REAL hap-nodejs Accessory. */
class HapPlatformAccessory {
  constructor(deviceContext) {
    this.context = { device: deviceContext };
    this._acc = new Accessory(ACCESSORY_NAME, uuid.generate(String(deviceContext.uniqueId ?? 'seed')));
  }
  getService(ctor) { return this._acc.getService(ctor); }
  getServiceById(ctor, sub) { return this._acc.getServiceById(ctor, sub); }
  addService(ctor, ...args) { return this._acc.addService(ctor, ...args); }
  removeService(svc) { this._acc.removeService(svc); return this; }
  get services() { return this._acc.services; }
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, log() {} };

/** Platform stub whose Service/Characteristic ARE the real HAP classes. */
export function makeHapPlatform(config = {}) {
  return {
    Service,
    Characteristic,
    api: { hap: { Service, Characteristic, uuid } },
    log: silentLog,
    config,
  };
}

export function makeHapAccessory(deviceContext) {
  return new HapPlatformAccessory(deviceContext);
}

// CharacteristicProps keys that are behavior-affecting and JSON-stable.
// (Functions / adminOnlyAccess arrays etc. are captured as-is; anything
// undefined is dropped so absent-vs-absent compares equal.)
function normalizeProps(props) {
  if (!props) return null;
  const out = {};
  for (const k of Object.keys(props).sort()) {
    const v = props[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Serialize an accessory's full HAP graph into a stable, comparable
 * structure. Sorted throughout so ordering never causes a false diff.
 * The volatile "Last Updated" timestamp characteristic value is
 * normalized (the platform seeds real values post-construct anyway).
 */
export function serializeHapGraph(accessory) {
  return accessory.services
    .map((svc) => ({
      uuid: svc.UUID,
      subtype: svc.subtype ?? null,
      isPrimary: Boolean(svc.isPrimaryService),
      isHidden: Boolean(svc.isHiddenService),
      linked: (svc.linkedServices ?? []).map((l) => l.UUID).sort(),
      optional: (svc.optionalCharacteristics ?? []).map((c) => c.UUID).sort(),
      characteristics: svc.characteristics
        .map((c) => ({
          uuid: c.UUID,
          name: c.displayName,
          props: normalizeProps(c.props),
          value: /last updated/i.test(c.displayName) ? '<volatile>' : c.value,
        }))
        .sort((a, b) => a.uuid.localeCompare(b.uuid)),
    }))
    .sort((a, b) => `${a.uuid}|${a.subtype}`.localeCompare(`${b.uuid}|${b.subtype}`));
}

/**
 * The device context both builds share. `battery` toggles the real
 * structural variant: v1.7 attaches Battery iff `batteryLow !== undefined`,
 * so ON → `false` (defined), OFF → `undefined`.
 */
export function contextFor(dataPoint, { battery, type }) {
  return {
    uniqueId: `MAC-${dataPoint}`,
    displayName: 'Parity Sensor',
    value: 50,                 // benign seed valid for every family
    batteryLow: battery ? false : undefined,
    type,
  };
}
