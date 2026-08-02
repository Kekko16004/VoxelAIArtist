# -*- coding: utf-8 -*-
"""Tabella chiavi i18n (parte 4/4): stringhe dei file NON posseduti da questo agent
(15-rig.js, 32-rig-tools.js). Le chiavi vengono aggiunte a tutti i locali ora, il
cablaggio nel codice spetta all'agent che possiede quei file (vedi i18n-pending.md).
Ordine: it, en, es, fr, de, pt.
"""

NEW = {}

# ---- M. 15-rig.js ----
NEW['rig.exitPaint'] = ["Esci dalla pittura", "Exit painting", "Salir de la pintura",
                        "Quitter la peinture", "Malmodus verlassen", "Sair da pintura"]
NEW['rig.handPaintedCount'] = [
    "{n} voxel corretti a mano", "{n} voxels corrected by hand", "{n} vóxeles corregidos a mano",
    "{n} voxels corrigés à la main", "{n} Voxel manuell korrigiert", "{n} voxels corrigidos à mão"]
NEW['rig.oneVoxel'] = ["1 voxel", "1 voxel", "1 vóxel", "1 voxel", "1 Voxel", "1 voxel"]
NEW['rig.voxelCount'] = ["{n} voxel", "{n} voxels", "{n} vóxeles", "{n} voxels", "{n} Voxel", "{n} voxels"]
NEW['rig.needAutoRig'] = [
    "Prima crea uno scheletro con Auto-Rig.", "Create a skeleton with Auto-Rig first.",
    "Crea primero un esqueleto con Auto-Rig.", "Crée d'abord un squelette avec Auto-Rig.",
    "Erstelle zuerst ein Skelett mit Auto-Rig.", "Cria primeiro um esqueleto com Auto-Rig."]
NEW['rig.dblClickRename'] = [
    "Doppio clic per rinominare", "Double-click to rename", "Doble clic para renombrar",
    "Double-clic pour renommer", "Doppelklick zum Umbenennen", "Duplo clique para renomear"]
NEW['rig.deleteAnim'] = ["Elimina animazione", "Delete animation", "Eliminar animación",
                         "Supprimer l'animation", "Animation löschen", "Eliminar animação"]
NEW['rig.needRigForObject'] = [
    "Prima crea uno scheletro (Rig) per l'oggetto.", "Create a skeleton (rig) for the object first.",
    "Crea primero un esqueleto (rig) para el objeto.", "Crée d'abord un squelette (rig) pour l'objet.",
    "Erstelle zuerst ein Skelett (Rig) für das Objekt.", "Cria primeiro um esqueleto (rig) para o objeto."]
NEW['rig.skeletonNotReady'] = [
    "Scheletro non pronto.", "Skeleton not ready.", "El esqueleto no está listo.",
    "Squelette non prêt.", "Skelett nicht bereit.", "Esqueleto não está pronto."]
NEW['rig.describeAnim'] = [
    "Descrivi l'animazione da generare.", "Describe the animation to generate.",
    "Describe la animación que quieres generar.", "Décris l'animation à générer.",
    "Beschreibe die zu erzeugende Animation.", "Descreve a animação a gerar."]
NEW['rig.aiNoTracks'] = [
    "L'AI non ha restituito track validi.", "The AI returned no valid tracks.",
    "La IA no ha devuelto pistas válidas.", "L'IA n'a renvoyé aucune piste valide.",
    "Die KI hat keine gültigen Tracks zurückgegeben.", "A IA não devolveu tracks válidos."]
NEW['rig.aiNoValidBones'] = [
    "Nessun osso valido nei track generati.", "No valid bone in the generated tracks.",
    "Ningún hueso válido en las pistas generadas.", "Aucun os valide dans les pistes générées.",
    "Kein gültiger Knochen in den erzeugten Tracks.", "Nenhum osso válido nos tracks gerados."]
NEW['rig.animCreated'] = [
    'Animazione "{name}" creata e in riproduzione.', 'Animation "{name}" created and playing.',
    'Animación "{name}" creada y en reproducción.', 'Animation "{name}" créée et en lecture.',
    'Animation "{name}" erstellt und wird abgespielt.', 'Animação "{name}" criada e em reprodução.']
NEW['rig.animError'] = [
    "Errore animazione: {error}", "Animation error: {error}", "Error de animación: {error}",
    "Erreur d'animation : {error}", "Animationsfehler: {error}", "Erro de animação: {error}"]

# ---- N. 32-rig-tools.js ----
NEW['rigTools.mirrorPoseNone'] = [
    "Nessuna posa da specchiare ({dir}): le ossa gemelle non esistono o sono a zero.",
    "No pose to mirror ({dir}): the twin bones do not exist or are at zero.",
    "No hay pose que reflejar ({dir}): los huesos gemelos no existen o están a cero.",
    "Aucune pose à mettre en miroir ({dir}) : les os jumeaux n'existent pas ou sont à zéro.",
    "Keine Pose zum Spiegeln ({dir}): die Gegenknochen fehlen oder stehen auf null.",
    "Nenhuma pose para espelhar ({dir}): os ossos gémeos não existem ou estão a zero."]
NEW['rigTools.mirrorPoseOk'] = [
    "Posa specchiata su X ({dir}): {n} ossa aggiornate.", "Pose mirrored on X ({dir}): {n} bones updated.",
    "Pose reflejada en X ({dir}): {n} huesos actualizados.", "Pose mise en miroir sur X ({dir}) : {n} os mis à jour.",
    "Pose an X gespiegelt ({dir}): {n} Knochen aktualisiert.", "Pose espelhada em X ({dir}): {n} ossos atualizados."]
NEW['rigTools.mirrorWeightsNone'] = [
    "Nessuna correzione da specchiare ({dir}): dipingi prima un lato.",
    "No correction to mirror ({dir}): paint one side first.",
    "No hay corrección que reflejar ({dir}): pinta primero un lado.",
    "Aucune correction à mettre en miroir ({dir}) : peins d'abord un côté.",
    "Keine Korrektur zum Spiegeln ({dir}): bemale zuerst eine Seite.",
    "Nenhuma correção para espelhar ({dir}): pinta primeiro um lado."]
NEW['rigTools.mirrorWeightsOk'] = [
    "Pesi specchiati ({dir}): {n} voxel", "Weights mirrored ({dir}): {n} voxels",
    "Pesos reflejados ({dir}): {n} vóxeles", "Poids mis en miroir ({dir}) : {n} voxels",
    "Gewichte gespiegelt ({dir}): {n} Voxel", "Pesos espelhados ({dir}): {n} voxels"]
NEW['rigTools.mirrorWeightsSkipped'] = [
    ", {n} senza gemello", ", {n} without a twin", ", {n} sin gemelo",
    ", {n} sans jumeau", ", {n} ohne Gegenstück", ", {n} sem gémeo"]
NEW['rigTools.symAlready'] = [
    "Scheletro già simmetrico su X.", "The skeleton is already symmetric on X.",
    "El esqueleto ya es simétrico en X.", "Le squelette est déjà symétrique sur X.",
    "Das Skelett ist auf X bereits symmetrisch.", "O esqueleto já é simétrico em X."]
NEW['rigTools.symOk'] = [
    "Scheletro simmetrizzato ({dir}): {moved} ossa spostate, {pairs} coppie L/R",
    "Skeleton symmetrized ({dir}): {moved} bones moved, {pairs} L/R pairs",
    "Esqueleto simetrizado ({dir}): {moved} huesos movidos, {pairs} pares L/R",
    "Squelette symétrisé ({dir}) : {moved} os déplacés, {pairs} paires L/R",
    "Skelett symmetrisiert ({dir}): {moved} Knochen verschoben, {pairs} L/R-Paare",
    "Esqueleto simetrizado ({dir}): {moved} ossos movidos, {pairs} pares L/R"]
NEW['rigTools.symCentred'] = [
    ", {n} ossa centrali riallineate", ", {n} central bones realigned",
    ", {n} huesos centrales realineados", ", {n} os centraux réalignés",
    ", {n} mittlere Knochen neu ausgerichtet", ", {n} ossos centrais realinhados"]
NEW['rigTools.selectParentFirst'] = [
    "Seleziona prima l'osso genitore nella lista.", "Select the parent bone in the list first.",
    "Selecciona primero el hueso padre en la lista.", "Sélectionne d'abord l'os parent dans la liste.",
    "Wähle zuerst den übergeordneten Knochen in der Liste.", "Seleciona primeiro o osso pai na lista."]
NEW['rigTools.newBonePrompt'] = [
    "Nome del nuovo osso (figlio di {parent}):", "Name of the new bone (child of {parent}):",
    "Nombre del nuevo hueso (hijo de {parent}):", "Nom du nouvel os (enfant de {parent}) :",
    "Name des neuen Knochens (Kind von {parent}):", "Nome do novo osso (filho de {parent}):"]
NEW['rigTools.nameCharset'] = [
    "Usa solo lettere, numeri, _ . e -", "Use only letters, numbers, _ . and -",
    "Usa solo letras, números, _ . y -", "Utilise seulement des lettres, chiffres, _ . et -",
    "Verwende nur Buchstaben, Zahlen, _ . und -", "Usa apenas letras, números, _ . e -"]
NEW['rigTools.nameTaken'] = [
    "Nome già usato da un altro osso.", "That name is already used by another bone.",
    "Ese nombre ya lo usa otro hueso.", "Ce nom est déjà utilisé par un autre os.",
    "Der Name wird schon von einem anderen Knochen verwendet.", "Nome já usado por outro osso."]
NEW['rigTools.boneAdded'] = [
    'Osso "{name}" aggiunto sotto {parent}. Con [G] sposti la sua articolazione, poi assegnagli i voxel con la pittura pesi.',
    'Bone "{name}" added under {parent}. Press [G] to move its joint, then assign voxels to it with weight painting.',
    'Hueso "{name}" añadido bajo {parent}. Con [G] mueves su articulación, luego asígnale vóxeles con la pintura de pesos.',
    'Os "{name}" ajouté sous {parent}. Avec [G] tu déplaces son articulation, puis assigne-lui des voxels avec la peinture de poids.',
    'Knochen "{name}" unter {parent} hinzugefügt. Mit [G] verschiebst du sein Gelenk, dann weist du ihm mit dem Gewichtsmalen Voxel zu.',
    'Osso "{name}" adicionado sob {parent}. Com [G] moves a sua articulação, depois atribui-lhe voxels com a pintura de pesos.']
NEW['rigTools.renamePrompt'] = [
    'Nuovo nome per "{name}":', 'New name for "{name}":', 'Nuevo nombre para "{name}":',
    'Nouveau nom pour "{name}" :', 'Neuer Name für "{name}":', 'Novo nome para "{name}":']
NEW['rigTools.boneRenamed'] = [
    "Osso rinominato: {before} -> {after} (posa, pesi e animazioni aggiornati).",
    "Bone renamed: {before} -> {after} (pose, weights and animations updated).",
    "Hueso renombrado: {before} -> {after} (pose, pesos y animaciones actualizados).",
    "Os renommé : {before} -> {after} (pose, poids et animations mis à jour).",
    "Knochen umbenannt: {before} -> {after} (Pose, Gewichte und Animationen aktualisiert).",
    "Osso renomeado: {before} -> {after} (pose, pesos e animações atualizados)."]
NEW['rigTools.boneDeleted'] = [
    'Osso "{name}" eliminato', 'Bone "{name}" deleted', 'Hueso "{name}" eliminado',
    'Os "{name}" supprimé', 'Knochen "{name}" gelöscht', 'Osso "{name}" eliminado']
NEW['rigTools.boneDeletedHelpers'] = [
    " (con {n} punta/e helper)", " (with {n} helper tip(s))", " (con {n} punta(s) auxiliar(es))",
    " (avec {n} pointe(s) auxiliaire(s))", " (mit {n} Hilfsspitze(n))", " (com {n} ponta(s) auxiliar(es))"]
NEW['rigTools.needPreview'] = [
    "Attiva prima l'anteprima del rig (Mostra rig).", "Turn on the rig preview first (Show rig).",
    "Activa primero la vista previa del rig (Mostrar rig).", "Active d'abord l'aperçu du rig (Afficher le rig).",
    "Aktiviere zuerst die Rig-Vorschau (Rig anzeigen).", "Ativa primeiro a pré-visualização do rig (Mostrar rig)."]
NEW['rigTools.ikHint'] = [
    "Trascina la mano, il piede o l'osso che vuoi puntare: la catena lo segue.",
    "Drag the hand, the foot or the bone you want to aim: the chain follows it.",
    "Arrastra la mano, el pie o el hueso que quieras apuntar: la cadena lo sigue.",
    "Fais glisser la main, le pied ou l'os que tu veux viser : la chaîne le suit.",
    "Ziehe die Hand, den Fuß oder den Knochen, den du ausrichten willst: die Kette folgt.",
    "Arrasta a mão, o pé ou o osso que queres apontar: a cadeia segue-o."]
NEW['rigTools.ikOn'] = [
    "IK attiva: trascina con il tasto sinistro l'estremità dell'arto verso il punto voluto. Ogni trascinamento è un solo Ctrl+Z. Premi di nuovo il pulsante per uscire.",
    "IK on: left-drag the tip of the limb towards the target point. Each drag is a single Ctrl+Z. Press the button again to exit.",
    "IK activa: arrastra con el botón izquierdo el extremo del miembro hacia el punto deseado. Cada arrastre es un solo Ctrl+Z. Pulsa de nuevo el botón para salir.",
    "IK active : fais glisser avec le bouton gauche l'extrémité du membre vers le point visé. Chaque glissement est un seul Ctrl+Z. Appuie à nouveau sur le bouton pour sortir.",
    "IK aktiv: ziehe mit der linken Maustaste das Ende der Extremität zum Zielpunkt. Jeder Zug ist ein einzelnes Ctrl+Z. Drücke die Taste erneut zum Beenden.",
    "IK ativa: arrasta com o botão esquerdo a extremidade do membro até ao ponto desejado. Cada arrasto é um único Ctrl+Z. Prime de novo o botão para sair."]
NEW['rigTools.ikOff'] = [
    "IK disattivata: [R] ruota, [G] sposta l'articolazione.",
    "IK off: [R] rotates, [G] moves the joint.",
    "IK desactivada: [R] rota, [G] mueve la articulación.",
    "IK désactivée : [R] tourne, [G] déplace l'articulation.",
    "IK deaktiviert: [R] dreht, [G] verschiebt das Gelenk.",
    "IK desativada: [R] roda, [G] move a articulação."]
NEW['rigTools.poseNoCommonBones'] = [
    'Nessun osso in comune con la posa "{name}": serve uno scheletro con gli stessi nomi.',
    'No bone in common with the pose "{name}": a skeleton with the same names is required.',
    'Ningún hueso en común con la pose "{name}": hace falta un esqueleto con los mismos nombres.',
    'Aucun os en commun avec la pose "{name}" : il faut un squelette avec les mêmes noms.',
    'Kein gemeinsamer Knochen mit der Pose "{name}": es braucht ein Skelett mit denselben Namen.',
    'Nenhum osso em comum com a pose "{name}": é necessário um esqueleto com os mesmos nomes.']
NEW['rigTools.poseApplied'] = [
    'Posa "{name}" applicata a {n} ossa', 'Pose "{name}" applied to {n} bones',
    'Pose "{name}" aplicada a {n} huesos', 'Pose "{name}" appliquée à {n} os',
    'Pose "{name}" auf {n} Knochen angewendet', 'Pose "{name}" aplicada a {n} ossos']
NEW['rigTools.poseMissingBones'] = [
    " ({n} ossa della posa non esistono qui: {names})", " ({n} bones of the pose do not exist here: {names})",
    " ({n} huesos de la pose no existen aquí: {names})", " ({n} os de la pose n'existent pas ici : {names})",
    " ({n} Knochen der Pose existieren hier nicht: {names})", " ({n} ossos da pose não existem aqui: {names})"]
NEW['rigTools.poseConfirmDelete'] = [
    'Eliminare la posa "{name}" dalla libreria?', 'Delete the pose "{name}" from the library?',
    '¿Eliminar la pose "{name}" de la biblioteca?', 'Supprimer la pose "{name}" de la bibliothèque ?',
    'Pose "{name}" aus der Bibliothek löschen?', 'Eliminar a pose "{name}" da biblioteca?']
NEW['rigTools.poseBoneCount'] = [
    "{n} ossa nella posa", "{n} bones in the pose", "{n} huesos en la pose",
    "{n} os dans la pose", "{n} Knochen in der Pose", "{n} ossos na pose"]
NEW['rigTools.poseDeleteTitle'] = [
    "Elimina questa posa", "Delete this pose", "Eliminar esta pose",
    "Supprimer cette pose", "Diese Pose löschen", "Eliminar esta pose"]
NEW['rigTools.poseZero'] = [
    "La posa è a zero: muovi qualche osso prima di salvarla.",
    "The pose is at zero: move some bones before saving it.",
    "La pose está a cero: mueve algún hueso antes de guardarla.",
    "La pose est à zéro : déplace quelques os avant de l'enregistrer.",
    "Die Pose steht auf null: bewege einige Knochen, bevor du sie speicherst.",
    "A pose está a zero: move alguns ossos antes de a guardar."]
NEW['rigTools.poseSavePrompt'] = [
    "Nome della posa da salvare:", "Name of the pose to save:", "Nombre de la pose que guardar:",
    "Nom de la pose à enregistrer :", "Name der zu speichernden Pose:", "Nome da pose a guardar:"]
NEW['rigTools.poseDefaultName'] = ["Posa {n}", "Pose {n}", "Pose {n}", "Pose {n}", "Pose {n}", "Pose {n}"]
NEW['rigTools.poseSaved'] = [
    'Posa "{name}" salvata ({n} ossa): puoi riapplicarla su qualsiasi oggetto con gli stessi nomi di ossa.',
    'Pose "{name}" saved ({n} bones): you can reapply it to any object with the same bone names.',
    'Pose "{name}" guardada ({n} huesos): puedes volver a aplicarla a cualquier objeto con los mismos nombres de huesos.',
    'Pose "{name}" enregistrée ({n} os) : tu peux la réappliquer à tout objet ayant les mêmes noms d\'os.',
    'Pose "{name}" gespeichert ({n} Knochen): du kannst sie auf jedes Objekt mit denselben Knochennamen erneut anwenden.',
    'Pose "{name}" guardada ({n} ossos): podes reaplicá-la a qualquer objeto com os mesmos nomes de ossos.']
