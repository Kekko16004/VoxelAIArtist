        window.addEventListener('load', () => {
            // Default Model Data
            const defaultData = {
                "metadata": {
                    "name": "Spada Pixel Art",
                    "grid_size": [16, 16, 16]
                },
                "voxels": [
                    { "x": 8, "y": 1, "z": 8, "color": "#4A3B32" },
                    { "x": 8, "y": 2, "z": 8, "color": "#4A3B32" },
                    { "x": 8, "y": 3, "z": 8, "color": "#FFD700" },
                    { "x": 7, "y": 3, "z": 8, "color": "#FFD700" },
                    { "x": 9, "y": 3, "z": 8, "color": "#FFD700" },
                    { "x": 8, "y": 4, "z": 8, "color": "#C0C0C0" },
                    { "x": 8, "y": 5, "z": 8, "color": "#C0C0C0" },
                    { "x": 8, "y": 6, "z": 8, "color": "#C0C0C0" },
                    { "x": 8, "y": 7, "z": 8, "color": "#C0C0C0" },
                    { "x": 8, "y": 8, "z": 8, "color": "#C0C0C0" },
                    { "x": 8, "y": 9, "z": 8, "color": "#C0C0C0" },
                    { "x": 8, "y": 10, "z": 8, "color": "#C0C0C0" },
                    { "x": 8, "y": 11, "z": 8, "color": "#C0C0C0" },
                    { "x": 8, "y": 12, "z": 8, "color": "#C0C0C0" },
                    { "x": 8, "y": 13, "z": 8, "color": "#C0C0C0" }
                ]
            };

            // Application State
            let currentModelData = defaultData;
            let visibleVoxels = [];
            let meshes = [];
            let gridHelper = null;
            let boxHelper = null;

            // ===== T1 Multi-object scene model (Fase A: fondamenta) =====
            // sceneObjects holds every object in the scene. In Fase A there is always
            // exactly one active object whose data IS currentModelData, so all the
            // existing single-object code (editing, rendering, export, rig) keeps
            // working unchanged. Selection / multi-object operations arrive in Fase B.
            let sceneObjects = [];
            let activeObjectId = null;
            let nextObjectId = 1;

            // Editing State
            // voxelMap is the source of truth while editing: "x,y,z" -> "#RRGGBB"
            // (the rest of the editing state lives in the EDITING ENGINE section below)
            let voxelMap = new Map();

            // Three.js Setup