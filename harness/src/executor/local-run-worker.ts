import { runLocalProjectWithReport, type RunLocalProjectOptions } from './index';
import { withPlatformConnections, type PlatformConnections } from '../platform-connections';
import { withUserSettings, type UserSettings } from '../user-settings';

const abort = new AbortController();
let started = false;
process.on('disconnect', () => { abort.abort(); setTimeout(() => process.exit(1), 3000).unref(); });
process.on('message', async (message: { cancel?: boolean; options?: RunLocalProjectOptions; platform?: PlatformConnections; settings?: UserSettings }) => {
  if (message.cancel) { abort.abort(); return; }
  if (started || !message.options) return;
  started = true;
  const run = () => runLocalProjectWithReport({ ...message.options, abortSignal: abort.signal });
  const reply = await withPlatformConnections(message.platform ?? {}, () => message.settings ? withUserSettings(message.settings, run) : run())
    .then(report => ({ report }), error => ({ error: error instanceof Error ? error.message : String(error) }));
  if (process.connected) process.send!(reply, () => process.disconnect?.());
});
