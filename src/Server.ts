import { Option, Ref } from "functype"
import type { Hono } from "hono"

import { registerArtifacts } from "./artifacts/ArtifactManager.js"
import { createDashboardArtifact } from "./artifacts/DashboardArtifact.js"
import { createHealthArtifact, createHealthDetailArtifact } from "./artifacts/HealthArtifact.js"
import { createInfoArtifact } from "./artifacts/InfoArtifact.js"
import type { ArtifactAuthenticate } from "./artifacts/types.js"
import type { Authenticate } from "./auth/index.js"
import { createAuthMiddleware } from "./auth/index.js"
import type { BackendSession } from "./backend/adapter.js"
import { createFastMCPBackend } from "./backend/fastmcp.js"
import { getRuntimeInfo, resolveBuildInfo } from "./buildInfo.js"
import { createGatewayManager } from "./gateway/GatewayManager.js"
import { createProxiedTools } from "./gateway/toolProxy.js"
import { createInfoTool } from "./introspection/infoTool.js"
import { createLogLayerTelemetry } from "./telemetry/LogLayerTelemetry.js"
import { NoopTelemetry } from "./telemetry/NoopTelemetry.js"
import type { TelemetryCollector } from "./telemetry/TelemetryCollector.js"
import { wrapPrompt, wrapResource, wrapTool } from "./telemetry/telemetryWrapper.js"
import type {
  ServerCapabilities,
  ServerHealth,
  ServerInfo,
  SomaServerInstance,
  SomaServerOptions,
  ToolOptions,
} from "./types.js"
import type { SchemaParams, SessionAuth, Tool } from "./types/core.js"
import type { RouteConfig } from "./types/routes.js"
import type { TransportConfig } from "./types/server.js"

export const createServer = <T extends SessionAuth = SessionAuth>(
  options: SomaServerOptions<T>,
): SomaServerInstance<T> => {
  const {
    artifacts,
    backendOptions,
    build: buildOverride,
    enableDashboard,
    enableHealthEndpoint,
    enableInfoEndpoint,
    enableIntrospection,
    gateways,
    healthDetailPath,
    healthPath,
    infoPath,
    introspectionPrefix,
    logLayer,
    telemetry: telemetryOption,
    ...serverConfig
  } = options

  const serverName = serverConfig.name
  const serverVersion = serverConfig.version
  const build = resolveBuildInfo(buildOverride)
  const runtime = getRuntimeInfo()
  const prefix = introspectionPrefix ?? ""

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

  const getInfo = (): ServerInfo => ({
    build,
    capabilities: {
      prompts: registeredPrompts.length,
      resources: registeredResources.length,
      tools: registeredTools.length,
    },
    name: serverName,
    runtime,
    version: serverVersion,
  })

  // Register introspection MCP tool (default: enabled). Only `info` — safe for agents.
  if (enableIntrospection !== false) {
    backend.addTool(createInfoTool<T>(() => getInfo(), `${prefix}info`))
  }

  // Register artifacts on the Hono app
  const allArtifacts = [...(artifacts ?? [])]
  if (enableHealthEndpoint !== false) {
    allArtifacts.push(createHealthArtifact(() => getHealth(), healthPath))
    allArtifacts.push(createHealthDetailArtifact(() => getHealth(), healthDetailPath))
  }
  if (enableInfoEndpoint !== false) {
    allArtifacts.push(createInfoArtifact(() => getInfo(), infoPath))
  }
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
    registerArtifacts(
      backend.getApp(),
      allArtifacts,
      Option(serverConfig.authenticate as ArtifactAuthenticate).orUndefined(),
    )
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

  const addRoute = (route: RouteConfig): void => {
    const app = backend.getApp()
    const methods = Array.isArray(route.method) ? [...route.method] : [route.method]
    if (route.protected) {
      const authenticate = Option(serverConfig.authenticate as Authenticate).orUndefined()
      app.use(route.path, createAuthMiddleware({ authenticate, onUnauthorized: route.onUnauthorized }))
    }
    app.on(methods, route.path, (c) => route.handler(c))
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

    addRoute,

    addTool,
    addTools: <P extends SchemaParams>(tools: Tool<T, P>[]): void => {
      tools.forEach((tool) => addTool(tool))
    },

    getApp: (): Hono => backend.getApp(),

    getCapabilities,

    getGatewayManager: () => gatewayManager,

    getHealth,

    getInfo,

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
