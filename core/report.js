// Text report. Verdict first, one line per finding, then what was not checked.
// ASCII only (Windows terminals still default to cp932 or cp1252 in places).

const CHECK_WIDTH = 14;

export function renderText(result) {
  const lines = [];
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      lines.push(`This tool couldn't read ${error.file}${error.line ? ` (line ${error.line})` : ''}: ${error.message}.`);
    }
    lines.push('That is our parser, not necessarily your workflow.');
    return lines.join('\n');
  }

  lines.push(verdict(result));
  lines.push(`${result.summary.workflows} workflow${result.summary.workflows === 1 ? '' : 's'} read in ${result.summary.files_scanned} files.`);

  for (const finding of result.findings) {
    lines.push('');
    const label = finding.check.padEnd(CHECK_WIDTH);
    lines.push(`${label}${finding.file}:${finding.line}`);
    lines.push(`${' '.repeat(CHECK_WIDTH)}${finding.detail}`);
  }

  if (result.skipped.length > 0) {
    lines.push('');
    lines.push('Not checked:');
    const seen = new Set();
    for (const item of result.skipped) {
      if (seen.has(item.reason)) continue;
      seen.add(item.reason);
      lines.push(`  - ${item.reason}`);
    }
  }
  return lines.join('\n');
}

export function verdict(result) {
  const count = result.findings.length;
  if (count === 0) {
    return 'No trigger in this repo names something that is missing. That is not proof your CI runs - only that the names resolve.';
  }
  const plural = count === 1 ? 'name names' : 'names name';
  return `${count} trigger ${plural} something that does not exist.`;
}
