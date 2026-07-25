            // ===================== EDITING ENGINE =====================
            // Tools: 'view' (orbit only), 'place' (add voxel), 'remove' (delete voxel),
            // 'pick' (eyedropper). Left click performs the tool's action; a live preview
            // shows a green ghost cube for placement and a red outline for removal.
            let currentTool = 'view';
            let activeColorHex = '#6366F1';
            let symmetryAxis = 'none';  // 'none' | 'x' | 'y' | 'z' — mirror edits across model center
            const raycaster = new THREE.Raycaster();
            const pointer = new THREE.Vector2();
            let hoverCell = null;      // {x,y,z} cell that would be affected
            let pointerDownPos = null; // to distinguish a click from a drag-orbit

            // Undo/redo history stores deep snapshots of the voxel array.
            const undoStack = [];
            const redoStack = [];
            const MAX_HISTORY = 40;

            const toolButtons = {
                view: document.getElementById('toolView'),
                place: document.getElementById('toolPlace'),
                draw: document.getElementById('toolDraw'),
                pick: document.getElementById('toolPick'),
            };
            const activeColorInput = document.getElementById('activeColor');
            const activeColorHexEl = document.getElementById('activeColorHex');
            const editHint = document.getElementById('editHint');
            const brushSizeInput = document.getElementById('brushSize');
            const brushSizeVal = document.getElementById('brushSizeVal');
            let brushSize = 1;   // radius in voxels for place/remove/draw
            brushSizeInput.addEventListener('input', () => {
                brushSize = parseInt(brushSizeInput.value, 10) || 1;
                brushSizeVal.textContent = brushSize;
            });
            const undoBtn = document.getElementById('undoBtn');
            const redoBtn = document.getElementById('redoBtn');

            const HINTS = {
                view: 'Modalità Vista: trascina per orbitare, rotella per zoom.',
                place: 'Aggiungi: trascina con tasto sinistro per creare un\'area (Scrap Mechanic). Premi Q per ciclare l\'asse.',
                remove: 'Rimuovi: trascina con tasto destro o strumento attivo per cancellare aree. Premi Q per ciclare l\'asse.',
                draw: 'Disegna: trascina per ricolorare un\'intera area. Premi Q per ciclare l\'asse.',
                pick: 'Contagocce: clic sinistro su un voxel per copiarne il colore.',
            };

            // --- Preview meshes ---
            // Green ghost cube for "place".
            const previewAddMesh = new THREE.Mesh(
                new THREE.BoxGeometry(1, 1, 1),
                new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.45, depthWrite: false })
            );
            previewAddMesh.visible = false;
            scene.add(previewAddMesh);
            // Red wireframe box highlighting the voxel to remove.
            const previewRemoveMesh = new THREE.LineSegments(
                new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)),
                new THREE.LineBasicMaterial({ color: 0xff3b3b })
            );
            previewRemoveMesh.visible = false;
            scene.add(previewRemoveMesh);

            // Scrap Mechanic style area preview box
            const previewBoxMesh = new THREE.Mesh(
                new THREE.BoxGeometry(1, 1, 1),
                new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.35, depthWrite: false })
            );
            previewBoxMesh.visible = false;
            scene.add(previewBoxMesh);

            const previewBoxEdges = new THREE.LineSegments(
                new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
                new THREE.LineBasicMaterial({ color: 0x22c55e, linewidth: 2 })
            );
            previewBoxEdges.visible = false;
            scene.add(previewBoxEdges);

            // Voxel box selection/drag variables
            let isDraggingArea = false;
            let boxStartCell = null;
            let boxEndCell = null;
            let dragNormal = null;
            let activePlane = null;
            let dragConstraintMode = 'auto'; // 'auto' | 'x' | 'y' | 'z'
            let lastPointerEvent = null;

            // T2b: "spessore" della selezione box. Mentre trascini un rettangolo di
            // selezione (isDraggingArea) puoi premere E per BLOCCARE le due dimensioni
            // nel piano e trasformare il rettangolo in un cubo, dando profondità lungo
            // il terzo asse (quello bloccato/normale) col movimento su/giù del mouse.
            // Mouse in alto -> cresce verso +asse, in basso -> verso -asse.
            let boxDepthMode = false;      // true dopo aver premuto E durante il drag
            let boxDepthAxis = null;       // 'x' | 'y' | 'z' — asse di profondità
            let boxDepthAnchor = null;     // punto-mondo sull'asse per la proiezione
            let lockedDragAxis = 'y';      // ultimo asse bloccato calcolato dal piano

            const dragConstraintHUD = document.getElementById('dragConstraintHUD');
