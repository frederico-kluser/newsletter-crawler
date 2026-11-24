#!/usr/bin/env python3
"""Antes/depois do prompt de relevância do newsletter-crawler, com o **Laya** (System One) na GPU.

O `judgeRelevance` do produto é uma decisão tipada disfarçada de texto: (1) o artigo é o foco da
consulta, é adjacente, ou não tem relação; (2) é sobre uma ferramenta ou é notícia. O Laya responde
exatamente esse tipo de pergunta (choice calibrado), então ele mede o **prompt** sem o ruído de um
modelo generativo: mesma pergunta, duas redações, mesma gabarito.

- **Antes (v0_prod):** a redação do `src/llm.js` (`judgeRelevance`), sem rubrica e sem guardas.
- **Depois (v1_rubric):** rubrica no contexto (o que a pergunta do Laya não comporta), guarda contra
  falso-positivo de tópico amplo, guarda de `kind` (tutorial ≠ ferramenta; release de ferramenta =
  ferramenta) e exemplos curtos — o que o eval generativo do repo elegeu (`v2_fewshot`, F1 0.848).

Métricas iguais às do `eval/REPORT.md`: **F1 macro** de relevância binária (relevant =
direct ∪ similar), precisão, recall, acurácia 3-vias e acurácia de `kind`, média por cenário.

Uso (na máquina com a GPU):
  python eval/laya/laya_gpu_eval.py \
      --model-dir C:/Users/kluse/Models/laya-typed-decisions \
      --pool-json C:/Users/kluse/Models/laya-typed-decisions/nc-pool.json \
      --golden eval/golden.json --provider dml
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_FILE = "laya-typed-decisions-fp32.onnx"
TOKENIZER_FILE = "tokenizer.json"
CONFIG_FILE = "rl_agent_config.json"
MAX_STATE_CHARS = 2000  # o motor corta o estado aqui; o prompt tem de caber
QTYPES = {"choice": 0, "score": 1, "noul": 2}
QTYPE_NAMES = {v: k for k, v in QTYPES.items()}
OPTION_CAP = 48
TEMP_MIN, TEMP_MAX = 0.5, 5.0
MASK_TOKEN = "[MASK]"


# --------------------------------------------------------------------------------------------
# Codificação do Laya (spec §3–§7, a mesma que o app usa; ver SystemOne/LayaEncoding.swift)
# --------------------------------------------------------------------------------------------
def render_options(q):
    t, crit = q["t"], q.get("crit")
    if t == "choice":
        return [str(k) if v is None or v == "" else "%s: %s" % (k, v) for k, v in crit.items()]
    raise ValueError("só choice neste eval")


def encode(tok, text):
    return tok.encode(text, add_special_tokens=False).ids


def build_sequence(tok, ids_of, state_ids, q, max_len, head_max_len):
    opts = render_options(q)
    ins = str(q["ins"]).replace(MASK_TOKEN, " ")
    header = "%s question: %s" % (q["t"], ins)
    head_ids = encode(tok, header)
    opt_ids = []
    for o in opts:
        opt_tokens = encode(tok, " " + o.replace(MASK_TOKEN, " "))[:OPTION_CAP]
        opt_ids.append([ids_of["[MASK]"]] + opt_tokens)
    opt_budget = head_max_len - sum(len(o) for o in opt_ids)
    per_option = None
    if opt_budget < 16:
        per = max(4, (head_max_len - 16) // max(1, len(opt_ids)))
        per_option = per
        opt_ids = [o[:per] for o in opt_ids]
        opt_budget = head_max_len - sum(len(o) for o in opt_ids)
    head_ids = head_ids[: max(8, opt_budget)]
    ids = [ids_of["[CLS]"]] + head_ids + [ids_of["[SEP]"]]
    markers = []
    for o in opt_ids:
        markers.append(len(ids))
        ids.extend(o)
    ids.append(ids_of["[SEP]"])
    room = max(0, max_len - len(ids) - 1)
    st = state_ids[:room]
    ids = ids + st + [ids_of["[SEP]"]]
    ids, markers = ids[:max_len], [m for m in markers if m < max_len]
    return ids, markers, header, opts, per_option


def temp_bucket(qtype, k):
    size = "2" if k <= 2 else "3-5" if k <= 5 else "6-10" if k <= 10 else "11+"
    return "%s:%s" % (QTYPE_NAMES[int(qtype)], size)


def clamp_temperature(t, lo=TEMP_MIN, hi=TEMP_MAX):
    try:
        t = float(t)
    except (TypeError, ValueError):
        return lo
    return max(lo, min(hi, t))


def confidence_from_probs(p, k):
    k = max(1, k)
    if k <= 1:
        return 1.0
    p = np.clip(np.asarray(p, dtype=np.float64), 1e-12, 1.0)
    h = -np.sum(p * np.log(p))
    return float(1.0 - h / np.log(k))


# --------------------------------------------------------------------------------------------
# As duas redações do prompt (antes / depois)
# --------------------------------------------------------------------------------------------
V0_RELATION = "O ARTIGO é o foco da CONSULTA, é adjacente, ou não tem relação?"
V0_RELATION_OPTIONS = {
    "direct": "o artigo trata DIRETAMENTE do que a consulta pede (é o foco)",
    "similar": "relacionado/adjacente mas não é o foco",
    "none": "não há relação real",
}
V0_KIND = "O ARTIGO é SOBRE uma ferramenta (pacote npm, biblioteca, framework, CLI e o que ela faz/como usar)?"
V0_KIND_OPTIONS = {
    "tool": "o artigo é sobre uma ferramenta",
    "news": "notícia, lançamento, análise, tutorial, opinião ou paper",
}

# A rubrica vive no CONTEXTO (`state`): a pergunta do Laya é curta por construção.
AFTER_RUBRIC = (
    "RUBRICA (aplique à risca, sem expandir o tópico da consulta):\n"
    "- direct: o artigo responde ao que a consulta pede e é o assunto principal dele.\n"
    "- similar: o mesmo domínio, mas o assunto principal é outro (ex.: a consulta é \"gerenciadores de\n"
    "  pacotes\" e o artigo é sobre \"monorepo com workspaces\").\n"
    "- none: tópico amplo apenas (ex.: \"JavaScript\" genérico, carreira, opinião sem o tema).\n"
    "GUARDA DE TÓPICO AMPLO: se o único elo for ser da mesma linguagem/ecossistema, é none.\n"
    "GUARDA DE kind: tutorial que USA a ferramenta = news; lançamento de versão de uma ferramenta,\n"
    "guia de instalação/configuração, comparação de ferramentas = tool.\n"
    "EXEMPLO: consulta \"gerenciadores de pacotes\"; artigo \"npm 12 acelera o install com cache\" →\n"
    "direct + tool. Artigo \"por que adotamos pnpm no nosso monorepo\" → similar + tool.\n"
    "Artigo \"carreira em JavaScript em 2026\" → none + news.\n\n"
)

AFTER_RELATION = "Com a rubrica do contexto, o ARTIGO é o foco da CONSULTA, adjacente, ou sem relação?"
AFTER_RELATION_OPTIONS = {
    "direct": "é o foco: responde ao que a consulta pede",
    "similar": "mesmo domínio, assunto principal outro",
    "none": "só tópico amplo ou sem relação",
}
AFTER_KIND = "Com as guardas do contexto, o ARTIGO é SOBRE uma ferramenta ou é notícia/ensaio?"
AFTER_KIND_OPTIONS = {
    "tool": "a ferramenta é o assunto (inclui release, guia e comparação de ferramentas)",
    "news": "notícia, tutorial que usa a ferramenta, opinião, case ou paper",
}


def state_of(variant: str, query: str, article: dict, mode: str = "summary") -> str:
    """O estado que o Laya lê. `summary` = título + resumo pt-BR + 600 caracteres do corpo (o que o
    produto já tem em `summary_pt`, e o que cabe nos 2000 caracteres do motor mesmo com a rubrica);
    `content` = só o corpo, como o prompt generativo faz (mas cortado pelo motor)."""
    title = article.get("title") or ""
    if mode == "content":
        text = "CONSULTA: %s\n\nARTIGO\nTítulo: %s\n\nConteúdo:\n%s" % (query, title, (article.get("content") or "")[:2000])
    else:
        summary = (article.get("summary_pt") or "").strip() or (article.get("blurb") or "").strip()
        body = (article.get("content") or "")[:600]
        text = "CONSULTA: %s\n\nARTIGO\nTítulo: %s\nResumo: %s\nInício do texto: %s" % (query, title, summary, body)
    return (AFTER_RUBRIC + text) if variant == "v1_rubric" else text


def questions_of(variant: str):
    if variant == "v1_rubric":
        relation = {"t": "choice", "ins": AFTER_RELATION, "crit": AFTER_RELATION_OPTIONS}
        kind = {"t": "choice", "ins": AFTER_KIND, "crit": AFTER_KIND_OPTIONS}
    else:
        relation = {"t": "choice", "ins": V0_RELATION, "crit": V0_RELATION_OPTIONS}
        kind = {"t": "choice", "ins": V0_KIND, "crit": V0_KIND_OPTIONS}
    return relation, kind


# --------------------------------------------------------------------------------------------
# Execução
# --------------------------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-dir", default="C:/Users/kluse/Models/laya-typed-decisions")
    ap.add_argument("--pool-json", default="C:/Users/kluse/Models/laya-typed-decisions/nc-pool.json")
    ap.add_argument("--golden", default="eval/golden.json")
    ap.add_argument("--variants", default="v0_prod,v1_rubric")
    ap.add_argument("--provider", default="cuda", choices=["cuda", "dml", "cpu"])
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--state-mode", default="summary", choices=["summary", "content"])
    ap.add_argument("--json-out", default="eval/laya/resultado-gpu.json")
    args = ap.parse_args()

    cfg = json.load(open(os.path.join(args.model_dir, CONFIG_FILE)))
    max_len, head_max_len = int(cfg["max_len"]), int(cfg["head_max_len"])
    temperature = [clamp_temperature(t) for t in cfg["temperature"]]
    temperature_by_options = {k: clamp_temperature(v) for k, v in cfg["temperature_by_options"].items()}

    tok = Tokenizer.from_file(os.path.join(args.model_dir, TOKENIZER_FILE))
    ids_of = {t: tok.token_to_id(t) for t in ("[CLS]", "[SEP]", "[PAD]", "[MASK]", "[UNK]")}

    if args.provider != "cpu":
        # ONNX Runtime GPU: as DLLs do CUDA 12 vêm nos pacotes `nvidia-*` (pip) e não estão no PATH.
        import glob
        import site
        dll_dirs: list[str] = []
        for base in site.getsitepackages() + [site.getusersitepackages()]:
            dll_dirs += glob.glob(os.path.join(base, "nvidia", "*", "bin"))
        for d in dll_dirs:
            try:
                os.add_dll_directory(d)
            except (AttributeError, OSError):
                pass
        # O `onnxruntime_providers_cuda.dll` carrega as DLLs do CUDA por `LoadLibrary` simples: só o
        # PATH conta (`AddDllDirectory` não serve). Sem isto o EP cai calado para CPU.
        os.environ["PATH"] = ";".join(dll_dirs) + ";" + os.environ.get("PATH", "")
    wanted = {"cuda": ["CUDAExecutionProvider"], "dml": ["DmlExecutionProvider"], "cpu": []}[args.provider]
    providers = wanted + ["CPUExecutionProvider"] if wanted else ["CPUExecutionProvider"]
    so = ort.SessionOptions()
    so.intra_op_num_threads = args.threads
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    t0 = time.perf_counter()
    sess = ort.InferenceSession(os.path.join(args.model_dir, MODEL_FILE), so, providers=providers)
    load_s = time.perf_counter() - t0
    active = sess.get_providers()
    print("Laya: onnxruntime %s · providers %s · sessão em %.1f s" % (ort.__version__, active, load_s))

    def decide(state: str, q: dict) -> tuple[str, float, float]:
        state_cut = state[:MAX_STATE_CHARS]
        state_ids = encode(tok, state_cut.replace(MASK_TOKEN, " "))
        ids, markers, _header, opts, _per = build_sequence(tok, ids_of, state_ids, q, max_len, head_max_len)
        k = len(markers)
        qt = QTYPES[q["t"]]
        t_scale = temperature_by_options.get(temp_bucket(qt, k), temperature[qt])
        feeds = {
            "input_ids": np.array([ids], dtype=np.int64),
            "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
            "marker_pos": np.array([markers], dtype=np.int64),
            "marker_mask": np.ones((1, k), dtype=bool),
            "qtype": np.array([qt], dtype=np.int64),
        }
        t1 = time.perf_counter()
        try:
            logits, _act = sess.run(None, feeds)
        except Exception as error:  # o EP recusou este grafo (ex.: DirectML e um Reshape do ModernBERT)
            print("AVISO: %s falhou (%s) — esta corrida vai em CPU" % (args.provider, str(error).splitlines()[0][:160]))
            raise SystemExit(12)
        ms = (time.perf_counter() - t1) * 1000
        z = logits[0, :k].astype(np.float64) / t_scale
        p = np.exp(z - z.max())
        p = p / p.sum()
        names = list(q["crit"].keys())
        best = int(np.argmax(p))
        return names[best], float(p[best]), ms

    golden = json.load(open(args.golden, encoding="utf-8"))
    pool_ids = golden["pool"]
    kind_tool = set(golden["kindTool"])
    articles = {a["id"]: a for a in json.load(open(args.pool_json, encoding="utf-8"))["articles"]}
    pool = [pid for pid in pool_ids if pid in articles]
    print("corpus: %d artigos do pool · %d cenários" % (len(pool), len(golden["scenarios"])))

    results = {}
    for variant in [v.strip() for v in args.variants.split(",") if v.strip()]:
        relation_q, kind_q = questions_of(variant)
        per_scenario = []
        latencies = []
        for scn in golden["scenarios"]:
            tp = fp = fn = 0
            correct3 = correct_kind = 0
            detail = []
            for pid in pool:
                article = articles[pid]
                state = state_of(variant, scn["query"], article, args.state_mode)
                relation, conf, ms = decide(state, relation_q)
                kind, conf_kind, ms_kind = decide(state, kind_q)
                latencies.extend([ms, ms_kind])
                truth = "direct" if pid in scn["direct"] else ("similar" if pid in scn["similar"] else "none")
                truth_relevant = truth in ("direct", "similar")
                said_relevant = relation in ("direct", "similar")
                if truth_relevant and said_relevant:
                    tp += 1
                elif truth_relevant and not said_relevant:
                    fn += 1
                elif not truth_relevant and said_relevant:
                    fp += 1
                correct3 += int(relation == truth)
                correct_kind += int((kind == "tool") == (pid in kind_tool))
                detail.append({"id": pid, "relation": relation, "truth": truth, "kind": kind, "conf": round(conf, 4)})
            precision = tp / (tp + fp) if (tp + fp) else 0.0
            recall = tp / (tp + fn) if (tp + fn) else 0.0
            f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
            per_scenario.append({
                "scenario": scn["id"],
                "f1": round(f1, 4),
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "acc3": round(correct3 / len(pool), 4),
                "kindAcc": round(correct_kind / len(pool), 4),
                "items": len(pool),
                "detail": detail,
            })
        macro = lambda key: round(sum(s[key] for s in per_scenario) / len(per_scenario), 4)  # noqa: E731
        results[variant] = {
            "variant": variant,
            "f1": macro("f1"),
            "precision": macro("precision"),
            "recall": macro("recall"),
            "acc3": macro("acc3"),
            "kindAcc": macro("kindAcc"),
            "msPorDecisao": round(sum(latencies) / len(latencies), 1),
            "decisoes": len(latencies),
            "perScenario": per_scenario,
        }
        print("  %-11s F1 %.3f · P %.3f · R %.3f · acc3 %.3f · kind %.3f · %.1f ms/décisão"
              % (variant, results[variant]["f1"], results[variant]["precision"], results[variant]["recall"],
                 results[variant]["acc3"], results[variant]["kindAcc"], results[variant]["msPorDecisao"]))

    out = {
        "modelo": "laya-typed-decisions fp32 (System One)",
        "providers": active,
        "hardware": os.environ.get("COMPUTERNAME", ""),
        "stateMode": args.state_mode,
        "pool": len(pool),
        "cenarios": len(golden["scenarios"]),
        "variantes": results,
    }
    os.makedirs(os.path.dirname(args.json_out), exist_ok=True)
    json.dump(out, open(args.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("resultado: %s" % args.json_out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
