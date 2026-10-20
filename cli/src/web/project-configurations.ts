import { createLocalProjectConfigurationStore } from 'steamharness';
import type { ProjectConfigurationAction, ProjectConfigurationState } from '@steamharness/project-configuration';

/** One service for every local surface. Its directory is independent of Web/Studio history. */
export class ProjectConfigurations {
  private store!: Awaited<ReturnType<typeof createLocalProjectConfigurationStore>>;
  state!: ProjectConfigurationState;
  private poll?: ReturnType<typeof setInterval>;
  private reading = false;
  error?: string;
  constructor(private readonly projectDir: string, private readonly changed: () => void) {}
  async initialize() {
    this.store = await createLocalProjectConfigurationStore(this.projectDir);
    this.state = await this.store.read();
    this.poll = setInterval(() => {
      if (this.reading) return;
      this.reading = true;
      void this.refresh().catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.error !== message) { this.error = message; this.changed(); }
      }).finally(() => { this.reading = false; });
    }, 750);
    this.poll.unref();
  }
  async refresh() {
    try {
      const next = await this.store.read();
      const changed = !!this.error || JSON.stringify(next) !== JSON.stringify(this.state);
      this.error = undefined; this.state = next; if (changed) this.changed();
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.error !== message) { this.error = message; this.changed(); }
      throw error;
    }
  }
  async dispatch(call: ProjectConfigurationAction) {
    const result = await this.store.dispatch(call);
    if (call.action !== 'export') {
      const next = result as ProjectConfigurationState;
      const changed = !!this.error || JSON.stringify(next) !== JSON.stringify(this.state);
      this.error = undefined; this.state = next; if (changed) this.changed();
    }
    return result;
  }
  close() { clearInterval(this.poll); }
}
