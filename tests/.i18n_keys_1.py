# -*- coding: utf-8 -*-
"""Tabella chiavi i18n (parte 1/3). Ordine valori: it, en, es, fr, de, pt.
Strumento di lavoro, non parte della suite: consumato da tests/.i18n_apply.py.
"""

UPDATE = {
    'alert.parseNoVoxels': [
        "Formato non valido: deve contenere un array 'voxels', 'ops', 'objects' o un oggetto 'parts'.",
        "Invalid format: it must contain a 'voxels', 'ops' or 'objects' array, or a 'parts' object.",
        "Formato no válido: debe contener un array 'voxels', 'ops' u 'objects', o un objeto 'parts'.",
        "Format non valide : il doit contenir un tableau 'voxels', 'ops' ou 'objects', ou un objet 'parts'.",
        "Ungültiges Format: es muss ein Array 'voxels', 'ops' oder 'objects' bzw. ein Objekt 'parts' enthalten.",
        "Formato inválido: deve conter um array 'voxels', 'ops' ou 'objects', ou um objeto 'parts'."],
}

NEW = {}

# ---- A. Chiavi referenziate da index.template.html ma assenti da TUTTI i locali ----
NEW['generate.modularTitle'] = [
    "Genera pezzi componibili (es. pareti, pavimenti, blocchi con bordi combacianti)",
    "Generate tileable pieces (e.g. walls, floors, blocks with matching edges)",
    "Genera piezas modulares (p. ej. paredes, suelos, bloques con bordes que encajan)",
    "Génère des pièces modulaires (ex. murs, sols, blocs aux bords jointifs)",
    "Kachelbare Teile erzeugen (z. B. Wände, Böden, Blöcke mit passenden Kanten)",
    "Gera peças modulares (ex. paredes, pisos, blocos com bordas encaixáveis)"]
NEW['generate.modular'] = [
    "Asset modulare / componibile", "Modular / tileable asset", "Asset modular / combinable",
    "Asset modulaire / raccordable", "Modulares / kachelbares Asset", "Asset modular / encaixável"]
NEW['generate.modularHint'] = [
    "L'IA allineerà i bordi alla griglia in modo che il modello sia componibile e affiancabile.",
    "The AI will align the edges to the grid so the model can be tiled and placed side by side.",
    "La IA alineará los bordes a la rejilla para que el modelo se pueda combinar y colocar en serie.",
    "L'IA alignera les bords sur la grille afin que le modèle puisse être raccordé et juxtaposé.",
    "Die KI richtet die Kanten am Raster aus, damit das Modell kachelbar und aneinanderreihbar ist.",
    "A IA alinhará as bordas à grade para que o modelo possa ser encaixado e colocado lado a lado."]
NEW['generate.singleObjectTitle'] = [
    "Genera un oggetto singolo. Disattivare per suddividere l'oggetto in parti mobili (es. per esportare in GLB con mesh separate)",
    "Generate a single object. Turn it off to split the object into movable parts (e.g. to export a GLB with separate meshes)",
    "Genera un solo objeto. Desactívalo para dividir el objeto en partes móviles (p. ej. para exportar un GLB con mallas separadas)",
    "Génère un objet unique. Désactive cette option pour découper l'objet en parties mobiles (ex. pour exporter un GLB avec des maillages séparés)",
    "Erzeugt ein einzelnes Objekt. Deaktivieren, um das Objekt in bewegliche Teile zu zerlegen (z. B. für den GLB-Export mit getrennten Meshes)",
    "Gera um único objeto. Desative para dividir o objeto em partes móveis (ex. para exportar um GLB com malhas separadas)"]
NEW['generate.singleObject'] = [
    "Oggetto unico (mesh singola)", "Single object (one mesh)", "Objeto único (una sola malla)",
    "Objet unique (maillage unique)", "Einzelnes Objekt (ein Mesh)", "Objeto único (malha única)"]
NEW['glb.options'] = [
    "Opzioni importazione GLB", "GLB import options", "Opciones de importación GLB",
    "Options d'import GLB", "GLB-Importoptionen", "Opções de importação GLB"]
NEW['glb.resolution'] = ["Risoluzione", "Resolution", "Resolución", "Résolution", "Auflösung", "Resolução"]
NEW['glb.fillTitle'] = [
    "Riempie l'interno invece di lasciare un guscio cavo",
    "Fills the interior instead of leaving a hollow shell",
    "Rellena el interior en lugar de dejar una cáscara hueca",
    "Remplit l'intérieur au lieu de laisser une coque creuse",
    "Füllt das Innere, anstatt eine hohle Schale zu lassen",
    "Preenche o interior em vez de deixar uma casca vazia"]
NEW['glb.fill'] = ["Modello pieno", "Solid model", "Modelo macizo", "Modèle plein", "Massives Modell", "Modelo maciço"]
NEW['glb.colorsTitle'] = [
    "Una mesh con texture produce centinaia di colori quasi identici",
    "A textured mesh produces hundreds of nearly identical colours",
    "Una malla con textura produce cientos de colores casi idénticos",
    "Un maillage texturé produit des centaines de couleurs presque identiques",
    "Ein texturiertes Mesh erzeugt hunderte fast identische Farben",
    "Uma malha com textura produz centenas de cores quase idênticas"]
NEW['glb.colors'] = ["Colori palette", "Palette colours", "Colores de la paleta",
                     "Couleurs de la palette", "Palettenfarben", "Cores da paleta"]
NEW['pack.modularTitle'] = [
    "Forza la generazione di oggetti modulari allineati alla griglia (da incastrare)",
    "Force the generation of grid-aligned modular objects (made to fit together)",
    "Fuerza la generación de objetos modulares alineados a la rejilla (para encajar)",
    "Force la génération d'objets modulaires alignés sur la grille (à emboîter)",
    "Erzwingt die Erzeugung rasterausgerichteter modularer Objekte (zum Zusammenstecken)",
    "Força a geração de objetos modulares alinhados à grade (para encaixar)"]
NEW['pack.modular'] = [
    "Asset modulari / componibili", "Modular / tileable assets", "Assets modulares / combinables",
    "Assets modulaires / raccordables", "Modulare / kachelbare Assets", "Assets modulares / encaixáveis"]
NEW['pack.singleObjectTitle'] = [
    "Genera ogni asset del pack come un oggetto singolo. Disattivare per consentire parti mobili separate.",
    "Generate every asset in the pack as a single object. Turn it off to allow separate movable parts.",
    "Genera cada asset del pack como un solo objeto. Desactívalo para permitir partes móviles separadas.",
    "Génère chaque asset du pack comme un objet unique. Désactive cette option pour autoriser des parties mobiles séparées.",
    "Erzeugt jedes Asset des Packs als einzelnes Objekt. Deaktivieren, um getrennte bewegliche Teile zuzulassen.",
    "Gera cada asset do pack como um único objeto. Desative para permitir partes móveis separadas."]
NEW['pack.singleObject'] = list(NEW['generate.singleObject'])
NEW['import.progressTitle'] = [
    "Voxelizzazione in corso...", "Voxelizing...", "Voxelizando...",
    "Voxelisation en cours...", "Voxelisierung läuft...", "A voxelizar..."]

# ---- B. Comuni ----
NEW['common.error'] = ["Errore", "Error", "Error", "Erreur", "Fehler", "Erro"]
NEW['common.unknownError'] = ["Errore sconosciuto", "Unknown error", "Error desconocido",
                              "Erreur inconnue", "Unbekannter Fehler", "Erro desconhecido"]
NEW['common.loading'] = ["Caricamento…", "Loading…", "Cargando…",
                         "Chargement…", "Wird geladen…", "A carregar…"]
NEW['common.restore'] = ["Ripristina", "Restore", "Restaurar", "Restaurer", "Wiederherstellen", "Restaurar"]
NEW['common.browse'] = ["Sfoglia...", "Browse...", "Examinar...", "Parcourir...", "Durchsuchen...", "Procurar..."]

# ---- C. Alert di 02-io-files.js ----
NEW['alert.fileNoValidVoxels'] = [
    "Il file non contiene voxel validi.", "The file does not contain any valid voxels.",
    "El archivo no contiene vóxeles válidos.", "Le fichier ne contient aucun voxel valide.",
    "Die Datei enthält keine gültigen Voxel.", "O ficheiro não contém voxels válidos."]
NEW['alert.binaryLoadError'] = [
    "Errore nel caricamento del file binario: {error}", "Error loading the binary file: {error}",
    "Error al cargar el archivo binario: {error}", "Erreur lors du chargement du fichier binaire : {error}",
    "Fehler beim Laden der Binärdatei: {error}", "Erro ao carregar o ficheiro binário: {error}"]
NEW['alert.glbModuleMissing'] = [
    "Il modulo import-glb.js non è stato caricato.", "The import-glb.js module has not been loaded.",
    "El módulo import-glb.js no se ha cargado.", "Le module import-glb.js n'a pas été chargé.",
    "Das Modul import-glb.js wurde nicht geladen.", "O módulo import-glb.js não foi carregado."]
NEW['alert.importedNoVoxels'] = [
    "Il modello importato non contiene voxel.", "The imported model contains no voxels.",
    "El modelo importado no contiene vóxeles.", "Le modèle importé ne contient aucun voxel.",
    "Das importierte Modell enthält keine Voxel.", "O modelo importado não contém voxels."]
NEW['alert.glbImportError'] = [
    "Errore importazione GLB: {error}", "GLB import error: {error}", "Error de importación GLB: {error}",
    "Erreur d'import GLB : {error}", "GLB-Importfehler: {error}", "Erro de importação GLB: {error}"]
NEW['alert.fileNotJsonOrVoxelai'] = [
    "Il file non è in formato JSON in chiaro né in formato crittografato .voxelai valido.",
    "The file is neither plain JSON nor a valid encrypted .voxelai file.",
    "El archivo no está en formato JSON sin cifrar ni en un formato .voxelai cifrado válido.",
    "Le fichier n'est ni du JSON en clair ni un fichier .voxelai chiffré valide.",
    "Die Datei ist weder unverschlüsseltes JSON noch eine gültige verschlüsselte .voxelai-Datei.",
    "O ficheiro não está em JSON simples nem num formato .voxelai cifrado válido."]
NEW['alert.pasteNotJsonOrVoxelai'] = [
    "Il testo inserito non è JSON valido né un codice .voxelai valido.",
    "The pasted text is neither valid JSON nor a valid .voxelai code.",
    "El texto introducido no es JSON válido ni un código .voxelai válido.",
    "Le texte collé n'est ni du JSON valide ni un code .voxelai valide.",
    "Der eingefügte Text ist weder gültiges JSON noch ein gültiger .voxelai-Code.",
    "O texto introduzido não é JSON válido nem um código .voxelai válido."]

# ---- D. Oggetti / parti (04-objects.js, 11-symmetry-tools.js) ----
NEW['objects.partDuplicateTitle'] = [
    "Duplica come oggetto separato", "Duplicate as a separate object", "Duplicar como objeto separado",
    "Dupliquer comme objet distinct", "Als separates Objekt duplizieren", "Duplicar como objeto separado"]
NEW['objects.partDeleteTitle'] = [
    "Elimina parte/figlio", "Delete part/child", "Eliminar parte/hijo",
    "Supprimer la partie/l'enfant", "Teil/Kind löschen", "Eliminar parte/filho"]
NEW['objects.confirmDeletePart'] = [
    'Eliminare la parte "{name}"?', 'Delete the part "{name}"?', '¿Eliminar la parte "{name}"?',
    'Supprimer la partie "{name}" ?', 'Teil "{name}" löschen?', 'Eliminar a parte "{name}"?']
NEW['objects.confirmDeleteChild'] = [
    'Eliminare la parte/figlio "{name}"?', 'Delete the part/child "{name}"?',
    '¿Eliminar la parte/hijo "{name}"?', "Supprimer la partie/l'enfant \"{name}\" ?",
    'Teil/Kind "{name}" löschen?', 'Eliminar a parte/filho "{name}"?']
NEW['objects.deleteChild'] = [
    "\U0001F5D1 Elimina figlio: {name}", "\U0001F5D1 Delete child: {name}",
    "\U0001F5D1 Eliminar hijo: {name}", "\U0001F5D1 Supprimer l'enfant : {name}",
    "\U0001F5D1 Kind löschen: {name}", "\U0001F5D1 Eliminar filho: {name}"]
NEW['objects.defaultName'] = ["Oggetto {n}", "Object {n}", "Objeto {n}", "Objet {n}", "Objekt {n}", "Objeto {n}"]
NEW['objects.defaultNameBase'] = ["Oggetto", "Object", "Objeto", "Objet", "Objekt", "Objeto"]
NEW['objects.copyName'] = ["{name} (copia)", "{name} (copy)", "{name} (copia)",
                           "{name} (copie)", "{name} (Kopie)", "{name} (cópia)"]
