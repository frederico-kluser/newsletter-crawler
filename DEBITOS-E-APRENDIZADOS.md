# Débitos e aprendizados — execução de 2026-09-05

Esta execução respondeu à pergunta "por que o sistema recomeça a captura do zero?". A resposta é que
ele não recomeçava: **a base era apagada**. Duas vezes, por um item de menu colado no "Sair". Foram
12 squash-commits, a suíte foi de 638 para 895 testes, e o acervo saiu de **0 para 15.502 artigos**,
reconstruído a partir do histórico do git — sem rede e sem gastar LLM. Depois, uma auditoria de
duplicidade mediu que 380 dessas 15.502 linhas (2,45%) são cópias reais do mesmo item.

Este arquivo é o que sobrou para resolver, e o que aprendemos no caminho.

---

## O que já ficou garantido

Não reabra estes — estão fechados e cobertos por teste.

| garantia | onde vive | como verificar |
|---|---|---|
| destruição sempre reversível | `backupBeforeDestructive` em `src/commands.js` | falha de backup **aborta** reset/purge/remove |
| reset exige intenção | `checkResetConfirmation`, `getResetImpact` | `reset --yes --confirm <nº de artigos>` |
| reset não é desfeito pelo restore | `.nc-wipe.json`, `writeWipeMarker`/`readWipeMarker` | pós-reset, `status` não ressuscita |
| base vazia se reconstrói sozinha | `maybeAutoRestore` em `src/cli-restore.js` | clone novo + `status` → 15.502 em ~9s |
| publicar vazio é impossível | `evaluateSnapshotChange` dentro de `exportWebSnapshot` | cobre os 4 escritores do snapshot |
| `npm test` não abre o banco real | `test/nc-home-isolation.test.js` | `HOME=<sentinela> npm test` deixa a sentinela vazia |
| menu não apaga por engano | `src/ui/screens.js` | "Limpar tudo" saiu do menu principal |

---

## Débitos

### Crítico

**D1 — `llm_usage` e `runs` não estão no snapshot: publicar zera o custo do site.**
O site no ar mostra `US$ 42,58 em 174.394 chamadas`. A base restaurada tem `llm_usage = 0` e
`runs = 0`, porque o snapshot exportado nunca carregou essas tabelas. Um `export`/`deploy` agora
levaria os artigos de 13.758 → 15.502 (ganho real) **e o custo para US$ 0,00**. O guard
anti-encolhimento não pega: ele só compara `totals.articles`.
*Onde:* `src/export-web.js` (o que o `meta.json` carrega), `src/db.js` (`webMeta*`).
*Risco de fazer errado:* inventar número de custo é pior que mostrar zero. A saída honesta é
preservar o `cost` do `meta.json` anterior quando o ledger local estiver vazio, marcando que é
herdado — ou exportar o ledger de verdade.
*Esforço:* pequeno.

**D2 — `issue_url` não existe no snapshot commitado: toda restauração paga re-curadoria por IA.**
O código já exporta e já consome o campo (`src/export-web.js`, `restorePage` em `src/restore.js`),
mas o `articles.json` do HEAD foi gerado pelo exportador antigo: `grep -c '"issue_url"'` = **0** em
13.758 registros. Medido pós-restauração: `isUrlKnown` reconhece **100% das 15.502 URLs de artigo** e
**0 de 747 URLs de issue**. A primeira coleta re-percorre e re-cura ~745 issues — a fase mais cara do
pipeline. Os `issue_url` históricos se perderam junto com o banco antigo.
*Mitigação imediata:* use `--since <data recente>` na próxima coleta, para não descer no arquivo antigo.
*Fechamento definitivo:* o campo se preenche sozinho conforme novos crawls rodarem.
*Esforço:* nenhum (só disciplina no `--since`), ou grande se quiser reconstruir o histórico.

### Alto

**D3 — 380 linhas duplicadas (2,45%), 299 delas nascidas do merge das gerações.**
Composição: 284 por URL canônica idêntica (só `www.`, protocolo ou caixa do host), 82 por typo de
host/slug emitido pela curadoria de IA, 8 por query decorativa (`?s=20`, `?source=`, `?_bhlid=`),
6 por URL alucinada. O acervo verdadeiro é ~15.122 itens. Verificado: 297 grupos pela chave canônica,
266 pareando um id antigo (>13758) com um novo.
*Causa:* `normalizeUrl` (`src/util.js`) roda com `stripWWW:false` **de propósito** — e o comentário
está certo, colapsar `www.` gera URL morta em Substack de domínio próprio. O erro é usar a mesma
chave para **buscar** e para **identificar**.
*Correção estrutural:* coluna `dedup_key` com índice único (host minúsculo, sem `www.` inicial,
params decorativos removidos), mantendo `url` intacta para o fetch. A auditoria verificou seguindo
redirects que **286 dos 288 pares resolvem para a mesma URL hoje**.
*Risco de fazer errado:* colapsar demais. Guards obrigatórios, cada um com contra-exemplo real:
  - **não fundir se um título tem versão/data que o outro não tem** — "pgschema 1.8" × "1.6.1" têm
    Jaccard **1,000** (o redirect serve a mesma página viva hoje) e distância de URL 1;
  - **não fundir por conteúdo parecido** — `github.com/axios/axios` (README, 80 mil chars) ×
    `/releases/tag/v1.20.0` (changelog, 3 mil) têm Jaccard 0,00 e são páginas legítimas distintas;
  - **não fundir landing reusada** — dois slots de patrocínio do Tailscale, Fuse.js 7.3 × 7.4 com
    56 dias de intervalo, React Miami 2026 × 2027;
  - **nunca preferir `https` ou `www` cegamente** — em 4 dos 9 pares de protocolo o lado `http://` é
    o mais longo, e em 5 pares do vetor `www` o lado ápice é 3× maior.
*Ordem de sobrevivência sugerida:* maior substância → `verify_status` (ok > suspect > junk > null) →
riqueza de metadado → menor id. Antes do DELETE, copiar do perdedor todo campo que o vencedor não
tem e **unir as tags**. A linha da `frontier` do perdedor deve continuar `done`.
*Esforço:* médio.

**D4 — 87 linhas cujo `content` não é o artigo, com resumo em português alucinado.**
26 páginas 404/500, 29 com o chrome da plataforma, 5 banners de cookie, 2 paywall, 2 anti-bot, e
**23 com a saída do próprio pipeline de IA gravada como corpo** — num deles o system prompt
("Você extrai o conteúdo principal de um artigo…"). As 87 têm `summary_pt`, `title_pt` e 620 tags:
resumos gerados a partir do título, e pagos. 27 passaram no gate como `ok`/`suspect`.
*Ação:* `content = NULL`, `needs_enrich = 1`, `verify_status = 'junk'` e re-enfileirar — **não apagar**.
*Risco:* ~8 são falso positivo (o corpo é o artigo, só mal emoldurado). Exigir corpo curto **e**
ausência do vocabulário do título antes de zerar.
*Onde:* `src/parse-core.js` (`isBlockedPage`, `BLOCKED_PATTERNS`), `src/clean.js`.
*Esforço:* médio.

**D5 — A curadoria de IA emite URLs com typo, e o buraco está vivo hoje.**
Hosts errados (`blog.gaboos.com` por `blog.gaborkoos.com`, `tkd.eu` por `tkdodo.eu`, `aemik.com` por
`aem1k.com`), ids de vídeo com caracteres transpostos, slugs truncados. Em **52 de 65 casos
auditados o lado quebrado veio da geração mais NOVA** — não é resíduo histórico.
*Correção:* validar (HEAD/GET) a URL emitida pela IA antes de criar ficha nova; 404 ou DNS morto ⇒
anexa ao item existente em vez de criar linha.
*Onde:* `src/curate.js`, na saída da curadoria.
*Esforço:* médio.

### Médio

**D6 — 24 registros de riqueza máxima sumiram no merge, e nenhum crawl os recupera.**
`SELECT COUNT(*) FROM frontier f WHERE NOT EXISTS(SELECT 1 FROM articles a WHERE a.url=f.url)` → 24.
Colidiram por `content_hash` no INSERT e a frontier foi marcada `done` mesmo assim. Duas eram ids
autoritativos do site no ar. A colisão foi **fabricada** pela `bodyPolicy 'best'`, que deu a um
registro o corpo de um snapshot antigo, igualando o sha256 ao de outro.
*Ação:* devolver essas 24 URLs para `pending`. Reversível, pior caso é recoletar 24 páginas.
*Guard para não repetir:* se o corpo escolhido pela `bodyPolicy` colide com uma linha já inserida de
URL diferente, manter o corpo original.
*Onde:* `src/restore.js` (marcação da frontier em colisão silenciosa), `bodyPolicy`.
*Esforço:* pequeno.

**D7 — 4.417 artigos do Golang Weekly com `published_at` = a data do crawl.**
28,5% do acervo, todos em `2026-08-30`, incluindo um post de 2009. Não é duplicidade — é metadado
ruim, e distorce a ordenação do site inteiro.
*Onde:* extração de data (`src/clean.js` `extractPublishedDate`, `src/selectors.js`) para essa fonte.
*Esforço:* médio.

**D8 — Arquivo não-rastreado em `webapp/public/data/` é publicado.**
O deploy trata qualquer arquivo solto ali como dado novo e o inclui no `git add`. Se você guardar um
rascunho ou um backup manual nessa pasta, ele vai para o site. Comportamento anterior a esta execução.
*Onde:* `src/deploy.js`, o `git add -- <dirs>`.
*Esforço:* pequeno.

**D9 — Duas instâncias concorrentes re-pagam LLM.**
`resetInProgress` (`src/db.js`) é um `UPDATE frontier SET state='pending' WHERE state='in_progress'`
global, sem escopo de processo, rodado no início de todo crawl. Um segundo `ncrawl` devolve os jobs
em voo do primeiro para a fila e os reivindica: dois processos buscando e pagando pela mesma URL.
Não corrompe dado (as camadas de dedup seguram), mas duplica custo. Não há lock nenhum no projeto.
*Correção:* `NC_HOME/crawl.lock` com PID e `--force-lock`, ou escopar `resetInProgress` por idade/PID.
*Esforço:* pequeno.

**D10 — `sources.json` escrito sem atomicidade.**
`writeFileSync` puro, sem tmp+rename e sem lock (`src/config.js`). Truncado, `loadSources()` engole o
erro e devolve `[]` — e o crawl "termina com sucesso" tendo feito zero trabalho.
*Esforço:* pequeno.

**D11 — `content_hash` é sha256 do texto cru.**
53 a 68 pares de duplicata escaparam do índice UNIQUE por diferirem apenas em espaço em branco.
*Correção:* segundo índice sobre texto normalizado (whitespace colapsado, minúsculo), ao lado do cru.
*Esforço:* pequeno.

### Baixo

**D12 — `ncrawl reset` age sobre a raiz do código, não sobre o cwd.**
Rodar `node src/index.js reset` de dentro do repositório remove **e commita** `webapp/public/data` e
`webapp/public/api/v1` do próprio repo. É o comportamento que você pediu (limpar o local propaga
para o git), e o `--confirm <nº>` novo é o que o tornou seguro — mas o gesto continua agindo num
lugar diferente de onde você está.

**D13 — A janela do high-water é finita.**
O baseline do guard olha os últimos 1.000 commits que tocam o `meta.json` (~3 anos no ritmo atual).
Depois disso ele esquece o pico. É um efeito catraca mais lento, não eliminado. Persistir o
high-water fora do histórico fecharia de vez.

**D14 — ~196 linhas-fantasma.**
`id > 13758`, sem tags, corpo mediano de ~167 caracteres, quase todas atribuídas a uma fonte só,
inflando a contagem dela. Vieram de snapshots antigos e nunca foram enriquecidas.

**D15 — `isBlockedPage` tem 1 falso positivo e perde 2 interstitials reais.**
O falso positivo é um artigo legítimo da NBC com "Just a moment." no meio da prosa; os dois
interstitials reais usam frases que não estão em `BLOCKED_PATTERNS` (`src/parse-core.js`).

**D16 — A TUI não expõe `--allow-shrink wipe`, de propósito.**
Um bloqueio do guard aparece na interface como erro com dica para usar a linha de comando. Foi uma
decisão consciente: uma linha de menu capaz de apagar o site público seria exatamente o erro que
esta execução corrigiu. Registrado para você não achar que é esquecimento.

---

## Aprendizados

### Sobre testes

**Contar casos não é cobrir casos.** Um teste que enumerava 13.310 combinações do guard
anti-encolhimento passava verde com o guard **inteiramente desligado**. Ele derivava a expectativa da
própria saída da implementação (`v.counts.baseline`), então um mutante `baseline = 0 sempre` — que
desativa a proteção por completo — continuava aprovado. A correção foi um oráculo independente,
calculado só a partir das entradas cruas, mais valores adjacentes na fronteira (2865, 2866, 2867).
Sem adjacência, mutantes de off-by-one e de tolerância de 1% também sobreviviam.

**Teste de mutação é o único jeito de saber se o teste testa.** Sete mutantes aplicados ao módulo de
restauração, sete mortos. Antes disso, dava para desligar a política de escolha de conteúdo
(`bodyPolicy: 'longest'`) por completo e os 25 testes continuavam passando — porque o fixture fazia o
corpo mais novo ser também o mais longo, e os dois testes asseriam a mesma string.

**Testes que confirmam as pontas e nunca o fio.** Existia teste provando que o parser entende
`--allow-shrink`, e teste provando que o export honra `allowShrink`. Nenhum ligava os dois — e era
exatamente ali que estava o defeito: ninguém repassava a flag.

### Sobre proteções

**Uma proteção sem saída é pior que nenhuma: ela ensina a contorná-la.** O guard mandava rodar
`--allow-shrink=wipe`, uma sintaxe que o `parseFlags` do projeto não aceita (`a.slice(2)` toma a
string inteira como chave). Seguir a instrução dava o mesmo bloqueio. Um `remove` de fonte legítimo
travaria o export para sempre. É o mesmo mecanismo pelo qual `--no-verify` virou hábito neste
projeto — e foi o `--no-verify` que deixou o deploy publicar 0 artigos por cima de 2866.

**O código de proteção foi o mais perigoso de todos.** O módulo de backup, criado para impedir a
perda do banco, ganhou uma rota para apagá-lo: com `BACKUP_DIR=.`, a rotina de retenção incluía o
próprio `crawler.db` na lista de candidatos e o removia. E o caminho de erro apagava o backup válido
de outro processo — uma corrida de 4 processos por 4 segundos destruía 26 backups.

**Guard fail-open é guard desligado.** O hook `pre-push` pulava a verificação inteira quando não
conseguia ler um dos totais (`[ -n "$a" ] && [ -n "$b" ]`). Falha de leitura virava permissão. E
`Number('')` é `0`, então "não consegui ler" viraria "zero artigos" — a armadilha que faz um guard
aprovar exatamente o desastre que deveria barrar.

### Sobre dados

**Id não é identidade quando a base foi recriada.** 4.228 ids apontam para mais de uma URL ao longo
dos 30 snapshots, porque cada wipe reiniciou o AUTOINCREMENT em 1. O id `1` é um artigo num snapshot
e outro completamente diferente no seguinte. A identidade tem que ser a URL normalizada; os ids do
snapshot mais novo se preservam porque são os que o site serve e o histórico de buscas referencia.

**O registro mais rico vence, não o mais recente.** Na união dos snapshots, "mais recente" perderia
~720 resumos e ~725 classificações — porque snapshots feitos logo após um wipe são novos e pobres, e
sobrescreveriam os antigos e completos.

**Métricas de similaridade dão o valor máximo exatamente onde os itens são mais distintos.**
"pgschema 1.8" e "pgschema 1.6.1" têm Jaccard **1,000** — o redirect do GitHub pós-rename serve a
mesma página viva hoje, então o corpo raspado é idêntico embora sejam releases diferentes. No sentido
oposto, 15 matérias distintas do Engadget compartilham os mesmos 300 primeiros caracteres porque
todas carregam o mesmo "403 Request blocked". Similaridade de conteúdo, sozinha, não decide nada.

**Detector agressivo destrói o que deveria proteger.** A primeira versão do filtro de "HTML lixo"
reprovava 52 artigos técnicos legítimos — os que têm exemplos de código. O post do Remix 3 tem 232
tags em 65 KB de conteúdo real e perderia o corpo para uma alternativa de 79 caracteres. A versão
final exige três condições simultâneas e não barra nenhum corpo legítimo do acervo.

### Sobre ferramentas

**`copyFileSync` de um SQLite em WAL produz uma cópia inútil.** Medido: o `.db` sozinho não tinha
nem a tabela — todo o dado estava no `-wal`. Backup tem que ser `VACUUM INTO`, que enxerga o
commitado e ignora transação em voo. E ao restaurar de um backup, é obrigatório fechar a conexão e
apagar `-wal`/`-shm` antes de copiar: um WAL remanescente se aplica por cima do arquivo restaurado.

**O `heap_size_limit` do V8 mente.** Com `--max-old-space-size=220`, ele reporta 432 MB disponíveis
e o processo morre em 222. A primeira versão da proteção de memória confiou no número reportado e
continuou estourando. Pior: `FATAL ERROR: Reached heap limit` é um abort que `try/catch` não captura,
então o "fail-open em tudo" não vale para memória.

**Em ESM, o import estático é içado.** `process.env.NC_HOME = ...` escrito no topo do corpo do
arquivo roda **depois** de todo o grafo de dependências ser avaliado. Era por isso que 24 arquivos de
teste abriam o banco de produção mesmo "setando NC_HOME antes": só `await import()` funciona. A rede
de segurança que criamos analisa o grafo de imports justamente porque um guard em tempo de execução
não enxergaria isso.

**`Select` do Ink que sobrevive ao próprio `onChange` entra em laço infinito.** O efeito tem
`options`/`onChange` nas dependências, então re-dispara a cada render. As telas antigas escapavam por
acaso, porque sempre trocavam de tela no callback. A tela de backups precisou remontar o `Select` por
`key`.

### Sobre processo

**A revisão adversarial achou defeito real em 5 de 5 revisões.** Nenhum deles apareceria em teste de
fumaça: o guard desligado passando em 13.310 casos, o backup apagando o banco vivo, o `git clean`
levando arquivos do usuário, o marcador de wipe ressuscitando dado após `rebase`, a política de
conteúdo jogando fora 916 corpos maiores. O padrão que funcionou foi pedir ao revisor que **tentasse
derrubar** o trabalho, com perguntas falsificáveis específicas — não "revise isto".

**Verifique a base antes de medir qualquer coisa.** O checkout estava 23 commits atrás do remoto, e
todas as primeiras medições saíram erradas: 4.581 artigos recuperáveis contra 15.526 reais, 851 no ar
contra 13.758, e o formato do conteúdo (`contents.json` contra `contents.part0/part1.json`). Um
restore escrito contra o formato antigo encontraria **zero corpos** nos três commits mais ricos.

**Sub-agente também erra, e outro sub-agente corrige.** Um relatório de validação afirmou que o
README da API v1 ainda apontava para `contents.json`; o agente seguinte conferiu e o arquivo já
estava correto. Vale a mesma desconfiança que se aplica ao próprio trabalho.

**Gate por onda, em worktree isolada.** Cada integração rodou a suíte num snapshot do estado
integrado antes de a worktree anterior ser limpa — 638 → 669 → 688 → 694 → 729 → 770 → 811 → 829 →
862 → 889 → 895. Quando um gate ficou vermelho, foi a rede de isolamento pegando um teste novo
desprotegido: exatamente o que ela existe para fazer.
