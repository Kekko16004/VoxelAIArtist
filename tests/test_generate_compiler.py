"""Il prompt di generazione e' un compilatore JSON, non una chat.

Gemini a volte risponde "Non posso assisterti, poiche' sono solo un modello
linguistico..." invece del blocco ops. Non e' un 429: il retry di rete non lo
vede. Questo test copre il framing (COMPILATORE, soggetto in ultima riga) e il
ritento unico su un rifiuto. Nessuna rete.
"""
import os as _os
_HERE = _os.path.dirname(_os.path.abspath(__file__))
REPO_ROOT = _os.path.dirname(_HERE)
import os, sys, types

os.chdir(REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
sys.path.insert(0, REPO_ROOT)

stub = types.ModuleType("gemini")
class Gemini:
    def __init__(self, *a, **k): pass
    def generate_content(self, prompt):
        class R: text = '{"ops":[]}'
        return R()
stub.Gemini = Gemini
sys.modules["gemini"] = stub

import aiclient
import main

fails = []
def check(cond, msg):
    if not cond:
        print("  FAIL " + msg); fails.append(msg)
    else:
        print("  OK  " + msg)

print("=== framing compilatore ===")
p = main.build_generate_prompt("un dinosauro", grid_size="32x32x32")
check("COMPILATORE" in p, "il prompt si presenta come compilatore di ops")
check("NON generare un'immagine" in p, "anti-immagine (stessa cura di PixelAI)")
check("non posso assisterti" in p.lower() or "rifiutare" in p.lower(),
      "il prompt vieta il rifiuto in prosa")
check("[INSERISCI QUI" not in p, "nessun segnaposto rimasto")
check("un dinosauro" in p, "il soggetto entra nel prompt")
tail = p.rstrip("\n").split("\n")[-1]
check(tail.strip() == "SOGGETTO DA GENERARE: un dinosauro",
      "la richiesta resta l'ultima riga (ricevuto %r)" % tail)
check("32, 32, 32" in p, "la griglia chiesta diventa regola tassativa")
check("DAN" not in p and "jailbreak" not in p.lower(),
      "nessun jailbreak nel prompt")

p2 = main.build_generate_prompt("una casetta", big_structure=True, humanoid=True)
check(main.BIG_STRUCTURE_RULE.strip()[:60] in p2, "struttura grande resta nel prompt")
check(main.HUMANOID_RULE.strip()[:60] in p2, "umanoide resta nel prompt")
check(p2.rstrip("\n").split("\n")[-1].strip() == "SOGGETTO DA GENERARE: una casetta",
      "anche con le regole extra il soggetto e' in fondo")

print("=== riconoscimento rifiuto ===")
check(aiclient.looks_like_refusal(
    "Non posso assisterti, poiche' sono solo un modello linguistico "
    "e non ho la capacita di comprendere e rispondere questa richiesta."),
      "rifiuto italiano riconosciuto")
check(aiclient.looks_like_refusal("I'm just a language model and cannot assist."),
      "rifiuto inglese riconosciuto")
check(not aiclient.looks_like_refusal(
    '```json\n{"metadata":{"name":"x"},"palette":{"a":"#111"},'
    '"ops":[["fill",0,0,0,1,1,1,"a"]]}\n```'),
      "un blocco json non e' un rifiuto")
check(aiclient._looks_like_json_payload(
    '```json\n{"ops":[["fill",0,0,0,1,1,1,"a"]]}\n```'),
      "fenced json riconosciuto")
check(not aiclient._looks_like_json_payload("Non posso assisterti."),
      "un rifiuto non passa per json")

print("=== ritento unico sul rifiuto ===")
calls = []
def fake_retrying(prompt, model=None, sleep=None, provider=None, images=None):
    calls.append(prompt)
    if len(calls) == 1:
        return "Non posso assisterti, poiche' sono solo un modello linguistico."
    return '```json\n{"ops":[["fill",0,0,0,2,2,2,"a"]],"palette":{"a":"#333"}}\n```'

saved = aiclient.ai_answer_text_retrying
aiclient.ai_answer_text_retrying = fake_retrying
out = aiclient.ai_json_text_retrying("PROMPT")
aiclient.ai_answer_text_retrying = saved
check(len(calls) == 2, "un rifiuto costa un ritento (chiamate=%d)" % len(calls))
check("OUTPUT JSON ONLY" in calls[1], "il ritento aggiunge il nudge json")
check("ops" in out, "il secondo tentativo restituisce il json")

calls.clear()
aiclient.ai_answer_text_retrying = fake_retrying
# Secondo giro: fake restituisce rifiuto alla 1, json alla 2. Per il caso
# "gia' json" serve un'altra finta.
def already_json(prompt, model=None, sleep=None, provider=None, images=None):
    calls.append(prompt)
    return '```json\n{"ops":[["fill",0,0,0,1,1,1,"a"]]}\n```'
aiclient.ai_answer_text_retrying = already_json
aiclient.ai_json_text_retrying("PROMPT")
aiclient.ai_answer_text_retrying = saved
check(len(calls) == 1, "un json valido non viene ritentato (chiamate=%d)" % len(calls))

if fails:
    print("\nFALLITI:", len(fails))
    sys.exit(1)
print("\nTUTTI I CONTROLLI PASSATI")
