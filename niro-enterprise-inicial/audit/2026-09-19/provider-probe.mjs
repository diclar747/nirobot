// Offline: no connection, credentials or real calls. Argument: installed index.mjs path.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { ActiveCall, CallState } = await import(pathToFileURL(process.argv[2]).href);
const engine = { endCall() {} };
const wait = (call) => Promise.race([
  call.waitForEnd(), new Promise(resolve => setTimeout(() => resolve('UNRESOLVED'), 100))
]);
const results = [];
for (const [name, run] of [
  ['remote terminal state resolves', async () => {
    const call = new ActiveCall('offline-remote', engine, 0);
    call._updateState(CallState.Active);
    call._updateState(CallState.Ending);
    assert.equal(await wait(call), 'ended');
  }],
  ['local hangup resolves', async () => {
    const call = new ActiveCall('offline-local', engine, 0);
    call.end();
    call._updateState(CallState.Ending);
    call._forceEnd('hangup');
    assert.notEqual(await wait(call), 'UNRESOLVED');
  }],
  ['duration timeout resolves', async () => {
    const call = new ActiveCall('offline-timeout', engine, 10);
    assert.notEqual(await wait(call), 'UNRESOLVED');
  }]
]) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.some(result => !result.passed) ? 1 : 0;
