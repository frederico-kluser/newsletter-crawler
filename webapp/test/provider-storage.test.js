// storage.js: slots INDEPENDENTES de chave (nc-or-key) e provedor (nc-llm-provider) — o provedor
// SÓ importa quando há chave salva e persiste junto dela; sem valor salvo = openrouter (migração
// silenciosa). Testes com localStorage fake observável (o Node não tem localStorage nativo → a
// storage.js cai no Map em memória; aqui instalamos um stub para ver as CHAVES usadas) + o caso
// Safari-private (localStorage que LANÇA → fallback em memória).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearApiKey, clearProvider, getApiKey, getProvider, getTheme, setApiKey, setProvider, setTheme,
} from '../src/lib/storage.js';

function makeFakeStorage() {
  const items = new Map();
  return {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => items.set(k, String(v)),
    removeItem: (k) => items.delete(k),
    _items: items,
  };
}

function installStorage(stub) {
  const prev = globalThis.localStorage;
  globalThis.localStorage = stub;
  return () => {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  };
}

test('getProvider: sem valor salvo = openrouter (migração silenciosa de usuários antigos)', () => {
  const restore = installStorage(makeFakeStorage());
  try {
    assert.equal(getProvider(), 'openrouter');
  } finally {
    restore();
  }
});

test('setProvider: só "deepseek" exato é persistido; qualquer outro valor vira openrouter na GRAVAÇÃO', () => {
  const restore = installStorage(makeFakeStorage());
  try {
    const ls = globalThis.localStorage;
    setProvider('deepseek');
    assert.equal(ls._items.get('nc-llm-provider'), 'deepseek');
    assert.equal(getProvider(), 'deepseek');
    setProvider('DeepSeek'); // caixa alta não conta
    assert.equal(ls._items.get('nc-llm-provider'), 'openrouter');
    assert.equal(getProvider(), 'openrouter');
    setProvider('banana');
    assert.equal(ls._items.get('nc-llm-provider'), 'openrouter');
  } finally {
    restore();
  }
});

test('chave da API segue INTOCADA: setApiKey grava em nc-or-key; setProvider em nc-llm-provider', () => {
  const restore = installStorage(makeFakeStorage());
  try {
    const ls = globalThis.localStorage;
    setApiKey('sk-or-123');
    assert.equal(ls._items.get('nc-or-key'), 'sk-or-123');
    assert.equal(getApiKey(), 'sk-or-123');
    setProvider('deepseek');
    assert.equal(ls._items.get('nc-or-key'), 'sk-or-123', 'provider não toca a chave');
    assert.equal(ls._items.get('nc-llm-provider'), 'deepseek');
  } finally {
    restore();
  }
});

test('chave e provedor são slots INDEPENDENTES: limpar um não afeta o outro', () => {
  const restore = installStorage(makeFakeStorage());
  try {
    const ls = globalThis.localStorage;
    setApiKey('k');
    setProvider('deepseek');
    clearProvider();
    assert.equal(getApiKey(), 'k', 'esquecer o provedor mantém a chave');
    assert.equal(getProvider(), 'openrouter');
    setProvider('deepseek');
    clearApiKey();
    assert.equal(getProvider(), 'deepseek', 'esquecer a chave mantém o provedor');
    assert.equal(getApiKey(), null);
  } finally {
    restore();
  }
});

test('migração: usuário com chave antiga da OpenRouter e SEM provedor salvo cai em openrouter', () => {
  const restore = installStorage(makeFakeStorage());
  try {
    setApiKey('sk-or-antiga');
    // nada de nc-llm-provider — simula o período pré-seletor
    assert.equal(getProvider(), 'openrouter');
    assert.equal(getApiKey(), 'sk-or-antiga');
  } finally {
    restore();
  }
});

test('fluxo saveKey/forgetKey (o que useAiSearch faz): salva no slot do provedor e ativa; esquecer limpa o slot', () => {
  const restore = installStorage(makeFakeStorage());
  try {
    const ls = globalThis.localStorage;
    setApiKey('sk-ds-x', 'deepseek'); // após probe ok — slot DO provedor
    setProvider('deepseek'); // salvar ATIVA o provedor
    assert.equal(getApiKey(), 'sk-ds-x');
    assert.equal(getProvider(), 'deepseek');
    assert.equal(ls._items.get('nc-ds-key'), 'sk-ds-x', 'slot deepseek preenchido');
    assert.ok(!ls._items.has('nc-or-key'), 'slot openrouter intocado');
    // forgetKey do hook: clearApiKey(provider ativo) + clearProvider
    clearApiKey('deepseek');
    clearProvider();
    assert.equal(getApiKey(), null);
    assert.equal(getProvider(), 'openrouter', 'sem chave o provedor volta ao default');
  } finally {
    restore();
  }
});

test('as DUAS chaves convivem em slots independentes; getApiKey() devolve a do provedor ATIVO', () => {
  const restore = installStorage(makeFakeStorage());
  try {
    setApiKey('sk-or-x'); // ativo default = openrouter
    setApiKey('sk-ds-y', 'deepseek');
    assert.equal(getApiKey('openrouter'), 'sk-or-x');
    assert.equal(getApiKey('deepseek'), 'sk-ds-y');
    assert.equal(getApiKey(), 'sk-or-x', 'ativo openrouter → chave da OpenRouter');
    setProvider('deepseek'); // troca o ativo SEM tocar as chaves
    assert.equal(getApiKey(), 'sk-ds-y', 'ativo deepseek → chave da DeepSeek');
    clearApiKey('openrouter'); // esquece só a OpenRouter
    assert.equal(getApiKey('openrouter'), null);
    assert.equal(getApiKey(), 'sk-ds-y', 'a chave do outro provedor segue valendo');
  } finally {
    restore();
  }
});

test('esquecer a chave ATIVA sem outra salva zera o hasKey (getApiKey() null); com outra salva, sobra ela', () => {
  const restore = installStorage(makeFakeStorage());
  try {
    setApiKey('sk-or-x');
    setApiKey('sk-ds-y', 'deepseek');
    setProvider('deepseek');
    clearApiKey('deepseek'); // esquece a ativa
    clearProvider();
    assert.equal(getProvider(), 'openrouter');
    assert.equal(getApiKey(), 'sk-or-x', 'sobra a chave da OpenRouter → hasKey segue true');
    clearApiKey('openrouter'); // esqueceu as duas
    assert.equal(getApiKey(), null, 'sem nenhuma chave → hasKey false');
  } finally {
    restore();
  }
});

test('getProvider com valor CORROMPIDO no armazenamento cai em openrouter (nunca lança)', () => {
  const restore = installStorage(makeFakeStorage());
  try {
    const ls = globalThis.localStorage;
    ls._items.set('nc-llm-provider', 'deepseek '); // com espaço
    assert.equal(getProvider(), 'openrouter');
    ls._items.set('nc-llm-provider', 'DEEPSEEK');
    assert.equal(getProvider(), 'openrouter');
    ls._items.set('nc-llm-provider', '{"provider":"deepseek"}'); // JSON estranho
    assert.equal(getProvider(), 'openrouter');
  } finally {
    restore();
  }
});

test('localStorage que LANÇA (Safari private/iframe restrito): provedor e chave caem no Map da sessão', () => {
  const throwing = {
    getItem: () => { throw new DOMException('The operation is insecure', 'SecurityError'); },
    setItem: () => { throw new DOMException('The operation is insecure', 'SecurityError'); },
    removeItem: () => { throw new DOMException('The operation is insecure', 'SecurityError'); },
  };
  const restore = installStorage(throwing);
  try {
    setProvider('deepseek');
    assert.equal(getProvider(), 'deepseek', 'sessão continua funcionando via Map em memória');
    setApiKey('sk-ds-y');
    assert.equal(getApiKey(), 'sk-ds-y');
    clearApiKey();
    assert.equal(getApiKey(), null);
    setTheme('dark'); // demais slots também sobrevivem
    assert.equal(getTheme(), 'dark');
  } finally {
    restore();
  }
});
