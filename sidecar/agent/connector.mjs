import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const read = (dir, name) => readFileSync(join(dir, name), 'utf8');

// Log in to the local worker; initialise its single account on first start.
export async function ensureWorkerAuth({engineUrl, password, fetch}) {
  const call = path => fetch(new URL(path, engineUrl).href, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'GHOSTWIRE', password}),
  });
  let response = await call('/api/auth/login');
  if (response.ok) return;
  if (![400, 401, 403].includes(response.status)) throw Error('Worker login failed');
  response = await call('/api/auth/init');
  if (!response.ok && response.status !== 409) throw Error('Worker setup failed');
  response = await call('/api/auth/login');
  if (!response.ok) throw Error('Worker login failed');
}

// Adapter for connectSidecar, built only from the private state volume.
export function connectorConfig(stateDir) {
  const device = JSON.parse(read(stateDir, 'device.json'));
  return {
    testUserId: device.user_id, credential: device.credential,
    engineUrl: 'http://worker:8787', engineUsername: 'GHOSTWIRE', enginePassword: read(stateDir, 'engine-password'),
    database: join(stateDir, 'ownership.db'), hostedWorkspace: true, workspaceMode: 'api',
    secret: read(stateDir, 'gateway-secret'),
    modelRouteDir: '/route', modelRouteKeyFile: join(stateDir, 'model-route.key'),
    // Own-PC installs have no mining node; without miningSecret the proxy never calls this placeholder.
    miningOrigin: 'http://127.0.0.1:1/',
    // "My keys" chat from the console goes straight to the broker on the private network.
    modelChat: {url: 'http://model-broker:8791', token: read(stateDir, 'scoped-token')},
  };
}
