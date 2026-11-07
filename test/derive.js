// Test helper: derive the directory list the way the CLI's view does.
// (The core does not need directories; only the checks' path-existence test
// does, and it derives them from filePaths.)

export function deriveDirectories(filePaths) {
  const set = new Set(['/']);
  for (const path of filePaths) {
    const segments = path.replace(/^\//, '').split('/');
    for (let i = 1; i < segments.length; i += 1) set.add(`/${segments.slice(0, i).join('/')}`);
  }
  return [...set].sort();
}
