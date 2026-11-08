// Display only; engineering calculations and identifiers retain their original values.
function precision(value, kind) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('显示数值须为有限数字；缺项与标识符另行保留');
  const fixed = { force: 0, forceMargin: 0, area: 0, count: 0, opening: 1, percent: 1,
    length: 1, velocity: 1, flow: 1, temperature: 1, pressure: 3 };
  let digits;
  if (kind === 'cv') digits = Math.abs(value) < 10 ? 2 : 1;
  else if (kind === 'coefficient' || kind === 'density') {
    const significant = kind === 'coefficient' ? 5 : 4;
    digits = value === 0 ? 0 : Math.max(0, significant - 1 - Math.floor(Math.log10(Math.abs(value))));
  } else if (Object.hasOwn(fixed, kind)) digits = fixed[kind];
  else throw new TypeError('须指定数值含义，不能按行标题猜测：' + kind);
  if (value !== 0 && Math.abs(value) < 0.5 * 10 ** -digits) digits = 2 - Math.floor(Math.log10(Math.abs(value)));
  return { digits: Math.min(digits, 12), scientific: digits > 12, grouped: ['force', 'forceMargin', 'area', 'count', 'flow'].includes(kind) };
}

export function displayNumber(value, kind) {
  const p = precision(value, kind);
  if (p.scientific) return value.toExponential(2).replace(/\.?(0+)(?=e)/, '').replace('e', 'E');
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: p.digits, useGrouping: p.grouped }).format(Object.is(value, -0) ? 0 : value);
}

export function numberFormat(value, kind) {
  const p = precision(value, kind);
  const shown = displayNumber(value, kind).split('E')[0];
  const digits = shown.split('.')[1]?.length ?? 0;
  return (p.grouped ? '#,##0' : '0') + (digits ? '.' + '0'.repeat(digits) : '') + (p.scientific ? 'E+00' : '');
}

// These are review findings, not automatic text replacements or an engineering pass.
export function auditVisibleText(entries) {
  const findings = [], notes = new Map();
  for (const { location, text, scope = '', role = 'text' } of entries) {
    if (typeof location !== 'string' || typeof text !== 'string') throw new TypeError('检查项需要location和text');
    if (role === 'identifier') continue;
    for (const match of text.matchAll(/(?<![\w.])[-−]?\d[\d,]*\.\d{7,}(?![\d.])/g))
      findings.push({ location, type: 'long-decimal', value: match[0] });
    for (const match of text.matchAll(/(?<![\w.])[-−]?\d[\d,]*\.\d*0(?![\d.])/g))
      findings.push({ location, type: 'trailing-zero-review', value: match[0] });
    if (role === 'note' && text.trim().length >= 20) {
      const key = scope + '\0' + text.trim().replace(/\s+/g, ' ');
      if (notes.has(key)) findings.push({ location, type: 'repeated-note', firstLocation: notes.get(key) });
      else notes.set(key, location);
    }
  }
  return findings;
}
