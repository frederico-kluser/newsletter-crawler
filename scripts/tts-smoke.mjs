// Teste local da API de TTS da OpenRouter (Kokoro 82M) ANTES de ligar na UI. Sintetiza um resumo
// PT-BR de exemplo com as vozes candidatas (+ um controle em inglês) e grava os .mp3 em
// NC_HOME/tts-samples/ p/ audição; imprime bytes, content-type, latência e magic-bytes de MP3.
// Script throwaway → console direto é permitido (seguindo-code-style: escape hatch p/ scripts).
// Rodar: node --env-file-if-exists=.env scripts/tts-smoke.mjs [voz1 voz2 ...]
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { synthesizeSpeech } from '../src/tts.js';
import { HAS_LLM, TTS_MODEL, NC_HOME } from '../src/config.js';

// Um summary_pt realista (tamanho típico do acervo ~300–600 chars).
const SAMPLE =
  'O Node.js 24 chegou com melhorias importantes de desempenho no motor V8 e um novo modelo de ' +
  'permissões experimental. A versão traz o npm 11, suporte aprimorado a WebSocket nativo e ' +
  'mudanças no carregador de módulos ECMAScript. Desenvolvedores devem revisar as notas de ' +
  'atualização antes de migrar projetos em produção.';

const cliVoices = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// Kokoro PT-BR usa prefixo p* (pf_=feminina, pm_=masculina). af_heart é controle em inglês:
// se ele funcionar e as PT falharem, o problema é só o NOME da voz, não o endpoint.
const voices = cliVoices.length ? cliVoices : ['pf_dora', 'pm_alex', 'pm_santa', 'af_heart'];

if (!HAS_LLM) {
  console.error('Sem OPENROUTER_API_KEY (procure em NC_HOME/.env). Configure com `ncrawl key set <k>`.');
  process.exit(1);
}

const outDir = path.join(NC_HOME, 'tts-samples');
mkdirSync(outDir, { recursive: true });

console.log(`modelo: ${TTS_MODEL} · ${SAMPLE.length} chars · saída em ${outDir}\n`);

let anyOk = false;
for (const voice of voices) {
  const t0 = Date.now();
  try {
    const { buffer, contentType, generationId } = await synthesizeSpeech({ text: SAMPLE, voice });
    const m = buffer.subarray(0, 3);
    const isMp3 =
      (m[0] === 0x49 && m[1] === 0x44 && m[2] === 0x33) || // "ID3"
      (m[0] === 0xff && (m[1] & 0xe0) === 0xe0); // frame sync MPEG
    const out = path.join(outDir, `tts-${voice}.mp3`);
    writeFileSync(out, buffer);
    anyOk = true;
    console.log(
      `✓ ${voice.padEnd(10)} ${String(buffer.length).padStart(7)} bytes · ${contentType} · mp3=${isMp3} · ${Date.now() - t0}ms · gen=${generationId ?? '—'}`,
    );
    console.log(`   → ${out}`);
  } catch (e) {
    console.log(`✗ ${voice.padEnd(10)} status=${e.status ?? '?'} · ${Date.now() - t0}ms · ${e.message}`);
  }
}

console.log(anyOk ? '\nOuça os arquivos acima e escolha a melhor voz PT-BR.' : '\nNenhuma voz funcionou — veja as mensagens de erro (podem listar as vozes válidas).');
process.exit(anyOk ? 0 : 1);
