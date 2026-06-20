import type { Option } from "functype"
import { Map as FMap, Ref, Tuple } from "functype"

import type { TelemetryCollector } from "@/telemetry"

import { createGateway } from "./Gateway.js"
import type { GatewayConfig, GatewayInfo, GatewayInstance, GatewayManagerInstance } from "./types.js"

export const createGatewayManager = (telemetry: TelemetryCollector): GatewayManagerInstance => {
  const gateways = Ref(FMap.empty<string, GatewayInstance>())
  const values = (): GatewayInstance[] => [...gateways.get()].map(([, g]) => g)

  return {
    get connectedCount() {
      return values().filter((s) => s.status === "connected").length
    },
    get totalCount() {
      return gateways.get().size
    },

    add(config: GatewayConfig): GatewayInstance {
      const gateway = createGateway(config, telemetry)
      gateways.set(gateways.get().add(Tuple<[string, GatewayInstance]>([config.id, gateway])))
      return gateway
    },

    async connectAll(): Promise<void> {
      await Promise.allSettled(values().map((s) => s.connect()))
    },

    async disconnectAll(): Promise<void> {
      await Promise.allSettled(values().map((s) => s.disconnect()))
    },

    get(id: string): Option<GatewayInstance> {
      return gateways.get().get(id)
    },

    getAll(): ReadonlyArray<GatewayInstance> {
      return values()
    },

    getInfoAll(): ReadonlyArray<GatewayInfo> {
      return values().map((s) => s.info)
    },
  }
}
