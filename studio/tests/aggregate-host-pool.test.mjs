import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { AggregateWebHostPool } = await import('../extensions/studio-workstation/src/workflow-host-pool.ts');
function session(port = 8123) {
  const exits = new Set(); let finish; let closes = 0;
  return {
    ready: { url: `http://127.0.0.1:${port}/entries/agent/#session=secret`, project: { id: 'aggregate', entries: [{ entryId: 'agent' }, { entryId: 'worker' }] } },
    closed: new Promise(resolve => { finish = resolve; }),
    async close() { closes++; finish(); },
    crash() { finish(); for (const callback of exits) callback({ code: 1 }); },
    onExit(callback) { exits.add(callback); return { dispose: () => exits.delete(callback) }; },
    updateAuth() {}, updateUserSettings() {}, updateResourceProjects() {},
    get closes() { return closes; },
  };
}
test('entry tabs share one host, independent URLs and cancellation; last close releases the process', async () => {
  const pool = new AggregateWebHostPool(); const host = session(); let starts = 0;
  const start = async () => { starts++; return host; };
  const abort = new AbortController();
  const [a,b] = await Promise.all([pool.acquire('root', { entryId:'agent' }, start, abort.signal), pool.acquire('root', { entryId:'worker' }, start)]);
  assert.equal(starts,1); assert.equal(new URL(b.ready.url).pathname,'/entries/worker/'); assert.equal(new URL(b.ready.url).hash,'#session=secret');
  abort.abort(); await a.closed; assert.equal(host.closes,0);
  await b.close(); assert.equal(host.closes,1); await pool.close(); assert.equal(host.closes,1);
});
test('cancelled startup does not abort another pending entry lease', async () => {
  const pool = new AggregateWebHostPool(); const host = session(); let resolve; let hostSignal;
  const start = async (_,signal) => { hostSignal = signal; return new Promise(done => { resolve = done; }); };
  const abort = new AbortController();
  const a = pool.acquire('root',{entryId:'agent'},start,abort.signal);
  const rejected = assert.rejects(a); const b = pool.acquire('root',{entryId:'worker'},start);
  abort.abort(); await rejected; assert.equal(hostSignal.aborted,false);
  resolve(host); await (await b).close(); assert.equal(host.closes,1);
});
test('recovery is shared, preserves the port, and notifies every entry', async () => {
  const pool = new AggregateWebHostPool(); const first=session(); const next=session(); let starts=0;
  const start=async port=>{ starts++; if(starts===2) assert.equal(port,8123); return starts===1?first:next; };
  const a=await pool.acquire('root',{entryId:'agent'},start), b=await pool.acquire('root',{entryId:'worker'},start);
  let recovered=0; a.onReconnect(()=>recovered++); b.onReconnect(()=>recovered++);
  first.crash(); assert.deepEqual(await Promise.all([a.reconnect(),b.reconnect()]),[true,true]);
  assert.equal(starts,2); assert.equal(recovered,2); await a.close(); assert.equal(next.closes,0); await b.close(); assert.equal(next.closes,1);
});
test('failed and unknown entry leases are released and separate aggregates never share', async () => {
  const pool=new AggregateWebHostPool(); const a=session(),b=session();
  const lease=await pool.acquire('a',{entryId:'agent'},async()=>a);
  await assert.rejects(pool.acquire('a',{entryId:'unknown'},async()=>{throw Error('must reuse');}),/no longer registered/);
  const other=await pool.acquire('b',{entryId:'agent'},async()=>b);
  await lease.close(); assert.equal(a.closes,1); assert.equal(b.closes,0); await other.close(); await pool.close();
});

test('multiple tabs of the same entry hold independent leases on a single aggregate host', async () => {
  const pool = new AggregateWebHostPool(), host = session(); let starts = 0;
  const start = async () => { starts++; return host; };
  const [first, second] = await Promise.all([pool.acquire('root', { entryId: 'agent' }, start), pool.acquire('root', { entryId: 'agent' }, start)]);
  assert.equal(starts, 1);
  await first.close(); assert.equal(host.closes, 0);
  assert.equal(new URL(second.ready.url).pathname, '/entries/agent/');
  await second.close(); assert.equal(host.closes, 1); await pool.close();
});
