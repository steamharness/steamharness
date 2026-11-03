import type { Storage } from "@earendil-works/pi-durable";

export interface AgentStorageFactory {
  /** Non-secret backend name shown in diagnostics. */
  label: string;
  /** Acquire an exclusive owner; release after the Harness has closed storage. */
  open(): Promise<{ storage: Storage; failure?: AbortSignal; release?(): void | Promise<void> }>;
}
