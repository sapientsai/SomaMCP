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

const readEnv = (key: string): string | undefined => {
  const value = process.env[key]
  return value && value.length > 0 ? value : undefined
}

export const readBuildInfoFromEnv = (): BuildInfo => ({
  branch: readEnv("SOMAMCP_BUILD_BRANCH"),
  commit: readEnv("SOMAMCP_BUILD_COMMIT"),
  date: readEnv("SOMAMCP_BUILD_DATE"),
  environment: readEnv("SOMAMCP_ENVIRONMENT"),
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
