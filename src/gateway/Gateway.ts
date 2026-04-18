import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import { Option, Ref, Try } from "functype"

import type { TelemetryCollector } from "../telemetry/TelemetryCollector.js"
import type { GatewayConfig, GatewayInstance, GatewayStatus } from "./types.js"

// eslint-disable-next-line functype/prefer-either -- factory returns GatewayInstance by design; callTool's throw is required by the Promise<unknown> contract
export const createGateway = (config: GatewayConfig, telemetry: TelemetryCollector): GatewayInstance => {
  const client = Ref<Option<Client>>(Option.none())
  const transport = Ref<Option<StreamableHTTPClientTransport>>(Option.none())
  const remoteTools = Ref<MCPTool[]>([])
  const currentStatus = Ref<GatewayStatus>("disconnected")
  const reconnectTimer = Ref<Option<ReturnType<typeof setTimeout>>>(Option.none())

  const gatewayName = config.name ?? config.id

  const scheduleReconnect = (): void => {
    const interval = config.reconnectIntervalMs ?? 5000
    reconnectTimer.set(
      Option(
        setTimeout(() => {
          void instance.connect()
        }, interval),
      ),
    )
  }

  const instance: GatewayInstance = {
    get config() {
      return config
    },
    get info() {
      return {
        id: config.id,
        name: gatewayName,
        remoteTools: remoteTools.get().map((t) => ({
          description: t.description,
          name: t.name,
        })),
        status: currentStatus.get(),
        url: config.url,
      }
    },
    get name() {
      return gatewayName
    },
    get status() {
      return currentStatus.get()
    },
    get tools() {
      return remoteTools.get() as ReadonlyArray<MCPTool>
    },

    async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      const c = client.get()
      if (c.isEmpty || currentStatus.get() !== "connected") {
        // eslint-disable-next-line functype/prefer-either -- method returns Promise<unknown>; rejection is the protocol signal
        throw new Error(`Gateway ${config.id} is not connected`)
      }
      return c.orThrow(new Error(`Gateway ${config.id} is not connected`)).callTool({ arguments: args, name })
    },

    async connect(): Promise<void> {
      if (currentStatus.get() === "connected") return

      currentStatus.set("connecting")
      const start = Date.now()

      // eslint-disable-next-line functype/prefer-do-notation -- Do notation doesn't fit here: Option(...) calls are Ref-cell writes (side effects), not monadic binds; Try wraps a single async effect
      const attempt = await Try.fromPromise(
        (async () => {
          const t = new StreamableHTTPClientTransport(new URL(config.url))
          transport.set(Option(t))

          const c = new Client({
            name: `soma-gateway-${config.id}`,
            version: "1.0.0",
          })
          client.set(Option(c))

          await c.connect(t)

          const toolsResult = await c.listTools()
          remoteTools.set(toolsResult.tools)
        })(),
      )

      attempt.fold(
        (error) => {
          currentStatus.set("error")
          telemetry.recordEvent({
            data: { id: config.id, url: config.url },
            error: error instanceof Error ? error.message : String(error),
            name: gatewayName,
            timestamp: start,
            type: "gateway.error",
          })
          if (config.reconnect !== false) {
            scheduleReconnect()
          }
        },
        () => {
          currentStatus.set("connected")
          telemetry.recordEvent({
            data: {
              id: config.id,
              remoteToolCount: remoteTools.get().length,
              url: config.url,
            },
            durationMs: Date.now() - start,
            name: gatewayName,
            timestamp: start,
            type: "gateway.connect",
          })
        },
      )
    },

    async disconnect(): Promise<void> {
      reconnectTimer.get().match({
        None: () => undefined,
        Some: (timer) => clearTimeout(timer),
      })
      reconnectTimer.set(Option.none())

      const currentClient = client.get()
      if (currentClient.isSome()) {
        // Try swallows close errors — disconnect is best-effort
        await Try.fromPromise(currentClient.value.close())
      }

      client.set(Option.none())
      transport.set(Option.none())
      remoteTools.set([])
      currentStatus.set("disconnected")

      telemetry.recordEvent({
        data: { id: config.id },
        name: gatewayName,
        timestamp: Date.now(),
        type: "gateway.disconnect",
      })
    },
  }

  return instance
}
