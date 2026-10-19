import type { RuntimeApi } from "steamharness/runtime-api";

export const workflow = new Proxy({} as RuntimeApi, {
  get(_target, property) {
    return globalThis.workflow?.[property as keyof RuntimeApi];
  },
});
