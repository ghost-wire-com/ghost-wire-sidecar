#!/usr/bin/env node
// Ghost Wire Sidecar agent image entry: setup | broker | connector.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {runSetup} from './setup.mjs';
import {validateFolder} from './folder.mjs';
import {ensureWorkerAuth, connectorConfig} from './connector.mjs';
import {readSecret} from './secrets.mjs';

const env = process.env;
const stateDir = env.GHOSTWIRE_STATE_DIR || '/state';
const origin = env.GHOSTWIRE_APP_ORIGIN || 'https://app.ghost-wire.com';
const folder = env.GHOSTWIRE_FOLDER || '~/GhostWire';
const home = env.GHOSTWIRE_HOST_HOME || undefined;

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main([command, ...args]) {
  if (command === 'setup') {
    // Runs as root once: state files go to the agent user (node, 1000), worker secrets stay root-only.
    const owner = process.getuid?.() === 0 ? {uid: 1000, gid: 1000} : undefined;
    await runSetup({code: option(args, '--code'), name: option(args, '--name'), stateDir, origin, fetch, folder, home,
      workerSecretsDir: env.GHOSTWIRE_WORKER_SECRETS_DIR || undefined, owner});
    console.log('Next: start it with the second half of the line (docker compose ... up -d).');
    return;
  }
  if (command === 'broker') {
    const device = JSON.parse(readFileSync(join(stateDir, 'device.json'), 'utf8'));
    env.MODEL_UPSTREAM_TOKEN = readSecret('MODEL_UPSTREAM_TOKEN') || device.credential;
    env.WORKSPACE_MODEL_TOKEN = readSecret('WORKSPACE_MODEL_TOKEN') || readFileSync(join(stateDir, 'scoped-token'), 'utf8');
    env.MODEL_ROUTE_KEY ||= join(stateDir, 'model-route.key');
    const {createBroker} = await import('../../premium-agent/workspace-model-broker.mjs');
    createBroker({env, routeDir: env.MODEL_ROUTE_DIR, masterKeyFile: env.MODEL_ROUTE_KEY, providersFile: env.MODEL_PROVIDERS, filterFile: env.MODEL_FILTER}).listen(8791, '0.0.0.0');
    return;
  }
  if (command === 'connector') {
    validateFolder(folder, {home});
    const config = connectorConfig(stateDir);
    for (let attempt = 1; ; attempt++) {
      try { await ensureWorkerAuth({engineUrl: config.engineUrl, password: config.enginePassword, fetch}); break; }
      catch { if (attempt >= 60) throw Error('The local worker did not start. Check: docker compose logs worker'); await delay(2000); }
    }
    const {connectSidecar} = await import('../connection.mjs');
    const abort = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort());
    await connectSidecar(config, {origin, signal: abort.signal});
    // Only a revoked credential ends the loop. Wait before Docker restarts us so a
    // disconnected computer doesn't keep knocking; a re-pair is picked up on restart.
    if (!abort.signal.aborted) await delay(5 * 60 * 1000, undefined, {signal: abort.signal}).catch(() => {});
    return;
  }
  throw Error('Usage: setup --code <code> [--name <computer name>] | broker | connector');
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message === 'unsafe_folder'
    ? 'Unsafe folder. Choose one specific folder (for example ~/GhostWire), not your home folder or a drive.'
    : error.message);
  process.exit(1);
});
