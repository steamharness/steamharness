import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveResourceAccess } from '@steamharness/project-access';
import { AGENT_MODELS_CONFIGURATION_KEY as key, configurationSnapshot, type ProjectConfigurationState } from '@steamharness/project-configuration';
import { Storage } from '../storage';
const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const projectId = '00000000-0000-4000-8000-000000000095';
test('Server discovers Agent model fields without executing source, isolates accounts and excludes published keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'server-configured-agent-'));
  try {
    const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot: root });
    await storage.createProjectFromFiles({ projectName: projectId, files: [
      { path: 'package.json', content: JSON.stringify({ id: projectId, name: 'Agent config', version: '1.0.0', devDependencies: { steamharness: pkg.dependencies.steamharness }, steamHarness: { projectType: 'workflow', projectInfo: { localizedNames: {}, declarations: [], platformSupport: { mode: 'agnostic' }, dataStorage: { mode: 'server' }, relatedProjects: [] } } }) },
      { path: 'index.ts', content: 'throw new Error("must not execute"); const node = steamharness.createAgentNode();' },
      { path: 'configuration.json', content: JSON.stringify({ version: 2, fields: [{ name: 'title', type: 'string' }] }) },
    ] });
    storage.getProjectAccessSummary = async (_id, actorId) => ({ projectId, projectName: 'Agent config', visibility: 'private', access: resolveResourceAccess([{ type: 'project', id: projectId, role: actorId === 'author' ? 'owner' : 'developer' }]) });
    const options = { projectName: projectId, actorId: 'author' };
    let state = await storage.projectConfigurations(options, { action: 'get' }) as ProjectConfigurationState;
    assert.equal(state.fields[0]?.control, 'ai-models'); assert.equal(state.fields[0]?.name, key);
    const model = { id: 'custom', name: 'Custom', source: 'third-party', model: 'real-model', apiKind: 'openai-responses', baseUrl: 'https://models.example/v1', apiKey: 'author-only-test-key' };
    state = await storage.projectConfigurations(options, { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { [key]: [model], title: 'Saved' } }) as ProjectConfigurationState;
    await assert.rejects(storage.projectConfigurations(options, { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { title: 'Must not save', [key]: [{ ...model, apiKey: '' }] } }), /apiKey/);
    const unchanged = await storage.projectConfigurations(options, { action: 'get' }) as ProjectConfigurationState;
    assert.equal(unchanged.revision, state.revision); assert.equal(configurationSnapshot(unchanged).values.title, 'Saved');
    const other = await storage.projectConfigurations({ ...options, actorId: 'other' }, { action: 'get' }) as ProjectConfigurationState;
    assert.ok(!JSON.stringify(other).includes(model.apiKey));
    state = await storage.projectConfigurations(options, { action: 'publication.save', revision: state.revision, publication: { ...unchanged.publication!, configurations: unchanged.publication!.configurations.map(profile => ({ ...profile, values: unchanged.configurations.find(item => item.id === profile.id)!.values })) } }) as ProjectConfigurationState;
    await storage.publish({ projectName: projectId, createdByUserId: 'author', expectedConfigurationRevision: state.publication!.revision, expectedSourceHash: state.sourceHash });
    const recipient = await storage.projectConfigurations({ ...options, actorId: 'other', target: '1.0.0' }, { action: 'get' }) as ProjectConfigurationState;
    assert.equal(recipient.fields[0]?.control, 'ai-models'); assert.ok(!JSON.stringify(recipient).includes(model.apiKey));
  } finally { await rm(root, { recursive: true, force: true }); }
});
