import {randomBytes} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, chownSync} from 'node:fs';
import {join} from 'node:path';
import {validateFolder} from './folder.mjs';

export const STATE_FILES = ['device.json', 'postgres-password', 'scoped-token', 'engine-password', 'gateway-secret', 'model-route.key', 'jwt.key'];
const GENERATED = {
  'postgres-password': () => randomBytes(32).toString('base64url'),
  'scoped-token': () => randomBytes(32).toString('base64url'),
  'engine-password': () => randomBytes(32).toString('base64url'),
  'gateway-secret': () => randomBytes(32).toString('base64url'),
  'model-route.key': () => randomBytes(32).toString('base64'),
  'jwt.key': () => randomBytes(48).toString('base64url'),
};
const EXPIRED = 'Pairing code is invalid or expired. Create a new code on the website (Ghost Wire → Use my computer) and run the line again.';

function writePrivate(file, value) {
  const temporary = file + '.tmp';
  writeFileSync(temporary, value, {mode: 0o600});
  renameSync(temporary, file);
}

// Pair this computer (claim), keep a paired one unchanged, or replace only its
// device credential after the user paired again. Never prints secrets.
// The worker gets only these, through a separate root-only volume; it never mounts the state volume.
// postgres-password and scoped-token stay root-only (read by the entrypoint before it drops
// privileges); jwt.key is read by the running worker, so it belongs to the worker user.
const WORKER_SECRETS = ['postgres-password', 'scoped-token', 'jwt.key'];

function shareWithWorker(stateDir, workerSecretsDir, owner) {
  if (!workerSecretsDir) return;
  mkdirSync(workerSecretsDir, {recursive: true});
  for (const name of WORKER_SECRETS) {
    const target = join(workerSecretsDir, name);
    if (!existsSync(target)) writeFileSync(target, readFileSync(join(stateDir, name)), {mode: 0o400, flag: 'wx'});
  }
  if (owner) {
    chownSync(join(workerSecretsDir, 'jwt.key'), owner.uid, owner.gid);
    for (const name of readdirSync(stateDir)) chownSync(join(stateDir, name), owner.uid, owner.gid);
  }
}

export async function runSetup({code, name, stateDir, origin, fetch, folder, home, workerSecretsDir, owner}) {
  validateFolder(folder, {home});
  mkdirSync(stateDir, {recursive: true});
  const deviceFile = join(stateDir, 'device.json');
  const previous = existsSync(deviceFile) ? JSON.parse(readFileSync(deviceFile, 'utf8')) : null;
  if (!code) {
    if (previous) { shareWithWorker(stateDir, workerSecretsDir, owner); console.log('This computer is already connected. Nothing changed.'); return {status: 'unchanged'}; }
    throw Error('No pairing code. Copy the install line from Ghost Wire → Use my computer; it contains a fresh pairing code.');
  }
  const user = Number(String(code).split(':', 1)[0]);
  if (!Number.isSafeInteger(user) || user < 1) throw Error(EXPIRED);
  if (previous && previous.user_id !== user) throw Error('Pair again using the same Ghost Wire account. Existing data on this computer belongs to that account.');
  const response = await fetch(new URL('/api/sidecar/claim', origin).href, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({code, user_id: user, name: name || 'My computer'}),
  });
  if (!response.ok) throw Error(EXPIRED);
  const device = await response.json();
  if (device.user_id !== user || typeof device.credential !== 'string' || device.credential.length < 32) throw Error('Ghost Wire returned an unexpected pairing response. Try again.');
  writePrivate(deviceFile, JSON.stringify({device_id: device.device_id, user_id: device.user_id, credential: device.credential}));
  for (const [file, make] of Object.entries(GENERATED)) {
    const path = join(stateDir, file);
    if (!existsSync(path)) writeFileSync(path, make(), {mode: 0o600, flag: 'wx'});
  }
  shareWithWorker(stateDir, workerSecretsDir, owner);
  console.log(previous ? 'Reconnected this computer. Your data is kept.' : `Connected this computer to Ghost Wire account ${user}.`);
  return {status: previous ? 'replaced' : 'claimed'};
}
