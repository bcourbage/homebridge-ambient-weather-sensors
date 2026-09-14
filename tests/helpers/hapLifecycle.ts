/**
 * Real-HAP platform-lifecycle harness (migration proof, §12.7).
 *
 * The graph-parity harness (hapGraph.mjs) proves WRAPPER classes build
 * identical real-HAP graphs, but it never runs the platform: rows are
 * hand-built, the config is empty, and names are pinned. The mock
 * lifecycle harness (mockHomebridge.ts) runs the real platform but its
 * services cannot carry CharacteristicProps. This helper is the bridge:
 * a MockAPI-shaped api whose hap namespace and PlatformAccessory are
 * backed by REAL @homebridge/hap-nodejs objects, so a full
 * `didFinishLaunching` lifecycle — legacy path or v2 path — produces
 * accessories whose complete graphs serialize with hapGraph.mjs's
 * serializer, byte-comparable across the conversion boundary.
 */
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import hap from '@homebridge/hap-nodejs';

import { serializeHapGraph } from './hapGraph.mjs';

const { Service, Characteristic, uuid, Accessory } = hap;

/**
 * PlatformAccessory shim backed by a real hap-nodejs Accessory, with
 * the PlatformAccessory surface the plugin touches (displayName, UUID,
 * context, service management). The real Accessory attaches
 * AccessoryInformation itself, exactly like Homebridge.
 */
export class HapLifecyclePlatformAccessory {
  public displayName: string;
  public UUID: string;
  public context: { device?: unknown } = {};
  private readonly acc: InstanceType<typeof Accessory>;

  constructor(displayName: string, uu: string) {
    this.displayName = displayName;
    this.UUID = uu;
    this.acc = new Accessory(displayName, uu);
  }

  getService(ctor: Parameters<InstanceType<typeof Accessory>['getService']>[0]): unknown {
    return this.acc.getService(ctor);
  }

  getServiceById(ctor: never, subtype: string): unknown {
    return this.acc.getServiceById(ctor, subtype);
  }

  addService(...args: Parameters<InstanceType<typeof Accessory>['addService']>): unknown {
    return this.acc.addService(...args);
  }

  removeService(svc: never): this {
    this.acc.removeService(svc);
    return this;
  }

  get services(): InstanceType<typeof Accessory>['services'] {
    return this.acc.services;
  }
}

/**
 * The api object a lifecycle run hands the platform: real HAP classes,
 * real-HAP-backed accessories, recorded register/unregister/update
 * calls, and a per-instance storagePath so the v2 path's store reads
 * see an empty directory. No configPath — the dynamic-schema sync is
 * accessor-guarded in the platform and skips.
 */
export class HapMockAPI extends EventEmitter {
  public readonly hap = { Service, Characteristic, uuid };
  public readonly platformAccessory = HapLifecyclePlatformAccessory as unknown as {
    new (displayName: string, uu: string): HapLifecyclePlatformAccessory;
  };

  public readonly user = {
    storagePath: (): string => nodePath.join(os.tmpdir(), `awn-haplc-${this.storageId}`),
  };
  private readonly storageId = `${process.pid}-${HapMockAPI.instanceCounter++}`;
  private static instanceCounter = 0;

  public readonly registered: HapLifecyclePlatformAccessory[] = [];
  public readonly unregistered: HapLifecyclePlatformAccessory[] = [];
  public readonly updated: HapLifecyclePlatformAccessory[] = [];

  registerPlatformAccessories(_plugin: string, _platform: string, accessories: HapLifecyclePlatformAccessory[]): void {
    this.registered.push(...accessories);
  }

  unregisterPlatformAccessories(_plugin: string, _platform: string, accessories: HapLifecyclePlatformAccessory[]): void {
    this.unregistered.push(...accessories);
  }

  updatePlatformAccessories(accessories: HapLifecyclePlatformAccessory[]): void {
    this.updated.push(...accessories);
  }
}

/**
 * One registered accessory, serialized for comparison: identity
 * (uniqueId), the platform-composed display name, and the COMPLETE
 * real-HAP graph (services, subtypes, linked/optional sets, every
 * characteristic's props and value — AccessoryInformation.Name
 * included, so naming equivalence is part of graph equivalence).
 */
export interface SerializedAccessory {
  uniqueId: string;
  displayName: string;
  graph: unknown;
}

/** Serialize a run's registered accessories, keyed and sorted by uniqueId. */
export function serializeRegistered(api: HapMockAPI): SerializedAccessory[] {
  return api.registered
    .map((a) => ({
      uniqueId: String((a.context.device as { uniqueId?: unknown } | undefined)?.uniqueId ?? a.UUID),
      displayName: a.displayName,
      graph: serializeHapGraph(a),
    }))
    .sort((x, y) => x.uniqueId.localeCompare(y.uniqueId));
}
