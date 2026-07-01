# Relatório do eval de prompt — relevância (DeepSeek V4 Flash vs Pro)

Rodadas agregadas: **3** (round-1.json..round-3.json) · pool=36 · cenários=5 · effort=high
Métrica primária: **F1 macro** de relevância binária (relevant = direct∪similar), média sobre cenários e rodadas. Gabarito: Opus 4.8 (eval/golden.json).

| # | variante | modelo | F1 (μ±σ) | Precisão | Recall | acc 3-vias | kind acc | latência | JSON fails |
|---|---|---|---|---|---|---|---|---|---|
| 1 | v2_fewshot | flash | **0.848** ±0.02 | 0.787 | 0.933 | 0.926 | 0.919 | 5178ms | 0.0 |
| 2 | v2_fewshot | pro | **0.807** ±0.03 | 0.835 | 0.789 | 0.931 | 0.907 | 5967ms | 0.0 |
| 3 | v3_evidence | flash | **0.795** ±0.02 | 0.722 | 0.900 | 0.898 | 0.944 | 5346ms | 0.0 |
| 4 | v4_decompose | flash | **0.784** ±0.01 | 0.689 | 0.933 | 0.883 | 0.835 | 7790ms | 0.0 |
| 5 | v1_rubric | pro | **0.780** ±0.01 | 0.718 | 0.867 | 0.883 | 0.952 | 6636ms | 0.0 |
| 6 | v0_baseline | pro | **0.778** ±0.01 | 0.710 | 0.889 | 0.900 | 0.950 | 6240ms | 0.0 |
| 7 | v3_evidence | pro | **0.777** ±0.03 | 0.747 | 0.833 | 0.891 | 0.920 | 6349ms | 0.0 |
| 8 | v1_rubric | flash | **0.773** ±0.03 | 0.665 | 0.944 | 0.872 | 0.946 | 5139ms | 0.0 |
| 9 | v4_decompose | pro | **0.734** ±0.01 | 0.652 | 0.889 | 0.850 | 0.856 | 11378ms | 0.0 |
| 10 | v0_baseline | flash | **0.731** ±0.01 | 0.591 | 0.978 | 0.856 | 0.969 | 5299ms | 0.0 |

**Melhor:** `v2_fewshot` / flash — F1 0.848.
- Melhor **flash**: `v2_fewshot` (F1 0.848, acc3 0.926, 5178ms).
- Melhor **pro**: `v2_fewshot` (F1 0.807, acc3 0.931, 5967ms).

## Erros mais frequentes (cenário:id → nº rodadas)
- `v2_fewshot/flash` — FP: S1:3(3), S1:17(3), S1:16(3), S2:60(3), S5:56(3), S5:3(2) · FN: S2:56(3), S2:197(1), S4:23(1), S5:54(1)
- `v2_fewshot/pro` — FP: S1:16(3), S5:56(3), S1:17(2), S2:60(2), S3:56(1), S4:25(1) · FN: S1:60(3), S2:197(3), S2:56(3), S4:23(3), S5:54(3), S1:27(2)
- `v3_evidence/flash` — FP: S2:60(3), S2:157(3), S5:56(3), S1:3(2), S1:16(2), S2:101(2) · FN: S1:60(3), S2:56(2), S2:197(2), S1:27(1), S1:101(1)
- `v4_decompose/flash` — FP: S1:3(3), S1:16(3), S1:17(3), S2:60(3), S2:157(3), S3:136(3) · FN: S2:56(2), S4:23(1), S5:136(1), S1:60(1), S2:197(1)
- `v1_rubric/pro` — FP: S1:17(3), S1:16(3), S2:95(3), S3:136(3), S5:3(3), S5:56(3) · FN: S2:56(3), S5:54(3), S1:60(2), S2:197(1), S1:27(1), S4:23(1)
- `v0_baseline/pro` — FP: S1:3(3), S1:16(3), S1:17(3), S2:60(3), S2:157(3), S5:3(3) · FN: S2:56(3), S2:197(2), S4:23(2), S1:60(1), S1:27(1), S4:28(1)

## F1 por cenário (melhor variante de cada modelo)
- **flash** `v2_fewshot`: S1=0.800 · S2=0.735 · S3=0.933 · S4=0.944 · S5=0.828
- **pro** `v2_fewshot`: S1=0.687 · S2=0.731 · S3=0.923 · S4=0.884 · S5=0.812
