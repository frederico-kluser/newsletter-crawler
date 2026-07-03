// Formatação de datas PT-BR sem Date/timezone: date_iso é YYYY-MM-DD do export — parsear com
// new Date() deslocaria um dia em fusos negativos (Brasil). Split manual é exato e barato.
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return String(iso);
  return `${d} ${MESES[m - 1]} ${y}`;
}
