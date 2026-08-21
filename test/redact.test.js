// Testes da redação de segredos do export (`src/redact.js`) — o guard que impede o GitHub
// Push Protection de derrubar o deploy quando um artigo do acervo carrega um token no texto.
// Sem rede/LLM: redige os padrões conhecidos (incl. o caso REAL que bloqueou o push: artigo 2828,
// "Stealing Reasoning Traces from Proprietary LLM APIs"), NÃO toca texto limpo nem slug de URL,
// e é determinístico (idempotente).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/redact.js';

test('redige placeholder Hugging Face em ambos os casos (caso do push bloqueado)', () => {
  // placeholder determinístico (o token REAL vazado foi removido do teste — o GitHub Push
  // Protection rejeita o push se o arquivo carregar um token válido, mesmo em teste unitário).
  const body =
    'exemplo: `hf_abcdefghijklmnopqrstuvwxyz123456` (huggingface token) e outro ' +
    'hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 no fim.';
  const out = redactSecrets(body);
  assert.equal(out, 'exemplo: `[REDACTED]` (huggingface token) e outro [REDACTED] no fim.');
});

test('redige os principais padrões de token (prefixos reservados)', () => {
  const cases = [
    'ghp_1234567890abcdefghijklmnopqrstuvwxyZ',
    'github_pat_11ABCDEF00_abcdefghijklmnopqrstuv',
    'glpat-AbCdEfGhIjKlMnOpQrStUvWx',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'sk-proj-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'sk-' + 'a'.repeat(48),
    'AKIAIOSFODNN7EXAMPLE',
    'ASIAIOSFODNN7EXAMPLE',
    'xox' + 'b-' + '1234567890-abcdefghijklmnopqrstuv', // Slack (concat p/ não casar no push protection)
    'sk_' + 'live_' + 'abcdefghijklmnopqrstuvwxyz0123456789', // Stripe
    'rk_' + 'live_' + 'abcdefghijklmnopqrstuvwxyz0123456789', // Stripe restricted
    'AIza' + 'a'.repeat(35), // Google API: AIza + 35 exatos
    'npm_' + 'a'.repeat(36), // npm: npm_ + 36 exatos
    'shpat_abcdefghijklmnopqrstuvwxyz123456',
    '1234567890:AAabcdefghijklmnopqrstuvwxyzABCDEFG',
    'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  ];
  for (const c of cases) assert.equal(redactSecrets(`antes ${c} depois`), 'antes [REDACTED] depois', c);
});

test('redige bloco PEM multilinha de chave privada inteiro', () => {
  const key =
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBA\n-----END PRIVATE KEY-----';
  assert.equal(redactSecrets(key), '[REDACTED]');
});

test('não toca texto limpo nem slug de URL parecido com chave', () => {
  const clean = [
    'o crawler roda com got e não axios',
    'sk-zuckerberg-killed-trumps-ai-safety-order-in-three', // slug de URL com sk-
    'npm_package_using_postinstall_to_inject', // nome de pacote
    'npm_config__auth', // nome de variável de ambiente
    'hf_tools são da Hugging Face', // prefixo sem corpo de token
    '2026-08-13T01:21:00.000Z', // data ISO não é token
  ];
  for (const c of clean) assert.equal(redactSecrets(c), c, c);
});

test('determinístico e idempotente (re-export não muda bytes fora da redação)', () => {
  const body = 'texto com hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 e ghp_1234567890abcdefghijklmnopqrstuvwxyZ';
  const once = redactSecrets(body);
  assert.equal(redactSecrets(once), once);
});

test('fail-open: entrada não-string volta intacta', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(123), 123);
});
