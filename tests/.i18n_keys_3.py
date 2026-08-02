# -*- coding: utf-8 -*-
"""Tabella chiavi i18n (parte 3/3): impostazioni schermate, toolbar, scorciatoie,
plugin, import GLB, pack, rig (file non posseduti). Ordine: it, en, es, fr, de, pt.
"""

NEW = {}

# ---- H. 22-screens.js: sezioni Impostazioni + toolbar ----
NEW['screens.startup'] = ["Avvio", "Startup", "Inicio", "Démarrage", "Start", "Início"]
NEW['screens.showLauncher'] = [
    "Mostra la schermata iniziale all'avvio", "Show the start screen at startup",
    "Mostrar la pantalla inicial al iniciar", "Afficher l'écran d'accueil au démarrage",
    "Startbildschirm beim Start anzeigen", "Mostrar o ecrã inicial ao iniciar"]
NEW['screens.openLauncher'] = [
    "\U0001F5C2 Apri schermata iniziale", "\U0001F5C2 Open start screen",
    "\U0001F5C2 Abrir pantalla inicial", "\U0001F5C2 Ouvrir l'écran d'accueil",
    "\U0001F5C2 Startbildschirm öffnen", "\U0001F5C2 Abrir ecrã inicial"]
NEW['screens.openLauncherTitle'] = [
    "Apri la schermata dei progetti recenti", "Open the recent projects screen",
    "Abre la pantalla de proyectos recientes", "Ouvre l'écran des projets récents",
    "Bildschirm der kürzlichen Projekte öffnen", "Abre o ecrã dos projetos recentes"]
NEW['screens.saving'] = ["Salvataggio", "Saving", "Guardado", "Enregistrement", "Speichern", "Gravação"]
NEW['screens.defaultDir'] = [
    "Cartella di default (Salvataggio/Esportazione)", "Default folder (Save/Export)",
    "Carpeta predeterminada (Guardar/Exportar)", "Dossier par défaut (Enregistrement/Export)",
    "Standardordner (Speichern/Export)", "Pasta predefinida (Gravar/Exportar)"]
NEW['screens.defaultDirPlaceholder'] = [
    "Predefinita (Appdata)", "Default (Appdata)", "Predeterminada (Appdata)",
    "Par défaut (Appdata)", "Standard (Appdata)", "Predefinida (Appdata)"]
NEW['screens.autosaveNote'] = [
    "I salvataggi automatici vengono conservati in una cartella dedicata dal backend Python (funziona sia in modalità web sia desktop).",
    "Automatic saves are kept in a dedicated folder by the Python backend (it works in both web and desktop mode).",
    "Los guardados automáticos se conservan en una carpeta dedicada por el backend de Python (funciona tanto en modo web como escritorio).",
    "Les sauvegardes automatiques sont conservées dans un dossier dédié par le backend Python (fonctionne en mode web comme en mode bureau).",
    "Automatische Speicherungen werden vom Python-Backend in einem eigenen Ordner aufbewahrt (funktioniert im Web- und im Desktop-Modus).",
    "As gravações automáticas são guardadas numa pasta dedicada pelo backend Python (funciona em modo web e desktop)."]
NEW['screens.openAutosaveFolder'] = [
    "\U0001F4C1 Apri cartella autosave", "\U0001F4C1 Open autosave folder",
    "\U0001F4C1 Abrir carpeta de autoguardado", "\U0001F4C1 Ouvrir le dossier d'autosauvegarde",
    "\U0001F4C1 Autosave-Ordner öffnen", "\U0001F4C1 Abrir pasta de gravação automática"]
NEW['screens.openAutosaveFolderTitle'] = [
    "Apri la cartella dei salvataggi automatici", "Open the automatic saves folder",
    "Abre la carpeta de los guardados automáticos", "Ouvre le dossier des sauvegardes automatiques",
    "Ordner der automatischen Speicherungen öffnen", "Abre a pasta das gravações automáticas"]
NEW['screens.chooseDirNeedsDesktop'] = [
    'La finestra di scelta cartella è un dialog di sistema: serve la modalità desktop (avvia con "python main.py --py").',
    'The folder picker is a system dialog: desktop mode is required (start with "python main.py --py").',
    'El selector de carpeta es un diálogo del sistema: hace falta el modo escritorio (inicia con "python main.py --py").',
    'Le sélecteur de dossier est une boîte de dialogue système : le mode bureau est requis (lance avec "python main.py --py").',
    'Die Ordnerauswahl ist ein Systemdialog: der Desktop-Modus ist erforderlich (starte mit "python main.py --py").',
    'O seletor de pasta é um diálogo do sistema: é necessário o modo desktop (inicia com "python main.py --py").']
NEW['screens.chooseDirError'] = [
    "Impossibile aprire la finestra di selezione cartella: {error}",
    "Could not open the folder selection dialog: {error}",
    "No se ha podido abrir la ventana de selección de carpeta: {error}",
    "Impossible d'ouvrir la fenêtre de sélection de dossier : {error}",
    "Der Ordnerauswahl-Dialog konnte nicht geöffnet werden: {error}",
    "Não foi possível abrir a janela de seleção de pasta: {error}"]
NEW['screens.chooseDirFailed'] = [
    "Errore nell'apertura della finestra di selezione cartella.",
    "Error opening the folder selection dialog.",
    "Error al abrir la ventana de selección de carpeta.",
    "Erreur lors de l'ouverture de la fenêtre de sélection de dossier.",
    "Fehler beim Öffnen des Ordnerauswahl-Dialogs.",
    "Erro ao abrir a janela de seleção de pasta."]
NEW['toolbar.groupProject'] = ["Progetto", "Project", "Proyecto", "Projet", "Projekt", "Projeto"]
NEW['toolbar.groupFileExport'] = ["File / Export", "File / Export", "Archivo / Exportar",
                                  "Fichier / Export", "Datei / Export", "Ficheiro / Exportar"]
NEW['toolbar.savePlainJsonTitle'] = [
    "Salva la scena come file JSON in chiaro (.json)", "Save the scene as a plain JSON file (.json)",
    "Guarda la escena como archivo JSON sin cifrar (.json)", "Enregistre la scène en JSON en clair (.json)",
    "Szene als unverschlüsselte JSON-Datei speichern (.json)", "Guarda a cena como ficheiro JSON simples (.json)"]
NEW['toolbar.exportMtlTitle'] = [
    "Esporta il file materiali (.mtl) da affiancare all'OBJ",
    "Export the materials file (.mtl) to sit next to the OBJ",
    "Exporta el archivo de materiales (.mtl) para acompañar al OBJ",
    "Exporte le fichier de matériaux (.mtl) à placer à côté de l'OBJ",
    "Materialdatei (.mtl) exportieren, die neben der OBJ liegen muss",
    "Exporta o ficheiro de materiais (.mtl) para acompanhar o OBJ"]
NEW['toolbar.exportObjTitle'] = [
    "Esporta la mesh in Wavefront OBJ (con MTL)", "Export the mesh to Wavefront OBJ (with MTL)",
    "Exporta la malla a Wavefront OBJ (con MTL)", "Exporte le maillage en Wavefront OBJ (avec MTL)",
    "Mesh als Wavefront OBJ exportieren (mit MTL)", "Exporta a malha em Wavefront OBJ (com MTL)"]
NEW['toolbar.exportGlbTitle'] = [
    "Esporta GLB con scheletro e animazioni (Blender/Unity/Godot)",
    "Export GLB with skeleton and animations (Blender/Unity/Godot)",
    "Exporta GLB con esqueleto y animaciones (Blender/Unity/Godot)",
    "Exporte en GLB avec squelette et animations (Blender/Unity/Godot)",
    "GLB mit Skelett und Animationen exportieren (Blender/Unity/Godot)",
    "Exporta GLB com esqueleto e animações (Blender/Unity/Godot)"]

# ---- I. 19-prefs.js (scorciatoie) ----
NEW['shortcut.toolView'] = ["Strumento: Vista", "Tool: View", "Herramienta: Vista",
                            "Outil : Vue", "Werkzeug: Ansicht", "Ferramenta: Vista"]
NEW['shortcut.toolPlace'] = ["Strumento: Aggiungi", "Tool: Add", "Herramienta: Añadir",
                             "Outil : Ajouter", "Werkzeug: Hinzufügen", "Ferramenta: Adicionar"]
NEW['shortcut.toolRemove'] = ["Strumento: Rimuovi", "Tool: Remove", "Herramienta: Quitar",
                              "Outil : Supprimer", "Werkzeug: Entfernen", "Ferramenta: Remover"]
NEW['shortcut.toolDraw'] = ["Strumento: Disegna", "Tool: Draw", "Herramienta: Dibujar",
                            "Outil : Dessiner", "Werkzeug: Zeichnen", "Ferramenta: Desenhar"]
NEW['shortcut.toolPick'] = ["Strumento: Contagocce", "Tool: Eyedropper", "Herramienta: Cuentagotas",
                            "Outil : Pipette", "Werkzeug: Pipette", "Ferramenta: Conta-gotas"]
NEW['shortcut.toggleMode'] = ["Modalità Oggetto/Modifica", "Object/Edit mode", "Modo Objeto/Edición",
                              "Mode Objet/Édition", "Objekt-/Bearbeitungsmodus", "Modo Objeto/Edição"]
NEW['shortcut.extrude'] = ["Estrusione", "Extrude", "Extrusión", "Extrusion", "Extrusion", "Extrusão"]
NEW['shortcut.brushDown'] = ["Pennello −", "Brush −", "Pincel −", "Pinceau −", "Pinsel −", "Pincel −"]
NEW['shortcut.brushUp'] = ["Pennello +", "Brush +", "Pincel +", "Pinceau +", "Pinsel +", "Pincel +"]
NEW['shortcut.keySpace'] = ["Spazio", "Space", "Espacio", "Espace", "Leertaste", "Espaço"]
NEW['shortcut.keyEsc'] = ["Esc", "Esc", "Esc", "Échap", "Esc", "Esc"]
NEW['shortcut.pressKey'] = ["premi un tasto…", "press a key…", "pulsa una tecla…",
                            "appuie sur une touche…", "Taste drücken…", "prime uma tecla…"]
NEW['shortcut.rebindTitle'] = [
    "Clicca e premi la nuova combinazione (Esc per annullare)",
    "Click, then press the new combination (Esc to cancel)",
    "Haz clic y pulsa la nueva combinación (Esc para cancelar)",
    "Clique puis appuie sur la nouvelle combinaison (Échap pour annuler)",
    "Klicken und die neue Tastenkombination drücken (Esc zum Abbrechen)",
    "Clica e prime a nova combinação (Esc para cancelar)"]
NEW['shortcut.conflict'] = [
    'Il tasto "{key}" è già usato da "{action}". Scegli un altro tasto.',
    'The "{key}" key is already used by "{action}". Choose another key.',
    'La tecla "{key}" ya la usa "{action}". Elige otra tecla.',
    'La touche "{key}" est déjà utilisée par "{action}". Choisis une autre touche.',
    'Die Taste "{key}" wird schon von "{action}" verwendet. Wähle eine andere Taste.',
    'A tecla "{key}" já é usada por "{action}". Escolhe outra tecla.']

# ---- J. 24-plugins.js ----
NEW['plugins.builtinMirrorX'] = ["Specchia su X", "Mirror on X", "Reflejar en X",
                                 "Miroir sur X", "An X spiegeln", "Espelhar em X"]
NEW['plugins.builtinGrayscale'] = ["Scala di grigi", "Grayscale", "Escala de grises",
                                   "Niveaux de gris", "Graustufen", "Escala de cinzas"]
NEW['plugins.builtinHollow'] = ["Svuota interno", "Hollow out", "Vaciar el interior",
                                "Évider l'intérieur", "Innen aushöhlen", "Esvaziar o interior"]
NEW['plugins.notArray'] = [
    "lo script deve restituire un array di voxel", "the script must return an array of voxels",
    "el script debe devolver un array de vóxeles", "le script doit renvoyer un tableau de voxels",
    "das Skript muss ein Array von Voxeln zurückgeben", "o script tem de devolver um array de voxels"]
NEW['plugins.tooManyVoxels'] = [
    "troppi voxel restituiti ({n} > {max})", "too many voxels returned ({n} > {max})",
    "se han devuelto demasiados vóxeles ({n} > {max})", "trop de voxels renvoyés ({n} > {max})",
    "zu viele Voxel zurückgegeben ({n} > {max})", "demasiados voxels devolvidos ({n} > {max})"]
NEW['plugins.doneCount'] = [
    "Fatto: {n} voxel", "Done: {n} voxels", "Hecho: {n} vóxeles",
    "Terminé : {n} voxels", "Fertig: {n} Voxel", "Concluído: {n} voxels"]
NEW['plugins.dropped'] = [
    "({n} scartati non validi)", "({n} invalid ones discarded)", "({n} descartados no válidos)",
    "({n} non valides ignorés)", "({n} ungültige verworfen)", "({n} inválidos descartados)"]
NEW['plugins.missingTransform'] = [
    "manca function transform(voxels, api)", "function transform(voxels, api) is missing",
    "falta function transform(voxels, api)", "function transform(voxels, api) est absente",
    "function transform(voxels, api) fehlt", "falta function transform(voxels, api)"]
NEW['plugins.pluginError'] = [
    "Errore plugin: {error}", "Plugin error: {error}", "Error del plugin: {error}",
    "Erreur du plugin : {error}", "Plugin-Fehler: {error}", "Erro do plugin: {error}"]
NEW['plugins.genericError'] = [
    "Errore: {error}", "Error: {error}", "Error: {error}",
    "Erreur : {error}", "Fehler: {error}", "Erro: {error}"]

# ---- K. 30-import-glb.js ----
NEW['glb.noVisibleMeshes'] = [
    "Il modello non contiene mesh visibili.", "The model contains no visible meshes.",
    "El modelo no contiene mallas visibles.", "Le modèle ne contient aucun maillage visible.",
    "Das Modell enthält keine sichtbaren Meshes.", "O modelo não contém malhas visíveis."]
NEW['glb.noTriangles'] = [
    "Nessun triangolo trovato nel modello.", "No triangles found in the model.",
    "No se han encontrado triángulos en el modelo.", "Aucun triangle trouvé dans le modèle.",
    "Im Modell wurden keine Dreiecke gefunden.", "Nenhum triângulo encontrado no modelo."]
NEW['glb.zeroSize'] = [
    "Il modello ha dimensione nulla.", "The model has zero size.", "El modelo tiene tamaño nulo.",
    "Le modèle a une taille nulle.", "Das Modell hat die Größe null.", "O modelo tem dimensão nula."]
NEW['glb.noVoxels'] = [
    "La voxelizzazione non ha prodotto voxel.", "Voxelization produced no voxels.",
    "La voxelización no ha producido vóxeles.", "La voxélisation n'a produit aucun voxel.",
    "Die Voxelisierung hat keine Voxel erzeugt.", "A voxelização não produziu voxels."]

# ---- L. 27-pack.js (buchi residui) ----
NEW['pack.assetUnavailable'] = [
    "Asset non disponibile", "Asset unavailable", "Asset no disponible",
    "Asset indisponible", "Asset nicht verfügbar", "Asset não disponível"]
NEW['pack.jobStatusTitle'] = [
    "{label} — {status}", "{label} — {status}", "{label} — {status}",
    "{label} — {status}", "{label} — {status}", "{label} — {status}"]
