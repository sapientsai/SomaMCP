// Proof Key for Code Exchange (RFC 7636).
import { createHash, randomBytes } from "node:crypto"

import { sameSecret } from "./secrets.js"

export type PkceMethod = "S256" | "plain"

export const isPkceMethod = (method: string): method is PkceMethod => method === "S256" || method === "plain"

/** `BASE64URL(SHA256(verifier))`, RFC 7636 §4.2. */
export const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url")

/** A fresh 128-character verifier (the RFC's maximum) and its S256 challenge. */
export const createPkcePair = (): { challenge: string; verifier: string } => {
  const verifier = randomBytes(96).toString("base64url")
  return { challenge: s256(verifier), verifier }
}

/** Whether `verifier` answers `challenge`. Unknown methods and empty values never do. */
export const verifiesChallenge = (verifier: string, challenge: string, method: string): boolean => {
  if (verifier === "" || challenge === "") return false
  if (method === "S256") return sameSecret(s256(verifier), challenge)
  if (method === "plain") return sameSecret(verifier, challenge)
  return false
}
