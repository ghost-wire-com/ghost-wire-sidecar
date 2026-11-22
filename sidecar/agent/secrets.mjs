import {readFileSync} from 'node:fs';

// Value from NAME, else from the file named by NAME_FILE (trimmed), else undefined.
export function readSecret(name, env = process.env) {
  if (env[name]) return env[name];
  const file = env[name + '_FILE'];
  return file ? readFileSync(file, 'utf8').trim() : undefined;
}
