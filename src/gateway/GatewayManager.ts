import { Option } from "functype"

import type { TelemetryCollector } from "@/telemetry"

import { createGateway } from "./Gateway.js"
import type { GatewayConfig, GatewayInfo, GatewayInstance, GatewayManagerInstance } from "./types.js"

export const createGatewayManager = (telemetry: TelemetryCollector): GatewayManagerInstance => {
  const gateways = new Map<string, GatewayInstance>()

  return {
    get connectedCount() {
      return [...gateways.values()].filter((s) => s.status === "connected").length
    },
    get totalCount() {
      return gateways.size
    },

    add(config: GatewayConfig): GatewayInstance {
      const gateway = createGateway(config, telemetry)
      gateways.set(config.id, gateway)
      return gateway
    },

    async connectAll(): Promise<void> {
      await Promise.allSettled([...gateways.values()].map((s) => s.connect()))
    },

    async disconnectAll(): Promise<void> {
      await Promise.allSettled([...gateways.values()].map((s) => s.disconnect()))
    },

    get(id: string): Option<GatewayInstance> {
      return Option(gateways.get(id))
    },

    getAll(): ReadonlyArray<GatewayInstance> {
      return [...gateways.values()]
    },

    getInfoAll(): ReadonlyArray<GatewayInfo> {
      return [...gateways.values()].map((s) => s.info)
    },
  }
}
