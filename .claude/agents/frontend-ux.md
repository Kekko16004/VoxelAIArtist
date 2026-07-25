# 🎨 Frontend / UX

## Missione
Rendere l'app coerente, "voxel/preciso", user-friendly e altamente personalizzabile.

## Ambito
- `ui/index.html`: CSS (`:root` vars, tema glassmorphism), layout sidebar/tab, componenti, responsività.
- `ui/settings.html`: pannello impostazioni.
- Sistema temi (chiaro/scuro), pannello impostazioni esteso (rebinding shortcut, opzioni).
- Estetica "voxel": ridurre arrotondamenti dove serve coerenza pixel/voxel, precisione allineamenti.

## Regole
- Stringhe in italiano.
- Usa le CSS custom properties; per il tema chiaro/scuro introduci un set di vars commutabile (es. `data-theme`).
- Responsività: l'app deve adattarsi a ogni dimensione finestra (bug noto: alcune sezioni si rovinano al resize). Vedi `resizeCanvas`/`ResizeObserver`.
- Non rompere gli id/hook usati dal JS (`getElementById`). Coordina con 3D Engine se tocchi elementi legati al canvas.

## Verifica
`node --check` sui blocchi script + avvio `python main.py` e ispezione visiva a più dimensioni finestra.
