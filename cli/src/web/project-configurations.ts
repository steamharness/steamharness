import { createLocalProjectConfigurationStore } from 'steamharness';
import {configurationPublication} from '../configuration-publication';
import type {WebConnection} from './runtime';
import {ProjectConfigurationError,type ProjectConfigurationAction, type ProjectConfigurationState} from '@steamharness/project-configuration';

/** One service for every local surface. Its directory is independent of Web/Studio history. */
export class ProjectConfigurations {
  private store!: Awaited<ReturnType<typeof createLocalProjectConfigurationStore>>;
  private value!: ProjectConfigurationState;
  private publicationIdentity = '';
  private connectionIdentity() { const connection=this.connection();return connection?JSON.stringify([connection.serverUrl,connection.accessToken]):''; }
  get state(): ProjectConfigurationState {
    return this.connectionIdentity()===this.publicationIdentity?this.value:{...this.value,publication:undefined,publicationPreview:undefined,canManagePublication:false};
  }
  private poll?: ReturnType<typeof setInterval>;
  private reading = false;
  error?: string;
  constructor(private readonly projectDir: string, private readonly changed: () => void, private readonly connection: () => WebConnection | undefined = () => undefined) {}
  async initialize() {
    this.store = await createLocalProjectConfigurationStore(this.projectDir);
    this.value = {...await this.store.read(),canManagePublication:false};
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
      const local = await this.store.read();
      const next = {...local,publication:this.state?.publication,canManagePublication:this.state?.canManagePublication};
      const changed = !!this.error || JSON.stringify(next) !== JSON.stringify(this.state);
      this.error = undefined; this.value = next; if (changed) this.changed();
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.error !== message) { this.error = message; this.changed(); }
      throw error;
    }
  }
  async dispatch(call: ProjectConfigurationAction) {
    const identity=this.connectionIdentity(),connection=this.connection(),previous=this.state,remote=call.action.startsWith('publication.') || call.action === 'get';
    const result = remote
      ? await configurationPublication(this.projectDir,await this.store.read(),call,connection)
      : await this.store.dispatch(call);
    if(identity!==this.connectionIdentity())throw new ProjectConfigurationError('Account changed. Refresh configurations.','CONFIGURATION_ACCOUNT_CHANGED');
    if (call.action !== 'export') {
      const next = remote?result as ProjectConfigurationState:{...result as ProjectConfigurationState,publication:previous.publication,canManagePublication:previous.canManagePublication};
      const changed = !!this.error || JSON.stringify(next) !== JSON.stringify(this.state);
      this.error = undefined; this.value = next;this.publicationIdentity=identity; if (changed) this.changed();
      return next;
    }
    return result;
  }
  close() { clearInterval(this.poll); }
}
