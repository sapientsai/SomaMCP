import { Ref } from "functype"
import type { Hono } from "hono"

import { registerArtifacts } from "./artifacts/ArtifactManager.js"
import { createDashboardArtifact } from "./artifacts/DashboardArtifact.js"
import type { BackendSession } from "./backend/adapter.js"
import { createFastMCPBackend } from "./backend/fastmcp.js"
import { createGatewayManager } from "./gateway/GatewayManager.js"
import { createProxiedTools } from "./gateway/toolProxy.js"
import { createCapabilitiesTool } from "./introspection/capabilitiesTool.js"
import { createConnectionsTool } from "./introspection/connectionsTool.js"
import { createHealthTool } from "./introspection/healthTool.js"
import { createLogLayerTelemetry } from "./telemetry/LogLayerTelemetry.js"
import { NoopTelemetry } from "./telemetry/NoopTelemetry.js"
import type { TelemetryCollector } from "./telemetry/TelemetryCollector.js"
import { wrapPrompt, wrapResource, wrapTool } from "./telemetry/telemetryWrapper.js"
import type { ServerCapabilities, ServerHealth, SomaServerInstance, SomaServerOptions, ToolOptions } from "./types.js"
import type { SchemaParams, SessionAuth, Tool } from "./types/core.js"
import type { TransportConfig } from "./types/server.js"

export const createServer = <T extends SessionAuth = SessionAuth>(
  options: SomaServerOptions<T>,
): SomaServerInstance<T> => {
  const {
    artifacts,
    backendOptions,
    enableDashboard,
    enableIntrospection,
    gateways,
    logLayer,
    telemetry: telemetryOption,
    ...serverConfig
  } = options

  const serverName = serverConfig.name
  const telemetry: TelemetryCollector =
    telemetryOption ?? (logLayer ? createLogLayerTelemetry(logLayer) : NoopTelemetry)
  const backend = createFastMCPBackend<T>(serverConfig, backendOptions)
  const gatewayManager = createGatewayManager(telemetry)

  const registeredTools: Array<{ description?: string; name: string }> = []
  const registeredResources: Array<{
    description?: string
    name: string
    uri: string
  }> = []
  const registeredPrompts: Array<{ description?: string; name: string }> = []

  const startedAt = Ref(0)

  // Register gateways
  gateways?.forEach((config) => gatewayManager.add(config))

  const getHealth = (): ServerHealth => {
    const started = startedAt.get()
    const uptime = started > 0 ? Date.now() - started : 0
    return {
      activeSessions: backend.sessions.length,
      gateways: {
        connected: gatewayManager.connectedCount,
        total: gatewayManager.totalCount,
      },
      name: serverName,
      startedAt: started,
      status: backend.serverState,
      uptime,
    }
  }

  const getCapabilities = (): ServerCapabilities => ({
    prompts: registeredPrompts,
    resources: registeredResources,
    tools: registeredTools,
  })

  // Register introspection tools (default: enabled)
  if (enableIntrospection !== false) {
    backend.addTool(createHealthTool<T>(() => getHealth()))
    backend.addTool(createCapabilitiesTool<T>(() => getCapabilities()))
    backend.addTool(createConnectionsTool<T>(() => gatewayManager.getInfoAll()))
  }

  // Register artifacts on the Hono app
  const allArtifacts = [...(artifacts ?? [])]
  if (enableDashboard !== false) {
    allArtifacts.push(
      createDashboardArtifact(
        () => getHealth(),
        () => getCapabilities(),
        () => gatewayManager.getInfoAll(),
      ),
    )
  }
  if (allArtifacts.length > 0) {
    registerArtifacts(backend.getApp(), allArtifacts)
  }

  // Wire session telemetry
  backend.on("connect", ({ session }) => {
    telemetry.recordEvent({
      data: { sessionId: (session as BackendSession<T>).sessionId },
      name: serverName,
      timestamp: Date.now(),
      type: "session.connect",
    })
  })
  backend.on("disconnect", ({ session }) => {
    telemetry.recordEvent({
      data: { sessionId: (session as BackendSession<T>).sessionId },
      name: serverName,
      timestamp: Date.now(),
      type: "session.disconnect",
    })
  })

  const addTool = <P extends SchemaParams>(tool: Tool<T, P> | ToolOptions<T, P>): void => {
    const captureConfig = "captureConfig" in tool ? tool.captureConfig : undefined
    const wrapped = wrapTool(tool, telemetry, captureConfig)
    backend.addTool(wrapped)
    registeredTools.push({
      description: tool.description,
      name: tool.name,
    })
  }

  const addResource = (resource: Parameters<SomaServerInstance<T>["addResource"]>[0]): void => {
    const wrapped = wrapResource(resource, telemetry)
    backend.addResource(wrapped)
    registeredResources.push({
      description: resource.description,
      name: resource.name,
      uri: resource.uri,
    })
  }

  const addPrompt = (prompt: Parameters<SomaServerInstance<T>["addPrompt"]>[0]): void => {
    const wrapped = wrapPrompt(prompt, telemetry)
    backend.addPrompt(wrapped)
    registeredPrompts.push({
      description: prompt.description,
      name: prompt.name,
    })
  }

  return {
    get name() {
      return serverName
    },
    get serverState() {
      return backend.serverState
    },
    get sessions() {
      return backend.sessions
    },

    addPrompt,
    addPrompts: (prompts: Parameters<SomaServerInstance<T>["addPrompts"]>[0]): void => {
      prompts.forEach(addPrompt)
    },

    addResource,
    addResources: (resources: Parameters<SomaServerInstance<T>["addResources"]>[0]): void => {
      resources.forEach(addResource)
    },

    addResourceTemplate: (...args: ReadonlyArray<unknown>): void => {
      backend.addResourceTemplate(...args)
    },

    addTool,
    addTools: <P extends SchemaParams>(tools: Tool<T, P>[]): void => {
      tools.forEach((tool) => addTool(tool))
    },

    getApp: (): Hono => backend.getApp(),

    getCapabilities,

    getGatewayManager: () => gatewayManager,

    getHealth,

    removePrompt: (name: string): void => {
      backend.removePrompt(name)
    },

    removeResource: (name: string): void => {
      backend.removeResource(name)
    },

    removeTool: (name: string): void => {
      backend.removeTool(name)
    },

    async start(transport?: TransportConfig): Promise<void> {
      startedAt.set(Date.now())

      telemetry.recordEvent({
        name: serverName,
        timestamp: startedAt.get(),
        type: "server.start",
      })

      await backend.start(transport)

      // Connect gateways and proxy their tools
      await gatewayManager.connectAll()

      gatewayManager
        .getAll()
        .filter((gateway) => gateway.status === "connected" && gateway.config.proxyTools !== false)
        .forEach((gateway) => {
          createProxiedTools<T>(gateway, telemetry).forEach((tool) => backend.addTool(tool))
        })
    },

    async stop(): Promise<void> {
      await gatewayManager.disconnectAll()
      await backend.stop()

      telemetry.recordEvent({
        name: serverName,
        timestamp: Date.now(),
        type: "server.stop",
      })

      if (telemetry.flush) {
        await telemetry.flush()
      }
    },
  }
}
