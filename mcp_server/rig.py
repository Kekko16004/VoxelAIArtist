"""Scheletro, legatura, posa e animazioni: il porto Python di `15-rig.js`.

PERCHE' UN PORTO E NON UNA CHIAMATA. Il motore di rig vive nel browser, dentro
una closure, e dipende da THREE per quaternioni, ossa e clip. Da qui non e'
raggiungibile in nessun modo. Ma le sue costanti non sono arbitrarie: sono
MISURATE su modelli veri (vedi CLAUDE.md e `tests/.diag_signs.mjs`), e
reinventarle darebbe uno scheletro che sembra giusto e si piega male. Quindi si
porta, riga per riga, e le trappole sono le stesse.

TRE COSE CHE NON SI POSSONO DEDURRE, e che qui sono copiate e non ricavate:

1. **Le braccia si ruotano su Z, non su X.** A riposo l'osso del braccio e'
   ALLINEATO ALL'ASSE X, quindi `rot(30,0,0)` su `upperArm_R` sposta la punta di
   esattamente (0,0,0): una rotazione attorno al proprio asse non muove niente.
   `-78` su `_R` / `+78` su `_L` e' la posa "lungo il corpo" da cui parte ogni
   preset. La Z NON dipende dall'imbardata (l'osso `_R` sta sempre a X maggiore).

2. **La X e' l'oscillazione avanti/indietro e DIPENDE dall'imbardata.** I preset
   sono scritti nel frame della camminata di riferimento (`faceYaw == 180`, dove
   X>0 = avanti) e `S = 1 if faceYaw == 180 else -1` li riporta sull'imbardata
   vera. A 90/270 i segni non bastano e la rotazione si CONIUGA (`face_rotate`).

3. **I preset ricevono `qface`; le clip dell'AI NO.** L'AI vede i nomi e le
   posizioni delle ossa vere, quindi scrive gia' nel frame dello scheletro
   reale: coniugarla applicherebbe l'imbardata due volte.

L'EXPORT HA SEI INVARIANTI PROPRI (CLAUDE.md li elenca con le misure). Qui:
niente TRS sul nodo della mesh (1), mesh a riposo con la posa sui nodi delle
ossa (2), tracce di posizione ASSOLUTE costruite direttamente nello spazio cotto
(3), clip di posa PRIMA di tutte (4), faccia condivisa tolta solo se i due voxel
si deformano IDENTICI (5), nessun COLOR_0 (6).

L'ORDINE DEI VOXEL E' L'INDICE. Tutto (`primary`, `indices`, `weights`) e'
parallelo a `obj.voxel_list()`, che ordina per `(y, z, x)`. Chi ricalcola una di
queste liste senza ripartire da li' allinea i pesi ai voxel sbagliati.
"""

import math

from . import compat
from .exporters import _GltfBuilder, pack_glb
from .session import SessionError

# In glTF (come in THREE r128) JOINTS_0/WEIGHTS_0 sono vec4: la quinta influenza
# la butterebbe la GPU in silenzio, quindi la buttiamo noi in modo esplicito e
# ridistribuiamo il suo peso sulle altre.
MAX_BONE_INFLUENCES = 4
WEIGHT_EPS = 1e-4
PART_BONE_SHARE = 0.08
MIRROR_TIE = 0.5
DEFAULT_HARDNESS = 6
# Quantizzazione con cui si confrontano due pesi in `deforms_alike`: l'errore per
# slot resta sotto 1.6e-5, cioe' una fessura sotto 0.03 mm. Invisibile.
WQ = 65536
POSE_CLIP_NAME = "pose"
POSE_CLIP_DT = 1.0 / 24.0

_NEIGHBORS = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))


# --- geometria ---------------------------------------------------------------

def voxel_bounds(voxels):
    """Ingombro + centro, nella forma che usano tutte le misure dello scheletro."""
    if not voxels:
        return {"minX": 0, "minY": 0, "minZ": 0, "maxX": 0, "maxY": 0, "maxZ": 0,
                "cx": 0.0, "cy": 0.0, "cz": 0.0, "w": 0, "h": 0, "d": 0}
    xs = [v["x"] for v in voxels]
    ys = [v["y"] for v in voxels]
    zs = [v["z"] for v in voxels]
    mnx, mxx = min(xs), max(xs)
    mny, mxy = min(ys), max(ys)
    mnz, mxz = min(zs), max(zs)
    return {"minX": mnx, "minY": mny, "minZ": mnz,
            "maxX": mxx, "maxY": mxy, "maxZ": mxz,
            "cx": (mnx + mxx) / 2.0, "cy": (mny + mxy) / 2.0,
            "cz": (mnz + mxz) / 2.0,
            "w": mxx - mnx, "h": mxy - mny, "d": mxz - mnz}


def dist_sq_to_segment(p, a, b):
    """Distanza al quadrato punto-segmento. E' il cuore del costo di legatura."""
    abx, aby, abz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    apx, apy, apz = p[0] - a[0], p[1] - a[1], p[2] - a[2]
    len2 = abx * abx + aby * aby + abz * abz or 1e-6
    t = (apx * abx + apy * aby + apz * abz) / len2
    t = max(0.0, min(1.0, t))
    dx, dy, dz = apx - abx * t, apy - aby * t, apz - abz * t
    return dx * dx + dy * dy + dz * dz


# --- quaternioni (puri: nessun THREE, nessuno stato) -------------------------

def quat_from_euler_xyz(rx, ry, rz):
    """Euler XYZ in RADIANTI -> (x, y, z, w), stesso ordine di THREE.Euler.

    L'ordine conta: gli assi non commutano, e le clip sono scritte per XYZ.
    """
    c1, c2, c3 = math.cos(rx / 2), math.cos(ry / 2), math.cos(rz / 2)
    s1, s2, s3 = math.sin(rx / 2), math.sin(ry / 2), math.sin(rz / 2)
    return (s1 * c2 * c3 + c1 * s2 * s3,
            c1 * s2 * c3 - s1 * c2 * s3,
            c1 * c2 * s3 + s1 * s2 * c3,
            c1 * c2 * c3 - s1 * s2 * s3)


def quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def quat_inverse(q):
    """Per un quaternione UNITARIO l'inverso e' il coniugato. I nostri lo sono
    tutti (nascono da Euler o da asse-angolo), quindi non si normalizza."""
    return (-q[0], -q[1], -q[2], q[3])


def quat_from_yaw(yaw_rad):
    return (0.0, math.sin(yaw_rad / 2), 0.0, math.cos(yaw_rad / 2))


def face_rotate(q, qface):
    """Porta una rotazione dal frame canonico a quello dello scheletro reale.

    Coniugazione, non composizione: `q` e' una rotazione LOCALE dell'osso, e
    comporre soltanto la ruoterebbe attorno all'asse sbagliato.
    """
    if not qface:
        return q
    return quat_mul(quat_mul(qface, q), quat_inverse(qface))


# --- scheletro ---------------------------------------------------------------

def default_binding_for(voxels):
    """Se il modello ha gia' delle PARTI l'utente le ha definite apposta: sono
    componenti, non ammassi di cubetti. Senza parti resta 'smooth'."""
    for v in voxels:
        if v.get("part"):
            return "parts"
    return "smooth"


def build_humanoid_skeleton(voxels):
    """24 ossa adattate all'ingombro, con le rifiniture MISURATE.

    Ogni frazione qui sotto e' stata tarata su modelli veri; i commenti dicono
    quale difetto ha prodotto la versione ingenua, perche' il numero da solo non
    lo racconta.
    """
    b = voxel_bounds(voxels)
    H = b["h"] or 1
    W = b["w"] or 1
    cx, cz, min_y, max_y = b["cx"], b["cz"], b["minY"], b["maxY"]

    # Centri delle gambe dal 20% inferiore: due gruppi in X.
    leg_band_top = min_y + 0.20 * H
    l_sum = l_n = r_sum = r_n = 0
    for v in voxels:
        if v["y"] <= leg_band_top:
            if v["x"] < cx:
                l_sum += v["x"]
                l_n += 1
            elif v["x"] > cx:
                r_sum += v["x"]
                r_n += 1
    leg_xl = (l_sum / l_n) if l_n else (cx - 0.20 * W)
    leg_xr = (r_sum / r_n) if r_n else (cx + 0.20 * W)

    # Fascia verticale delle braccia. `side_gap` e' quanto un voxel deve stare
    # fuori dal centro per contare come braccio e non come torso.
    # La fascia e il distacco laterale servono piu' sotto, per misurare il vero
    # estremo del braccio e la sua altezza media.
    arm_band_lo, arm_band_hi = min_y + 0.45 * H, min_y + 0.82 * H
    side_gap = 0.18 * W

    # Verso dei piedi: il confronto va fatto sul CENTRO DEL PIEDE, non sul cz di
    # tutto il corpo — capelli, zaini e visori spostano cz indietro.
    foot_band_top = min_y + 0.12 * H
    foot_zmin = foot_zmax = cz
    for v in voxels:
        if v["y"] <= foot_band_top:
            if v["z"] < foot_zmin:
                foot_zmin = v["z"]
            if v["z"] > foot_zmax:
                foot_zmax = v["z"]
    foot_zmid = (foot_zmin + foot_zmax) / 2.0
    dist_min = abs(foot_zmid - foot_zmin)
    dist_max = abs(foot_zmax - foot_zmid)
    faces_neg_z = dist_min > dist_max + 0.5
    if abs(dist_min - dist_max) <= 0.5:
        # Piede a scatola: il piede non dice niente, lo chiediamo alla TESTA. Il
        # viso e' piatto e la nuca sporge, quindi la massa sta dietro.
        # Misurato sul Tecnico_del_Video: testa z 25..38, mid 31.5, com 32.0.
        head_band_lo = min_y + 0.85 * H
        hz_min, hz_max, hz_sum, hz_n = None, None, 0, 0
        for v in voxels:
            if v["y"] < head_band_lo:
                continue
            z = v["z"]
            hz_min = z if hz_min is None or z < hz_min else hz_min
            hz_max = z if hz_max is None or z > hz_max else hz_max
            hz_sum += z
            hz_n += 1
        if hz_n:
            hz_mid = (hz_min + hz_max) / 2.0
            if hz_sum / hz_n > hz_mid + 0.15:
                faces_neg_z = True
    ankle_z = cz
    if faces_neg_z:
        toe_z = foot_zmin
    elif foot_zmax > cz:
        toe_z = foot_zmax
    else:
        toe_z = cz + 0.15 * (b["d"] or 1)
    toe_tip_z = (toe_z - 0.4) if faces_neg_z else (toe_z + 0.4)

    # Stazioni verticali: le articolazioni di braccia e gambe sono allineate su
    # una sola verticale, cosi' a riposo ogni arto e' DRITTO (niente gomiti
    # piegati che poi la posa non riesce a raddrizzare).
    hips_y = min_y + 0.44 * H
    spine_y = min_y + 0.53 * H
    chest_y = min_y + 0.64 * H
    shld_y = min_y + 0.74 * H
    neck_y = min_y + 0.75 * H
    head_y = min_y + 0.79 * H
    head_top_y = min_y + 0.97 * H
    knee_y = min_y + 0.26 * H
    ankle_y = min_y + 0.11 * H

    bones = []

    def add(name, parent, head, tail, helper=False):
        bd = {"name": name, "parent": parent, "head": list(head), "tail": list(tail)}
        if helper:
            bd["helper"] = True
        bones.append(bd)
        return len(bones) - 1

    hips = add("hips", -1, [cx, hips_y, cz], [cx, spine_y, cz])
    spine = add("spine", hips, [cx, spine_y, cz], [cx, chest_y, cz])
    chest = add("chest", spine, [cx, chest_y, cz], [cx, neck_y, cz])
    neck = add("neck", chest, [cx, neck_y, cz], [cx, head_y, cz])
    head = add("head", neck, [cx, head_y, cz], [cx, head_top_y, cz])
    add("headTip", head, [cx, head_top_y, cz], [cx, max_y, cz], True)

    torso_band_lo, torso_band_hi = min_y + 0.55 * H, min_y + 0.68 * H
    row_span = {}
    for v in voxels:
        if v["y"] < torso_band_lo or v["y"] > torso_band_hi:
            continue
        r = row_span.get(v["y"])
        if r is None:
            row_span[v["y"]] = [v["x"], v["x"]]
        else:
            if v["x"] < r[0]:
                r[0] = v["x"]
            if v["x"] > r[1]:
                r[1] = v["x"]
    spans = list(row_span.values())
    widths = sorted(r[1] - r[0] for r in spans)
    med_w = widths[len(widths) // 2] if widths else 0
    torso_max_r = torso_min_l = cx
    for r in spans:
        if med_w > 0 and (r[1] - r[0]) > med_w * 1.6:
            continue
        if r[1] > torso_max_r:
            torso_max_r = r[1]
        if r[0] < torso_min_l:
            torso_min_l = r[0]

    arm_outer_r, arm_outer_l = torso_max_r, torso_min_l
    arm_y_sum = arm_y_n = 0
    for v in voxels:
        if arm_band_lo <= v["y"] <= arm_band_hi:
            if v["x"] >= cx + side_gap:
                if v["x"] > arm_outer_r:
                    arm_outer_r = v["x"]
                arm_y_sum += v["y"]
                arm_y_n += 1
            elif v["x"] <= cx - side_gap:
                if v["x"] < arm_outer_l:
                    arm_outer_l = v["x"]
                arm_y_sum += v["y"]
                arm_y_n += 1
    arm_y = (arm_y_sum / arm_y_n) if arm_y_n else (shld_y - 0.08 * H)

    sh_rx, sh_lx = torso_max_r, torso_min_l
    reach_r = max(arm_outer_r - sh_rx, 0.18 * W)
    reach_l = max(sh_lx - arm_outer_l, 0.18 * W)
    f_u, f_f, f_h = 0.375, 0.375, 0.19
    r_e = sh_rx + reach_r * f_u
    r_w = r_e + reach_r * f_f
    r_h = r_w + reach_r * f_h
    l_e = sh_lx - reach_l * f_u
    l_w = l_e - reach_l * f_f
    l_h = l_w - reach_l * f_h

    sho_r = add("shoulder_R", chest, [cx, shld_y, cz], [sh_rx, arm_y, cz])
    ua_r = add("upperArm_R", sho_r, [sh_rx, arm_y, cz], [r_e, arm_y, cz])
    fa_r = add("forearm_R", ua_r, [r_e, arm_y, cz], [r_w, arm_y, cz])
    ha_r = add("hand_R", fa_r, [r_w, arm_y, cz], [r_h, arm_y, cz])
    add("handTip_R", ha_r, [r_h, arm_y, cz], [arm_outer_r, arm_y, cz], True)

    sho_l = add("shoulder_L", chest, [cx, shld_y, cz], [sh_lx, arm_y, cz])
    ua_l = add("upperArm_L", sho_l, [sh_lx, arm_y, cz], [l_e, arm_y, cz])
    fa_l = add("forearm_L", ua_l, [l_e, arm_y, cz], [l_w, arm_y, cz])
    ha_l = add("hand_L", fa_l, [l_w, arm_y, cz], [l_h, arm_y, cz])
    add("handTip_L", ha_l, [l_h, arm_y, cz], [arm_outer_l, arm_y, cz], True)

    ul_r = add("upperLeg_R", hips, [leg_xr, hips_y, cz], [leg_xr, knee_y, cz])
    ll_r = add("lowerLeg_R", ul_r, [leg_xr, knee_y, cz], [leg_xr, ankle_y, ankle_z])
    ft_r = add("foot_R", ll_r, [leg_xr, ankle_y, ankle_z], [leg_xr, min_y, toe_z])
    add("toeTip_R", ft_r, [leg_xr, min_y, toe_z], [leg_xr, min_y, toe_tip_z], True)

    ul_l = add("upperLeg_L", hips, [leg_xl, hips_y, cz], [leg_xl, knee_y, cz])
    ll_l = add("lowerLeg_L", ul_l, [leg_xl, knee_y, cz], [leg_xl, ankle_y, ankle_z])
    ft_l = add("foot_L", ll_l, [leg_xl, ankle_y, ankle_z], [leg_xl, min_y, toe_z])
    add("toeTip_L", ft_l, [leg_xl, min_y, toe_z], [leg_xl, min_y, toe_tip_z], True)

    default_pose = {
        "hips": [0, 0, 0],
        "spine": [0.08726646259971649, 0, 0],
        "chest": [0.17453292519943295, 0, 0],
        "head": [-0.08726646259971649, 0, 0],
        "upperLeg_R": [0, 0, -0.007504915783575617],
        "lowerLeg_R": [-0.1804670446562137, 0, 0],
        "foot_R": [0, 0.2617993877991494, 0],
        "upperLeg_L": [0, 0, -0.04974188368183839],
        "lowerLeg_L": [-0.1169370598836201, 0, 0],
        "foot_L": [0, -0.2617993877991494, 0],
        "upperArm_R": [-2.845632641629237, -1.118885906249436, -0.11442588799980974],
        "forearm_R": [0.2617993877991494, 0, 0],
        "upperArm_L": [-0.17453292519943292, -0.3490658503988659, 0.30141836181942067],
        "forearm_L": [-1.9198621771937625, 1.1627383476786222, -3.141592653589793],
        "neck": [0, 0, 0],
        "shoulder_R": [0, 0, 0],
        "hand_R": [0, 0, 0],
        "shoulder_L": [0, 0, 0],
        "hand_L": [0, 0, 0]
    }

    default_pose_pos = {
        "hips": [0, 0.05, 0],
        "upperArm_L": [0, 0, 0],
        "upperArm_R": [0, 0, 0],
        "spine": [0, 0, 0],
        "chest": [0, 0, 0],
        "head": [0, 0, 0],
        "upperLeg_R": [0, 0, 0],
        "lowerLeg_R": [0, 0, 0],
        "foot_R": [0, 0, 0],
        "upperLeg_L": [0, 0, 0],
        "lowerLeg_L": [0, 0, 0],
        "foot_L": [0, 0, 0],
        "forearm_R": [0, 0, 0],
        "forearm_L": [0, 0, 0],
        "neck": [0, 0, 0],
        "shoulder_R": [0, 0, 0],
        "hand_R": [0, 0, 0],
        "shoulder_L": [0, 0, 0],
        "hand_L": [0, 0, 0]
    }

    default_custom_anims = [
        {
            "name": "NaturalWalk",
            "duration": 1,
            "loop": True,
            "tracks": [
                {"bone": "hips", "keys": [{"t": 0, "pos": [0, -0.04, 0], "rot": [0, 5, 2]}, {"t": 0.25, "pos": [0, 0.08, 0], "rot": [0, 0, 0]}, {"t": 0.5, "pos": [0, -0.04, 0], "rot": [0, -5, -2]}, {"t": 0.75, "pos": [0, 0.08, 0], "rot": [0, 0, 0]}, {"t": 1, "pos": [0, -0.04, 0], "rot": [0, 5, 2]}]},
                {"bone": "spine", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [2, -4, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [2, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [2, 4, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [2, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [2, -4, 0]}]},
                {"bone": "chest", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [0, -3, -1]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [0, 3, 1]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [0, -3, -1]}]},
                {"bone": "head", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [-2, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [1, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [-2, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [1, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [-2, 0, 0]}]},
                {"bone": "upperLeg_R", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [30, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [-30, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [10, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [30, 0, 0]}]},
                {"bone": "lowerLeg_R", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [-5, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [-15, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [-10, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [-60, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [-5, 0, 0]}]},
                {"bone": "foot_R", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [-15, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [25, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [-5, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [-15, 0, 0]}]},
                {"bone": "upperLeg_L", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [-30, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [10, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [30, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [-30, 0, 0]}]},
                {"bone": "lowerLeg_L", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [-10, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [-60, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [-5, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [-15, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [-10, 0, 0]}]},
                {"bone": "foot_L", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [25, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [-5, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [-15, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [25, 0, 0]}]},
                {"bone": "upperArm_R", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [-30, 0, -78]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, -78]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [30, 0, -78]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, -78]}, {"t": 1, "pos": [0, 0, 0], "rot": [-30, 0, -78]}]},
                {"bone": "forearm_R", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [15, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [25, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [45, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [25, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [15, 0, 0]}]},
                {"bone": "upperArm_L", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [30, 0, 78]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, 78]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [-30, 0, 78]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, 78]}, {"t": 1, "pos": [0, 0, 0], "rot": [30, 0, 78]}]},
                {"bone": "forearm_L", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [45, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [25, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [15, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [25, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [45, 0, 0]}]},
                {"bone": "neck", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [0, 0, 0]}]},
                {"bone": "shoulder_R", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [0, 0, 0]}]},
                {"bone": "hand_R", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [0, 0, 0]}]},
                {"bone": "shoulder_L", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [0, 0, 0]}]},
                {"bone": "hand_L", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.25, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.5, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.75, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 1, "pos": [0, 0, 0], "rot": [0, 0, 0]}]}
            ]
        },
        {
            "name": "Dux Salute",
            "duration": 2,
            "loop": True,
            "tracks": [
                {"bone": "hips", "keys": [{"t": 0, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0], "pos": [0, 0.05, 0]}, {"t": 2, "rot": [0, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "spine", "keys": [{"t": 0, "rot": [5, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [5, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [5, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "chest", "keys": [{"t": 0, "rot": [10, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [10, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [10, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "head", "keys": [{"t": 0, "rot": [-5, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [-5, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [-5, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "upperArm_R", "keys": [{"t": 0, "rot": [-2.22, -51.81, -53.97], "pos": [0, 0, 0]}, {"t": 1, "rot": [-89.55, -66.74, 65.32], "pos": [0, 0, 0]}, {"t": 2, "rot": [-2.22, -51.81, -53.97], "pos": [0, 0, 0]}]},
                {"bone": "forearm_R", "keys": [{"t": 0, "rot": [15, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [15, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [15, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "upperArm_L", "keys": [{"t": 0, "rot": [-10, -20, 68.41], "pos": [0, 0, 0]}, {"t": 1, "rot": [-10, -20, 17.27], "pos": [0, 0, 0]}, {"t": 2, "rot": [-10, -20, 68.41], "pos": [0, 0, 0]}]},
                {"bone": "forearm_L", "keys": [{"t": 0, "rot": [70, 20, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [-110, 66.62, -180], "pos": [0, 0, 0]}, {"t": 2, "rot": [70, 20, 0], "pos": [0, 0, 0]}]},
                {"bone": "upperLeg_R", "keys": [{"t": 0, "rot": [0, 0, -0.43], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, 0, -0.43], "pos": [0, 0, 0]}, {"t": 2, "rot": [0, 0, -0.43], "pos": [0, 0, 0]}]},
                {"bone": "upperLeg_L", "keys": [{"t": 0, "rot": [0, 0, -2.85], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, 0, -2.85], "pos": [0, 0, 0]}, {"t": 2, "rot": [0, 0, -2.85], "pos": [0, 0, 0]}]},
                {"bone": "foot_R", "keys": [{"t": 0, "rot": [0, 15, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, 15, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [0, 15, 0], "pos": [0, 0, 0]}]},
                {"bone": "foot_L", "keys": [{"t": 0, "rot": [0, -15, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, -15, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [0, -15, 0], "pos": [0, 0, 0]}]},
                {"bone": "neck", "keys": [{"t": 0, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [0, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "shoulder_R", "keys": [{"t": 0, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [0, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "hand_R", "keys": [{"t": 0, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [0, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "shoulder_L", "keys": [{"t": 0, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [0, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "hand_L", "keys": [{"t": 0, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [0, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "lowerLeg_R", "keys": [{"t": 0, "rot": [-10.34, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [-10.34, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [-10.34, 0, 0], "pos": [0, 0, 0]}]},
                {"bone": "lowerLeg_L", "keys": [{"t": 0, "rot": [-6.7, 0, 0], "pos": [0, 0, 0]}, {"t": 1, "rot": [-6.7, 0, 0], "pos": [0, 0, 0]}, {"t": 2, "rot": [-6.7, 0, 0], "pos": [0, 0, 0]}]}
            ]
        }
    ]

    return {"bones": bones, "pose": default_pose, "posePos": default_pose_pos,
            "customAnims": default_custom_anims,
            "binding": default_binding_for(voxels), "type": "humanoid"}


def build_generic_skeleton(voxels, segments=5):
    """Catena di N ossa lungo l'asse PIU' LUNGO: il ripiego per cio' che non e'
    un umanoide (un ponte, un albero, un'astronave)."""
    b = voxel_bounds(voxels)
    axes = [{"k": "x", "len": b["w"], "min": b["minX"]},
            {"k": "y", "len": b["h"], "min": b["minY"]},
            {"k": "z", "len": b["d"], "min": b["minZ"]}]
    axes.sort(key=lambda a: -a["len"])
    main = axes[0]
    seg = max(1, int(segments))

    def at(t):
        p = {"x": b["cx"], "y": b["cy"], "z": b["cz"]}
        p[main["k"]] = main["min"] + t * main["len"]
        return [p["x"], p["y"], p["z"]]

    bones = [{"name": "bone_%d" % i, "parent": (-1 if i == 0 else i - 1),
              "head": at(i / float(seg)), "tail": at((i + 1) / float(seg))}
             for i in range(seg)]
    return {"bones": bones, "pose": {}, "posePos": {},
            "binding": default_binding_for(voxels), "type": "generic"}


# --- pesi ---------------------------------------------------------------------

def normalize_weight_entry(entry, max_bones=None):
    """`{osso: peso}` -> al piu' 4 voci, positive, che sommano a 1. None se vuota.

    Accetta anche una stringa (un solo osso a peso pieno): e' la forma che
    scrive chi assegna un voxel a mano.
    """
    limit = max_bones or MAX_BONE_INFLUENCES
    if entry is None:
        return None
    if isinstance(entry, str):
        return {entry: 1.0} if entry else None
    if not isinstance(entry, dict):
        return None
    pairs = []
    for name, w in entry.items():
        try:
            fw = float(w)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(fw) or fw <= WEIGHT_EPS:
            continue
        pairs.append((str(name), fw))
    if not pairs:
        return None
    pairs.sort(key=lambda p: -p[1])
    keep = pairs[:limit]
    total = sum(p[1] for p in keep)
    if total <= 0:
        return None
    return {name: w / total for name, w in keep}


def dominant_weight_bone(entry):
    norm = normalize_weight_entry(entry)
    if not norm:
        return None
    return max(norm.items(), key=lambda p: p[1])[0]


def bone_cost(v, bone, ctx):
    """Distanza voxel-osso, con due penalita' che valgono piu' della distanza.

    La lateralita' (x10) impedisce che il braccio destro si prenda i voxel del
    sinistro quando le mani sono vicine; la penalita' sotto i fianchi (x4)
    impedisce che busto e bacino si prendano le cosce.
    """
    d = dist_sq_to_segment((v["x"], v["y"], v["z"]), bone["head"], bone["tail"])
    lat = ctx.get("lat")
    if lat:
        side = ((v["x"] - lat["mx"]) * lat["ax"]
                + (v["y"] - lat["my"]) * lat["ay"]
                + (v["z"] - lat["mz"]) * lat["az"])
        name = bone["name"]
        if name.endswith("_R") and side < -lat["dead"]:
            d *= 10.0
        elif name.endswith("_L") and side > lat["dead"]:
            d *= 10.0
    if v["y"] < ctx["hipsY"] and bone["name"] in ("hips", "spine", "chest"):
        d *= 4.0
    return d


def bindable_bones(bones):
    """Indici delle ossa che possono ricevere voxel: le `helper` no.

    Il ripiego a "tutte" copre lo scheletro fatto di sole punte, che altrimenti
    non legherebbe niente e lascerebbe la mesh senza pesi.
    """
    cand = [i for i, b in enumerate(bones) if not b.get("helper")]
    return cand if cand else list(range(len(bones)))


def bind_context(voxels, bones):
    """L'asse sinistra-destra MISURATO sulle ossa, non assunto su X.

    Uno scheletro ruotato ha `_R` e `_L` separati su Z, e assumere X darebbe una
    penalita' laterale applicata nella direzione sbagliata — peggio che assente.
    Sotto una separazione dell'8% dell'ingombro l'asse non e' affidabile e la
    penalita' si spegne del tutto.
    """
    b = voxel_bounds(voxels)
    scale = max(b["w"], b["h"], b["d"]) or 1
    rx = ry = rz = lx = ly = lz = 0.0
    rn = ln = 0
    for bd in bones:
        mid = ((bd["head"][0] + bd["tail"][0]) / 2.0,
               (bd["head"][1] + bd["tail"][1]) / 2.0,
               (bd["head"][2] + bd["tail"][2]) / 2.0)
        if bd["name"].endswith("_R"):
            rx += mid[0]; ry += mid[1]; rz += mid[2]; rn += 1
        elif bd["name"].endswith("_L"):
            lx += mid[0]; ly += mid[1]; lz += mid[2]; ln += 1
    lat = None
    if rn and ln:
        rx /= rn; ry /= rn; rz /= rn
        lx /= ln; ly /= ln; lz /= ln
        ax, ay, az = rx - lx, ry - ly, rz - lz
        length = math.sqrt(ax * ax + ay * ay + az * az)
        if length > 0.08 * scale:
            lat = {"ax": ax / length, "ay": ay / length, "az": az / length,
                   "mx": (rx + lx) / 2.0, "my": (ry + ly) / 2.0,
                   "mz": (rz + lz) / 2.0, "dead": 0.15 * (length / 2.0)}
    return {"hipsY": b["minY"] + 0.44 * (b["h"] or 1), "lat": lat,
            "cand": bindable_bones(bones)}


def bind_skin(voxels, bones, overrides=None, binding="smooth", hardness=None):
    """Assegna a ogni voxel fino a 4 ossa con i loro pesi.

    Ritorna `{primary, indices, weights}`: `primary[i]` e' l'osso dominante (lo
    usa la UI per colorare), `indices`/`weights` sono piatti a 4 slot per voxel.
    """
    n = len(voxels)
    m = MAX_BONE_INFLUENCES
    indices = [0] * (n * m)
    weights = [0.0] * (n * m)
    primary = [0] * n
    if not n or not bones:
        return {"primary": primary, "indices": indices, "weights": weights}

    parts_mode = binding == "parts"
    rigid_mode = binding == "rigid" or parts_mode
    hard = max(1.0, min(16.0, float(hardness or DEFAULT_HARDNESS)))

    ctx = bind_context(voxels, bones)
    cand = ctx["cand"]

    # 1. osso piu' vicino per ogni voxel.
    best_dist = [0.0] * n
    for i, v in enumerate(voxels):
        best_j, best_d = cand[0], None
        for j in cand:
            d = bone_cost(v, bones[j], ctx)
            if best_d is None or d < best_d:
                best_d, best_j = d, j
        primary[i] = best_j
        best_dist[i] = best_d if best_d is not None else 0.0

    # 2. le parti dichiarate restringono le ossa ammesse, poi si leviga il
    #    confine (un solo voxel assegnato "di traverso" si vede a occhio).
    part_keys = restrict_to_parts(voxels, bones, primary, best_dist, ctx) if parts_mode else None
    smooth_assignments(voxels, bones, primary, best_dist, ctx, part_keys)

    if rigid_mode:
        # Rigido/parti: un osso, peso 1. Niente sfumatura per costruzione.
        for i in range(n):
            indices[i * m] = primary[i]
            weights[i * m] = 1.0
        apply_weight_overrides_skin(voxels, bones, indices, weights, primary,
                                    overrides, True)
        return {"primary": primary, "indices": indices, "weights": weights}

    # 3. caduta con la distanza: peso = (r_primario / r)^durezza, troncata.
    for i, v in enumerate(voxels):
        pj = primary[i]
        d_prim = best_dist[i]
        r_prim = math.sqrt(max(d_prim, 1e-9))
        slot = [0] * m
        sw = [0.0] * m
        used = 0
        for j in cand:
            if j == pj:
                w = 1.0
            else:
                r = math.sqrt(max(bone_cost(v, bones[j], ctx), 1e-9))
                if r > r_prim * 3:
                    continue
                w = (r_prim / r) ** hard
                if w > 1:
                    w = 1.0
                if w <= 0.02:
                    continue
            # inserimento ordinato nei 4 slot: chi non entra e' piu' leggero di
            # tutti, quindi si scarta senza rimpianti.
            p = used if used < m else m
            if p == m:
                if w <= sw[m - 1]:
                    continue
                p = m - 1
            else:
                used += 1
            while p > 0 and sw[p - 1] < w:
                sw[p] = sw[p - 1]
                slot[p] = slot[p - 1]
                p -= 1
            sw[p] = w
            slot[p] = j
        total = sum(sw[:used])
        if total <= 0:
            used, slot[0], sw[0], total = 1, pj, 1.0, 1.0
        base = i * m
        for s in range(m):
            indices[base + s] = slot[s] if s < used else 0
            weights[base + s] = (sw[s] / total) if s < used else 0.0

    # 4. una levigata sui pesi, poi le assegnazioni a mano (che vincono su tutto).
    smooth_skin_weights(voxels, indices, weights, primary)
    apply_weight_overrides_skin(voxels, bones, indices, weights, primary,
                                overrides, False)
    return {"primary": primary, "indices": indices, "weights": weights}


def restrict_to_parts(voxels, bones, primary, best_dist, ctx):
    """Ogni PARTE dichiarata segue una sola catena di ossa, non un ammasso.

    Senza questo una parte votava ossa sparse e si spaccava appena due di quelle
    ossa si animavano in controfase.
    """
    n = len(voxels)
    parts = [v.get("part") or "" for v in voxels]
    if not any(parts):
        return None

    children_of = {}
    for j, bd in enumerate(bones):
        if bd["parent"] < 0:
            continue
        children_of.setdefault(bd["parent"], []).append(j)

    tally = {}
    total = {}
    for i in range(n):
        p = parts[i]
        if not p:
            continue
        t = tally.setdefault(p, {})
        t[primary[i]] = t.get(primary[i], 0) + 1
        total[p] = total.get(p, 0) + 1

    by_name = {bd["name"]: k for k, bd in enumerate(bones)}

    def mirror_of(j):
        """Osso speculare (upperLeg_R <-> upperLeg_L). Riconosce le parti
        CENTRALI, che votano quasi alla pari due ossa simmetriche."""
        nm = bones[j]["name"] if 0 <= j < len(bones) else ""
        if len(nm) < 3 or nm[-2] != "_" or nm[-1] not in ("R", "L"):
            return -1
        twin = nm[:-1] + ("L" if nm[-1] == "R" else "R")
        return by_name.get(twin, -1)

    allowed = {}
    for p, t in tally.items():
        minimum = max(1, int(total[p] * PART_BONE_SHARE))
        votes = lambda j: t.get(j, 0)
        root, top_n = -1, -1
        for bi, c in t.items():
            if c > top_n:
                top_n, root = c, bi
        s = set()
        if root < 0:
            allowed[p] = s
            continue
        # Se il dominante ha un gemello speculare quasi alla pari la parte NON e'
        # di quel lato: sta in mezzo. Misurato su `bacino`, che vota
        # upperLeg_R=505 contro upperLeg_L=467 — un lancio di dado, e mezzo
        # bacino finiva saldato alla gamba destra. La radice risale allora
        # all'antenato comune (hips), che e' l'osso che la parte segue davvero.
        while True:
            twin = mirror_of(root)
            if twin < 0 or votes(twin) < top_n * MIRROR_TIE:
                break
            up = bones[root]["parent"]
            if up < 0:
                break
            root = up
            top_n = votes(root)
        s.add(root)
        # Verso l'alto: antenati CONTIGUI davvero conquistati. Ci si ferma al
        # primo che non interessa, per non saltarne uno in mezzo e ritrovarsi
        # due tronconi che ruotano separati.
        j = bones[root]["parent"]
        while j >= 0:
            if votes(j) < minimum:
                break
            s.add(j)
            j = bones[j]["parent"]
        # Verso il basso: UN SOLO ramo, il piu' votato — con la stessa eccezione
        # speculare (misurato: 545 voxel di `bacino` su upperLeg_R, 1284 di
        # `torso` su shoulder_R).
        j = root
        while True:
            kids = children_of.get(j)
            if not kids:
                break
            best, best_v = -1, minimum - 1
            for k in kids:
                if votes(k) > best_v:
                    best_v, best = votes(k), k
            if best < 0:
                break
            twin = mirror_of(best)
            if twin >= 0 and votes(twin) >= best_v * MIRROR_TIE:
                break
            s.add(best)
            j = best
        allowed[p] = s

    # Ritardatari: chi e' finito fuori dalla catena della sua parte torna
    # sull'osso ammesso piu' vicino.
    for i in range(n):
        p = parts[i]
        if not p:
            continue
        s = allowed.get(p)
        if not s or primary[i] in s:
            continue
        best, best_d = -1, None
        for bi in s:
            d = bone_cost(voxels[i], bones[bi], ctx)
            if best_d is None or d < best_d:
                best_d, best = d, bi
        if best >= 0:
            primary[i] = best
            best_dist[i] = best_d
    return parts


def smooth_assignments(voxels, bones, assign, best_dist, ctx, parts=None, iterations=2):
    """Voto di maggioranza fra i 6 vicini: toglie i voxel isolati sul confine.

    Tre guardie perche' non diventi un livellamento cieco: serve una MAGGIORANZA
    stretta (non un pareggio), il voxel deve avere almeno 3 vicini (su uno
    spigolo la maggioranza non significa niente), e il nuovo osso non puo'
    costare piu' del doppio di quello vecchio. E i vicini di un'ALTRA parte non
    votano: e' li' che il confine deve restare netto.
    """
    index = {}
    for i, v in enumerate(voxels):
        index[(v["x"], v["y"], v["z"])] = i
    passes = iterations or 2
    n = len(voxels)
    for _ in range(passes):
        nxt = list(assign)
        changed = False
        for i, v in enumerate(voxels):
            counts = {}
            neigh = 0
            for dx, dy, dz in _NEIGHBORS:
                k = index.get((v["x"] + dx, v["y"] + dy, v["z"] + dz))
                if k is None:
                    continue
                if parts is not None and parts[k] != parts[i]:
                    continue
                counts[assign[k]] = counts.get(assign[k], 0) + 1
                neigh += 1
            if neigh < 3:
                continue
            top_bone, top_n = assign[i], counts.get(assign[i], 0)
            for bi, c in counts.items():
                if c > top_n:
                    top_n, top_bone = c, bi
            if top_bone == assign[i]:
                continue
            if top_n * 2 <= neigh:
                continue
            if bone_cost(v, bones[top_bone], ctx) > best_dist[i] * 2.25 + 1e-6:
                continue
            nxt[i] = top_bone
            changed = True
        if not changed:
            break
        for i in range(n):
            assign[i] = nxt[i]


def smooth_skin_weights(voxels, indices, weights, primary, lam=0.3, iterations=2):
    """Media i pesi coi vicini: e' cio' che rende continua la deformazione.

    Il DOMINANTE non si perde mai: se la media lo espellesse dai 4 slot lo si
    reintroduce e gli si da' il peso massimo, o un voxel cambierebbe osso di
    riferimento per via di una levigata e il colore per-osso nella UI
    lampeggerebbe senza motivo.
    """
    m = MAX_BONE_INFLUENCES
    index = {}
    for i, v in enumerate(voxels):
        index[(v["x"], v["y"], v["z"])] = i
    passes = iterations or 2
    for _ in range(passes):
        src = list(weights)
        sidx = list(indices)
        for i, v in enumerate(voxels):
            acc = {}
            neigh = 0
            for dx, dy, dz in _NEIGHBORS:
                k = index.get((v["x"] + dx, v["y"] + dy, v["z"] + dz))
                if k is None:
                    continue
                neigh += 1
                for s in range(m):
                    w = src[k * m + s]
                    if w > WEIGHT_EPS:
                        b = sidx[k * m + s]
                        acc[b] = acc.get(b, 0.0) + w
            if not neigh:
                continue
            mix = {}
            for s in range(m):
                w = src[i * m + s]
                if w > WEIGHT_EPS:
                    b = sidx[i * m + s]
                    mix[b] = mix.get(b, 0.0) + w * (1.0 - lam)
            for b, w in acc.items():
                mix[b] = mix.get(b, 0.0) + w * (lam / neigh)
            pairs = [(b, w) for b, w in mix.items() if w > WEIGHT_EPS]
            if not pairs:
                continue
            pairs.sort(key=lambda p: -p[1])
            keep = pairs[:m]
            pj = primary[i]
            if not any(p[0] == pj for p in keep):
                keep[-1] = (pj, keep[0][1])          # il dominante non si perde
            top = max(p[1] for p in keep)
            keep = [((pj, top) if p[0] == pj else p) for p in keep]
            keep.sort(key=lambda p: -p[1])
            total = sum(p[1] for p in keep)
            if total <= 0:
                continue
            for s in range(m):
                indices[i * m + s] = keep[s][0] if s < len(keep) else 0
                weights[i * m + s] = (keep[s][1] / total) if s < len(keep) else 0.0


def apply_weight_overrides_skin(voxels, bones, indices, weights, primary,
                                overrides, rigid_mode):
    """Le assegnazioni a mano VINCONO: sono l'ultima parola dell'utente.

    Vanno applicate DOPO la levigata, o la levigata le annacquerebbe proprio dove
    l'utente e' intervenuto perche' l'automatismo sbagliava.
    """
    if not overrides:
        return 0
    m = MAX_BONE_INFLUENCES
    by_name = {bd["name"]: k for k, bd in enumerate(bones)}
    hits = 0
    for i, v in enumerate(voxels):
        raw = overrides.get("%d,%d,%d" % (v["x"], v["y"], v["z"]))
        entry = normalize_weight_entry(raw)
        if not entry:
            continue
        pairs = []
        for name, w in entry.items():
            j = by_name.get(name)
            if j is None:                 # osso sparito: l'assegnazione decade
                continue
            pairs.append((j, w))
        if not pairs:
            continue
        pairs.sort(key=lambda p: -p[1])
        hits += 1
        base = i * m
        if rigid_mode:
            primary[i] = pairs[0][0]
            indices[base] = pairs[0][0]
            weights[base] = 1.0
            for s in range(1, m):
                indices[base + s] = 0
                weights[base + s] = 0.0
            continue
        total = sum(p[1] for p in pairs) or 1.0
        for s in range(m):
            indices[base + s] = pairs[s][0] if s < len(pairs) else 0
            weights[base + s] = (pairs[s][1] / total) if s < len(pairs) else 0.0
        primary[i] = pairs[0][0]
    return hits


# --- imbardata e preset -------------------------------------------------------

def rig_facing_yaw(bones):
    """Da che parte guarda lo scheletro, a quarti di giro.

    Prima si guardano i PIEDI (`tail - head`: la punta indica avanti). Se sono
    degeneri si ripiega sull'asse spalle/fianchi ruotato di 90 gradi: l'asse
    sinistra-destra e' perpendicolare al davanti. Zero se nemmeno quello esiste.
    """
    fx = fz = 0.0
    for bd in bones:
        nm = bd["name"]
        if not (nm.startswith("foot_") or nm.startswith("toeTip_")):
            continue
        if nm[-2:] not in ("_R", "_L"):
            continue
        fx += bd["tail"][0] - bd["head"][0]
        fz += bd["tail"][2] - bd["head"][2]
    if math.hypot(fx, fz) < 1e-3:
        by_name = {bd["name"]: bd for bd in bones}
        rx = rz = 0.0
        for bd in bones:
            nm = bd["name"]
            if not nm.endswith("_R"):
                continue
            twin = by_name.get(nm[:-1] + "L")
            if not twin:
                continue
            rx += bd["head"][0] - twin["head"][0]
            rz += bd["head"][2] - twin["head"][2]
        if math.hypot(rx, rz) < 1e-3:
            return 0
        fx, fz = -rz, rx
    steps = int(round(math.atan2(fx, fz) / (math.pi / 2))) % 4
    return steps * 90


def preset_anims(face_yaw):
    """Le cinque clip predefinite, gia' riportate sull'imbardata reale.

    I valori sono quelli della camminata di riferimento validata a mano
    (`faceYaw == 180`, dove X>0 = avanti); `S` li rebasa. La Z delle braccia NON
    passa da `S`: e' lateralita', non oscillazione.
    """
    s = 1 if face_yaw == 180 else -1

    idle = {"name": "idle", "duration": 3, "loop": True, "tracks": [
        {"bone": "hips", "keys": [
            {"t": 0, "pos": [0, 0, 0], "rot": [0, 0, 0]},
            {"t": 0.75, "pos": [0, -0.03, 0], "rot": [0, 1, 0]},
            {"t": 1.5, "pos": [0, -0.05, 0], "rot": [0, 0, 0]},
            {"t": 2.25, "pos": [0, -0.03, 0], "rot": [0, -1, 0]},
            {"t": 3, "pos": [0, 0, 0], "rot": [0, 0, 0]}]},
        {"bone": "spine", "keys": [{"t": 0, "rot": [1 * s, 0, 0]}, {"t": 1.5, "rot": [-1.5 * s, 0, 0]}, {"t": 3, "rot": [1 * s, 0, 0]}]},
        {"bone": "chest", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1.5, "rot": [-2.5 * s, 0, 0]}, {"t": 3, "rot": [0, 0, 0]}]},
        {"bone": "neck", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1.5, "rot": [1 * s, 0, 0]}, {"t": 3, "rot": [0, 0, 0]}]},
        {"bone": "head", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [-1 * s, 3, 0]}, {"t": 2, "rot": [1 * s, -3, 0]}, {"t": 3, "rot": [0, 0, 0]}]},
        {"bone": "upperLeg_R", "keys": [{"t": 0, "rot": [2 * s, 0, 0]}, {"t": 3, "rot": [2 * s, 0, 0]}]},
        {"bone": "lowerLeg_R", "keys": [{"t": 0, "rot": [-4 * s, 0, 0]}, {"t": 1.5, "rot": [-3 * s, 0, 0]}, {"t": 3, "rot": [-4 * s, 0, 0]}]},
        {"bone": "foot_R", "keys": [{"t": 0, "rot": [2 * s, 0, 0]}, {"t": 3, "rot": [2 * s, 0, 0]}]},
        {"bone": "upperLeg_L", "keys": [{"t": 0, "rot": [2 * s, 0, 0]}, {"t": 3, "rot": [2 * s, 0, 0]}]},
        {"bone": "lowerLeg_L", "keys": [{"t": 0, "rot": [-3 * s, 0, 0]}, {"t": 1.5, "rot": [-4 * s, 0, 0]}, {"t": 3, "rot": [-3 * s, 0, 0]}]},
        {"bone": "foot_L", "keys": [{"t": 0, "rot": [2 * s, 0, 0]}, {"t": 3, "rot": [2 * s, 0, 0]}]},
        {"bone": "shoulder_R", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1.5, "rot": [0, 0, -1.5]}, {"t": 3, "rot": [0, 0, 0]}]},
        {"bone": "upperArm_R", "keys": [{"t": 0, "rot": [2 * s, 0, -78]}, {"t": 1.5, "rot": [-2 * s, 0, -76]}, {"t": 3, "rot": [2 * s, 0, -78]}]},
        {"bone": "forearm_R", "keys": [{"t": 0, "rot": [10 * s, 0, 0]}, {"t": 1.5, "rot": [14 * s, 0, 0]}, {"t": 3, "rot": [10 * s, 0, 0]}]},
        {"bone": "hand_R", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1.5, "rot": [4 * s, 0, 0]}, {"t": 3, "rot": [0, 0, 0]}]},
        {"bone": "shoulder_L", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1.5, "rot": [0, 0, 1.5]}, {"t": 3, "rot": [0, 0, 0]}]},
        {"bone": "upperArm_L", "keys": [{"t": 0, "rot": [2 * s, 0, 78]}, {"t": 1.5, "rot": [-2 * s, 0, 76]}, {"t": 3, "rot": [2 * s, 0, 78]}]},
        {"bone": "forearm_L", "keys": [{"t": 0, "rot": [12 * s, 0, 0]}, {"t": 1.5, "rot": [16 * s, 0, 0]}, {"t": 3, "rot": [12 * s, 0, 0]}]},
        {"bone": "hand_L", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1.5, "rot": [4 * s, 0, 0]}, {"t": 3, "rot": [0, 0, 0]}]},
    ]}

    # La camminata di riferimento ("NaturalWalk"), validata a mano. Le altre tre
    # sono derivate da qui: cambiando una convenzione si parte da questa.
    walk = {"name": "walk", "duration": 1, "loop": True, "tracks": [
        {"bone": "hips", "keys": [
            {"t": 0, "pos": [0, -0.04, 0], "rot": [0, 5, 2]},
            {"t": 0.25, "pos": [0, 0.08, 0], "rot": [0, 0, 0]},
            {"t": 0.5, "pos": [0, -0.04, 0], "rot": [0, -5, -2]},
            {"t": 0.75, "pos": [0, 0.08, 0], "rot": [0, 0, 0]},
            {"t": 1, "pos": [0, -0.04, 0], "rot": [0, 5, 2]}]},
        {"bone": "spine", "keys": [{"t": 0, "rot": [2 * s, -4, 0]}, {"t": 0.25, "rot": [2 * s, 0, 0]}, {"t": 0.5, "rot": [2 * s, 4, 0]}, {"t": 0.75, "rot": [2 * s, 0, 0]}, {"t": 1, "rot": [2 * s, -4, 0]}]},
        {"bone": "chest", "keys": [{"t": 0, "rot": [0, -3, -1]}, {"t": 0.25, "rot": [0, 0, 0]}, {"t": 0.5, "rot": [0, 3, 1]}, {"t": 0.75, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, -3, -1]}]},
        {"bone": "head", "keys": [{"t": 0, "rot": [-2 * s, 0, 0]}, {"t": 0.25, "rot": [1 * s, 0, 0]}, {"t": 0.5, "rot": [-2 * s, 0, 0]}, {"t": 0.75, "rot": [1 * s, 0, 0]}, {"t": 1, "rot": [-2 * s, 0, 0]}]},
        {"bone": "neck", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0]}]},
        {"bone": "upperLeg_R", "keys": [{"t": 0, "rot": [30 * s, 0, 0]}, {"t": 0.25, "rot": [0, 0, 0]}, {"t": 0.5, "rot": [-30 * s, 0, 0]}, {"t": 0.75, "rot": [10 * s, 0, 0]}, {"t": 1, "rot": [30 * s, 0, 0]}]},
        {"bone": "lowerLeg_R", "keys": [{"t": 0, "rot": [-5 * s, 0, 0]}, {"t": 0.25, "rot": [-15 * s, 0, 0]}, {"t": 0.5, "rot": [-10 * s, 0, 0]}, {"t": 0.75, "rot": [-60 * s, 0, 0]}, {"t": 1, "rot": [-5 * s, 0, 0]}]},
        {"bone": "foot_R", "keys": [{"t": 0, "rot": [-15 * s, 0, 0]}, {"t": 0.25, "rot": [0, 0, 0]}, {"t": 0.5, "rot": [25 * s, 0, 0]}, {"t": 0.75, "rot": [-5 * s, 0, 0]}, {"t": 1, "rot": [-15 * s, 0, 0]}]},
        {"bone": "upperLeg_L", "keys": [{"t": 0, "rot": [-30 * s, 0, 0]}, {"t": 0.25, "rot": [10 * s, 0, 0]}, {"t": 0.5, "rot": [30 * s, 0, 0]}, {"t": 0.75, "rot": [0, 0, 0]}, {"t": 1, "rot": [-30 * s, 0, 0]}]},
        {"bone": "lowerLeg_L", "keys": [{"t": 0, "rot": [-10 * s, 0, 0]}, {"t": 0.25, "rot": [-60 * s, 0, 0]}, {"t": 0.5, "rot": [-5 * s, 0, 0]}, {"t": 0.75, "rot": [-15 * s, 0, 0]}, {"t": 1, "rot": [-10 * s, 0, 0]}]},
        {"bone": "foot_L", "keys": [{"t": 0, "rot": [25 * s, 0, 0]}, {"t": 0.25, "rot": [-5 * s, 0, 0]}, {"t": 0.5, "rot": [-15 * s, 0, 0]}, {"t": 0.75, "rot": [0, 0, 0]}, {"t": 1, "rot": [25 * s, 0, 0]}]},
        {"bone": "shoulder_R", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0]}]},
        {"bone": "upperArm_R", "keys": [{"t": 0, "rot": [-30 * s, 0, -78]}, {"t": 0.25, "rot": [0, 0, -78]}, {"t": 0.5, "rot": [30 * s, 0, -78]}, {"t": 0.75, "rot": [0, 0, -78]}, {"t": 1, "rot": [-30 * s, 0, -78]}]},
        {"bone": "forearm_R", "keys": [{"t": 0, "rot": [15 * s, 0, 0]}, {"t": 0.25, "rot": [25 * s, 0, 0]}, {"t": 0.5, "rot": [45 * s, 0, 0]}, {"t": 0.75, "rot": [25 * s, 0, 0]}, {"t": 1, "rot": [15 * s, 0, 0]}]},
        {"bone": "hand_R", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0]}]},
        {"bone": "shoulder_L", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0]}]},
        {"bone": "upperArm_L", "keys": [{"t": 0, "rot": [30 * s, 0, 78]}, {"t": 0.25, "rot": [0, 0, 78]}, {"t": 0.5, "rot": [-30 * s, 0, 78]}, {"t": 0.75, "rot": [0, 0, 78]}, {"t": 1, "rot": [30 * s, 0, 78]}]},
        {"bone": "forearm_L", "keys": [{"t": 0, "rot": [45 * s, 0, 0]}, {"t": 0.25, "rot": [25 * s, 0, 0]}, {"t": 0.5, "rot": [15 * s, 0, 0]}, {"t": 0.75, "rot": [25 * s, 0, 0]}, {"t": 1, "rot": [45 * s, 0, 0]}]},
        {"bone": "hand_L", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1, "rot": [0, 0, 0]}]},
    ]}

    # La walk accelerata: stesse fasi e stessi segni, ampiezze quasi doppie,
    # busto in avanti, gomiti a ~75 gradi (e' quello che distingue una corsa da
    # una camminata veloce) e una fase di volo — il bacino SALE a meta' appoggio.
    run = {"name": "run", "duration": 0.6, "loop": True, "tracks": [
        {"bone": "hips", "keys": [
            {"t": 0, "pos": [0, -0.06, 0], "rot": [0, 7, 4]},
            {"t": 0.15, "pos": [0, 0.22, 0], "rot": [0, 0, 0]},
            {"t": 0.3, "pos": [0, -0.06, 0], "rot": [0, -7, -4]},
            {"t": 0.45, "pos": [0, 0.22, 0], "rot": [0, 0, 0]},
            {"t": 0.6, "pos": [0, -0.06, 0], "rot": [0, 7, 4]}]},
        {"bone": "spine", "keys": [{"t": 0, "rot": [8 * s, -5, 0]}, {"t": 0.15, "rot": [8 * s, 0, 0]}, {"t": 0.3, "rot": [8 * s, 5, 0]}, {"t": 0.45, "rot": [8 * s, 0, 0]}, {"t": 0.6, "rot": [8 * s, -5, 0]}]},
        {"bone": "chest", "keys": [{"t": 0, "rot": [7 * s, -6, -2]}, {"t": 0.15, "rot": [7 * s, 0, 0]}, {"t": 0.3, "rot": [7 * s, 6, 2]}, {"t": 0.45, "rot": [7 * s, 0, 0]}, {"t": 0.6, "rot": [7 * s, -6, -2]}]},
        {"bone": "neck", "keys": [{"t": 0, "rot": [-6 * s, 0, 0]}, {"t": 0.6, "rot": [-6 * s, 0, 0]}]},
        {"bone": "head", "keys": [{"t": 0, "rot": [-9 * s, 0, 0]}, {"t": 0.15, "rot": [-7 * s, 0, 0]}, {"t": 0.3, "rot": [-9 * s, 0, 0]}, {"t": 0.45, "rot": [-7 * s, 0, 0]}, {"t": 0.6, "rot": [-9 * s, 0, 0]}]},
        {"bone": "upperLeg_R", "keys": [{"t": 0, "rot": [52 * s, 0, 0]}, {"t": 0.15, "rot": [5 * s, 0, 0]}, {"t": 0.3, "rot": [-38 * s, 0, 0]}, {"t": 0.45, "rot": [15 * s, 0, 0]}, {"t": 0.6, "rot": [52 * s, 0, 0]}]},
        {"bone": "lowerLeg_R", "keys": [{"t": 0, "rot": [-22 * s, 0, 0]}, {"t": 0.15, "rot": [-28 * s, 0, 0]}, {"t": 0.3, "rot": [-20 * s, 0, 0]}, {"t": 0.45, "rot": [-105 * s, 0, 0]}, {"t": 0.6, "rot": [-22 * s, 0, 0]}]},
        {"bone": "foot_R", "keys": [{"t": 0, "rot": [-18 * s, 0, 0]}, {"t": 0.15, "rot": [5 * s, 0, 0]}, {"t": 0.3, "rot": [35 * s, 0, 0]}, {"t": 0.45, "rot": [-12 * s, 0, 0]}, {"t": 0.6, "rot": [-18 * s, 0, 0]}]},
        {"bone": "upperLeg_L", "keys": [{"t": 0, "rot": [-38 * s, 0, 0]}, {"t": 0.15, "rot": [15 * s, 0, 0]}, {"t": 0.3, "rot": [52 * s, 0, 0]}, {"t": 0.45, "rot": [5 * s, 0, 0]}, {"t": 0.6, "rot": [-38 * s, 0, 0]}]},
        {"bone": "lowerLeg_L", "keys": [{"t": 0, "rot": [-20 * s, 0, 0]}, {"t": 0.15, "rot": [-105 * s, 0, 0]}, {"t": 0.3, "rot": [-22 * s, 0, 0]}, {"t": 0.45, "rot": [-28 * s, 0, 0]}, {"t": 0.6, "rot": [-20 * s, 0, 0]}]},
        {"bone": "foot_L", "keys": [{"t": 0, "rot": [35 * s, 0, 0]}, {"t": 0.15, "rot": [-12 * s, 0, 0]}, {"t": 0.3, "rot": [-18 * s, 0, 0]}, {"t": 0.45, "rot": [5 * s, 0, 0]}, {"t": 0.6, "rot": [35 * s, 0, 0]}]},
        {"bone": "shoulder_R", "keys": [{"t": 0, "rot": [-4 * s, 0, 0]}, {"t": 0.3, "rot": [4 * s, 0, 0]}, {"t": 0.6, "rot": [-4 * s, 0, 0]}]},
        {"bone": "upperArm_R", "keys": [{"t": 0, "rot": [-48 * s, 0, -74]}, {"t": 0.15, "rot": [-5 * s, 0, -72]}, {"t": 0.3, "rot": [42 * s, 0, -74]}, {"t": 0.45, "rot": [-5 * s, 0, -72]}, {"t": 0.6, "rot": [-48 * s, 0, -74]}]},
        {"bone": "forearm_R", "keys": [{"t": 0, "rot": [62 * s, 0, 0]}, {"t": 0.15, "rot": [78 * s, 0, 0]}, {"t": 0.3, "rot": [88 * s, 0, 0]}, {"t": 0.45, "rot": [78 * s, 0, 0]}, {"t": 0.6, "rot": [62 * s, 0, 0]}]},
        {"bone": "hand_R", "keys": [{"t": 0, "rot": [10 * s, 0, 0]}, {"t": 0.6, "rot": [10 * s, 0, 0]}]},
        {"bone": "shoulder_L", "keys": [{"t": 0, "rot": [4 * s, 0, 0]}, {"t": 0.3, "rot": [-4 * s, 0, 0]}, {"t": 0.6, "rot": [4 * s, 0, 0]}]},
        {"bone": "upperArm_L", "keys": [{"t": 0, "rot": [42 * s, 0, 74]}, {"t": 0.15, "rot": [-5 * s, 0, 72]}, {"t": 0.3, "rot": [-48 * s, 0, 74]}, {"t": 0.45, "rot": [-5 * s, 0, 72]}, {"t": 0.6, "rot": [42 * s, 0, 74]}]},
        {"bone": "forearm_L", "keys": [{"t": 0, "rot": [88 * s, 0, 0]}, {"t": 0.15, "rot": [78 * s, 0, 0]}, {"t": 0.3, "rot": [62 * s, 0, 0]}, {"t": 0.45, "rot": [78 * s, 0, 0]}, {"t": 0.6, "rot": [88 * s, 0, 0]}]},
        {"bone": "hand_L", "keys": [{"t": 0, "rot": [10 * s, 0, 0]}, {"t": 0.6, "rot": [10 * s, 0, 0]}]},
    ]}

    # Salto in cinque pose: 0 in piedi, 0.22 caricamento (bacino giu', braccia
    # indietro), 0.38 stacco, 0.62 apice (gambe raccolte), 0.85 atterraggio,
    # 1.2 ritorno. `hips` e' la radice, quindi `pos` in voxel sposta TUTTO il
    # corpo: -1.6 in caricamento e +3.2 all'apice su ~40 voxel di altezza.
    jump = {"name": "jump", "duration": 1.2, "loop": False, "tracks": [
        {"bone": "hips", "keys": [
            {"t": 0, "pos": [0, 0, 0], "rot": [0, 0, 0]},
            {"t": 0.22, "pos": [0, -1.6, 0], "rot": [16 * s, 0, 0]},
            {"t": 0.38, "pos": [0, 0.6, 0], "rot": [-6 * s, 0, 0]},
            {"t": 0.62, "pos": [0, 3.2, 0], "rot": [10 * s, 0, 0]},
            {"t": 0.85, "pos": [0, -1.3, 0], "rot": [20 * s, 0, 0]},
            {"t": 1.2, "pos": [0, 0, 0], "rot": [0, 0, 0]}]},
        {"bone": "spine", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.22, "rot": [12 * s, 0, 0]}, {"t": 0.38, "rot": [-8 * s, 0, 0]}, {"t": 0.62, "rot": [6 * s, 0, 0]}, {"t": 0.85, "rot": [14 * s, 0, 0]}, {"t": 1.2, "rot": [0, 0, 0]}]},
        {"bone": "chest", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.22, "rot": [14 * s, 0, 0]}, {"t": 0.38, "rot": [-10 * s, 0, 0]}, {"t": 0.62, "rot": [4 * s, 0, 0]}, {"t": 0.85, "rot": [16 * s, 0, 0]}, {"t": 1.2, "rot": [0, 0, 0]}]},
        {"bone": "neck", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.22, "rot": [-6 * s, 0, 0]}, {"t": 0.62, "rot": [-3 * s, 0, 0]}, {"t": 0.85, "rot": [-8 * s, 0, 0]}, {"t": 1.2, "rot": [0, 0, 0]}]},
        {"bone": "head", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.22, "rot": [-9 * s, 0, 0]}, {"t": 0.38, "rot": [6 * s, 0, 0]}, {"t": 0.62, "rot": [-4 * s, 0, 0]}, {"t": 0.85, "rot": [-11 * s, 0, 0]}, {"t": 1.2, "rot": [0, 0, 0]}]},
        {"bone": "upperLeg_R", "keys": [{"t": 0, "rot": [3 * s, 0, 0]}, {"t": 0.22, "rot": [58 * s, 0, 0]}, {"t": 0.38, "rot": [-8 * s, 0, 0]}, {"t": 0.62, "rot": [42 * s, 0, 0]}, {"t": 0.85, "rot": [50 * s, 0, 0]}, {"t": 1.2, "rot": [3 * s, 0, 0]}]},
        {"bone": "lowerLeg_R", "keys": [{"t": 0, "rot": [-4 * s, 0, 0]}, {"t": 0.22, "rot": [-88 * s, 0, 0]}, {"t": 0.38, "rot": [-3 * s, 0, 0]}, {"t": 0.62, "rot": [-75 * s, 0, 0]}, {"t": 0.85, "rot": [-70 * s, 0, 0]}, {"t": 1.2, "rot": [-4 * s, 0, 0]}]},
        {"bone": "foot_R", "keys": [{"t": 0, "rot": [2 * s, 0, 0]}, {"t": 0.22, "rot": [-26 * s, 0, 0]}, {"t": 0.38, "rot": [42 * s, 0, 0]}, {"t": 0.62, "rot": [24 * s, 0, 0]}, {"t": 0.85, "rot": [-14 * s, 0, 0]}, {"t": 1.2, "rot": [2 * s, 0, 0]}]},
        {"bone": "upperLeg_L", "keys": [{"t": 0, "rot": [3 * s, 0, 0]}, {"t": 0.22, "rot": [58 * s, 0, 0]}, {"t": 0.38, "rot": [-8 * s, 0, 0]}, {"t": 0.62, "rot": [44 * s, 0, 0]}, {"t": 0.85, "rot": [50 * s, 0, 0]}, {"t": 1.2, "rot": [3 * s, 0, 0]}]},
        {"bone": "lowerLeg_L", "keys": [{"t": 0, "rot": [-4 * s, 0, 0]}, {"t": 0.22, "rot": [-88 * s, 0, 0]}, {"t": 0.38, "rot": [-3 * s, 0, 0]}, {"t": 0.62, "rot": [-80 * s, 0, 0]}, {"t": 0.85, "rot": [-70 * s, 0, 0]}, {"t": 1.2, "rot": [-4 * s, 0, 0]}]},
        {"bone": "foot_L", "keys": [{"t": 0, "rot": [2 * s, 0, 0]}, {"t": 0.22, "rot": [-26 * s, 0, 0]}, {"t": 0.38, "rot": [42 * s, 0, 0]}, {"t": 0.62, "rot": [24 * s, 0, 0]}, {"t": 0.85, "rot": [-14 * s, 0, 0]}, {"t": 1.2, "rot": [2 * s, 0, 0]}]},
        {"bone": "shoulder_R", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.38, "rot": [0, 0, -6]}, {"t": 0.62, "rot": [0, 0, -6]}, {"t": 1.2, "rot": [0, 0, 0]}]},
        {"bone": "upperArm_R", "keys": [{"t": 0, "rot": [0, 0, -78]}, {"t": 0.22, "rot": [45 * s, 0, -85]}, {"t": 0.38, "rot": [-40 * s, 0, 40]}, {"t": 0.62, "rot": [15 * s, 0, 110]}, {"t": 0.85, "rot": [12 * s, 0, -95]}, {"t": 1.2, "rot": [0, 0, -78]}]},
        {"bone": "forearm_R", "keys": [{"t": 0, "rot": [10 * s, 0, 0]}, {"t": 0.22, "rot": [48 * s, 0, 0]}, {"t": 0.38, "rot": [8 * s, 0, 0]}, {"t": 0.62, "rot": [22 * s, 0, 0]}, {"t": 0.85, "rot": [58 * s, 0, 0]}, {"t": 1.2, "rot": [10 * s, 0, 0]}]},
        {"bone": "hand_R", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.38, "rot": [-10 * s, 0, 0]}, {"t": 1.2, "rot": [0, 0, 0]}]},
        {"bone": "shoulder_L", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.38, "rot": [0, 0, 6]}, {"t": 0.62, "rot": [0, 0, 6]}, {"t": 1.2, "rot": [0, 0, 0]}]},
        {"bone": "upperArm_L", "keys": [{"t": 0, "rot": [0, 0, 78]}, {"t": 0.22, "rot": [45 * s, 0, 85]}, {"t": 0.38, "rot": [-40 * s, 0, -40]}, {"t": 0.62, "rot": [15 * s, 0, -110]}, {"t": 0.85, "rot": [12 * s, 0, 95]}, {"t": 1.2, "rot": [0, 0, 78]}]},
        {"bone": "forearm_L", "keys": [{"t": 0, "rot": [10 * s, 0, 0]}, {"t": 0.22, "rot": [48 * s, 0, 0]}, {"t": 0.38, "rot": [8 * s, 0, 0]}, {"t": 0.62, "rot": [22 * s, 0, 0]}, {"t": 0.85, "rot": [58 * s, 0, 0]}, {"t": 1.2, "rot": [10 * s, 0, 0]}]},
        {"bone": "hand_L", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.38, "rot": [-10 * s, 0, 0]}, {"t": 1.2, "rot": [0, 0, 0]}]},
    ]}

    # Saluto: il braccio destro sale, il SINISTRO resta lungo il corpo. Prima il
    # sinistro non era animato affatto e restava dov'era, cioe' in T-pose.
    wave = {"name": "wave", "duration": 1.6, "loop": True, "tracks": [
        {"bone": "hips", "keys": [{"t": 0, "pos": [0, 0, 0], "rot": [0, 0, 0]}, {"t": 0.8, "pos": [0, -0.03, 0], "rot": [0, -2, 0]}, {"t": 1.6, "pos": [0, 0, 0], "rot": [0, 0, 0]}]},
        {"bone": "spine", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.8, "rot": [0, -3, 1]}, {"t": 1.6, "rot": [0, 0, 0]}]},
        {"bone": "chest", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.4, "rot": [0, -4, 2]}, {"t": 1.6, "rot": [0, -4, 2]}]},
        {"bone": "head", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.4, "rot": [-3 * s, -6, 0]}, {"t": 1.6, "rot": [-3 * s, -6, 0]}]},
        {"bone": "upperLeg_R", "keys": [{"t": 0, "rot": [2 * s, 0, 0]}, {"t": 1.6, "rot": [2 * s, 0, 0]}]},
        {"bone": "lowerLeg_R", "keys": [{"t": 0, "rot": [-4 * s, 0, 0]}, {"t": 1.6, "rot": [-4 * s, 0, 0]}]},
        {"bone": "upperLeg_L", "keys": [{"t": 0, "rot": [2 * s, 0, 0]}, {"t": 1.6, "rot": [2 * s, 0, 0]}]},
        {"bone": "lowerLeg_L", "keys": [{"t": 0, "rot": [-4 * s, 0, 0]}, {"t": 1.6, "rot": [-4 * s, 0, 0]}]},
        {"bone": "shoulder_R", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.4, "rot": [0, 0, -12]}, {"t": 1.6, "rot": [0, 0, -12]}]},
        {"bone": "upperArm_R", "keys": [{"t": 0, "rot": [0, 0, -78]}, {"t": 0.4, "rot": [-10 * s, 0, 148]}, {"t": 1.6, "rot": [-10 * s, 0, 148]}]},
        {"bone": "forearm_R", "keys": [{"t": 0, "rot": [10 * s, 0, 0]}, {"t": 0.4, "rot": [0, 0, -14]}, {"t": 0.7, "rot": [0, 0, 20]}, {"t": 1, "rot": [0, 0, -14]}, {"t": 1.3, "rot": [0, 0, 20]}, {"t": 1.6, "rot": [0, 0, -14]}]},
        {"bone": "hand_R", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 0.4, "rot": [0, 0, -8]}, {"t": 0.7, "rot": [0, 0, 12]}, {"t": 1, "rot": [0, 0, -8]}, {"t": 1.3, "rot": [0, 0, 12]}, {"t": 1.6, "rot": [0, 0, -8]}]},
        {"bone": "shoulder_L", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1.6, "rot": [0, 0, 0]}]},
        {"bone": "upperArm_L", "keys": [{"t": 0, "rot": [0, 0, 78]}, {"t": 0.8, "rot": [3 * s, 0, 76]}, {"t": 1.6, "rot": [0, 0, 78]}]},
        {"bone": "forearm_L", "keys": [{"t": 0, "rot": [12 * s, 0, 0]}, {"t": 0.8, "rot": [18 * s, 0, 0]}, {"t": 1.6, "rot": [12 * s, 0, 0]}]},
        {"bone": "hand_L", "keys": [{"t": 0, "rot": [0, 0, 0]}, {"t": 1.6, "rot": [0, 0, 0]}]},
    ]}

    return [idle, walk, run, jump, wave]


PRESET_NAMES = ("idle", "walk", "run", "jump", "wave")


# --- clip ---------------------------------------------------------------------
#
# Una clip qui e' un dizionario:
#   {name, duration, loop, tracks: [{bone: indice, path: "rotation"|"translation",
#                                    times: [...], values: [...]}]}
# I valori sono GIA' nello spazio cotto (origine tolta, scala applicata), cioe'
# quello in cui esce il GLB. Nell'app le clip nascono nello spazio voxel e un
# secondo passaggio (`scaleClipsForExport`) le ribasa, perche' li' le stesse clip
# servono anche all'anteprima a schermo; qui l'unico consumatore e' l'export,
# quindi si costruiscono direttamente giuste e l'invariante 3 (le tracce
# `.position` sono ASSOLUTE, non delta: `(v - restVecchio) * K + restNuovo`) e'
# soddisfatta per costruzione invece che da una correzione a posteriori.

def rest_baked(bones, i, origin=None, scale=1.0):
    """Posizione di riposo dell'osso `i` nello spazio cotto, RELATIVA al padre.

    E' la traslazione del nodo glTF: le figlie sono relative al padre, le radici
    all'origine di cottura. Le ossa a riposo non hanno rotazione, quindi questa
    e' tutta la loro trasformazione.
    """
    k = float(scale) if float(scale) > 0 else 1.0
    o = origin or {"x": 0.0, "y": 0.0, "z": 0.0}
    head = bones[i]["head"]
    p = bones[i].get("parent", -1)
    ph = bones[p]["head"] if p >= 0 else (o["x"], o["y"], o["z"])
    return ((head[0] - ph[0]) * k, (head[1] - ph[1]) * k, (head[2] - ph[2]) * k)


def build_clip_from_anim_data(anim, bones, qface=None, origin=None, scale=1.0):
    """Dati di animazione (gradi, offset in voxel) -> clip nello spazio cotto.

    Le ROTAZIONI si coniugano con l'imbardata (`face_rotate`), le TRASLAZIONI si
    ruotano: sono vettori, non rotazioni. Vedi `preset_anims` per il perche' e
    `build_all_clips` per la regola su chi riceve `qface` e chi no.
    """
    if not isinstance(anim, dict) or not isinstance(anim.get("tracks"), list):
        return None
    by_name = {}
    for i, bd in enumerate(bones):
        by_name[bd["name"]] = i
    k = float(scale) if float(scale) > 0 else 1.0
    try:
        dur = max(0.1, float(anim.get("duration") or 1))
    except (TypeError, ValueError):
        dur = 1.0

    def clamp_t(t):
        try:
            v = float(t or 0)
        except (TypeError, ValueError):
            v = 0.0
        return min(dur, max(0.0, v))

    # L'imbardata come angolo: serve a ruotare gli offset di traslazione.
    yaw = 2 * math.atan2(qface[1], qface[3]) if qface else 0.0
    fcos, fsin = math.cos(yaw), math.sin(yaw)

    tracks = []
    for tr in anim["tracks"]:
        if not isinstance(tr, dict):
            continue
        bi = by_name.get(tr.get("bone"))
        if bi is None or not isinstance(tr.get("keys"), list) or not tr["keys"]:
            continue
        rot_keys, pos_keys = [], []
        for kf in tr["keys"]:
            if not isinstance(kf, dict):
                continue
            if isinstance(kf.get("rot"), (list, tuple)) and len(kf["rot"]) >= 3:
                rot_keys.append((clamp_t(kf.get("t")), kf["rot"]))
            if isinstance(kf.get("pos"), (list, tuple)) and len(kf["pos"]) >= 3:
                pos_keys.append((clamp_t(kf.get("t")), kf["pos"]))
        rot_keys.sort(key=lambda e: e[0])
        pos_keys.sort(key=lambda e: e[0])

        if rot_keys:
            times, values = [], []
            for t, rot in rot_keys:
                times.append(t)
                q = face_rotate(quat_from_euler_xyz(
                    math.radians(float(rot[0] or 0)),
                    math.radians(float(rot[1] or 0)),
                    math.radians(float(rot[2] or 0))), qface)
                values += [q[0], q[1], q[2], q[3]]
            tracks.append({"bone": bi, "path": "rotation",
                           "times": times, "values": values})
        if pos_keys:
            rx, ry, rz = rest_baked(bones, bi, origin, k)
            times, values = [], []
            for t, pos in pos_keys:
                times.append(t)
                dx = float(pos[0] or 0)
                dy = float(pos[1] or 0)
                dz = float(pos[2] or 0)
                values += [rx + (dx * fcos + dz * fsin) * k,
                           ry + dy * k,
                           rz + (-dx * fsin + dz * fcos) * k]
            tracks.append({"bone": bi, "path": "translation",
                           "times": times, "values": values})

    if not tracks:
        return None
    return {"name": str(anim.get("name") or "anim"), "duration": dur,
            "loop": bool(anim.get("loop", True)), "tracks": tracks}


def build_pose_clip(rig_data, bones, origin=None, scale=1.0, name=POSE_CLIP_NAME):
    """La posa dell'editor come CLIP, e deve essere la PRIMA del file.

    INVARIANTE 4. L'importatore glTF di Blender assegna d'ufficio la prima action
    del file, e le sue tracce coprono la posa sui nodi per ogni osso che animano:
    con `idle` per prima le braccia tornavano in T-pose (silhouette 0.911 m
    invece di 0.550 m) mentre le gambe, che `idle` non tocca, restavano posate.
    Due keyframe identici a 0 e 1/24 cosi' e' una clip valida (durata > 0) che
    resta ferma qualunque fotogramma si guardi.

    Ritorna None se la posa e' vuota: una clip di soli valori di riposo sarebbe
    corretta ma inutile, e comparirebbe nell'elenco delle animazioni.
    """
    pose = (rig_data or {}).get("pose") or {}
    pose_pos = (rig_data or {}).get("posePos") or {}
    if not any(pose.get(bd["name"]) for bd in bones) and \
       not any(pose_pos.get(bd["name"]) for bd in bones):
        return None
    k = float(scale) if float(scale) > 0 else 1.0
    times = [0.0, POSE_CLIP_DT]
    tracks = []
    for i, bd in enumerate(bones):
        p = pose.get(bd["name"]) or [0, 0, 0]
        # `rig.pose` e' in RADIANTI (il pannello scrive radianti, non gradi):
        # passarlo da `math.radians` lo ridurrebbe a un sessantesimo.
        q = quat_from_euler_xyz(float(p[0] or 0), float(p[1] or 0),
                                float(p[2] or 0))
        tracks.append({"bone": i, "path": "rotation", "times": times,
                       "values": [q[0], q[1], q[2], q[3],
                                  q[0], q[1], q[2], q[3]]})
        rx, ry, rz = rest_baked(bones, i, origin, k)
        d = pose_pos.get(bd["name"])
        if isinstance(d, (list, tuple)) and len(d) >= 3:
            # Le traslazioni di posa sono in unita' VOXEL: qui le ossa sono
            # cotte a scala K, quindi si riscalano. Le rotazioni no: una scala
            # uniforme non le cambia.
            rx += float(d[0] or 0) * k
            ry += float(d[1] or 0) * k
            rz += float(d[2] or 0) * k
        tracks.append({"bone": i, "path": "translation", "times": times,
                       "values": [rx, ry, rz, rx, ry, rz]})
    return {"name": str(name or POSE_CLIP_NAME), "duration": POSE_CLIP_DT,
            "loop": False, "tracks": tracks}


def build_all_clips(rig_data, bones, origin=None, scale=1.0, presets=True,
                    custom=True, only=None):
    """Le clip da mettere nel file, posa per prima.

    **I preset ricevono `qface`, le clip AI NO.** I preset sono scritti nel
    riferimento della camminata validata a mano e vanno riportati sull'imbardata
    reale; una clip scritta dall'AI ha davanti i nomi e le posizioni delle ossa
    VERE, quindi e' gia' nel riferimento giusto e coniugarla applicherebbe
    l'imbardata due volte.
    """
    face_yaw = rig_facing_yaw(bones)
    qface = quat_from_yaw(math.radians(face_yaw)) if face_yaw in (90, 270) else None
    wanted = None
    if only:
        wanted = set(str(n).strip().lower() for n in only if str(n).strip())

    out = []
    pose_clip = build_pose_clip(rig_data, bones, origin, scale)
    if pose_clip:
        out.append(pose_clip)
    if presets:
        for anim in preset_anims(face_yaw):
            if wanted is not None and anim["name"].lower() not in wanted:
                continue
            c = build_clip_from_anim_data(anim, bones, qface, origin, scale)
            if c:
                out.append(c)
    if custom:
        for anim in ((rig_data or {}).get("customAnims") or []):
            if not isinstance(anim, dict):
                continue
            nm = str(anim.get("name") or "").strip().lower()
            if wanted is not None and nm not in wanted:
                continue
            c = build_clip_from_anim_data(anim, bones, None, origin, scale)
            if c:
                out.append(c)
    return out


# --- guscio riggato -----------------------------------------------------------

_CUBE_FACES = (
    ((1, 0, 0), ((.5, -.5, -.5), (.5, .5, -.5), (.5, .5, .5), (.5, -.5, .5))),
    ((-1, 0, 0), ((-.5, -.5, .5), (-.5, .5, .5), (-.5, .5, -.5), (-.5, -.5, -.5))),
    ((0, 1, 0), ((-.5, .5, -.5), (-.5, .5, .5), (.5, .5, .5), (.5, .5, -.5))),
    ((0, -1, 0), ((-.5, -.5, .5), (-.5, -.5, -.5), (.5, -.5, -.5), (.5, -.5, .5))),
    ((0, 0, 1), ((.5, -.5, .5), (.5, .5, .5), (-.5, .5, .5), (-.5, -.5, .5))),
    ((0, 0, -1), ((-.5, -.5, -.5), (-.5, .5, -.5), (.5, .5, -.5), (.5, -.5, -.5))),
)
# I 4 angoli del quadrato UV nello stesso ordine dei 4 angoli di `_CUBE_FACES`:
# il winding e' coerente su tutte e sei, quindi lo stesso quadrato le copre tutte
# ("la stessa texture su ogni faccia").
_UV_QUAD = ((0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0))


def deforms_alike(a, b, skin):
    """Due voxel si deformano IDENTICI? Stessi 4 pesi sulle stesse ossa.

    INVARIANTE 5. Solo in quel caso la faccia che condividono resta interna in
    OGNI posa e si puo' togliere per sempre. Se si deformano diversamente quella
    faccia e' una GIUNZIONE: a riposo i due quad sono coincidenti e sepolti, ma
    appena la posa separa le ossa diventano esattamente le PARETI della fessura,
    e toglierli lascia il guscio APERTO. Con i materiali FrontSide (= backface
    culling in Blender) si guarda dentro il modello vuoto. Misurato sul modello
    dell'utente (24 ossa, binding 'parts'): 1268 giunzioni, che nella posa
    salvata si aprono in media 5.3 mm e fino a 55 mm; Blender contava 0 spigoli
    di bordo a riposo e 936 sulla mesh POSATA. Costo: +28% facce.

    Lo z-fighting per cui erano state tolte lo risolve FrontSide, non la cull: di
    due quad coplanari a orientamento OPPOSTO il backface culling ne disegna
    sempre e solo uno (verificato: zero coppie con lo stesso winding in tutti e
    tre i modi di binding).

    I pesi si confrontano QUANTIZZATI a 1/65536: l'errore per slot resta sotto
    1.6e-5, cioe' una fessura sotto 0.03 mm, invisibile.
    """
    if not skin:
        return True
    idx, w = skin["indices"], skin["weights"]
    ba, bb = a * MAX_BONE_INFLUENCES, b * MAX_BONE_INFLUENCES
    for s in range(MAX_BONE_INFLUENCES):
        wa, wb = w[ba + s], w[bb + s]
        za, zb = not (wa > WEIGHT_EPS), not (wb > WEIGHT_EPS)
        if za != zb:
            return False
        if za:
            continue
        if idx[ba + s] != idx[bb + s]:
            return False
        if round(wa * WQ) != round(wb * WQ):
            return False
    return True


def build_rigged_shell(voxels, skin, tokens, origin=None, scale=1.0,
                       all_faces=False):
    """Il guscio per-voxel, raggruppato per token.

    Deliberatamente NON passa da `meshing.greedy_mesh`: un quad che fonde voxel
    di ossa diverse non si puo' pesare (i suoi 4 vertici vorrebbero pesi
    diversi), e la cull di `deforms_alike` lavora faccia per faccia. Il guscio
    riggato e' quindi piu' grande di quello statico, ed e' il prezzo giusto.

    `all_faces` costruisce anche le facce fra voxel adiacenti: e' il "modello
    pieno" per chi importa il modello per tagliarlo o simularlo.
    """
    k = float(scale) if float(scale) > 0 else 1.0
    o = origin or {"x": 0.0, "y": 0.0, "z": 0.0}
    at = {}
    for i, v in enumerate(voxels):
        at[(v["x"], v["y"], v["z"])] = i

    groups = {}
    for i, v in enumerate(voxels):
        g = groups.get(tokens[i])
        if g is None:
            g = groups[tokens[i]] = {"pos": [], "nrm": [], "uv": [],
                                     "joints": [], "weights": [], "idx": [],
                                     "hex": v["color"]}
        base_w = i * MAX_BONE_INFLUENCES
        if skin:
            ji = skin["indices"][base_w:base_w + MAX_BONE_INFLUENCES]
            jw = skin["weights"][base_w:base_w + MAX_BONE_INFLUENCES]
        else:
            ji, jw = [0, 0, 0, 0], [1.0, 0.0, 0.0, 0.0]
        for normal, corners in _CUBE_FACES:
            nk = (v["x"] + normal[0], v["y"] + normal[1], v["z"] + normal[2])
            if not all_faces and nk in at and deforms_alike(i, at[nk], skin):
                continue
            vbase = len(g["pos"]) // 3
            for ci, off in enumerate(corners):
                g["pos"] += [(v["x"] + off[0] - o["x"]) * k,
                             (v["y"] + off[1] - o["y"]) * k,
                             (v["z"] + off[2] - o["z"]) * k]
                g["nrm"] += [float(normal[0]), float(normal[1]), float(normal[2])]
                # V capovolta: glTF ha l'origine UV in basso a sinistra, le
                # nostre texture in alto a sinistra (convenzione immagine).
                g["uv"] += [_UV_QUAD[ci][0], 1.0 - _UV_QUAD[ci][1]]
                g["joints"] += list(ji)
                g["weights"] += list(jw)
            g["idx"] += [vbase, vbase + 1, vbase + 2,
                         vbase, vbase + 2, vbase + 3]
    return groups


def token_of_voxel(v):
    """Il token di raggruppamento di un voxel di `voxel_list()`.

    Stessa convenzione di `token_of` in meshing.py e di `tokenOf` in
    36-materials.js — `#RRGGBB` per un colore, `@m1` per un materiale — ma quella
    prende una `Cell`, e qui i voxel sono dizionari. Un id ORFANO resta un token
    `@...`: e' `material_for` a degradarlo a tinta unita, che e' il solito
    degrado senza un ramo dedicato.
    """
    mat = v.get("material")
    return ("@" + mat) if mat else v["color"]


def build_rigged_gltf(doc, obj, scale=1.0, all_faces=False, skin=None,
                      bone_list=None, clips=None):
    """glTF 2.0 completo di ossa, skin e animazioni, come dizionario + blob.

    I sei invarianti di CLAUDE.md, tutti insieme:
    1. Il nodo della mesh NON porta ne' translation ne' scale: lo standard li
       ignora (la posa viene da giunti + inverse bind) e Blender li spaccherebbe
       sull'Armature. Origine e scala sono cotte nei vertici e nelle ossa.
    2. La mesh e' costruita A RIPOSO, la posa viaggia sui nodi delle ossa (come
       clip): `bind()` ha calcolato le inverse bind a riposo, applicare la posa
       anche ai vertici la applicherebbe due volte.
    3. Le tracce `.position` sono ASSOLUTE nello spazio cotto: lo sono per
       costruzione (vedi `build_clip_from_anim_data`), senza un passaggio di
       ribasamento dove il salto dell'osso radice a +0.62 m viveva nell'app.
    4. La clip della posa e' la PRIMA (vedi `build_all_clips`): Blender assegna
       la prima action all'import, e le sue tracce sovrascrivono la posa dei
       nodi su ogni osso che animano.
    5. La cull delle facce interne e' `deforms_alike`, mai per posizione.
    6. COLOR_0 NON si emette MAI: l'exporter di r128 lo scrive guardando la
       GEOMETRIA, e in glTF il colore finale e' baseColorFactor * COLOR_0: lo
       stesso colore su entrambi da' il colore lineare AL QUADRATO, e il modello
       importato arriva quasi nero (misurato in Blender: 31 materiali su 31
       guidati da un nodo vertex-color).
    """
    voxels = obj.voxel_list()
    if not voxels:
        return {"asset": {"version": "2.0", "generator": "VoxelAIArtist MCP"},
                "scene": 0, "scenes": [{"nodes": []}], "nodes": []}, b""
    b = obj.bounds()
    # Stessa origine di `exportOrigin` in 16-export-glb.js: centro XZ, suolo a
    # y = minY - 0.5.
    origin = {"x": (b[0] + b[3]) / 2.0, "y": b[1] - 0.5, "z": (b[2] + b[5]) / 2.0}
    k = float(scale) if float(scale) > 0 else 1.0

    tokens = [token_of_voxel(v) for v in voxels]
    groups = build_rigged_shell(voxels, skin, tokens, origin, k, all_faces)

    gb = _GltfBuilder()
    prims = []
    for token in sorted(groups):
        g = groups[token]
        count = len(g["pos"]) // 3
        if count == 0:
            # Un primitive senza indici e' VELENO in r128: `processAccessor`
            # torna null, l'exporter fa `delete primitive.indices`, e senza
            # indici un primitivo disegna TUTTI i vertici in sequenza (misurati
            # 12098 triangoli fantasma). Un gruppo senza facce si salta.
            continue
        a_pos = gb.push_accessor(
            g["pos"], "f", 34962, 5126, count, "VEC3",
            [min(g["pos"][0::3]), min(g["pos"][1::3]), min(g["pos"][2::3])],
            [max(g["pos"][0::3]), max(g["pos"][1::3]), max(g["pos"][2::3])])
        a_nrm = gb.push_accessor(g["nrm"], "f", 34962, 5126, count, "VEC3")
        a_uv = gb.push_accessor(g["uv"], "f", 34962, 5126, count, "VEC2")
        attrs = {"POSITION": a_pos, "NORMAL": a_nrm, "TEXCOORD_0": a_uv}
        if skin is not None:
            # JOINTS_0 indica NODI, non ossa: +1 perche' il nodo 0 e' la mesh.
            ji = [j + 1 for j in g["joints"]]
            a_j = gb.push_accessor(ji, "H", 34962, 5123, count, "VEC4")
            a_w = gb.push_accessor(g["weights"], "f", 34962, 5126, count,
                                   "VEC4")
            attrs["JOINTS_0"] = a_j
            attrs["WEIGHTS_0"] = a_w
        a_idx = gb.push_accessor(g["idx"], "I", 34963, 5125, len(g["idx"]),
                                 "SCALAR")
        prims.append({"attributes": attrs, "indices": a_idx,
                      "material": gb.material_for(doc, token)})

    nodes = [{"name": obj.name, "mesh": 0, "skin": 0, "children": [1]}]
    skins = []
    if skin is not None and bone_list:
        # Le ossa di riposo portano SOLO la traslazione relativa al padre: i
        # riposi sono puri spostamenti (nessuna rotazione), quindi la matrice
        # del mondo di ogni osso e' `translate((head_j - O) * K)` e l'inversa
        # e' semplicemente `translate(-(head_j - O) * K)` — nessuna inversione.
        ibm = []
        for bd in bone_list:
            inv = [-(bd["head"][0] - origin["x"]) * k,
                   -(bd["head"][1] - origin["y"]) * k,
                   -(bd["head"][2] - origin["z"]) * k]
            # Colonne: identita' + traslazione in colonna 3 (glTF e'
            # column-major).
            ibm += [1.0, 0.0, 0.0, 0.0,
                    0.0, 1.0, 0.0, 0.0,
                    0.0, 0.0, 1.0, 0.0,
                    inv[0], inv[1], inv[2], 1.0]
        a_ibm = gb.push_accessor(ibm, "f", None, 5126, len(bone_list), "MAT4")
        for i, bd in enumerate(bone_list):
            node = {"name": bd["name"],
                    "translation": list(rest_baked(bone_list, i, origin, k))}
            kids = [j + 1 for j, bd2 in enumerate(bone_list)
                    if bd2.get("parent", -1) == i]
            if kids:
                node["children"] = kids
            nodes.append(node)
        skins.append({"joints": list(range(1, len(bone_list) + 1)),
                      "inverseBindMatrices": a_ibm, "skeleton": 1})

    anims = []
    for clip in (clips or []):
        channels, samplers = [], []
        for tr in clip.get("tracks", []):
            # `bone` e' l'indice nell'elenco ossa; il nodo e' bone + 1.
            node = tr["bone"] + 1 if tr.get("bone") is not None else None
            if node is None:
                continue
            t_acc = gb.push_accessor(tr["times"], "f", None, 5126,
                                     len(tr["times"]), "SCALAR")
            # Il tipo dipende dal PERCORSO: una rotazione e' un quaternione
            # (VEC4), una traslazione un vettore (VEC3). Dichiarare VEC3 per
            # tutti scriveva un accessor di 2 elementi su 8 float di
            # quaternioni: l'importatore ne legge 6 e li interpreta come due
            # terne, cioe' rotazioni inventate. Passava ogni controllo
            # strutturale (l'accessor ESISTE ed e' allineato) e si vedeva solo
            # aprendo il file.
            path = tr.get("path", "rotation")
            comps = 4 if path == "rotation" else 3
            kind = "VEC4" if comps == 4 else "VEC3"
            v_acc = gb.push_accessor(tr["values"], "f", None, 5126,
                                     len(tr["values"]) // comps, kind)
            samplers.append({"input": t_acc, "output": v_acc,
                             "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1,
                             "target": {"node": node, "path": path}})
        if channels:
            anims.append({"name": clip.get("name", "anim"),
                          "channels": channels, "samplers": samplers})

    gltf = {
        "asset": {"version": "2.0", "generator": "VoxelAIArtist MCP"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": nodes,
        "meshes": [{"name": obj.name, "primitives": prims}],
        "bufferViews": gb.buffer_views,
        "accessors": gb.accessors,
        "materials": gb.materials or [{"pbrMetallicRoughness": {
            "baseColorFactor": [0.8, 0.8, 0.8, 1.0]}}],
    }
    if skins:
        gltf["skins"] = skins
    if anims:
        gltf["animations"] = anims
    blob = gb.blob()
    if blob:
        gltf["buffers"] = [{"byteLength": len(blob)}]
    else:
        for key in ("bufferViews", "accessors"):
            gltf.pop(key, None)
    if gb.images:
        gltf["images"] = gb.images
        gltf["textures"] = gb.textures
        gltf["samplers"] = gb.samplers
    return gltf, blob


def build_rigged_glb(doc, obj, scale=1.0, all_faces=False, skin=None,
                     bone_list=None, clips=None):
    """Il GLB del modello riggato: la stessa cornice del modello statico
    (`pack_glb`), il glTF costruito qui sopra."""
    gltf, blob = build_rigged_gltf(doc, obj, scale, all_faces, skin,
                                   bone_list, clips)
    return pack_glb(gltf, blob)


# --- clip scritte a mano e clip generate ---------------------------------------

def bone_names(bones):
    """Solo i nomi. E' la forma che vogliono `normalize_anim_data` e
    `build_anim_prompt` di main.py, che lavorano su un elenco di stringhe
    (`str(b)` su un dizionario darebbe il suo repr, e ogni osso risulterebbe
    inesistente)."""
    return [bd["name"] if isinstance(bd, dict) else str(bd)
            for bd in (bones or [])]


def normalize_anim(anim, bones):
    """Riconduce una clip al contratto, passando dal normalizzatore dell'app.

    NON e' una riscrittura: `normalize_anim_data` in main.py e' la stessa
    funzione che valida le risposte dell'AI per la UI, e conosce una quantita' di
    forme approssimate (sinonimi dei nomi di traccia, keyframe per fotogramma
    invece che per secondo, un solo keyframe da duplicare, nomi d'osso con il
    lato scritto in un altro modo). Riscriverla qui vorrebbe dire due
    normalizzatori che divergono, e la stessa clip accettata da una parte e
    rifiutata dall'altra.
    """
    m = compat.main_module()
    out = m.normalize_anim_data(anim, bone_names(bones))
    if not out.get("tracks"):
        detail = ""
        if out.get("unknownBones"):
            detail = (" Le ossa citate non esistono: %s. Elencale con "
                      "voxel_rig_info." % ", ".join(out["unknownBones"]))
        elif out.get("warnings"):
            detail = " " + " ".join(out["warnings"][:3])
        raise SessionError("la clip non ha nessuna traccia valida.%s" % detail)
    return out


def generate_clip(prompt, bones, name=None, model=None, provider=None):
    """Fa scrivere una clip all'AI e la riporta al contratto.

    All'AI si mandano i nomi delle ossa VERE, quindi la clip torna gia' nel
    frame dello scheletro e **non va coniugata con l'imbardata** — al contrario
    dei preset, che sono scritti in un frame canonico. Coniugarla applicherebbe
    la rotazione due volte.
    """
    from . import ai
    m = compat.main_module()
    names = bone_names(bones)
    text = m.build_anim_prompt(str(prompt or "").strip(), names)
    data = ai.ask_json(text, model=model, provider=provider)
    out = normalize_anim(data, bones)
    if name and str(name).strip():
        out["name"] = str(name).strip()[:60]
    return out


# --- API di alto livello (quella che usano gli attrezzi MCP) --------------------

def rig_of(obj):
    """Il rig dell'oggetto, coi valori di default dei campi mancanti.

    Il rig e' PER OGGETTO e non di scena: una scena "corpo + armatura" ha due
    scheletri, e uno solo li mischierebbe. I default sono gli stessi del
    caricamento nell'app (`type||'humanoid'`, `binding||'rigid'`, ...), cosi' un
    rig salvato da una versione precedente si apre senza migrazioni.
    """
    r = obj.rig if isinstance(obj.rig, dict) else {}
    return {
        "type": r.get("type") or "humanoid",
        "binding": r.get("binding") or "rigid",
        "bones": r.get("bones") or [],
        "pose": r.get("pose") or {},
        "posePos": r.get("posePos") or {},
        "weights": r.get("weights") or {},
        "customAnims": r.get("customAnims") or [],
        "hardness": r.get("hardness"),
    }


def has_rig(obj):
    return bool((obj.rig or {}).get("bones"))


def require_rig(obj):
    """Il rig dell'oggetto, o un errore che dice come crearlo."""
    if not has_rig(obj):
        raise SessionError(
            "L'oggetto '%s' non ha uno scheletro. Crealo con voxel_rig_auto."
            % obj.name)
    return rig_of(obj)


def auto_rig(obj, kind="auto", binding=None, segments=5, hardness=None):
    """Crea (o rifa') lo scheletro e lo lega ai voxel.

    Nell'app il tipo lo SCEGLIE l'utente da una tendina (default umanoide); qui
    chi chiama e' spesso un agente che non ha guardato il modello, quindi
    `kind='auto'` decide dall'ingombro: umanoide solo se il modello e' piu' alto
    che largo e che profondo, che e' la condizione minima perche' le stazioni
    misurate (anche fianchi .44, spalle .80, testa .88 dell'altezza) cadano su
    qualcosa. Un ponte o un'astronave prendono la catena generica.

    La legatura si ricalcola SEMPRE, e i pesi manuali si buttano: le ossa nuove
    rendono gli indici vecchi privi di significato (puntano a un altro
    scheletro), quindi tenerli sarebbe peggio che perderli.
    """
    voxels = obj.voxel_list()
    if not voxels:
        raise SessionError("L'oggetto '%s' e' vuoto: niente da riggare."
                           % obj.name)
    k = (kind or "auto").lower()
    if k in ("auto", "automatico"):
        b = voxel_bounds(voxels)
        k = "humanoid" if b["h"] > b["w"] and b["h"] > b["d"] else "generic"
    if k in ("humanoid", "umanoide"):
        built = build_humanoid_skeleton(voxels)
    elif k in ("generic", "generico"):
        built = build_generic_skeleton(voxels, segments)
    else:
        raise SessionError(
            "Tipo di scheletro sconosciuto: '%s'. Usa 'auto', 'humanoid' o "
            "'generic'." % kind)

    bind = (binding or built.get("binding") or "rigid").lower()
    if bind not in ("rigid", "smooth", "parts"):
        raise SessionError("Legatura sconosciuta: '%s'. Usa 'rigid', 'smooth' "
                           "o 'parts'." % binding)
    old = rig_of(obj)
    obj.rig = {
        "type": built.get("type") or k,
        "binding": bind,
        "bones": built["bones"],
        # La posa si CONSERVA per nome: rifare lo scheletro su un modello
        # ritoccato non deve buttare via la posa gia' impostata, e le ossa che
        # non esistono piu' si ignorano da sole (si cerca per nome).
        "pose": dict(old["pose"]),
        "posePos": dict(old["posePos"]),
        "weights": {},          # gli indici puntavano ad altre ossa: si buttano
        "customAnims": old["customAnims"],
        "hardness": hardness if hardness is not None else old["hardness"],
    }
    return obj.rig


def unbound_bones(obj, rig_data=None):
    """Le ossa che non DOMINANO nessun voxel.

    Il criterio e' `primary`, non "peso totale zero", e la differenza e' tutta
    qui: in legatura `smooth` un osso mal posizionato prende comunque un po' di
    peso su molti voxel (misurato 17.3 di peso complessivo su un `upperArm_R`
    finito dentro il torso) e per il peso totale risulterebbe legato. Posarlo
    non muove un braccio: sbava il torso, che e' peggio di non fare niente ed e'
    piu' difficile da diagnosticare.

    Le ossa-punta (`helper`) sono escluse: non ricevono voxel per costruzione
    (esistono solo perche' Blender orienti le foglie della catena), quindi
    segnalarle sarebbe rumore su ogni singolo scheletro.

    Serve a dare un nome a un guasto che altrimenti si presenta travestito: si
    posa un braccio, non si muove niente, e sembra rotta la posa. In realta' le
    stazioni delle braccia dell'umanoide si misurano dal bordo del torso, e in
    un modello con le braccia lungo i fianchi il bordo del torso E' il braccio.
    """
    r = rig_data or rig_of(obj)
    if not r["bones"]:
        return []
    dominanti = set(skin_for(obj, r)["primary"])
    return [bd["name"] for i, bd in enumerate(r["bones"])
            if i not in dominanti and not bd.get("helper")]


def skin_for(obj, rig_data=None):
    """La legatura dei voxel dell'oggetto, ricalcolata dai dati del rig."""
    r = rig_data or require_rig(obj)
    return bind_skin(obj.voxel_list(), r["bones"], r["weights"],
                     r["binding"], r["hardness"])


def bone_summary(obj, rig_data=None):
    """Elenco leggibile delle ossa, coi loro figli e la posa corrente."""
    r = rig_data or require_rig(obj)
    out = []
    for i, bd in enumerate(r["bones"]):
        entry = {
            "index": i,
            "name": bd["name"],
            "parent": (r["bones"][bd["parent"]]["name"]
                       if bd.get("parent", -1) >= 0 else None),
            "head": [round(c, 3) for c in bd["head"]],
            "tail": [round(c, 3) for c in bd["tail"]],
        }
        rot = r["pose"].get(bd["name"])
        if rot and any(abs(float(a or 0)) > 1e-6 for a in rot):
            # Fuori si parla in GRADI: dentro `rig.pose` sono radianti, ma un
            # utente che legge "1.36" non riconosce 78 gradi.
            entry["rotationDeg"] = [round(math.degrees(float(a or 0)), 1)
                                    for a in rot]
        pos = r["posePos"].get(bd["name"])
        if pos and any(abs(float(a or 0)) > 1e-6 for a in pos):
            entry["offsetVoxel"] = [round(float(a or 0), 3) for a in pos]
        out.append(entry)
    return out


def set_pose(obj, poses, additive=False):
    """Imposta rotazioni e spostamenti di posa, per nome d'osso.

    `poses` e' `{nome: {"rot": [gx,gy,gz], "pos": [dx,dy,dz]}}`, con le rotazioni
    in GRADI (l'interfaccia parla gradi, il rig conserva radianti) e gli
    spostamenti in unita' VOXEL relative al riposo. Un nome sconosciuto e' un
    errore e non un silenzio: e' quasi sempre un refuso, e ignorarlo darebbe una
    posa "applicata" che non cambia niente.
    """
    r = require_rig(obj)
    known = {bd["name"]: True for bd in r["bones"]}
    pose = dict(r["pose"]) if additive else {}
    pose_pos = dict(r["posePos"]) if additive else {}
    touched = []
    for name, spec in (poses or {}).items():
        if name not in known:
            raise SessionError(
                "Osso sconosciuto: '%s'. Le ossa disponibili sono: %s."
                % (name, ", ".join(sorted(known))))
        if not isinstance(spec, dict):
            raise SessionError("La posa di '%s' deve essere un oggetto con "
                               "'rot' e/o 'pos'." % name)
        rot = spec.get("rot") or spec.get("rotation")
        if rot is not None:
            pose[name] = [math.radians(float(a or 0)) for a in list(rot)[:3]]
        pos = spec.get("pos") or spec.get("offset")
        if pos is not None:
            pose_pos[name] = [float(a or 0) for a in list(pos)[:3]]
        touched.append(name)
    obj.rig["pose"] = pose
    obj.rig["posePos"] = pose_pos
    return touched


def clear_pose(obj):
    """Riporta lo scheletro a riposo."""
    require_rig(obj)
    obj.rig["pose"] = {}
    obj.rig["posePos"] = {}


def clip_names(obj, presets=True, custom=True, only=None, rig_data=None):
    """I nomi delle clip, filtrati con gli STESSI criteri di `build_all_clips`.

    La posa non compare: non e' una clip della libreria, e' lo stato corrente
    dello scheletro, che l'export antepone sempre (invariante 4).
    """
    r = rig_data or rig_of(obj)
    wanted = None
    if only:
        wanted = set(str(n).strip().lower() for n in only if str(n).strip())
    names = []
    if presets:
        names += list(PRESET_NAMES)
    if custom:
        names += [str(a.get("name") or "") for a in r["customAnims"]
                  if isinstance(a, dict)]
    return [n for n in names
            if n and (wanted is None or n.lower() in wanted)]


def has_pose(obj, rig_data=None):
    """Lo scheletro e' posato? Stesso criterio di `build_pose_clip`, che a riposo
    non emette nessuna clip: chi descrive l'export deve dire cio' che il file
    contiene, non cio' che ha chiesto."""
    r = rig_data or rig_of(obj)
    return bool(any((r.get("pose") or {}).values()) or
                any((r.get("posePos") or {}).values()))


def add_custom_clip(obj, anim, replace=True):
    """Aggiunge (o sostituisce, per nome) una clip alla libreria dell'oggetto."""
    require_rig(obj)
    name = str((anim or {}).get("name") or "").strip()
    if not name:
        raise SessionError("La clip non ha un nome.")
    anims = [a for a in (obj.rig.get("customAnims") or [])
             if isinstance(a, dict)]
    if replace:
        anims = [a for a in anims
                 if str(a.get("name") or "").lower() != name.lower()]
    anims.append(anim)
    obj.rig["customAnims"] = anims
    return name


def remove_custom_clip(obj, name):
    require_rig(obj)
    want = str(name or "").strip().lower()
    anims = [a for a in (obj.rig.get("customAnims") or [])
             if isinstance(a, dict)]
    kept = [a for a in anims if str(a.get("name") or "").lower() != want]
    obj.rig["customAnims"] = kept
    return len(anims) - len(kept)


def export_rigged_glb(doc, obj, scale=0.01, all_faces=False, presets=True,
                      custom=True, only=None):
    """Il GLB riggato dell'oggetto: legatura, posa e clip, gia' cotti.

    `scale=0.01` e' il default dell'app ("scala in metri"): un voxel = 1 cm, cioe'
    un personaggio di ~40 voxel alto 40 cm... e infatti l'app espone la scala
    perche' dipende da cosa rappresenta il modello. `scale=1` esporta in unita'
    voxel.
    """
    r = require_rig(obj)
    b = obj.bounds()
    if not b:
        raise SessionError("L'oggetto '%s' e' vuoto." % obj.name)
    origin = {"x": (b[0] + b[3]) / 2.0, "y": b[1] - 0.5,
              "z": (b[2] + b[5]) / 2.0}
    k = float(scale) if float(scale) > 0 else 1.0
    skin = skin_for(obj, r)
    clips = build_all_clips(r, r["bones"], origin, k, presets, custom, only)
    return build_rigged_glb(doc, obj, k, all_faces, skin, r["bones"], clips)

