"""Test della normalizzazione SAM v1 e delle patch (offline)."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "src"))
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), "src"))

import spec as sam

pass_n = 0
fail_n = 0


def ok(cond, msg):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("  OK  " + msg)
    else:
        fail_n += 1
        print("  FAIL " + msg)


def main():
    print("[1] cassa minima")
    raw = {
        "id": "cassa",
        "cat": "prop",
        "style": "lowpoly",
        "detail": 2,
        "size": [0.9, 0.7, 0.6],
        "params": {"w": 0.9, "h": 0.62, "d": 0.6, "t": 0.05},
        "mats": {"legno": {"col": "#6B4A2F", "noise": {"t": "stripe", "scale": 20, "amp": 0.2}}},
        "nodes": [
            {"n": "corpo", "p": "box", "s": ["w", "h", "d"], "at": [0, "h/2", 0], "mat": "legno"},
            {"n": "cavo", "p": "box", "s": ["w-2*t", "h-t", "d-2*t"], "at": [0, "h/2", 0],
             "op": "sub", "of": "corpo"},
        ],
    }
    s, w = sam.normalize_spec(raw)
    ok(s["id"] == "cassa", "id")
    ok(s["cat"] == "prop", "cat")
    ok(s["style"] == "lowpoly", "style")
    ok(len(s["nodes"]) == 2, "2 nodi")
    ok(s["nodes"][1]["op"] == "sub" and s["nodes"][1]["of"] == "corpo", "booleana")
    ok("legno" in s["mats"] and s["mats"]["legno"]["noise"]["t"] == "stripe", "noise stripe")
    ok(s["ground"] is True, "ground default")

    print("[2] alias e forma legacy")
    legacy = {
        "asset_id": "x",
        "style": "voxel_art",
        "geometry": {
            "base_mesh": "primitive_box",
            "scale": [1, 1, 1],
            "sub_modules": [
                {"type": "armature_bone", "name": "lid",
                 "relative_position": [0, 1, 0],
                 "rotation_keyframes": {"idle": [0, 0, 0], "open": [-90, 0, 0]}},
            ],
        },
        "procedural_shader": {"type": "color_palette", "base_color": "#5C4033", "noise_scale": 15},
        "assembly_logic": "flatten_top_surface_and_exclude_center_pivot",
    }
    s2, w2 = sam.normalize_spec(legacy)
    ok(s2["style"] == "lowpoly", "voxel_art -> lowpoly")
    ok(any(x["code"] == "styleMapped" for x in w2), "avviso styleMapped")
    ok(len(s2["nodes"]) >= 1, "base_mesh diventa nodo")
    ok(any(b["b"] == "lid" for b in s2["rig"]), "osso lid")
    ok("flat_top" in s2["flags"] and "no_center_pivot" in s2["flags"], "flags da assembly_logic")
    ok("base" in s2["mats"] or len(s2["mats"]) >= 1, "shader -> mat")

    print("[3] categorie e stili")
    for cat_in, cat_out in [("personaggio", "char"), ("auto", "vehicle"),
                            ("edificio", "struct"), ("piattaforma", "prop")]:
        s3, _ = sam.normalize_spec({"cat": cat_in, "nodes": [{"n": "a", "p": "box"}]})
        ok(s3["cat"] == cat_out, "cat %s -> %s" % (cat_in, cat_out))

    print("[4] primitiva sconosciuta e op orfana")
    s4, w4 = sam.normalize_spec({
        "nodes": [
            {"n": "a", "p": "icosaedro_magico"},
            {"n": "b", "p": "box", "op": "sub", "of": "inesistente"},
        ],
    })
    ok(s4["nodes"][0]["p"] == "box", "primitiva ignota -> box")
    ok("op" not in s4["nodes"][1], "op senza target rimossa")
    ok(any(x["code"] == "unknownPrimitive" for x in w4), "avviso unknownPrimitive")

    print("[5] patch per nome")
    base, _ = sam.normalize_spec(raw)
    patched, pw, applied = sam.apply_patch(base, [
        ["set", "params.h", 1.0],
        ["set", "nodes.corpo.mat", "ferro"],
        ["mat", "ferro", {"col": "#555555", "metal": 0.9}],
        ["add", {"n": "maniglia", "p": "tube", "r": 0.02, "len": 0.3, "at": [0, 0.7, 0.3]}],
        ["del", "cavo"],
        ["flag", "flat_top"],
    ])
    ok(applied >= 5, "almeno 5 op applicate (%d)" % applied)
    ok(patched["params"]["h"] == 1.0, "param h aggiornato")
    ok(any(n["n"] == "maniglia" for n in patched["nodes"]), "nodo aggiunto")
    ok(not any(n["n"] == "cavo" for n in patched["nodes"]), "nodo cancellato")
    ok("ferro" in patched["mats"], "mat ferro creato")
    ok("flat_top" in patched["flags"], "flag accesa")

    print("[6] zero nodi solleva")
    try:
        sam.normalize_spec({"id": "vuoto", "nodes": []})
        ok(False, "doveva sollevare")
    except ValueError:
        ok(True, "ValueError su zero nodi")

    print("[7] digest e stats")
    dig = sam.spec_digest(s)
    ok("cassa" in dig and "nodes(2)" in dig, "digest contiene id e conteggio")
    st = sam.spec_stats(s)
    ok(st["nodes"] == 2 and st["bools"] == 1 and st["bytes"] > 50, "stats coerenti")

    print("[8] cone alias e caps")
    s8, _ = sam.normalize_spec({
        "nodes": [{"n": "c", "p": "cone", "r": 0.5, "len": 1}],
    })
    ok(s8["nodes"][0]["p"] == "cyl" and s8["nodes"][0].get("taper") == 0.0,
       "cone -> cyl taper=0")

    print()
    print("PASS %d  FAIL %d" % (pass_n, fail_n))
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
