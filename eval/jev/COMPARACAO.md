# COMPARAÇÃO — Jev via OpenRouter × Laya × prompt-builder

O mesmo gabarito de relevância (`eval/golden.json`), quatro motores. Reproduz tudo com
`eval/jev/openrouter_relevance.py` (Jev), `eval/laya/laya_gpu_eval.py` (Laya) e
`eval/prompt-builder/{arena.json,pontuacao.json}` (prompt-builder).

O Jev é consultado pela **Decisions API** do OpenRouter — `POST /api/alpha/decisions` com
`{model, state, questions}`, a mesma porta do `webapp/api/_lib/jev.js`, **nunca** chat. Uma chamada
responde as duas perguntas (`rel` choice 3 + `kind` choice 2) e devolve `{choice, probabilities,
confidence}`.

```bash
OPENROUTER_API_KEY=... python eval/jev/openrouter_relevance.py --pool-json <nc-pool.json> --limit 28
OPENROUTER_API_KEY=... python eval/jev/openrouter_relevance.py --pool-json <nc-pool.json> --all
```

Custo e tempo reais: **0,36 s/caso**, **US$ 0,00006/caso** (28 casos = US$ 0,0016; 210 = US$ 0,012).

## 1. Os mesmos 28 casos (10 direct, 8 similar, 10 none)

| motor | redação | acc3 | F1 | kind | previsto d/s/n | tempo/caso | US$/caso |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Jev** `typesafe/jev-1.13` | **antes** (`v0_prod`) | **0,500** | 0,364 | 0,536 | 0/4/24 | 0,36 s | 0,00006 |
| **Jev** | **depois** (`v1_rubric`) | 0,429 | 0,333 | **0,714** | 0/6/22 | 0,37 s | 0,00007 |
| **Laya** (GPU, fp32) | antes | 0,464 | 0,783¹ | 0,750 | 6/22/0 | 0,09 s | 0 |
| **Laya** | depois | 0,321 | 0,783¹ | **0,857** | 6/22/0 | 0,12 s | 0 |
| **prompt-builder** (DeepSeek V4.1 Flash) | antes | 0,357 | 0,000 | — | 0/0/28 | 1,6 s | 0,00024 |
| **prompt-builder** | depois (`v2_fewshot`) | 0,429 | 0,200 | — | 0/2/26 | 1,6 s | 0,00024 |

¹ O F1 do Laya só é alto porque ele responde "relevante" a **tudo** (recall 1,000, precisão 0,643):
numa amostra com 64 % de positivos isso infla o F1 e esconde que ele nunca diz "none" — a coluna
`previsto` mostra o colapso (0/22/0).

## 2. O gabarito inteiro (210 casos)

| motor | redação | acc3 | F1 | kind | previsto d/s/n |
| --- | --- | --- | --- | --- | --- |
| **Jev** | antes | **0,695** | 0,205 | 0,424 | 6/25/179 |
| **Jev** | depois | 0,662 | 0,209 | **0,605** | 7/32/171 |
| **Laya** | antes | 0,162 | 0,365 | 0,648 | 132/78/0 |
| **Laya** | depois | 0,148 | 0,365 | 0,567 | 133/77/0 |

O golden tem 74 % de `none`, então a `acc3` premia quem diz "none": o Jev acerta a maioria (179/210)
mas perde quase todos os relevantes (F1 0,205); o Laya pega todos os relevantes e marca tudo como
relevante (zero `none`).

## 3. O que isso diz

- **O Jev é o melhor dos decisores tipados** nesta tarefa: melhor `acc3` nas duas amostras (0,500 e
  0,695), 4× mais rápido e 4× mais barato que o flash do prompt-builder, e o único em que a redação
  nova melhora um eixo de verdade — `kind` de 0,536 para **0,714** (+17,8 p.p.).
- **A rubrica não ajuda a relevância em nenhum decisor** (Jev 0,500→0,429; Laya 0,464→0,321; só o
  flash melhora 0,357→0,429). O ganho grande do `eval/REPORT.md` (F1 0,731 → 0,848) vem do
  **formato imposto** (JSON schema) e do `effort: high`, não da prosa da rubrica.
- **Nenhum decisor tipado chega perto do generativo com schema** (0,848 de F1): a separação de
  notícias continua no prompt generativo; o Jev serve bem como segunda opinião barata ou para o eixo
  `kind`, onde é o melhor.

## 4. Ver também

- `eval/laya/README.md` — Laya na GPU, o harness e a sanidade.
- `eval/REPORT.md` — o antes/depois do prompt generativo (3 rodadas, formato imposto).
