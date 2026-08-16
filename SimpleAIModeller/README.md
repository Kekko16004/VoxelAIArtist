# SimpleAIModeller

Asset 3D parametrici da un prompt. App sorella di VoxelAIArtist: stesso server
HTTP locale, stessi cookie Gemini / provider a chiave, UI nel browser.

L'AI **non scrive codice WebGL**. Produce una spec JSON compatta; il motore
locale la interpreta estrudendo primitive, applicando booleane e materiali
procedurali. Le correzioni viaggiano come patch di poche righe.

## Avvio

```bat
SimpleAIModeller\run.bat
```

oppure `python SimpleAIModeller/main.py`. Serve `node` una volta per costruire
la UI (`node ui/build.mjs` da questa cartella) se `ui/index.html` non c'e'.

I cookie e i provider AI sono **condivisi** con VoxelAIArtist: se li hai gia'
configurati li', funzionano anche qui. Altrimenti Impostazioni (in-app).

## Cosa c'e' in fase 1

- Prompt → spec JSON → mesh (box, sfera, cilindro, capsula, torus, loft,
  estrusione, scale, arco, heightfield, … + CSG + array/mirror)
- Tre stili: low-poly, PBR procedurale, toon
- Validatori geometrici locali (braccia, piattaforme piatte, cabine, simmetria,
  pezzi staccati, appoggio a terra) + una passata di critica AI con spunta
- Sonda "il provider vede le immagini?": se no, la critica la fai tu a parole
- Export GLB / OBJ+MTL / JSON / collider sidecar
- Demo senza AI (cassa di legno) per giudicare il motore da subito

## Cosa non c'e' ancora (dopo il tuo ok)

Editor navigabile completo (gizmo, keymap Blender, undo strutturale),
Gauntlet Loop multi-agente, skinning vero, set coerenti di asset.

## Test

```bash
bash SimpleAIModeller/tests/run_all.sh
```

Offline, niente cookie, niente quota.
