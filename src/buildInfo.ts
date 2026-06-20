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
}

const readEnv = (key: string): Option<string> => Option(process.env[key]).filter((v) => v.length > 0)

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

export const getRuntimeInfo = (): RuntimeInfo => ({
  arch: process.arch,
  nodeVersion: process.version,
  platform: process.platform,
})
