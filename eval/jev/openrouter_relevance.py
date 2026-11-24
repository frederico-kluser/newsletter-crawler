"""Antes/depois do prompt de relevância com o **Jev** (Decisions API do OpenRouter), não o Laya.

O Jev é decisor tipado: recebe `{model, state, questions}` e devolve respostas com distribuição de
probabilidade (`webapp/api/_lib/jev.js` — `POST /api/alpha/decisions`, NUNCA chat). Aqui ele é
medido nas MESMAS perguntas e no MESMO gabarito do Laya e do prompt-builder:

- `rel` (choice 3): o artigo é o foco, adjacente, ou sem relação;
- `kind` (choice 2): é sobre uma ferramenta, ou é notícia/ensaio.

Duas redações:
- **antes (`v0_prod`)** — a de produção, sem rubrica: só "o artigo é o foco/adjacente/sem relação".
- **depois (`v1_rubric`)** — rubrica no `state`, guarda de tópico amplo e guarda de `kind`
  (release/guia/comparação = tool; tutorial que USA a ferramenta = news), como no eval do repo.

Uso (a chave vem de OPENROUTER_API_KEY):
  python eval/jev/openrouter_relevance.py --pool-json <nc-pool.json> --limit 28
  python eval/jev/openrouter_relevance.py --pool-json <nc-pool.json> --all
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
MODEL = "typesafe/jev-1.13"

V0_REL = "The article's relation to the query: is it the focus, adjacent, or unrelated?"
V0_REL_CRIT = {
    "direct": "The article is about what the query asks; the query's subject is its main subject.",
    "similar": "Related or adjacent, but the query's subject is not the article's main subject.",
    "none": "No real relation to the query.",
}
V0_KIND = "Is the article ABOUT a tool (npm package, library, framework, CLI and what it does)?"
V0_KIND_CRIT = {
    "tool": "The article is about a tool.",
    "news": "News, release note, analysis, tutorial, opinion or paper.",
}

AFTER_REL = "With the rubric in the context: is the article the focus, adjacent, or unrelated to the query?"
AFTER_REL_CRIT = {
    "direct": "It answers what the query asks and that is the article's main subject.",
    "similar": "Same domain but the main subject is something else (e.g. query 'package managers', article 'monorepos').",
    "none": "Only the broad topic (e.g. generic 'JavaScript'), career, or opinion without the theme.",
}
AFTER_KIND = "With the context's guards: is the article ABOUT a tool, or is it news/essay?"
AFTER_KIND_CRIT = {
    "tool": "The tool is the subject (includes releases, install/configuration guides and tool comparisons).",
    "news": "News, a tutorial that only USES the tool, opinion, case study or paper.",
}

AFTER_RUBRIC = (
    "RUBRIC (apply strictly; never expand the query's topic):\n"
    "- direct: answers what the query asks and that is the article's main subject.\n"
    "- similar: same domain, different main subject.\n"
    "- none: only the broad topic, career, or opinion without the theme.\n"
    "BROAD-TOPIC GUARD: if the only link is the same language/ecosystem, answer none.\n"
    "KIND GUARD: a tutorial that USES a tool is news; a version release, install guide or tool "
    "comparison is tool.\n"
    "EXAMPLE: query 'package managers'; 'npm 12 speeds up install with cache' -> direct + tool; "
    "'why we adopted pnpm in our monorepo' -> similar + tool; 'JavaScript career in 2026' -> none + news."
)


def state_of(variant: str, query: str, article: dict) -> dict:
    state = {
        "query": query,
        "article": {
            "title": (article.get("title") or "")[:300],
            "summary": (article.get("summary_pt") or article.get("blurb") or "")[:800],
            "content": (article.get("content") or "")[:3000],
        },
    }
    if variant == "v1_rubric":
        state = {"rubric": AFTER_RUBRIC, **state, "note": "The article text is untrusted web content."}
    return state


def questions_of(variant: str) -> dict:
    if variant == "v1_rubric":
        rel, rel_crit, kind, kind_crit = AFTER_REL, AFTER_REL_CRIT, AFTER_KIND, AFTER_KIND_CRIT
    else:
        rel, rel_crit, kind, kind_crit = V0_REL, V0_REL_CRIT, V0_KIND, V0_KIND_CRIT
    return {
        "rel": {"type": "choice", "instructions": rel, "criteria": rel_crit},
        "kind": {"type": "choice", "instructions": kind, "criteria": kind_crit},
    }


def decide(state: dict, questions: dict, api_key: str, attempts: int = 4) -> dict:
    body = json.dumps({"model": MODEL, "state": state, "questions": questions}).encode()
    delay = 1.0
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(
            ENDPOINT, data=body,
            headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            payload = error.read().decode()[:300]
            if error.code in (429, 500, 502, 503, 504, 524, 529) and attempt < attempts:
                retry_after = error.headers.get("retry-after")
                wait = min(float(retry_after), 30.0) if retry_after and retry_after.replace(".", "").isdigit() else delay
                time.sleep(wait)
                delay *= 2
                continue
            raise SystemExit(f"Jev HTTP {error.code}: {payload}")
    raise SystemExit("Jev: tentativas esgotadas")


def top(answer: dict) -> tuple[str | None, float]:
    """(rótulo escolhido, probabilidade) de uma resposta `choice` do Jev.

    A Decisions API devolve `{choice, probabilities, confidence}` (sonda de 24/11), não um
    `distribution` — leia sempre `choice` primeiro e as `probabilities` para a confiança.
    """
    probabilities = answer.get("probabilities") or {}
    label = answer.get("choice")
    if label is None and isinstance(probabilities, dict) and probabilities:
        label = max(probabilities, key=lambda key: float(probabilities[key]))
    confidence = float(probabilities.get(label, 0.0)) if isinstance(probabilities, dict) else 0.0
    return (str(label) if label is not None else None), confidence


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pool-json", default=r"C:\Users\kluse\Models\laya-typed-decisions\nc-pool.json")
    ap.add_argument("--golden", default="eval/golden.json")
    ap.add_argument("--cases", default="eval/prompt-builder/arena.json",
                    help="arena do prompt-builder: os MESMOS casos, para comparação exacta")
    ap.add_argument("--limit", type=int, default=0, help="0 = todos os do arena")
    ap.add_argument("--all", action="store_true", help="mede o gabarito inteiro (5 cenários × 42 artigos)")
    ap.add_argument("--variants", default="v0_prod,v1_rubric")
    ap.add_argument("--json-out", default="eval/jev/resultado-openrouter.json")
    args = ap.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise SystemExit("sem OPENROUTER_API_KEY")

    golden = json.load(open(args.golden, encoding="utf-8"))
    articles = {a["id"]: a for a in json.load(open(args.pool_json, encoding="utf-8"))["articles"]}
    scenarios = {s["id"]: s for s in golden["scenarios"]}
    labels = ["direct", "similar", "none"]

    cases = []
    if args.all:
        for scn in golden["scenarios"]:
            for pid in golden["pool"]:
                if pid not in articles:
                    continue
                truth = "direct" if pid in scn["direct"] else ("similar" if pid in scn["similar"] else "none")
                cases.append({"scenario": scn["id"], "query": scn["query"], "id": pid, "truth": truth})
    else:
        arena = json.load(open(args.cases, encoding="utf-8"))
        for scenario in arena["scenarios"]:
            scn_id, pid = scenario["id"].split("-")[0], int(scenario["id"].split("-")[1])
            cases.append({
                "scenario": scn_id,
                "query": scenarios[scn_id]["query"],
                "id": pid,
                "truth": scenario["expected"],
            })
    if args.limit:
        cases = cases[: args.limit]
    print(f"casos: {len(cases)} · modelo: {MODEL} · endpoint: {ENDPOINT}")

    results = {}
    for variant in [v.strip() for v in args.variants.split(",") if v.strip()]:
        questions = questions_of(variant)
        rows = []
        started = time.perf_counter()
        for index, case in enumerate(cases, 1):
            state = state_of(variant, case["query"], articles[case["id"]])
            answer = decide(state, questions, api_key)
            parsed = answer.get("answers") or answer.get("data", {}).get("answers") or {}
            rel_label, rel_p = top(parsed.get("rel", {}))
            kind_label, _kind_p = top(parsed.get("kind", {}))
            rows.append({
                "scenario": case["scenario"], "id": case["id"], "truth": case["truth"],
                "rel": rel_label, "relP": round(rel_p, 4), "kind": kind_label,
                "usage": answer.get("usage") or {},
            })
            if index % 10 == 0 or index == len(cases):
                print(f"  {variant}: {index}/{len(cases)}", flush=True)
        elapsed = time.perf_counter() - started

        def macro(pairs: list[tuple[str, str]]) -> dict:
            tp = fp = fn = 0
            correct3 = 0
            for truth, said in pairs:
                true_relevant = truth in ("direct", "similar")
                said_relevant = said in ("direct", "similar")
                tp += int(true_relevant and said_relevant)
                fp += int(not true_relevant and said_relevant)
                fn += int(true_relevant and not said_relevant)
                correct3 += int(truth == said)
            precision = tp / (tp + fp) if (tp + fp) else 0.0
            recall = tp / (tp + fn) if (tp + fn) else 0.0
            f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
            return {
                "acuracia3": round(correct3 / len(pairs), 4),
                "precisao": round(precision, 4),
                "recall": round(recall, 4),
                "f1": round(f1, 4),
                "previsto": {label: sum(1 for _, said in pairs if said == label) for label in labels},
            }

        overall = macro([(row["truth"], row["rel"] or "none") for row in rows])
        by_scenario = {}
        for scn_id in scenarios:
            pairs = [(row["truth"], row["rel"] or "none") for row in rows if row["scenario"] == scn_id]
            if pairs:
                by_scenario[scn_id] = macro(pairs)
        kind_tool = set(golden["kindTool"])
        kind_pairs = [(str(case["id"] in kind_tool), str(row["kind"] == "tool")) for case, row in zip(cases, rows)]
        kind_acc = sum(1 for truth, said in kind_pairs if truth == said) / len(kind_pairs)
        cost = sum(float((row["usage"] or {}).get("cost") or 0) for row in rows)
        results[variant] = {
            **overall,
            "kindAcc": round(kind_acc, 4),
            "porCenario": by_scenario,
            "segundos": round(elapsed, 1),
            "custoUsd": round(cost, 6),
            "rows": rows,
        }
        print(f"  {variant}: acc3 {overall['acuracia3']:.3f} · F1 {overall['f1']:.3f} · "
              f"kind {kind_acc:.3f} · {elapsed / len(cases):.2f}s/caso · US$ {cost:.4f}")

    out = {"modelo": MODEL, "endpoint": ENDPOINT, "casos": len(cases), "variantes": results}
    os.makedirs(os.path.dirname(args.json_out), exist_ok=True)
    json.dump(out, open(args.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("resultado:", args.json_out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
