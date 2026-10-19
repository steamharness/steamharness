import type { RuntimeApi } from "steamharness/runtime-api";

export const steamharness = new Proxy({} as RuntimeApi, {
  get(_target, property) {
    return globalThis.steamharness?.[property as keyof RuntimeApi];
  },
});
