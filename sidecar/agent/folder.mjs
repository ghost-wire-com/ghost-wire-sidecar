// The Sidecar shows tools exactly one folder. Refuse anything that would expose
// a whole drive, the home folder or a parent of it. The text comes from the host
// (GHOSTWIRE_FOLDER), so Windows paths are recognised by their drive letter.
const unsafe = () => { throw Error('unsafe_folder'); };

export function validateFolder(folder, {home} = {}) {
  let text = String(folder ?? '').trim();
  if (!text || text.includes(',')) unsafe();
  const windows = /^[A-Za-z]:/.test(text) || /^[A-Za-z]:/.test(home || '');
  const sep = windows ? '\\' : '/';
  const parts = value => value.split(/[\\/]+/).filter(Boolean);
  if (text === '~' || /^~[\\/]*$/.test(text)) unsafe();
  if (text.startsWith('~')) {
    const rest = parts(text.slice(1));
    if (!rest.length || rest.includes('..') || rest.includes('.')) unsafe();
    if (!home) return text.replace(/[\\/]+$/, '');
    text = home.replace(/[\\/]+$/, '') + sep + rest.join(sep);
  }
  const segments = parts(text);
  if (segments.includes('..') || segments.includes('.')) unsafe();
  let root, below;
  if (windows) {
    const drive = text.match(/^([A-Za-z]:)/);
    if (!drive) unsafe();
    root = drive[1].toUpperCase();
    below = parts(text.slice(2));
    if (below.some(part => part.includes(':'))) unsafe();
  } else {
    if (!text.startsWith('/') || text.includes(':')) unsafe();
    root = '';
    below = segments;
  }
  if (below.length < 2) unsafe(); // drive/filesystem root or one level below it
  const normalized = windows ? root + '\\' + below.join('\\') : '/' + below.join('/');
  if (home) {
    const key = value => (windows ? value.toLowerCase().replace(/\//g, '\\') : value).replace(/[\\/]+$/, '');
    const h = key(home), n = key(normalized);
    if (n === h || h.startsWith(n + sep)) unsafe();
  }
  return normalized;
}
