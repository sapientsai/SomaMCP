import type { GatewayInfo } from "../gateway/types.js"
import type { ServerCapabilities, ServerHealth } from "../types.js"
import type { ArtifactConfig } from "./types.js"

export const createDashboardArtifact = (
  getHealth: () => ServerHealth,
  getCapabilities: () => ServerCapabilities,
  getConnections: () => ReadonlyArray<GatewayInfo>,
): ArtifactConfig => ({
  handler: () => {
    const health = getHealth()
    const capabilities = getCapabilities()
    const connections = getConnections()
    const html = renderDashboard(health, capabilities, connections)
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  },
  path: "/dashboard",
  protected: true,
  type: "dynamic",
})

const renderDashboard = (
  health: ServerHealth,
  capabilities: ServerCapabilities,
  connections: ReadonlyArray<GatewayInfo>,
): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${health.name} - SomaMCP Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1.5rem; color: #fff; }
    h2 { font-size: 1.1rem; margin-bottom: 0.75rem; color: #a0a0a0; text-transform: uppercase; letter-spacing: 0.05em; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.25rem; }
    .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.85rem; font-weight: 600; }
    .status.running { background: #0a3d0a; color: #4ade80; }
    .status.stopped { background: #3d0a0a; color: #f87171; }
    .status.error { background: #3d2a0a; color: #fbbf24; }
    .status.connected { background: #0a3d0a; color: #4ade80; }
    .status.disconnected { background: #3d0a0a; color: #f87171; }
    .metric { margin: 0.5rem 0; }
    .metric-label { color: #888; font-size: 0.85rem; }
    .metric-value { color: #fff; font-weight: 500; }
    ul { list-style: none; }
    li { padding: 0.35rem 0; border-bottom: 1px solid #222; font-size: 0.9rem; }
    li:last-child { border-bottom: none; }
    .desc { color: #888; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>${health.name}</h1>
  <div class="grid">
    <div class="card">
      <h2>Health</h2>
      <div class="metric"><span class="metric-label">Status:</span> <span class="status ${health.status}">${health.status}</span></div>
      <div class="metric"><span class="metric-label">Uptime:</span> <span class="metric-value">${formatUptime(health.uptime)}</span></div>
      <div class="metric"><span class="metric-label">Sessions:</span> <span class="metric-value">${health.activeSessions}</span></div>
      <div class="metric"><span class="metric-label">Gateways:</span> <span class="metric-value">${health.gateways.connected}/${health.gateways.total}</span></div>
    </div>
    <div class="card">
      <h2>Tools (${capabilities.tools.length})</h2>
      <ul>${capabilities.tools.map((t) => `<li><strong>${t.name}</strong>${t.description ? ` <span class="desc">${t.description}</span>` : ""}</li>`).join("")}</ul>
    </div>
    <div class="card">
      <h2>Resources (${capabilities.resources.length})</h2>
      <ul>${capabilities.resources.map((r) => `<li><strong>${r.name}</strong> <span class="desc">${r.uri}</span></li>`).join("")}</ul>
    </div>
    <div class="card">
      <h2>Prompts (${capabilities.prompts.length})</h2>
      <ul>${capabilities.prompts.map((p) => `<li><strong>${p.name}</strong>${p.description ? ` <span class="desc">${p.description}</span>` : ""}</li>`).join("")}</ul>
    </div>
    ${
      connections.length > 0
        ? `<div class="card">
      <h2>Gateways (${connections.length})</h2>
      <ul>${connections.map((s) => `<li><strong>${s.name}</strong> <span class="status ${s.status}">${s.status}</span> <span class="desc">${s.url}</span></li>`).join("")}</ul>
    </div>`
        : ""
    }
  </div>
</body>
</html>`

const formatUptime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${String(days)}d ${String(hours % 24)}h`
  if (hours > 0) return `${String(hours)}h ${String(minutes % 60)}m`
  if (minutes > 0) return `${String(minutes)}m ${String(seconds % 60)}s`
  return `${String(seconds)}s`
}
