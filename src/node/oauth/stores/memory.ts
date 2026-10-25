import type { Option } from "functype"
import { Map, Ref, Tuple } from "functype"

import { background, CLEANUP_INTERVAL_MS, expiresAtFor, type TokenStore } from "./types.js"

type Slot = { expiresAt: number; value: unknown }

/** A store in this process's memory. Everything in it is lost on restart. */
export const createMemoryStore = (cleanupIntervalMs = CLEANUP_INTERVAL_MS): TokenStore => {
  const slots = Ref(Map.empty<string, Slot>())
  const forget = (key: string): void => slots.set(slots.get().remove(key))
  const live = (key: string): Option<Slot> =>
    slots
      .get()
      .get(key)
      .filter((slot) => slot.expiresAt >= Date.now())

  const cleanup = (): Promise<void> => {
    const now = Date.now()
    slots.set(Map([...slots.get()].filter(([, slot]) => slot.expiresAt >= now)))
    return Promise.resolve()
  }
  const stop = background(cleanupIntervalMs, () => void cleanup())

  const get = (key: string): Promise<unknown> => {
    const slot = live(key)
    if (slot.isNone()) forget(key)
    return Promise.resolve(slot.map((s) => s.value).orUndefined())
  }

  return {
    cleanup,
    close: () => {
      stop()
      slots.set(Map.empty())
    },
    delete: (key) => {
      forget(key)
      return Promise.resolve()
    },
    get,
    save: (key, value, ttl) => {
      slots.set(slots.get().add(Tuple<[string, Slot]>([key, { expiresAt: expiresAtFor(ttl), value }])))
      return Promise.resolve()
    },
    // The read and the removal happen in one synchronous step, so no other caller can see the value in between.
    take: (key) => {
      const slot = live(key)
      forget(key)
      return Promise.resolve(slot.map((s) => s.value).orUndefined())
    },
  }
}
