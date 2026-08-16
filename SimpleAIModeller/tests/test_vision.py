"""Sonda della vista: offline, con answer_fn finta."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "src"))
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), "src"))

# Registro provider usa-e-getta.
import tempfile
os.environ["VOXELAI_PROVIDERS_DIR"] = tempfile.mkdtemp(prefix="sam_vis_")

import vision as v

pass_n = fail_n = 0


def ok(c, m):
    global pass_n, fail_n
    if c:
        pass_n += 1
        print("  OK  " + m)
    else:
        fail_n += 1
        print("  FAIL " + m)


def main():
    print("[1] PNG di prova")
    top, bottom = "rosso", "blu"
    png = v.make_probe_png(top, bottom, size=32)
    ok(png.startswith(b"\x89PNG"), "header PNG")
    ok(len(png) > 50, "PNG non vuoto")

    print("[2] risposta corretta")
    def good(prompt, model=None, provider=None, images=None):
        ok(images and len(images) >= 1, "immagini passate alla fn")
        return "rosso, blu"
    r = v.run_probe(seed=1, answer_fn=good)
    # seed=1 produce una coppia deterministica: ricalcoliamola
    exp = v.pick_probe_pair(1)
    def good2(prompt, model=None, provider=None, images=None):
        return "%s, %s" % (exp[0], exp[1])
    r = v.run_probe(seed=1, answer_fn=good2)
    ok(r["ok"] is True and r["reason"] == "ok", "ok su colori giusti")

    print("[3] risposta sbagliata")
    def bad(prompt, model=None, provider=None, images=None):
        return "nero, bianco"
    r = v.run_probe(seed=1, answer_fn=bad)
    ok(r["ok"] is False and r["reason"] == "wrongAnswer", "wrongAnswer")

    print("[4] nessuna immagine")
    def noimg(prompt, model=None, provider=None, images=None):
        return "NESSUNA IMMAGINE"
    r = v.run_probe(seed=1, answer_fn=noimg)
    ok(r["ok"] is False and r["reason"] == "noImage", "noImage")

    print("[5] ordine invertito conta come ok (swapped)")
    def swapped(prompt, model=None, provider=None, images=None):
        return "%s, %s" % (exp[1], exp[0])
    r = v.run_probe(seed=1, answer_fn=swapped)
    ok(r["ok"] is True and r["reason"] == "swapped", "swapped accettato")

    print()
    print("PASS %d  FAIL %d" % (pass_n, fail_n))
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
