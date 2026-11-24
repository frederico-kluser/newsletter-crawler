"""Sanidade do harness do Laya na GPU + sinal da pergunta de relevância.

O primeiro teste é uma pergunta que o app faz e o Laya acerta na bateria do Mac (qual projeto);
se ela vier certa, a codificação deste harness está fiel e o resultado da relevância é do modelo,
não do código. O segundo imprime as probabilidades de relevância de uma amostra, para ver se há
sinal separável ou se o modelo responde quase sempre a mesma coisa.
"""
import glob
import json
import os
import site

import numpy as np

dirs = []
for base in site.getsitepackages():
    dirs += glob.glob(os.path.join(base, "nvidia", "*", "bin"))
os.environ["PATH"] = ";".join(dirs) + ";" + os.environ.get("PATH", "")

import onnxruntime as ort  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402

import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("laya_gpu_eval", "eval/laya/laya_gpu_eval.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

MD = r"C:\Users\kluse\Models\laya-typed-decisions"
cfg = json.load(open(os.path.join(MD, "rl_agent_config.json")))
tok = Tokenizer.from_file(os.path.join(MD, "tokenizer.json"))
ids_of = {t: tok.token_to_id(t) for t in ("[CLS]", "[SEP]", "[PAD]", "[MASK]", "[UNK]")}
so = ort.SessionOptions()
so.intra_op_num_threads = 4
so.inter_op_num_threads = 1
sess = ort.InferenceSession(
    os.path.join(MD, "laya-typed-decisions-fp32.onnx"), so,
    providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
)
print("EP:", sess.get_providers()[0])


def decide(state, q):
    state_ids = mod.encode(tok, state[:2000].replace("[MASK]", " "))
    ids, markers, header, opts, per = mod.build_sequence(tok, ids_of, state_ids, q, 1024, 256)
    k = len(markers)
    qt = 0
    t = cfg["temperature_by_options"].get(mod.temp_bucket(qt, k), cfg["temperature"][qt])
    feeds = {
        "input_ids": np.array([ids], np.int64),
        "attention_mask": np.ones((1, len(ids)), np.int64),
        "marker_pos": np.array([markers], np.int64),
        "marker_mask": np.ones((1, k), bool),
        "qtype": np.array([qt], np.int64),
    }
    logits, act = sess.run(None, feeds)
    z = logits[0, :k].astype(np.float64) / t
    p = np.exp(z - z.max())
    p = p / p.sum()
    return header, opts, list(q["crit"].keys()), p, len(ids)


q = {
    "t": "choice",
    "ins": "Em qual projeto do DSH o utilizador quer trabalhar?",
    "crit": {
        "newsletter-crawler": "recolhe newsletters e resume notícias",
        "apple-watch": "assistente de voz no iPhone e no Apple Watch",
        "capi-animation-studio": "estúdio do Capi",
        "nenhum": "o pedido não fala de nenhum destes",
    },
}
h, opts, names, p, n = decide("Pedido do utilizador: no newsletter crawler atualiza as notícias e faz commit", q)
print("SANIDADE ->", names[int(np.argmax(p))], "conf", round(float(p.max()), 3), "tokens", n)
print("  probs:", {names[i]: round(float(p[i]), 3) for i in range(len(names))})

articles = {a["id"]: a for a in json.load(open(os.path.join(MD, "nc-pool.json"), encoding="utf-8"))["articles"]}
golden = json.load(open("eval/golden.json", encoding="utf-8"))
scn = golden["scenarios"][0]
print("\nAMOSTRA (cenário", scn["id"], ")")
for pid in golden["pool"][:8]:
    a = articles[pid]
    truth = "direct" if pid in scn["direct"] else ("similar" if pid in scn["similar"] else "none")
    rq, kq = mod.questions_of("v0_prod")
    state = mod.state_of("v0_prod", scn["query"], a, "summary")
    _h, _o, names, pr, _n = decide(state, rq)
    _h2, _o2, names2, pr2, _n2 = decide(state, kq)
    print(
        f"{pid} truth={truth:7s} said={names[int(np.argmax(pr))]:7s} "
        f"p={[round(float(x), 2) for x in pr]} kind={names2[int(np.argmax(pr2))]} "
        f"| {str(a.get('title'))[:48]}"
    )
