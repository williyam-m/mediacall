import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startupConfig } from '../../../../src/server/config/startup.ts';

test('local startup defaults to custom-turn and automatic ICE, and flags override environment values', async () => {
  const defaults = (await startupConfig([], {}))!;
  assert.equal(defaults.provider, 'custom-turn');
  assert.equal(defaults.defaultMode, 'auto');
  assert.equal(defaults.turn.bindAddress, '127.0.0.1');
  const configured = (await startupConfig(['--turn', 'custom-turn', '--port', '5190', '--ice', 'relay', '--turn-public-ip', '192.168.1.3', '--turn-port', '3500', '--relay-min-port', '50000', '--relay-max-port', '50010'], { PORT: '9999', TURN_PROVIDER: 'metered' }))!;
  assert.equal(configured.port, 5190);
  assert.equal(configured.defaultMode, 'relay');
  assert.equal(configured.turn.publicAddress, '192.168.1.3');
  assert.equal(configured.turn.bindAddress, '0.0.0.0');
  assert.equal(configured.turn.port, 3500);
  assert.equal(configured.turn.relayMinPort, 50000);
  assert.equal(configured.turn.relayMaxPort, 50010);
});

test('Metered startup validates server-side credentials without requiring a custom public relay IP', async () => {
  await assert.rejects(startupConfig(['--turn', 'metered'], {}), /Metered mode requires/);
  const configured = (await startupConfig(['--turn', 'metered', '--production'], { METERED_REALTIME_KEY_ID: 'sk_id_test_fixture', METERED_REALTIME_SECRET: 'sk_secret_test_fixture' }))!;
  assert.equal(configured.provider, 'metered');
  assert.ok(configured.realtime);
  assert.equal(configured.defaultMode, 'auto');
});

test('startup validates options and keeps custom-turn production safety gates', async () => {
  for (const args of [['--turn', 'other'], ['--ice', 'sometimes'], ['--port', '-1'], ['--turn-public-ip', 'not-an-ip'], ['--relay-min-port', '55000', '--relay-max-port', '54000'], ['--unknown']]) {
    await assert.rejects(startupConfig(args, {}));
  }
  await assert.rejects(startupConfig(['--production'], {}), /TURN_SECRET/);
  await assert.rejects(startupConfig(['--production'], { TURN_SECRET: 'x'.repeat(32) }), /routable/);
  assert.equal(await startupConfig(['--help'], {}), undefined);
});

test('interactive configuration asks only for non-secret operational settings', async () => {
  const answers = ['custom-turn', '5192', 'auto', '192.168.1.4', '3492'];
  const questions: string[] = [];
  const configured = (await startupConfig(['--configure'], {}, async (question) => { questions.push(question); return answers.shift()!; }))!;
  assert.equal(configured.port, 5192);
  assert.equal(configured.turn.port, 3492);
  assert.equal(configured.turn.publicAddress, '192.168.1.4');
  assert.doesNotMatch(questions.join(' '), /secret|password|token|key/i);
});

test('the real local process can select Metered without opening a custom-turn listener', { timeout: 15_000 }, async (context) => {
  const child = spawn(process.execPath, ['src/server/index.ts', '--production', '--turn', 'metered', '--host', '127.0.0.1', '--port', '0', '--ice', 'relay'], {
    env: { ...process.env, METERED_REALTIME_KEY_ID: 'sk_id_test_fixture', METERED_REALTIME_SECRET: 'sk_secret_test_fixture', APP_ACCESS_TOKEN: '', APP_ORIGIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const finished = once(child, 'exit'); child.kill('SIGTERM'); await finished; }
  });
  const ready = await new Promise<{ app: string; provider: string; ice: string; turn: unknown }>((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error('Local Metered startup timed out')), 8000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Local Metered exited with ${code}: ${errors}`)); });
    child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      for (const line of output.split('\n')) {
        try { const event = JSON.parse(line); if (event.event === 'ready') { clearTimeout(timer); resolve(event); } } catch {}
      }
    });
  });
  assert.equal(ready.provider, 'metered');
  assert.equal(ready.ice, 'relay');
  assert.equal(ready.turn, 'Metered Open Relay');
  const base = ready.app.replace('localhost', '127.0.0.1');
  const config = await (await fetch(`${base}/api/config`)).json() as { defaultMode: string; relay: { name: string; managed: boolean } };
  assert.equal(config.defaultMode, 'relay');
  assert.equal(config.relay.name, 'Metered Open Relay');
  assert.equal(config.relay.managed, true);
  const ice = await (await fetch(`${base}/api/ice`)).json() as { signalingTransport: string };
  assert.equal(ice.signalingTransport, 'metered');
});