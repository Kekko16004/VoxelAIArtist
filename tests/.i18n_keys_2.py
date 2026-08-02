# -*- coding: utf-8 -*-
"""Tabella chiavi i18n (parte 2/3): formati, progetto, launcher, impostazioni schermate.
Ordine valori: it, en, es, fr, de, pt. Strumento di lavoro, non parte della suite.
"""

NEW = {}

# ---- E. 20-formats.js (errori import/export .vox e .schem) ----
NEW['formats.voxTooShort'] = [
    ".vox troppo corto", ".vox file too short", "Archivo .vox demasiado corto",
    "Fichier .vox trop court", ".vox-Datei zu kurz", "Ficheiro .vox demasiado curto"]
NEW['formats.voxBadMagic'] = [
    'Magic .vox non valido (atteso "VOX ")', 'Invalid .vox magic (expected "VOX ")',
    'Firma .vox no válida (se esperaba "VOX ")', 'Signature .vox non valide (attendu "VOX ")',
    'Ungültige .vox-Signatur (erwartet "VOX ")', 'Assinatura .vox inválida (esperado "VOX ")']
NEW['formats.voxNoModels'] = [
    ".vox senza modelli (nessun XYZI)", ".vox with no models (no XYZI chunk)",
    ".vox sin modelos (ningún XYZI)", ".vox sans modèles (aucun XYZI)",
    ".vox ohne Modelle (kein XYZI)", ".vox sem modelos (nenhum XYZI)"]
NEW['formats.schemNoGunzip'] = [
    "File .schem gzip ma non ho modo di decomprimerlo (manca pako/DecompressionStream).",
    "The .schem file is gzipped but there is no way to decompress it here (pako/DecompressionStream missing).",
    "El archivo .schem está comprimido con gzip pero no hay forma de descomprimirlo (falta pako/DecompressionStream).",
    "Le fichier .schem est en gzip mais il n'y a aucun moyen de le décompresser ici (pako/DecompressionStream manquant).",
    "Die .schem-Datei ist gzip-komprimiert, kann hier aber nicht entpackt werden (pako/DecompressionStream fehlt).",
    "O ficheiro .schem está comprimido em gzip mas não há forma de o descomprimir (falta pako/DecompressionStream)."]
NEW['formats.nbtUnsupportedTag'] = [
    "Tag NBT non supportato: {tag}", "Unsupported NBT tag: {tag}", "Etiqueta NBT no compatible: {tag}",
    "Balise NBT non prise en charge : {tag}", "Nicht unterstützter NBT-Tag: {tag}", "Tag NBT não suportado: {tag}"]
NEW['formats.nbtRootNotCompound'] = [
    "NBT root non è un compound", "The NBT root is not a compound", "La raíz NBT no es un compound",
    "La racine NBT n'est pas un compound", "Die NBT-Wurzel ist kein Compound", "A raiz NBT não é um compound"]
NEW['formats.schemNoBlockData'] = [
    ".schem senza BlockData", ".schem with no BlockData", ".schem sin BlockData",
    ".schem sans BlockData", ".schem ohne BlockData", ".schem sem BlockData"]
NEW['formats.voxExportError'] = [
    "Errore export .vox: {error}", ".vox export error: {error}", "Error al exportar .vox: {error}",
    "Erreur d'export .vox : {error}", "Fehler beim .vox-Export: {error}", "Erro ao exportar .vox: {error}"]
NEW['formats.schemExportError'] = [
    "Errore export .schem: {error}", ".schem export error: {error}", "Error al exportar .schem: {error}",
    "Erreur d'export .schem : {error}", "Fehler beim .schem-Export: {error}", "Erro ao exportar .schem: {error}"]
NEW['formats.schemNoGzip'] = [
    ".schem esportato SENZA compressione gzip (gzip non disponibile qui). La maggior parte dei tool WorldEdit/Litematica legge comunque NBT non compresso, ma alcuni potrebbero rifiutarlo.",
    ".schem exported WITHOUT gzip compression (gzip is not available here). Most WorldEdit/Litematica tools read uncompressed NBT anyway, but some may reject it.",
    ".schem exportado SIN compresión gzip (gzip no está disponible aquí). La mayoría de las herramientas WorldEdit/Litematica leen NBT sin comprimir, pero algunas pueden rechazarlo.",
    ".schem exporté SANS compression gzip (gzip indisponible ici). La plupart des outils WorldEdit/Litematica lisent le NBT non compressé, mais certains peuvent le refuser.",
    ".schem OHNE gzip-Komprimierung exportiert (gzip ist hier nicht verfügbar). Die meisten WorldEdit-/Litematica-Tools lesen unkomprimiertes NBT, einige lehnen es aber ab.",
    ".schem exportado SEM compressão gzip (gzip não disponível aqui). A maioria das ferramentas WorldEdit/Litematica lê NBT não comprimido, mas algumas podem rejeitá-lo."]

# ---- F. 21-project.js (progetto + cronologia autosave) ----
NEW['project.invalidData'] = [
    "Dati progetto non validi.", "Invalid project data.", "Datos de proyecto no válidos.",
    "Données de projet non valides.", "Ungültige Projektdaten.", "Dados de projeto inválidos."]
NEW['project.invalidFormat'] = [
    'Formato progetto non valido: manca "objects", "ops" o "voxels".',
    'Invalid project format: "objects", "ops" or "voxels" is missing.',
    'Formato de proyecto no válido: falta "objects", "ops" o "voxels".',
    'Format de projet non valide : "objects", "ops" ou "voxels" est absent.',
    'Ungültiges Projektformat: "objects", "ops" oder "voxels" fehlt.',
    'Formato de projeto inválido: falta "objects", "ops" ou "voxels".']
NEW['project.autosavedAt'] = [
    "Salvato automaticamente {time}", "Auto-saved at {time}", "Guardado automáticamente {time}",
    "Enregistré automatiquement à {time}", "Automatisch gespeichert um {time}", "Guardado automaticamente {time}"]
NEW['project.saveError'] = [
    "Errore salvataggio progetto: {error}", "Error saving the project: {error}",
    "Error al guardar el proyecto: {error}", "Erreur lors de l'enregistrement du projet : {error}",
    "Fehler beim Speichern des Projekts: {error}", "Erro ao guardar o projeto: {error}"]
NEW['project.openUnavailable'] = [
    "Apertura progetto non disponibile.", "Opening a project is not available.",
    "La apertura de proyectos no está disponible.", "L'ouverture de projet n'est pas disponible.",
    "Das Öffnen eines Projekts ist nicht verfügbar.", "A abertura de projeto não está disponível."]
NEW['project.openError'] = [
    "Errore apertura progetto: {error}", "Error opening the project: {error}",
    "Error al abrir el proyecto: {error}", "Erreur lors de l'ouverture du projet : {error}",
    "Fehler beim Öffnen des Projekts: {error}", "Erro ao abrir o projeto: {error}"]
NEW['project.unknownBinary'] = [
    "Formato binario non riconosciuto: {ext}", "Unrecognised binary format: {ext}",
    "Formato binario no reconocido: {ext}", "Format binaire non reconnu : {ext}",
    "Unbekanntes Binärformat: {ext}", "Formato binário não reconhecido: {ext}"]
NEW['project.openBadResponse'] = [
    "Risposta apertura progetto non riconosciuta.", "Unrecognised response while opening the project.",
    "Respuesta de apertura de proyecto no reconocida.", "Réponse d'ouverture de projet non reconnue.",
    "Unbekannte Antwort beim Öffnen des Projekts.", "Resposta de abertura de projeto não reconhecida."]
NEW['autosave.needsApp'] = [
    "La cronologia salvataggi richiede l'app avviata (python main.py): aperta come file locale non c'è il backend che la conserva.",
    "The save history needs the app running (python main.py): opened as a local file there is no backend to keep it.",
    "El historial de guardados necesita la app en marcha (python main.py): abierta como archivo local no hay backend que lo conserve.",
    "L'historique des sauvegardes nécessite l'app lancée (python main.py) : ouverte comme fichier local, aucun backend ne le conserve.",
    "Der Speicherverlauf benötigt die laufende App (python main.py): als lokale Datei geöffnet gibt es kein Backend, das ihn aufbewahrt.",
    "O histórico de gravações requer a app em execução (python main.py): aberta como ficheiro local não há backend que o guarde."]
NEW['autosave.loadFailed'] = [
    "Impossibile caricare la cronologia.", "Could not load the history.", "No se ha podido cargar el historial.",
    "Impossible de charger l'historique.", "Der Verlauf konnte nicht geladen werden.", "Não foi possível carregar o histórico."]
NEW['autosave.empty'] = [
    "Nessun salvataggio automatico presente.", "No automatic saves yet.", "No hay guardados automáticos.",
    "Aucune sauvegarde automatique.", "Keine automatischen Speicherungen vorhanden.", "Nenhuma gravação automática presente."]
NEW['autosave.loadError'] = [
    "Errore nel caricamento della cronologia.", "Error loading the history.",
    "Error al cargar el historial.", "Erreur lors du chargement de l'historique.",
    "Fehler beim Laden des Verlaufs.", "Erro ao carregar o histórico."]
NEW['autosave.confirmRestore'] = [
    "Ripristinare questo salvataggio automatico? La scena corrente verrà sostituita.",
    "Restore this automatic save? The current scene will be replaced.",
    "¿Restaurar este guardado automático? La escena actual se sustituirá.",
    "Restaurer cette sauvegarde automatique ? La scène actuelle sera remplacée.",
    "Diese automatische Speicherung wiederherstellen? Die aktuelle Szene wird ersetzt.",
    "Restaurar esta gravação automática? A cena atual será substituída."]
NEW['autosave.restoreLoadFailed'] = [
    "Impossibile caricare il salvataggio selezionato.", "Could not load the selected save.",
    "No se ha podido cargar el guardado seleccionado.", "Impossible de charger la sauvegarde sélectionnée.",
    "Die ausgewählte Speicherung konnte nicht geladen werden.", "Não foi possível carregar a gravação selecionada."]
NEW['autosave.restoreError'] = [
    "Errore nel ripristino: {error}", "Error while restoring: {error}", "Error al restaurar: {error}",
    "Erreur lors de la restauration : {error}", "Fehler beim Wiederherstellen: {error}", "Erro ao restaurar: {error}"]
NEW['autosave.needsAppFolder'] = [
    "Serve l'app avviata (python main.py): senza backend non c'è nessuna cartella da aprire.",
    "The app must be running (python main.py): without a backend there is no folder to open.",
    "Se necesita la app en marcha (python main.py): sin backend no hay ninguna carpeta que abrir.",
    "L'app doit être lancée (python main.py) : sans backend il n'y a aucun dossier à ouvrir.",
    "Die App muss laufen (python main.py): ohne Backend gibt es keinen Ordner zum Öffnen.",
    "É necessário ter a app em execução (python main.py): sem backend não há nenhuma pasta para abrir."]
NEW['autosave.folderError'] = [
    "Impossibile aprire la cartella: {error}", "Could not open the folder: {error}",
    "No se ha podido abrir la carpeta: {error}", "Impossible d'ouvrir le dossier : {error}",
    "Der Ordner konnte nicht geöffnet werden: {error}", "Não foi possível abrir a pasta: {error}"]

# ---- G. 22-screens.js (launcher progetti recenti) ----
NEW['launcher.dialogLabel'] = [
    "Apri o crea un progetto", "Open or create a project", "Abrir o crear un proyecto",
    "Ouvrir ou créer un projet", "Projekt öffnen oder erstellen", "Abrir ou criar um projeto"]
NEW['launcher.subtitle'] = [
    "Riprendi un progetto recente o creane uno nuovo.", "Resume a recent project or create a new one.",
    "Retoma un proyecto reciente o crea uno nuevo.", "Reprends un projet récent ou crées-en un nouveau.",
    "Setze ein kürzliches Projekt fort oder erstelle ein neues.", "Retoma um projeto recente ou cria um novo."]
NEW['launcher.recentTitle'] = [
    "Progetti recenti", "Recent projects", "Proyectos recientes",
    "Projets récents", "Kürzliche Projekte", "Projetos recentes"]
NEW['launcher.newBtn'] = [
    "＋ Nuovo progetto", "＋ New project", "＋ Nuevo proyecto",
    "＋ Nouveau projet", "＋ Neues Projekt", "＋ Novo projeto"]
NEW['launcher.newBtnTitle'] = [
    "Crea un nuovo progetto vuoto ed entra nella scena", "Create a new empty project and enter the scene",
    "Crea un nuevo proyecto vacío y entra en la escena", "Crée un nouveau projet vide et entre dans la scène",
    "Neues leeres Projekt erstellen und die Szene betreten", "Cria um novo projeto vazio e entra na cena"]
NEW['launcher.openBtn'] = [
    "\U0001F4C2 Apri progetto…", "\U0001F4C2 Open project…", "\U0001F4C2 Abrir proyecto…",
    "\U0001F4C2 Ouvrir un projet…", "\U0001F4C2 Projekt öffnen…", "\U0001F4C2 Abrir projeto…"]
NEW['launcher.openBtnTitle'] = [
    "Apri un progetto esistente (.voxai / .json / .vox / .schem)",
    "Open an existing project (.voxai / .json / .vox / .schem)",
    "Abre un proyecto existente (.voxai / .json / .vox / .schem)",
    "Ouvre un projet existant (.voxai / .json / .vox / .schem)",
    "Ein bestehendes Projekt öffnen (.voxai / .json / .vox / .schem)",
    "Abre um projeto existente (.voxai / .json / .vox / .schem)"]
NEW['launcher.showOnStart'] = [
    "Mostra questa schermata all'avvio", "Show this screen at startup",
    "Mostrar esta pantalla al iniciar", "Afficher cet écran au démarrage",
    "Diesen Bildschirm beim Start anzeigen", "Mostrar este ecrã ao iniciar"]
NEW['launcher.skip'] = ["Salta", "Skip", "Omitir", "Passer", "Überspringen", "Ignorar"]
NEW['launcher.skipTitle'] = [
    "Chiudi e vai alla scena corrente", "Close and go to the current scene",
    "Cierra y ve a la escena actual", "Ferme et va à la scène actuelle",
    "Schließen und zur aktuellen Szene wechseln", "Fecha e vai para a cena atual"]
NEW['launcher.selectInDialog'] = [
    'Seleziona "{name}" nella finestra che sta per aprirsi.\n\n(Percorso: {path})',
    'Select "{name}" in the dialog that is about to open.\n\n(Path: {path})',
    'Selecciona "{name}" en la ventana que se va a abrir.\n\n(Ruta: {path})',
    'Sélectionne "{name}" dans la fenêtre qui va s\'ouvrir.\n\n(Chemin : {path})',
    'Wähle "{name}" im Dialog, der sich gleich öffnet.\n\n(Pfad: {path})',
    'Seleciona "{name}" na janela que está a abrir.\n\n(Caminho: {path})']
NEW['launcher.theProject'] = ["il progetto", "the project", "el proyecto", "le projet", "das Projekt", "o projeto"]
NEW['launcher.recentNeedsApp'] = [
    "Senza l'app avviata (python main.py) i progetti recenti non sono disponibili. Usa \"Apri progetto…\".",
    "Without the app running (python main.py) recent projects are not available. Use \"Open project…\".",
    "Sin la app en marcha (python main.py) los proyectos recientes no están disponibles. Usa \"Abrir proyecto…\".",
    "Sans l'app lancée (python main.py) les projets récents ne sont pas disponibles. Utilise \"Ouvrir un projet…\".",
    "Ohne laufende App (python main.py) sind kürzliche Projekte nicht verfügbar. Verwende \"Projekt öffnen…\".",
    "Sem a app em execução (python main.py) os projetos recentes não estão disponíveis. Usa \"Abrir projeto…\"."]
NEW['launcher.recentEmpty'] = [
    "Nessun progetto recente. Creane uno nuovo o aprine uno esistente.",
    "No recent projects. Create a new one or open an existing one.",
    "No hay proyectos recientes. Crea uno nuevo o abre uno existente.",
    "Aucun projet récent. Crées-en un nouveau ou ouvres-en un existant.",
    "Keine kürzlichen Projekte. Erstelle ein neues oder öffne ein bestehendes.",
    "Nenhum projeto recente. Cria um novo ou abre um existente."]
NEW['launcher.projectFallback'] = ["Progetto", "Project", "Proyecto", "Projet", "Projekt", "Projeto"]
NEW['launcher.removeRecent'] = [
    "Rimuovi dai recenti", "Remove from recents", "Quitar de los recientes",
    "Retirer des récents", "Aus den kürzlichen entfernen", "Remover dos recentes"]
