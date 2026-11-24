"""Gera a run do prompt-builder para o prompt de relevância do newsletter-crawler.

50 casos pinados do gabarito real (10 por cenário: direct/similar/none balanceados), com `expected`
+ `labelSet` — o veredito é determinístico, sem juiz. Duas variantes escritas à mão: a de produção
(v0) e a melhor do eval do repo (v2_fewshot). O modelo sob teste é o mesmo do eval (DeepSeek V4.1
Flash), para o antes/depois ser comparável com o `eval/REPORT.md`.

Uso: python eval/laya/gerar-config-prompt-builder.py --pool-json <nc-pool.json> --out arena.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict


# v0 = src/llm.js `judgeRelevance` (o system prompt de produção).
V0_SYSTEM = "Você avalia se um ARTIGO técnico é relevante para uma CONSULTA de busca. Responda apenas com JSON."

# v2 = a variante eleita pelo eval do repo (`eval/prompts.mjs`, v2_fewshot: F1 0.848 no flash).
V2_SYSTEM = (
    "Você é um avaliador de relevância de busca, rigoroso e consistente. Classifique o ARTIGO em "
    "relação à CONSULTA seguindo a rubrica à risca. Responda APENAS com JSON válido.\n"
    "RUBRICA:\n"
    "- direct: o artigo responde ao que a consulta pede e é o assunto principal dele.\n"
    "- similar: o mesmo domínio, mas o assunto principal é outro.\n"
    "- none: apenas o tópico amplo (ex.: \"JavaScript\" genérico), carreira, opinião sem o tema, ou nada.\n"
    "GUARDA DE TÓPICO AMPLO: se o único elo for ser da mesma linguagem/ecossistema, é none.\n"
    "kind: \"tool\" quando o artigo é SOBRE a ferramenta (release, guia, comparação, uso); tutorial que "
    "apenas USA a ferramenta é \"news\".\n"
    "EXEMPLOS:\n"
    "consulta \"gerenciadores de pacotes\"; \"npm 12 acelera o install com cache\" -> direct + tool.\n"
    "consulta \"gerenciadores de pacotes\"; \"por que adotamos pnpm no nosso monorepo\" -> similar + tool.\n"
    "consulta \"gerenciadores de pacotes\"; \"carreira em JavaScript em 2026\" -> none + news.\n"
    "Formato: {\"relation\":\"direct|similar|none\",\"kind\":\"tool|news\"}."
)

USER_TEMPLATE = """CONSULTA: {query}

ARTIGO
Título: {title}

Conteúdo:
{content}"""

RUBRIC = (
    'Responda o JSON {"relation","kind"}. relation: direct = o artigo trata DIRETAMENTE do que a '
    "consulta pede (é o foco); similar = relacionado/adjacente mas não é o foco; none = não há relação "
    'real. kind: tool = o artigo é SOBRE uma ferramenta (pacote/biblioteca/framework/CLI); news = '
    "qualquer outro."
)


EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
IP = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


def scrubbed(text: str) -> str:
    """O eval não precisa de contacto nenhum: mascara e-mails e IPs antes de o texto viajar."""
    text = EMAIL.sub("***@***", text)
    return IP.sub("***.***.***.***", text)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--golden", default="eval/golden.json")
    ap.add_argument("--pool-json", default=r"C:\Users\kluse\Models\laya-typed-decisions\nc-pool.json")
    ap.add_argument("--per-scenario", type=int, default=6)
    ap.add_argument("--out", default="eval/prompt-builder/arena.json")
    args = ap.parse_args()

    golden = json.load(open(args.golden, encoding="utf-8"))
    articles = {a["id"]: a for a in json.load(open(args.pool_json, encoding="utf-8"))["articles"]}

    scenarios = []
    for scn in golden["scenarios"]:
        groups = defaultdict(list)
        for pid in golden["pool"]:
            if pid not in articles:
                continue
            truth = "direct" if pid in scn["direct"] else ("similar" if pid in scn["similar"] else "none")
            groups[truth].append(pid)
        # Equilíbrio direct/similar/none dentro do cenário (o gabarito tem mais none).
        take = args.per_scenario
        picked = []
        for truth in ("direct", "similar", "none"):
            picked += groups[truth][: max(1, take // 3)]
        picked = picked[:take]
        for pid in picked:
            article = articles[pid]
            content = scrubbed((article.get("content") or "")[:6000])
            truth = "direct" if pid in scn["direct"] else ("similar" if pid in scn["similar"] else "none")
            scenarios.append({
                "id": f"{scn['id']}-{pid}",
                "question": USER_TEMPLATE.format(query=scn["query"], title=article.get("title") or "", content=content),
                "productContext": V0_SYSTEM,
                "rubric": RUBRIC,
                "expected": truth,
                "labelSet": ["direct", "similar", "none"],
                # Gabarito já conhecido: sem isto o prompt-builder paga uma chamada de referência
                # por cenário (41 chamadas) antes de começar a medir.
                "reference": "{\"relation\":\"%s\",\"kind\":\"news\"}" % truth,
            })

    config = {
        "format": "arena-config@1",
        "mode": "variation",
        "theme": "Relevância de artigos técnicos para consultas de boletim (newsletter-crawler)",
        "scenarioBrief": "O judgeRelevance do produto decide se um artigo é foco, adjacente ou sem relação com a consulta do boletim; o antes/depois compara a redação de produção com a vencedora do eval.",
        "stages": len(scenarios),
        "scenarios": scenarios,
        "prompt": {"text": V0_SYSTEM},
        "models": {
            "datagen": "xiaomi/mimo-v2.6-pro",
            "judges": ["google/gemini-3.8-flash"],
            "reference": "z-ai/glm-5.3-flash",
            "contestant": "deepseek/deepseek-v4.1-flash",
        },
        "effort": {"judge": "low", "datagen": "low"},
        "variation": {
            "optimize": False,
            "manualVariants": [
                {"label": "v0_prod", "systemPrompt": V0_SYSTEM},
                {"label": "v2_fewshot", "systemPrompt": V2_SYSTEM},
            ],
        },
        "finalists": 2,
        "duels": False,
        "limits": {"maxOutputTokens": 400},
        "piiMode": "synthetic",
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump(config, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    counts = defaultdict(int)
    for s in scenarios:
        counts[s["expected"]] += 1
    print("config:", args.out, "· cenários:", len(scenarios), dict(counts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
