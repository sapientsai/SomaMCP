import {
  FastMCP,
  type FastMCPSession,
  type FastMCPSessionAuth,
  type InputPrompt,
  type InputPromptArgument,
  type Resource,
  type ServerOptions,
  ServerState,
  type Tool,
  type ToolParameters,
} from "fastmcp"
import type { Hono } from "hono"

import { registerArtifacts } from "./artifacts/ArtifactManager.js"
import { createDashboardArtifact } from "./artifacts/DashboardArtifact.js"
import { createGatewayManager } from "./gateway/GatewayManager.js"
import { createProxiedTools } from "./gateway/toolProxy.js"
import { createCapabilitiesTool } from "./introspection/capabilitiesTool.js"
import { createConnectionsTool } from "./introspection/connectionsTool.js"
import { createHealthTool } from "./introspection/healthTool.js"
import { createLogLayerTelemetry } from "./telemetry/LogLayerTelemetry.js"
import { NoopTelemetry } from "./telemetry/NoopTelemetry.js"
import type { TelemetryCollector } from "./telemetry/TelemetryCollector.js"
import { wrapPrompt, wrapResource, wrapTool } from "./telemetry/telemetryWrapper.js"
import type { CellCapabilities, CellHealth, CellInstance, CellOptions } from "./types.js"

export const createCell = <T extends FastMCPSessionAuth = FastMCPSessionAuth>(
  options: CellOptions<T>,
): CellInstance<T> => {
  const {
    artifacts,
    enableDashboard,
    enableIntrospection,
    gateways,
    logLayer,
    telemetry: telemetryOption,
    ...serverOptions
  } = options

  const cellName = serverOptions.name
  const telemetry: TelemetryCollector =
    telemetryOption ?? (logLayer ? createLogLayerTelemetry(logLayer) : NoopTelemetry)
  const server = new FastMCP<T>(serverOptions as ServerOptions<T>)
  const gatewayManager = createGatewayManager(telemetry)

  const registeredTools: Array<{ description?: string; name: string }> = []
  const registeredResources: Array<{
    description?: string
    name: string
    uri: string
  }> = []
  const registeredPrompts: Array<{ description?: string; name: string }> = []
  // eslint-disable-next-line functional/no-let -- closure state for factory
  let startedAt = 0

  // Register gateways
  if (gateways) {
    for (const config of gateways) {
      gatewayManager.add(config)
    }
  }

  const getHealth = (): CellHealth => {
    const uptime = startedAt > 0 ? Date.now() - startedAt : 0
    return {
      activeSessions: server.sessions.length,
      name: cellName,
      startedAt,
      status:
        server.serverState === ServerState.Running
          ? "running"
          : server.serverState === ServerState.Error
            ? "error"
            : "stopped",
      gateways: {
        connected: gatewayManager.connectedCount,
        total: gatewayManager.totalCount,
      },
      uptime,
    }
  }

  const getCapabilities = (): CellCapabilities => ({
    prompts: registeredPrompts,
    resources: registeredResources,
    tools: registeredTools,
  })

  // Register introspection tools (default: enabled)
  if (enableIntrospection !== false) {
    server.addTool(createHealthTool<T>(() => getHealth()))
    server.addTool(createCapabilitiesTool<T>(() => getCapabilities()))
    server.addTool(createConnectionsTool<T>(() => gatewayManager.getInfoAll()))
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
    registerArtifacts(server.getApp(), allArtifacts)
  }

  // Wire session telemetry
  server.on("connect", ({ session }) => {
    telemetry.recordEvent({
      data: { sessionId: (session as FastMCPSession<T>).sessionId },
      name: cellName,
      timestamp: Date.now(),
      type: "session.connect",
    })
  })
  server.on("disconnect", ({ session }) => {
    telemetry.recordEvent({
      data: { sessionId: (session as FastMCPSession<T>).sessionId },
      name: cellName,
      timestamp: Date.now(),
      type: "session.disconnect",
    })
  })

  const addTool = <P extends ToolParameters>(tool: Tool<T, P>): void => {
    const wrapped = wrapTool(tool, telemetry)
    server.addTool(wrapped)
    registeredTools.push({
      description: tool.description,
      name: tool.name,
    })
  }

  const addResource = (resource: Resource<T>): void => {
    const wrapped = wrapResource(resource, telemetry)
    server.addResource(wrapped)
    registeredResources.push({
      description: resource.description,
      name: resource.name,
      uri: resource.uri,
    })
  }

  const addPrompt = <Args extends InputPromptArgument<T>[]>(prompt: InputPrompt<T, Args>): void => {
    const wrapped = wrapPrompt(prompt, telemetry)
    server.addPrompt(wrapped)
    registeredPrompts.push({
      description: prompt.description,
      name: prompt.name,
    })
  }

  return {
    get name() {
      return cellName
    },
    get serverState() {
      return server.serverState
    },
    get sessions() {
      return server.sessions
    },

    addPrompt,
    addPrompts: <Args extends InputPromptArgument<T>[]>(prompts: InputPrompt<T, Args>[]): void => {
      for (const prompt of prompts) {
        addPrompt(prompt)
      }
    },

    addResource,
    addResources: (resources: Resource<T>[]): void => {
      for (const resource of resources) {
        addResource(resource)
      }
    },

    addResourceTemplate: (...args: Parameters<FastMCP<T>["addResourceTemplate"]>): void => {
      server.addResourceTemplate(...args)
    },

    addTool,
    addTools: <P extends ToolParameters>(tools: Tool<T, P>[]): void => {
      for (const tool of tools) {
        addTool(tool)
      }
    },

    getApp: (): Hono => server.getApp(),

    getCapabilities,

    getGatewayManager: () => gatewayManager,

    getHealth,

    removePrompt: (name: string): void => {
      server.removePrompt(name)
    },

    removeResource: (name: string): void => {
      server.removeResource(name)
    },

    removeTool: (name: string): void => {
      server.removeTool(name)
    },

    async start(options?: Parameters<FastMCP<T>["start"]>[0]): Promise<void> {
      startedAt = Date.now()

      telemetry.recordEvent({
        name: cellName,
        timestamp: startedAt,
        type: "cell.start",
      })

      await server.start(options)

      // Connect gateways and proxy their tools
      await gatewayManager.connectAll()

      for (const gateway of gatewayManager.getAll()) {
        if (gateway.status === "connected" && gateway.config.proxyTools !== false) {
          const proxiedTools = createProxiedTools<T>(gateway)
          for (const tool of proxiedTools) {
            server.addTool(tool)
          }
        }
      }
    },

    async stop(): Promise<void> {
      await gatewayManager.disconnectAll()
      await server.stop()

      telemetry.recordEvent({
        name: cellName,
        timestamp: Date.now(),
        type: "cell.stop",
      })

      if (telemetry.flush) {
        await telemetry.flush()
      }
    },
  }
}
