# Avaliação com o Laya na GPU + prompt-builder (24/11/2026)

Duas perguntas, dois instrumentos:

1. **A IA que separa as notícias pode ser o Laya?** — medido com o modelo real na GPU (ONNX Runtime
   CUDA, RTX 4070), 5 cenários × 42 artigos do gabarito (`eval/golden.json`), duas redações do
   prompt (produção e rubrica).
2. **A redação do prompt de relevância melhora o resultado?** — medido com o `prompt-builder` sobre
   28 casos pinados do mesmo gabarito, comparando a redação de produção (`v0`, `src/llm.js`) com a
   vencedora do eval do repo (`v2_fewshot`, `eval/prompts.mjs`).

## 1. Laya na GPU — a pergunta de relevância

`laya_gpu_eval.py` · modelo `laya-typed-decisions` fp32 (1,61 GB) · `CUDAExecutionProvider` ·
65–115 ms por decisão · estado = consulta + título + `summary_pt` + 600 caracteres do corpo.

| variante | F1 | precisão | recall | acurácia 3-vias | kind | ms/decisão |
| --- | --- | --- | --- | --- | --- | --- |
| **antes** `v0_prod` | 0,365 | 0,224 | 1,000 | 0,162 | 0,648 | 65,8 |
| **depois** `v1_rubric` | 0,365 | 0,224 | 1,000 | 0,148 | 0,567 | 115,3 |

**Veredito: o Laya não separa notícias.** As probabilidades ficam achatadas (0,39 / 0,38 / 0,23) e ele
responde "é o foco" para quase tudo — inclusive para artigos sem relação nenhuma com a consulta
(ex.: "overclocked a Raspberry Pi Pico" → direct 0,53). Nenhuma redação de prompt muda isso, porque
o problema é de **tarefa**, não de frase: o Laya é um modelo de decisões curtas e calibradas
(escolher entre 2–10 rótulos com nomes), não um leitor de artigos.

**Sanidade do harness** (para não culpar o código): a pergunta que o app faz — "Em qual projeto do DSH
o utilizador quer trabalhar?" com 4 projetos — responde **newsletter-crawler 0,663** na mesma sessão,
que é o resultado correto e o mesmo que a bateria do app no Mac mede. O harness está fiel; o modelo é
que não serve para relevância.

Reproduzir (na máquina com GPU; precisa do modelo e do `nc-pool.json` exportado do banco):

```bash
python eval/laya/laya_gpu_eval.py --model-dir <modelo> --pool-json <nc-pool.json> \
    --golden eval/golden.json --provider cuda --state-mode summary \
    --json-out eval/laya/resultado-gpu-summary.json
```

## 2. prompt-builder — as duas redações do prompt

`arena.json` gerado por `gerar-config-prompt-builder.py`: 28 casos pinados (10 direct, 8 similar, 10
none), `expected` + `labelSet` determinísticos, duas variantes escritas à mão
(`variation.optimize: false`), competidor `deepseek/deepseek-v4.1-flash`, orçamento US$ 4 (gastou
**US$ 0,0246** em 84 chamadas).

| variante | acertos (3-vias) | precisão | recall | F1 | respostas d/s/n |
| --- | --- | --- | --- | --- | --- |
| **antes** `v0_prod` (e o controle, idêntico) | 10/28 (**35,7 %**) | 0,000 | 0,000 | 0,000 | 0/0/28 |
| **depois** `v2_fewshot` | 12/28 (**42,9 %**) | 1,000 | 0,111 | 0,200 | 0/2/26 |

**Veredito: a redação melhor é 7,2 p.p. melhor**, mas o harness do prompt-builder deixa o modelo
colapsar em "none" (sem schema JSON imposto e com esforço baixo) — os números absolutos aqui não são
comparáveis aos do `eval/REPORT.md`, que aperta o formato e usa `effort: high`. Serve como ranking
relativo, e ele concorda com o eval do repo.

## 3. O antes/depois que conta (eval do repo, `eval/REPORT.md`)

Mesmo gabarito, 3 rodadas, 36 artigos, formato JSON imposto, `effort: high`:

| prompt | modelo | F1 | acurácia 3-vias | kind |
| --- | --- | --- | --- | --- |
| **antes** `v0_baseline` | flash | 0,731 | 0,856 | 0,969 |
| **antes** `v0_baseline` | pro | 0,778 | 0,900 | 0,950 |
| **depois** `v2_fewshot` | flash | **0,848** | 0,926 | 0,919 |
| **depois** `v2_fewshot` | pro | 0,807 | 0,931 | 0,907 |

**+11,7 p.p. de F1** com o mesmo modelo barato (flash) e **+7,0 p.p. de acurácia 3-vias**.

## Conclusão

- A separação de notícias **fica com o prompt generativo** (`v2_fewshot`), não com o Laya: a diferença
  entre 0,848 (generativo) e 0,365 (Laya) é de tarefa, e nenhuma redação fecha essa distância.
- O **Laya continua certo onde é forte**: as perguntas curtas do app (projeto, intenção, clareza),
  agora na GPU desta máquina a 65–115 ms por decisão.
- O ajuste fino do prompt de relevância **vale +11,7 p.p. de F1** no eval do repo e o prompt-builder
  confirma a mesma ordem numa amostra independente.
