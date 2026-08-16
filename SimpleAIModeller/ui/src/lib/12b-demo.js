
/**
 * DEMO senza AI: una cassa del tesoro low-poly, modellata a mano con la stessa
 * spec che produce il generatore.
 *
 * Non e' un segnaposto: e' il banco di prova del formato. Modellandola si sono
 * trovate tre lacune del motore che nessun test vedeva — il settore di cilindro
 * (il coperchio bombato), l'arco di toro (le cerchiature) e la convenzione che
 * centra gli archi IN ALTO. Se una cassa del tesoro con doghe, fasce, borchie,
 * serratura, cerniere e maniglie sta in sedici nodi e zero difetti, il formato
 * regge; se non ci stesse, sarebbe il formato da cambiare, non il prompt.
 */
function demoSpec() {
    return {
        id: "cassa_tesoro",
        cat: "prop",
        style: "lowpoly",
        detail: 3,
        ground: true,
        size: [0.92, 0.68, 0.56],
        smooth: {
            on: true,
            angle: 30
        },
        params: {
            w: 0.88,
            d: 0.52,
            corpo_h: 0.34,
            piede_h: 0.05,
            lid_r: 0.24,
            sp: 0.02,
            fe: 0.014
        },
        mats: {
            legno: {
                col: "#6B4226",
                rough: 0.88,
                noise: {
                    t: "stripe",
                    scale: 46,
                    amp: 0.32,
                    col2: "#4A2C17"
                }
            },
            ferro: {
                col: "#43474E",
                rough: 0.5,
                metal: 0.75,
                noise: {
                    t: "scratch",
                    scale: 70,
                    amp: 0.3,
                    col2: "#282B31"
                }
            },
            oro: {
                col: "#C9A24A",
                rough: 0.28,
                metal: 0.9,
                noise: {
                    t: "scratch",
                    scale: 100,
                    amp: 0.22,
                    col2: "#8A6A22"
                }
            }
        },
        nodes: [
            {
                n: "corpo",
                p: "box",
                s: ["w", "corpo_h", "d"],
                at: [0, "piede_h+corpo_h/2", 0],
                bevel: 0.014,
                mat: "legno"
            },
            {
                n: "vano",
                p: "box",
                s: ["w-2*sp", "corpo_h", "d-2*sp"],
                at: [0, "piede_h+corpo_h/2+sp", 0],
                op: "sub",
                of: "corpo"
            },
            {
                n: "coperchio",
                p: "cyl",
                axis: "x",
                arc: 180,
                r: "lid_r",
                len: "w",
                sides: 28,
                rot: [0, 0, 0],
                mat: "legno",
                at: [0, "piede_h+corpo_h+0.004", 0]
            },
            {
                n: "piede",
                p: "box",
                s: [0.1, "piede_h", 0.1],
                at: ["w/2-0.075", "piede_h/2", "d/2-0.075"],
                bevel: 0.01,
                mat: "legno",
                arr: {
                    n: 2,
                    step: [0, 0, "-(d-0.15)"]
                },
                mir: "x"
            },
            {
                n: "cornice_sup",
                p: "box",
                s: ["w+0.016", 0.03, "d+0.016"],
                at: [0, "piede_h+corpo_h-0.012", 0],
                bevel: 0.005,
                mat: "ferro"
            },
            {
                n: "cornice_sup_vano",
                p: "box",
                s: ["w-2*sp*1.2", 0.06, "d-2*sp*1.2"],
                at: [0, "piede_h+corpo_h-0.012", 0],
                op: "sub",
                of: "cornice_sup"
            },
            {
                n: "cornice_inf",
                p: "box",
                s: ["w+0.012", 0.024, "d+0.012"],
                at: [0, "piede_h+0.014", 0],
                bevel: 0.004,
                mat: "ferro"
            },
            {
                n: "fascia",
                p: "box",
                s: ["fe*1.6", "corpo_h+0.02", "d+0.02"],
                at: [-0.3, "piede_h+corpo_h/2", 0],
                bevel: 0.003,
                mat: "ferro",
                arr: {
                    n: 3,
                    step: [0.3, 0, 0]
                }
            },
            {
                n: "cerchio_cop",
                p: "torus",
                axis: "x",
                arc: 182,
                r: "lid_r+0.004",
                r2: 0.011,
                sides: 28,
                mat: "ferro",
                at: [-0.3, "piede_h+corpo_h+0.004", 0],
                arr: {
                    n: 3,
                    step: [0.3, 0, 0]
                }
            },
            {
                n: "spigolo",
                p: "box",
                s: [0.05, 0.05, "fe"],
                at: ["w/2-0.03", "piede_h+0.04", "d/2+0.004"],
                bevel: 0.004,
                mat: "ferro",
                arr: {
                    n: 2,
                    step: [0, "corpo_h-0.10", 0]
                },
                mir: "x"
            },
            {
                n: "piastra",
                p: "box",
                s: [0.14, 0.16, 0.016],
                at: [0, "piede_h+corpo_h-0.055", "d/2+0.006"],
                bevel: 0.007,
                mat: "oro"
            },
            {
                n: "buco_chiave",
                p: "cyl",
                r: 0.017,
                len: 0.06,
                axis: "z",
                at: [0, "piede_h+corpo_h-0.07", "d/2+0.006"],
                op: "sub",
                of: "piastra"
            },
            {
                n: "gancio",
                p: "box",
                s: [0.05, 0.07, 0.012],
                at: [0, "piede_h+corpo_h+0.03", "d/2+0.008"],
                bevel: 0.004,
                mat: "oro"
            },
            {
                n: "cerniera",
                p: "cyl",
                r: 0.017,
                len: 0.12,
                axis: "x",
                at: [-0.26, "piede_h+corpo_h+0.004", "-d/2+0.018"],
                mat: "ferro",
                arr: {
                    n: 3,
                    step: [0.26, 0, 0]
                }
            },
            {
                n: "borchia",
                p: "sphere",
                r: 0.012,
                at: [-0.36, "piede_h+0.055", "d/2+0.008"],
                mat: "ferro",
                arr: {
                    n: 13,
                    step: [0.06, 0, 0]
                }
            },
            {
                n: "maniglia",
                p: "tube",
                r: 0.012,
                path: [
                    [-0.445, "piede_h+corpo_h*0.62", 0.06],
                    [-0.495, "piede_h+corpo_h*0.5", 0.0],
                    [-0.445, "piede_h+corpo_h*0.38", -0.06]
                ],
                mat: "ferro",
                mir: "x"
            }
        ],
        rig: [
            {
                b: "cardine",
                piv: [0, 0.39, -0.26],
                axis: "x",
                lim: [-105, 0]
            }
        ],
        clips: {
            apri: {
                dur: 0.7,
                loop: false,
                keys: [
                    [
                        0,
                        {
                            cardine: [0, 0, 0]
                        }
                    ],
                    [
                        0.7,
                        {
                            cardine: [-100, 0, 0]
                        }
                    ]
                ]
            }
        },
        logic: [
            {
                on: "coperchio",
                var: "aperta",
                trig: "interact",
                clip: "apri"
            }
        ],
        col: [
            {
                t: "box",
                at: [0, 0.34, 0],
                s: [0.92, 0.68, 0.56]
            }
        ],
        flags: ["hollow"]
    };
}
