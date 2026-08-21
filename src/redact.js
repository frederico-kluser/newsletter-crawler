// Redação determinística de segredos na SAÍDA pública (snapshot do webapp + API).
// O GitHub Push Protection rejeita o push se QUALQUER arquivo carregar um token real — um artigo
// capturado do acervo pode trazer um token (vazado ou de exemplo) no corpo, e isso derrubava o
// `deploy` inteiro (o banco guarda o texto original e o export o reproduzia a cada run). Este guard
// roda SÓ no export, nunca no banco: o acervo local preserva o conteúdo; a superfície pública sai
// redigida. Determinístico de propósito — re-exportar não muda bytes fora da redação.
// Padrões de alto sinal: prefixos reservados a tokens (o que o push protection também varre),
// pares chave=valor óbvios, JWTs completos e blocos de chave privada. Substituição única
// `[REDACTED]` (idempotente: nada nos padrões casa com o marcador).
const SECRET_PATTERNS = [
  // ---- tokens com prefixo reservado (prefixo + corpo alfanumérico) ----
  /hf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub classic/OAuth/refresh/SSH
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic (vem antes de sk- genérico)
  /sk-proj-[A-Za-z0-9_-]{20,}/g, // OpenAI projeto (vem antes de sk- genérico)
  /sk-[A-Za-z0-9]{32,}/g, // OpenAI legacy (48 chars); 32+ evita slug de URL
  /AKIA[0-9A-Z]{16}/g, // AWS access key
  /ASIA[0-9A-Z]{16}/g, // AWS session key
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?:sk|rk)_live_[A-Za-z0-9]{20,}/g, // Stripe
  /AIza[0-9A-Za-z_-]{35}/g, // Google API
  /npm_[A-Za-z0-9]{36}/g, // npm
  /shpat_[A-Za-z0-9]{32}/g, // Shopify
  /\d{8,10}:[A-Za-z0-9_-]{35}/g, // Telegram bot
  // ---- par chave=valor de secret access key (não tem prefixo próprio) ----
  /(?:aws_secret_access_key|secret_access_key)\s*[=:]\s*[A-Za-z0-9/+=]{40,}/gi,
  // ---- JWT completo (3 segmentos) — exemplo de auth num artigo ----
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // ---- chave privada (bloco PEM, pode ter quebras de linha) ----
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
];

const SECRET_RE = new RegExp(SECRET_PATTERNS.map((p) => p.source).join('|'), 'g');

/** Redige segredos conhecidos de `text` (determinístico). Entrada não-string volta intacta. */
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text.replace(SECRET_RE, '[REDACTED]');
}
