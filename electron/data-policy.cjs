// Compare decimal values without first rounding their input tokens to binary64.
function decimal(token) {
  if (token.length > 4096) throw precisionError();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match || (match[4]?.replace(/^[+-]/, '').length || 0) > 8) throw precisionError();
  let digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
  let exponent = Number(match[4] || 0) - (match[3]?.length || 0);
  if (!digits) return match[1] ? '-0' : '0';
  const trailing = /0+$/.exec(digits)?.[0].length || 0;
  digits = digits.slice(0, digits.length - trailing);
  exponent += trailing;
  return match[1] + digits + 'e' + exponent;
}
function precisionError() {
  return new Error(
    'This numeric value cannot be converted without losing precision. Use quoted strings for exact identifiers or high-precision decimals.',
  );
}
function parseJSON(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number') {
      // Node 24+ and the bundled Electron provide source-aware JSON revivers.
      // Fail closed if a different host runtime omits the source token.
      if (
        !context?.source ||
        !Number.isFinite(value) ||
        decimal(context.source) !== decimal(String(value))
      )
        throw precisionError();
    }
    return value;
  });
}
function parseYAML(text, YAML) {
  const document = YAML.parseDocument(text);
  if (document.errors.length) throw document.errors[0];
  YAML.visit(document, (_key, node) => {
    if (!YAML.isScalar(node) || typeof node.value !== 'number') return;
    if (!node.source || node.source.length > 4096 || !Number.isFinite(node.value))
      throw precisionError();
    let token = node.source
      .replace(/_/g, '')
      .replace(/^\+/, '')
      .replace(/^(-?)\./, '$10.')
      .replace(/\.$/, '.0');
    if (/^0[ox]/i.test(token)) token = BigInt(token).toString();
    if (decimal(token) !== decimal(String(node.value))) throw precisionError();
  });
  return document.toJS({ maxAliasCount: 50 });
}
function tableShape(value) {
  if (
    !Array.isArray(value) ||
    value.some(
      (row) =>
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.values(row).some((v) => v !== null && typeof v === 'object'),
    )
  )
    throw new Error(
      'CSV and TSV require an array of flat records. Nested data cannot be converted to a table.',
    );
  if (value.length > 100000) throw new Error('Tables are limited to 100,000 rows.');
  const columns = new Set();
  for (const row of value) {
    for (const key of Object.keys(row)) columns.add(key);
    if (columns.size > 1000) throw new Error('Tables are limited to 1,000 columns.');
  }
  if (value.length > 100000 || value.length * columns.size > 1000000)
    throw new Error('Tables are limited to 100,000 rows and 1,000,000 cells.');
  return [...columns];
}
module.exports = { parseJSON, parseYAML, tableShape };
