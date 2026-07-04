// Formatação de datas sem Date/timezone: date_iso é YYYY-MM-DD do export — parsear com
// new Date() deslocaria um dia em fusos negativos (Brasil). Split manual é exato e barato.
// Meses pelo idioma ativo (mesma ordem "D Mon AAAA" nos dois — curta e inequívoca).
import { getFmtLocale } from '../strings.js';

const MONTHS = {
  pt: ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return String(iso);
  return `${d} ${MONTHS[getFmtLocale()][m - 1]} ${y}`;
}
