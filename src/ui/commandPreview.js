// Monta a linha de comando equivalente (ensina as flags). Booleano vira flag "bare"; valores
// com espaço/aspas são citados; `rest` são posicionais (ex.: a URL do `add`) logo após `--`.
function quote(s) {
  return /[\s"']/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

export function buildCommandPreview(sub, flags = {}, rest = []) {
  const args = [];
  for (const r of rest) if (r != null && r !== '') args.push(quote(r));
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    if (v === true) args.push(`--${k}`);
    else args.push(`--${k}`, quote(String(v)));
  }
  return `npm run ${sub} --${args.length ? ' ' + args.join(' ') : ''}`;
}
