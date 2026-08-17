import { Option } from "functype"

export type BuildInfo = {
  branch?: string
  commit?: string
  date?: string
  environment?: string
}

export type RuntimeInfo = {
  arch: string
  nodeVersion: string
  platform: string
  /** Which runtime family reported the fields above. Absent on pre-1.2 builds. */
  runtime?: "edge" | "node"
}

/**
 * Edge runtimes (Workers without nodejs_compat, Deno Deploy) have no `process`
 * global at all. @types/node declares it as always-present, so reading it through
 * `globalThis` is what makes the absence expressible — a bare `typeof process`
 * guard is discarded as provably-true by the type checker.
 */
const nodeProcess = (): Option<Partial<NodeJS.Process>> =>
  Option((globalThis as { process?: Partial<NodeJS.Process> }).process)

const isNode = (): boolean => nodeProcess().flatMap((p) => Option(p.versions?.node)).isEmpty === false

const readEnv = (key: string): Option<string> =>
  nodeProcess()
    .flatMap((p) => Option(p.env?.[key]))
    .filter((v) => v.length > 0)

export const readBuildInfoFromEnv = (): BuildInfo => ({
  branch: readEnv("SOMAMCP_BUILD_BRANCH").orUndefined(),
  commit: readEnv("SOMAMCP_BUILD_COMMIT").orUndefined(),
  date: readEnv("SOMAMCP_BUILD_DATE").orUndefined(),
  environment: readEnv("SOMAMCP_ENVIRONMENT").orUndefined(),
})

export const resolveBuildInfo = (override?: BuildInfo): BuildInfo => {
  const fromEnv = readBuildInfoFromEnv()
  return {
    branch: override?.branch ?? fromEnv.branch,
    commit: override?.commit ?? fromEnv.commit,
    date: override?.date ?? fromEnv.date,
    environment: override?.environment ?? fromEnv.environment,
  }
}

const UNKNOWN = "unknown"

export const getRuntimeInfo = (): RuntimeInfo =>
  isNode()
    ? {
        arch: nodeProcess()
          .flatMap((p) => Option(p.arch))
          .orElse(UNKNOWN),
        nodeVersion: nodeProcess()
          .flatMap((p) => Option(p.version))
          .orElse(UNKNOWN),
        platform: nodeProcess()
          .flatMap((p) => Option(p.platform))
          .orElse(UNKNOWN),
        runtime: "node",
      }
    : {
        arch: UNKNOWN,
        nodeVersion: UNKNOWN,
        // Workers reports "Cloudflare-Workers" here; it is the only platform signal
        // available. Read through a cast for the same reason as `nodeProcess` above.
        platform: Option((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent).orElse(UNKNOWN),
        runtime: "edge",
      }
