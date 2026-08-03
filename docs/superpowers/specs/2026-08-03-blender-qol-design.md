# Blender-QoL: fix posa al primo drag, primitive Shift+A, Ctrl+A sui keyframe

Data: 2026-08-03
Stato: approvato (design)

## Obiettivo

Tre interventi che rendono l'app piu' prevedibile e piu' familiare a chi arriva
da Blender:

1. **Fix**: il primo trascinamento di un osso nel Rig applica una posa
   estranea; serve un Ctrl+Z per recuperare la propria, poi funziona.
2. **Primitive**: `Shift+A` apre un menu con 5 forme (cubo, piramide, cilindro,
   sfera, cono). Prima di creare, un dialogo chiede la dimensione; il resto e'
   calcolato.
3. **Ctrl+A nella timeline**: seleziona tutti i keyframe.

Vincolo trasversale: le stringhe nuove passano da `t()` e vanno in **tutti** gli
8 file di `ui/locales/`, mai italiano hardcoded (guardia i18n del progetto).

---

## 1. Fix: posa estranea al primo drag

### Causa

`ui/src/lib/15-rig.js` guida `TransformControls` (r128, da CDN) tramite un
oggetto interposto, `gizmoProxy`. Nel sorgente di r128 l'ordine e' questo:

```
TransformControls.js:245   this._quaternionStart.copy( this.object.quaternion );
TransformControls.js:254   this.dragging = true;   // -> evento 'dragging-changed'
```

`gizmoProxy.quaternion` viene fotografato in `_quaternionStart` **prima** che
`dragging` diventi `true`, ed e' quel passaggio a emettere `dragging-changed`,
cioe' a chiamare `onGizmoDragStart()` (15-rig.js:3151-3156). Ne segue che
`onGizmoDragStart` gira **dopo** la fotografia: qualunque correzione faccia sul
proxy arriva tardi.

`onGizmoChange` (15-rig.js:3228) scrive la posa in **assoluto**, non come delta:

```js
const localQ = dragParentQuatInv.clone().multiply(gizmoProxy.quaternion);
rig.pose[bd.name] = [e.x, e.y, e.z];
```

Quindi se al pointerdown il proxy e' disallineato rispetto all'osso, al primo
movimento del mouse la posa salta di colpo all'orientamento del proxy, non a
quello dell'osso: e' la "posa che non c'entra nulla". A fine drag
`onGizmoDragEnd` chiama `syncGizmoToBone()` (15-rig.js:3264), il proxy torna
allineato e da lì in poi i drag sono corretti - il "solo la prima volta".

Verificato: l'ordine degli eventi e' letto dal sorgente r128 pubblicato sul CDN
che l'app carica (`index.template.html:28`). **Non ancora isolata** l'azione che
lascia il proxy disallineato la prima volta (candidati: prima selezione osso,
`mixer.update` di una clip, costruzione dell'anteprima rig). Da riprodurre con
systematic-debugging **prima** di scrivere la fix; il rimedio scelto copre
comunque tutti i candidati perche' risincronizza a ogni pressione.

### Rimedio

Un listener `pointerdown` in fase di **capture** su `renderer.domElement`,
registrato in 15-rig.js accanto agli altri listener del gizmo, che chiama
`syncGizmoToBone()` quando il gizmo e' attivo. La fase di capture garantisce che
giri prima del listener di TransformControls, quindi prima della fotografia.

Scartata l'alternativa "posa come delta": tocca il cuore del posing, che ha
invarianti delicate documentate in CLAUDE.md, e lascerebbe comunque il gizmo
disegnato nel posto sbagliato.

Perche' e' robusto: rende lo stato stantio impossibile *per costruzione* a ogni
pressione, invece di correggere a posteriori una singola causa.

### Test

`tests/test_gizmo_first_drag.mjs` (nuovo, in `run_all.sh`):

- Estrae da 15-rig.js il blocco del gizmo, come fa `test_focus_shortcuts.mjs`,
  così se il codice viene rimosso il test non parte nemmeno.
- Riproduce la sequenza r128: disallinea il proxy, emette `pointerdown`,
  fotografa `_quaternionStart`, poi `dragging-changed`, poi `objectChange`.
- Asserisce che al **primo** `objectChange` la posa scritta corrisponda
  all'orientamento dell'osso, non a quello stantio; e che con un movimento nullo
  la posa resti invariata (nessun salto).
- Un caso di controllo con proxy già allineato: la fix non deve cambiare nulla.

---

## 2. Primitive con Shift+A

### Comportamento

`Shift+A` apre un menu al centro dell'area viewport con 5 voci. Scelta una
forma, si apre un dialogo con:

- **Dimensione** (voxel): campo principale, precompilato, già a fuoco e
  selezionato - basta Invio.
- **Altezza** (voxel): precompilata dalla proporzione della forma, modificabile.
- **Mantieni proporzione**: se attiva, cambiare Dimensione ricalcola Altezza.
  Stato ricordato tra un uso e l'altro.

`Invio` crea, `Esc` annulla. La primitiva diventa un **nuovo oggetto** attivo
nell'outliner (scelta Blender-like), colorato con `activeColorHex`.

Proporzioni predefinite (altezza / dimensione):

| Forma     | Dimensione = | Proporzione | Default |
|-----------|--------------|-------------|---------|
| Cubo      | lato         | 1.0         | 16      |
| Piramide  | lato base    | 1.0         | 16      |
| Cilindro  | diametro     | 1.5         | 12      |
| Sfera     | diametro     | 1.0 (fissa) | 16      |
| Cono      | diametro     | 1.5         | 12      |

Per la sfera il campo Altezza e' disabilitato: una sfera con altezza diversa dal
diametro non e' una sfera. Servisse un ellissoide, e' una richiesta separata.

### Generazione

Modulo nuovo `ui/src/lib/35-primitives.js`, inserito nel manifest **prima** di
`lib/18-bootstrap-tail.js` (che e' ultimo, non in ordine numerico).

Una funzione pura per forma: dato un punto e le misure, dice dentro/fuori.
Coordinate **centrate sul centro geometrico** (offset di mezzo voxel per le
misure pari), così le forme sono simmetriche per costruzione e una sfera di
diametro pari non esce sbilenca di un voxel.

- cubo: tutte le celle della scatola
- piramide: base quadrata, lato che si restringe linearmente con l'altezza
- cilindro: `dx^2 + dz^2 <= r^2`
- sfera: `dx^2 + dy^2 + dz^2 <= r^2`
- cono: come il cilindro, con `r` che scala linearmente con l'altezza

Il raggio del test usa `r + 0.5` sul quadrato, così il guscio esterno non
risulta mangiato di un voxel: verificato dal test di simmetria.

Le funzioni non toccano DOM ne' Three.js, quindi sono testabili direttamente.

### Griglia

Se la forma non entra nella griglia corrente, la griglia del **nuovo** oggetto
sale al primo valore standard che la contiene (32/48/64/128/192/256/384/512, gli
stessi del selettore in `index.template.html:2054-2062`), con tetto **512**. Se
la dimensione chiesta eccede 512 il campo si ferma a 512 e il dialogo lo dice.
Nessun taglio silenzioso: la forma esce sempre come l'hai chiesta.

Il cap sui voxel va rispettato: la primitiva piu' costosa (cubo 512) e' 134M
celle, ben oltre il tetto di 8M documentato in CLAUDE.md. Quindi prima di creare
si conta quanti voxel produrrebbe la forma e, se sfondano il budget, il dialogo lo
segnala e non crea nulla.

Nota sul riuso: la formula del budget in JS **non** e' una funzione chiamabile -
e' un IIFE locale dentro `expandOps` (`ui/src/utils/expand-ops.js:26-38`), quindi
non e' raggiungibile da un altro modulo. Per non creare una **terza** copia della
regola (CLAUDE.md impone che Python e JS restino identici), la si estrae in una
funzione `voxelBudgetFor(gridSize)` nello stesso file e `expandOps` la chiama al
posto dell'IIFE. Comportamento identico, verificato dal test di parita' ops che
gia' esiste; le primitive chiamano la stessa funzione. Copie totali: sempre 2
(una Python, una JS), come oggi.

### Interferenze

- `Shift+A` non e' assegnato a nulla: nessun conflitto (unica occorrenza di
  `shiftKey` a tastiera e' in 13-history.js per Ctrl+Shift+Z).
- Il menu non si apre mentre si digita (`isTypingTarget`), con una modale aperta,
  o durante un gesto di estrusione/drag.
- La creazione passa da `pushHistory()`: Ctrl+Z riporta indietro. Attenzione
  documentata in `13-history.js:6-10`: lo snapshot **non** ripristina
  aggiunte/eliminazioni di oggetti. Quindi Ctrl+Z dopo una primitiva riporta i
  voxel e l'oggetto attivo di prima, ma l'oggetto vuoto resta nell'outliner, da
  togliere a mano. E' il comportamento già esistente per Nuovo/Duplica, non una
  regressione introdotta qui; allinearlo e' fuori scopo.
- Serve `invalidateIncremental()` prima del `buildModel()`, come impone CLAUDE.md
  per chi sostituisce `currentModelData` (lo fa già `setActiveObject`).

### Test

`tests/test_primitives.mjs` (nuovo, in `run_all.sh`), sulle funzioni pure:

- **Non vuote**: ogni forma a dimensione 1, 2, 3, 8, 16 produce > 0 voxel. E' la
  trappola che in passato ha colpito `box` con valori float (CLAUDE.md).
- **Simmetria**: l'insieme dei voxel e' invariante per riflessione su X e su Z
  (per ogni forma, dimensioni pari e dispari). Coglie l'errore di mezzo voxel.
- **Limiti**: nessun voxel fuori dalla scatola richiesta; l'altezza occupata e'
  esattamente quella chiesta.
- **Forma**: cubo = dimensione^2 * altezza esatti; il cilindro ha la stessa
  sezione a ogni livello; il cono e la piramide si restringono in modo monotono e
  hanno l'apice larghezza 1; la sfera e' invariante anche su Y.
- **Colore**: tutti i voxel prendono il colore attivo.
- **Scelta della griglia**: dimensione 40 su griglia 16 sceglie 48, non 32;
  dimensione 600 si ferma a 512.

---

## 3. Ctrl+A: seleziona tutti i keyframe

### Situazione

- `33-timeline.js:1293` scarta ogni evento con `ctrlKey`, quindi oggi Ctrl+A non
  raggiunge mai la timeline.
- `01-scene-setup.js:312` usa Ctrl+A per agganciare/sganciare il gizmo globale.
- `15-rig.js:3410` usa Ctrl+A per `tlSetKeyAllBones(true)`, che **non** seleziona
  keyframe: imposta l'ambito "inserisci chiave su tutte le ossa"
  (`33-timeline.js:1224`). Il suo toast ha testo italiano hardcoded e stili
  inline, contro le guardie i18n.

### Comportamento

Scoping per area, come Blender: la scorciatoia dipende da dove sei.

- Timeline visibile **e** area attiva (puntatore sopra il dock, o focus dentro):
  Ctrl+A seleziona tutti i keyframe dell'animazione attiva. `preventDefault` +
  `stopImmediatePropagation` così il gizmo globale non scatta anche lui. Il ramo
  richiede `ctrlKey` (o `metaKey`) **senza** `shiftKey` ne' `altKey`, così
  Ctrl+Shift+A resta libero per il rig anche col puntatore sulla timeline.
- Altrimenti Ctrl+A resta quello di oggi (gizmo globale).
- Il Ctrl+A del rig passa a **Ctrl+Shift+A**, con il toast portato su `t()` e gli
  stili spostati su una classe CSS.

L'area attiva e' un flag in `33-timeline.js` aggiornato da
`pointerenter`/`pointerleave` e `focusin` sul dock: un solo booleano, nessun
hit-testing. Il `pointerleave` non lo azzera mentre un trascinamento di chiavi e'
in corso (il puntatore può uscire dal dock durante il drag), e resta attivo se il
focus e' dentro il dock anche a puntatore fuori - così Ctrl+A funziona subito
dopo aver cliccato una chiave, senza dover tenere il mouse fermo.

### Selezione

`tlSelectAllKeys()` popola `tlSelected` con una voce `{bone, t}` per ogni chiave
di ogni traccia dell'animazione attiva - il modello che `tlSelected` già usa
(`33-timeline.js:43`), quindi Canc/X (`:1305`) e il trascinamento multiplo
(`:1094`) funzionano sulla selezione senza modifiche.

Dettagli:

- Sulle preset (sola lettura, `anim` assente) la selezione avviene comunque, ma i
  pulsanti di modifica restano disabilitati come già oggi (`:514`): coerente con
  il clic singolo, che già seleziona le chiavi read-only.
- Ripremendo Ctrl+A con tutto già selezionato la selezione si **svuota**; se la
  selezione e' parziale, seleziona tutto. Non e' il comportamento di Blender (che
  separa `A` per selezionare da `A A`/`Alt+A` per deselezionare): e' una scelta
  deliberata, perche' qui Ctrl+A e' l'unica scorciatoia dedicata alla selezione e
  senza il toggle non ci sarebbe modo di deselezionare da tastiera. Il clic su
  un'area vuota della pista continua a deselezionare come oggi.
- Nessuna chiave da selezionare: nessuna operazione, nessun errore.
- Chiude prima il menu dei canali se aperto (`tlChanMenuOpen()`), che oggi ha la
  priorita' sui tasti.
- Chiama `tlRedraw()`/`tlUpdateToolbar()` per riflettere la selezione (classe
  `.tl-key-sel`) e riabilitare il pulsante Elimina.
- La selezione non e' uno stato del documento: **non** passa da `pushHistory()`.

### Test

`tests/test_timeline_select_all.mjs` (nuovo, in `run_all.sh`), sul modello del
test UI del pack (DOM finto):

- Ctrl+A con area timeline attiva seleziona **tutte** le chiavi di tutte le
  tracce (contate su un'animazione con 3 ossa e conteggi diversi).
- Ripremuto svuota; da selezione parziale seleziona tutto.
- Con l'area **non** attiva la timeline non tocca `tlSelected` e non consuma
  l'evento (il gizmo globale resta raggiungibile).
- Su una preset read-only seleziona, ma il pulsante Elimina resta disabilitato.
- Timeline chiusa: nessun effetto.
- Ctrl+Shift+A non seleziona i keyframe (e' la scorciatoia del rig).
- Il toast del rig non contiene italiano hardcoded: passa da `t()`.

---

## Verifica complessiva

1. `node ui/build.mjs` - prima controllare che il bundle non sia avanti ai
   sorgenti (`grep -c deformsAlike ui/index.html ui/src/lib/15-rig.js`, come
   impone CLAUDE.md). Verificato in sede di design: 2 e 2, allineati.
2. `bash tests/run_all.sh` - deve restare verde, inclusi i tre test nuovi e i
   cinque test-tripwire del rig.
3. Chiavi i18n complete in tutti gli 8 file di `ui/locales/`: già coperto dal
   controllo in `run_all.sh:203`.
4. Prova manuale: posare un osso al primo colpo senza salti; Shift+A per ogni
   forma; Ctrl+A nella timeline e fuori.

## Fuori scopo

- Ellissoidi / primitive con tre misure indipendenti.
- Rendere annullabile l'aggiunta di un oggetto (limite noto e preesistente
  dell'history, vale già per Nuovo/Duplica/Elimina).
- Selezione a rettangolo dei keyframe, o Ctrl+A per selezionare ossa nella
  viewport 3D.
- Toccare la semantica delle op (`expand_ops`/`expandOps`): le primitive
  producono voxel piatti, non op compatte, quindi la parita' Python/JS non e'
  coinvolta. L'estrazione di `voxelBudgetFor` e' un refactor a comportamento
  invariato, coperto dal test di parita' esistente.
