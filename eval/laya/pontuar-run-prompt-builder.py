"""Pontua a run do prompt-builder contra o gabarito (`expected`) de cada cenário.

O prompt-builder guarda a resposta crua de cada variante e o `expected` de cada cenário; o
`judge` dele comparou o JSON inteiro com a `reference` (que aqui só fixava a relação), então a
contagem útil é a do produto: `relation` previsto vs. gabarito. Mesma métrica do `eval/REPORT.md`
(acurácia 3-vias); a binária (relevant = direct∪similar) sai do mesmo par.

Uso: python eval/laya/pontuar-run-prompt-builder.py --run eval/prompt-builder/run.json
"""

from __future__ import annotations

import argparse
import json
import re

LABELS = ["direct", "similar", "none"]
NAMES = {"original": "controle (base)", "m0": "v0_prod (antes)", "m1": "v2_fewshot (depois)"}
RELATION = re.compile(r'"relation"\s*:\s*"(direct|similar|none)"')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run", default="eval/prompt-builder/run.json")
    ap.add_argument("--json-out", default="eval/prompt-builder/pontuacao.json")
    args = ap.parse_args()
    run = json.load(open(args.run, encoding="utf-8"))["data"]["run"]

    stats: dict[str, dict] = {}
    pairs: dict[str, list[tuple[str, str]]] = {}
    for stage in run["stages"]:
        expected = stage["spec"]["expected"]
        for response in stage["responses"]:
            cid = response["contestantId"]
            stats.setdefault(cid, {"n": 0, "ok": 0, "pred": {label: 0 for label in LABELS}, "exp": {label: 0 for label in LABELS}})
            entry = stats[cid]
            entry["n"] += 1
            entry["exp"][expected] += 1
            match = RELATION.search(response.get("text") or "")
            predicted = match.group(1) if match else "none"
            entry["pred"][predicted] += 1
            entry["ok"] += int(predicted == expected)
            pairs.setdefault(cid, []).append((expected, predicted))

    def binary_metrics(pairs_list: list[tuple[str, str]]) -> tuple[float, float, float]:
        tp = fp = fn = 0
        for expected, predicted in pairs_list:
            truth = expected in ("direct", "similar")
            said = predicted in ("direct", "similar")
            tp += int(truth and said)
            fp += int(not truth and said)
            fn += int(truth and not said)
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        return precision, recall, f1

    print(f"{'variante':22s} {'acerto 3-vias':>14s} {'P':>6s} {'R':>6s} {'F1':>6s}   previsto d/s/n")
    out = {"cenarios": len(run["stages"]), "variantes": {}}
    for cid, entry in sorted(stats.items(), key=lambda kv: -kv[1]["ok"]):
        precision, recall, f1 = binary_metrics(pairs[cid])
        label = NAMES.get(cid, cid)
        print(
            f"{label:22s} {entry['ok']:>3d}/{entry['n']:<3d} ({100 * entry['ok'] / entry['n']:5.1f}%)"
            f" {precision:6.3f} {recall:6.3f} {f1:6.3f}   {entry['pred']['direct']}/{entry['pred']['similar']}/{entry['pred']['none']}"
        )
        out["variantes"][cid] = {
            "label": label,
            "acerto": entry["ok"],
            "n": entry["n"],
            "acuracia": round(entry["ok"] / entry["n"], 4),
            "precisao": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "previu": entry["pred"],
        }
    out["gabarito"] = {label: sum(1 for stage in run["stages"] if stage["spec"]["expected"] == label) for label in LABELS}
    json.dump(out, open(args.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("\ngabarito dos cenários:", out["gabarito"])
    print("resultado:", args.json_out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
