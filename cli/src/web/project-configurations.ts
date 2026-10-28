import { createLocalProjectConfigurationStore } from 'steamharness';
import {configurationPublication} from '../configuration-publication';
import type {WebConnection} from './runtime';
import {configurationAccessView,ProjectConfigurationError,type ProjectConfigurationAction, type ProjectConfigurationState} from '@steamharness/project-configuration';

// Defaults and persisted profiles may enumerate object keys in a different order.
// Only content changes may invalidate an in-flight request or durable owner.
function signature(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}

/** One service for every local surface. Its directory is independent of Web/Studio history. */
export class ProjectConfigurations {
  private store!: Awaited<ReturnType<typeof createLocalProjectConfigurationStore>>;
  private value!: ProjectConfigurationState;
  private publicationIdentity = '';
  private accessIdentity = '';
  private connectionIdentity() { const connection=this.connection();return connection?JSON.stringify([connection.serverUrl,connection.accessToken]):''; }
  get state(): ProjectConfigurationState {
    const value=this.connectionIdentity()===this.accessIdentity?this.value:configurationAccessView(this.value);
    return this.connectionIdentity()===this.publicationIdentity?value:{...value,publication:undefined,publicationPreview:undefined,canManagePublication:false};
  }
  get signature(): string { return signature(this.state); }
  private poll?: ReturnType<typeof setInterval>;
  private reading = false;
  error?: string;
  constructor(private readonly projectDir: string, private readonly changed: () => void, private readonly connection: () => WebConnection | undefined = () => undefined, private readonly entryId?: string) {}
  async initialize() {
    this.store = await createLocalProjectConfigurationStore(this.projectDir,{entryId: this.entryId, connection:()=>this.connection()??null});
    this.value = {...await this.store.read(true),canManagePublication:false};
    this.accessIdentity=this.connectionIdentity();
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
      const keepPublication=!local.profilePolicy||local.capabilities?.online&&['maintainer','owner'].includes(local.capabilities.role);
      const next = {...local,...(keepPublication?{publication:this.state?.publication,canManagePublication:this.state?.canManagePublication}:{canManagePublication:false})};
      const changed = !!this.error || signature(next) !== this.signature;
      this.error = undefined; this.value = next;this.accessIdentity=this.connectionIdentity(); if (changed) this.changed();
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
      ? await configurationPublication(this.projectDir,await this.store.read(),call,connection,this.entryId)
      : await this.store.dispatch(call);
    if(identity!==this.connectionIdentity())throw new ProjectConfigurationError('Account changed. Refresh configurations.','CONFIGURATION_ACCOUNT_CHANGED');
    if (call.action !== 'export') {
      const local=result as ProjectConfigurationState;
      const keepPublication=!local.profilePolicy||local.capabilities?.online&&['maintainer','owner'].includes(local.capabilities.role);
      const next = remote?local:{...local,...(keepPublication?{publication:previous.publication,canManagePublication:previous.canManagePublication}:{canManagePublication:false})};
      const changed = !!this.error || signature(next) !== this.signature;
      this.error = undefined; this.value = next;this.accessIdentity=identity;this.publicationIdentity=identity; if (changed) this.changed();
      return next;
    }
    return result;
  }
  async selection() {
    if(!this.state.profilePolicy)return undefined;
    const snapshot=await this.store.snapshot({required:false});
    return {id:snapshot.id,profileKey:snapshot.profileKey!,subject:snapshot.accessSubject!};
  }
  close() { clearInterval(this.poll); }
}
