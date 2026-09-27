// Texto de rubrica COMPARTILHADO entre as etapas do Jev (lado Node). Em INGLÊS de propósito: é a
// língua primária do Jev (PT-BR julga pior e precisa de calibração própria), e o texto de uma
// pergunta calibrada não pode variar entre etapas — a página de bloqueio que o verify chama de junk
// é a MESMA que o detectType chama de bloqueada e a navegação classifica em page_status.
//
// A guarda de injeção (INJECTION + UNTRUSTED_ANCHOR) mora em src/shared/jev-core.js porque o
// webapp também a usa (injectionNoul); aqui ela só é reexportada — fonte única, sem cópia.
import { INJECTION_CRITERIA, INJECTION_ID, INJECTION_QUESTION, UNTRUSTED_ANCHOR, noul, withUntrustedAnchor } from '../shared/jev-core.js';

export { INJECTION_CRITERIA, INJECTION_ID, UNTRUSTED_ANCHOR };
export const INJECTION = INJECTION_QUESTION;

// As CLASSES de página-que-não-é-conteúdo (a choice page_status da navegação usa cada uma como
// rubrica de opção; os nouls de bloqueio usam a união em BLOCK_PAGE_TEXT). Um banner de erro dentro
// de uma página completa NÃO é bloqueio — a exceção vive em BLOCK_PAGE_NOT_TEXT.
export const BLOCK_PAGE_KINDS = Object.freeze({
  bot_challenge:
    "A bot check instead of content: a captcha, 'checking your browser', 'verify you are human', 'just a moment', an unusual-traffic or rate-limit notice, or an unsupported-browser block.",
  access_denied: "Access refused: 403 forbidden, blocked by a firewall, region or IP, 'you have been blocked'.",
  not_found_or_error:
    "An error instead of content: 404 or 'page not found', a page that moved or was removed, a deleted or private post, 'video unavailable', a 500/502/503 or 'something went wrong' message.",
  login_or_paywall: 'Reading requires signing in, subscribing or paying; only a teaser or a login form is shown.',
  consent_wall: 'Only a cookie, consent or age gate is shown and the content is hidden behind it.',
  app_shell: 'Only navigation, menus, footer or boilerplate, or an app shell whose main content did not load.',
});

export const BLOCK_PAGE_TEXT =
  "An error, blocking or gate page shown instead of the real content: a 'not found' or 'video unavailable' message, a server error, access denied or a firewall block, an anti-bot or captcha challenge ('checking your browser', 'verify you are human', 'just a moment'), a rate-limit notice, a login or paywall stub, a cookie or consent gate hiding the content, or an empty app shell whose content did not load.";

export const BLOCK_PAGE_NOT_TEXT =
  'Real, readable content. An error banner, a cookie notice or a sign-up box inside an otherwise complete page still counts as real content.';

/**
 * O noul canônico de "página de bloqueio/erro" (verify error_or_block_page, detectType blocked).
 * `subject` nomeia o que é julgado ('the page in the state', 'the saved content'…). Já sai com a
 * âncora de conteúdo não confiável: o state dessa pergunta é sempre texto de página da web.
 */
export function blockPageNoul(subject = 'the page in the state') {
  return noul(withUntrustedAnchor(`Is ${subject} an error, blocking or gate page shown instead of the real content?`), {
    true: BLOCK_PAGE_TEXT,
    false: BLOCK_PAGE_NOT_TEXT,
  });
}
