import json
import os
from uuid import uuid4


def hex_to_rgb(hex_str):
    hex_str = hex_str.lstrip('#')
    return tuple(int(hex_str[i:i+2], 16) / 255.0 for i in (0, 2, 4))

def generate_cube_geometry(x, y, z, size=1.0):
    # Vertices of a cube at (x,y,z) of given size
    r = size / 2.0
    cx, cy, cz = x, y, z
    vertices = [
        (cx - r, cy - r, cz - r), # 1
        (cx + r, cy - r, cz - r), # 2
        (cx + r, cy + r, cz - r), # 3
        (cx - r, cy + r, cz - r), # 4
        (cx - r, cy - r, cz + r), # 5
        (cx + r, cy - r, cz + r), # 6
        (cx + r, cy + r, cz + r), # 7
        (cx - r, cy + r, cz + r), # 8
    ]
    
    # Faces defined by vertex indices (1-based for OBJ)
    # Each face is a list of 4 vertex indices
    # Front, Back, Top, Bottom, Left, Right
    faces = [
        (5, 6, 7, 8), # Front
        (2, 1, 4, 3), # Back
        (4, 3, 7, 8), # Top
        (1, 2, 6, 5), # Bottom
        (1, 5, 8, 4), # Left
        (6, 2, 3, 7), # Right
    ]
    return vertices, faces

def compute_visibility(voxels):
    voxel_set = {(v["x"], v["y"], v["z"]) for v in voxels}
    visible_voxels = []
    for v in voxels:
        x, y, z = v["x"], v["y"], v["z"]
        neighbors = [
            (x + 1, y, z),
            (x - 1, y, z),
            (x, y + 1, z),
            (x, y - 1, z),
            (x, y, z + 1),
            (x, y, z - 1)
        ]
        if any(n not in voxel_set for n in neighbors):
            visible_voxels.append(v)
    return visible_voxels

# Tetto massimo di celle espandibili da un singolo modello. Deve restare
# ALLINEATO ai valori in ui/src/utils/expand-ops.js (parita' Python <-> JS).
#
# Il tetto e' ADATTIVO: con le griglie grandi (192/256/384/512, usate per case ed
# edifici) un limite fisso a 4M troncava modelli legittimi. Ora la soglia segue la
# griglia dichiarata nel metadata, con un massimo assoluto che protegge comunque
# da un op malformato (`fill 0 0 0 999 999 999` = un miliardo di celle).
#
# Nota: una griglia piena e' un caso teorico. Un edificio 256^3 realistico sta
# ampiamente sotto il milione di voxel, perche' e' quasi tutto vuoto.
# Il tetto assoluto e' dettato dal BROWSER, non da Python. Misurato: una cella
# nella Map JS (chiave stringa "x,y,z" + valore colore) costa ~98 byte, quindi
# 24M celle = ~2,2 GB -> heap esaurito e tab morto (verificato: Node va in
# "heap out of memory"). 8M celle = ~0,8 GB, che sta comodamente dentro il
# budget di una webview. Meglio un modello troncato che un'app che muore.
MAX_VOXELS = 4_000_000          # default quando la griglia non e' dichiarata
MAX_VOXELS_ABSOLUTE = 8_000_000   # tetto invalicabile (~0,8 GB nel browser)


def voxel_budget_for(grid_size):
    """
    Tetto di celle adatto alla griglia dichiarata.

    Regola: meta' del volume della griglia (un modello piu' che pieno per meta'
    non e' un modello, e' un errore), con minimo il default e massimo il tetto
    assoluto. `grid_size` e' [W, H, D]; se manca o e' invalido si usa il default.
    """
    try:
        if isinstance(grid_size, (list, tuple)) and len(grid_size) == 3:
            w, h, d = (int(grid_size[0]), int(grid_size[1]), int(grid_size[2]))
            if w > 0 and h > 0 and d > 0:
                half = (w * h * d) // 2
                return max(MAX_VOXELS, min(half, MAX_VOXELS_ABSOLUTE))
    except (TypeError, ValueError):
        pass
    return MAX_VOXELS


def expand_ops(data):
    """Expand the compact palette+ops format into a flat {'voxels': [...]} model.

    If the data already has a flat 'voxels' list and no 'ops', it is returned as-is.
    Ops are applied in order; later ops overwrite earlier ones on the same cell.
    Supported ops: fill, box, line, rect, set, del.
    """
    if not isinstance(data, dict):
        return data
    ops = data.get("ops")
    parts = data.get("parts")
    if not ops and not parts:
        if "voxels" not in data:
            data["voxels"] = []
        return data

    palette = data.get("palette", {}) or {}

    def resolve_color(key):
        if isinstance(key, str) and key.startswith("#"):
            return key.upper()
        col = palette.get(key)
        if isinstance(col, str) and col:
            return col.upper()
        return "#CCCCCC"

    meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    budget_limit = voxel_budget_for(meta.get("grid_size"))

    def evaluate_ops_to_grid(op_list, start_count=0):
        grid = {}
        
        def rng(a, b):
            a, b = int(a), int(b)
            if a > b:
                a, b = b, a
            return range(a, b + 1)

        def budget_ok(extra=1):
            return (start_count + len(grid) + extra) <= budget_limit

        def do_fill(x0, y0, z0, x1, y1, z1, color):
            for x in rng(x0, x1):
                for y in rng(y0, y1):
                    for z in rng(z0, z1):
                        if not budget_ok(): return
                        grid[(x, y, z)] = color

        def do_box(x0, y0, z0, x1, y1, z1, color):
            xs, ys, zs = rng(x0, x1), rng(y0, y1), rng(z0, z1)
            xmin, xmax = min(int(x0), int(x1)), max(int(x0), int(x1))
            ymin, ymax = min(int(y0), int(y1)), max(int(y0), int(y1))
            zmin, zmax = min(int(z0), int(z1)), max(int(z0), int(z1))
            for x in xs:
                for y in ys:
                    for z in zs:
                        if (x in (xmin, xmax) or y in (ymin, ymax) or z in (zmin, zmax)):
                            if not budget_ok(): return
                            grid[(x, y, z)] = color

        def do_line(x0, y0, z0, x1, y1, z1, color):
            x0, y0, z0, x1, y1, z1 = map(int, (x0, y0, z0, x1, y1, z1))
            dx, dy, dz = abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)
            steps = max(dx, dy, dz)
            if steps == 0:
                grid[(x0, y0, z0)] = color
                return
            for i in range(steps + 1):
                t = i / steps
                x = round(x0 + (x1 - x0) * t)
                y = round(y0 + (y1 - y0) * t)
                z = round(z0 + (z1 - z0) * t)
                if not budget_ok(): return
                grid[(x, y, z)] = color

        def do_rect(axis, level, a0, b0, a1, b1, color):
            level, axis = int(level), str(axis).lower()
            for a in rng(a0, a1):
                for b in rng(b0, b1):
                    if not budget_ok(): return
                    if axis == "y": grid[(a, level, b)] = color
                    elif axis == "x": grid[(level, a, b)] = color
                    elif axis == "z": grid[(a, b, level)] = color

        def do_set(color, coords):
            for i in range(0, len(coords) - 2, 3):
                x, y, z = int(coords[i]), int(coords[i + 1]), int(coords[i + 2])
                if not budget_ok(): return
                grid[(x, y, z)] = color

        def do_del(x0, y0, z0, x1, y1, z1):
            for x in rng(x0, x1):
                for y in rng(y0, y1):
                    for z in rng(z0, z1):
                        grid.pop((x, y, z), None)

        for op in op_list:
            if not isinstance(op, (list, tuple)) or len(op) == 0: continue
            name = str(op[0]).lower()
            try:
                if name == "fill": do_fill(op[1], op[2], op[3], op[4], op[5], op[6], resolve_color(op[7]))
                elif name == "box": do_box(op[1], op[2], op[3], op[4], op[5], op[6], resolve_color(op[7]))
                elif name == "line": do_line(op[1], op[2], op[3], op[4], op[5], op[6], resolve_color(op[7]))
                elif name == "rect": do_rect(op[1], op[2], op[3], op[4], op[5], op[6], resolve_color(op[7]))
                elif name == "set": do_set(resolve_color(op[1]), op[2:])
                elif name == "del": do_del(op[1], op[2], op[3], op[4], op[5], op[6])
            except (IndexError, TypeError, ValueError):
                continue
        return grid

    all_voxels = []
    
    if "parts" in data and isinstance(data["parts"], dict):
        current_voxel_count = 0
        for part_name, part_ops in data["parts"].items():
            if not isinstance(part_ops, list):
                continue
            grid = evaluate_ops_to_grid(part_ops, current_voxel_count)
            for (x, y, z), c in grid.items():
                all_voxels.append({"x": x, "y": y, "z": z, "color": c, "part": part_name})
            current_voxel_count = len(all_voxels)
    elif "ops" in data and isinstance(data["ops"], list):
        grid = evaluate_ops_to_grid(data["ops"])
        for (x, y, z), c in grid.items():
            all_voxels.append({"x": x, "y": y, "z": z, "color": c})

    result = {
        "metadata": data.get("metadata", {}),
        "voxels": all_voxels,
    }
    if "palette" in data: result["palette"] = data["palette"]
    if "ops" in data: result["ops"] = data["ops"]
    if "parts" in data: result["parts"] = data["parts"]
    
    return result


def clean_json_string(s):
    import re
    s = re.sub(r'(?<!:)\/\/.*$', '', s, flags=re.MULTILINE)
    s = re.sub(r'\/\*.*?\*\/', '', s, flags=re.DOTALL)
    s = re.sub(r',\s*([}\]])', r'\1', s)
    return s

def repair_unescaped_quotes(s):
    chars = list(s)
    n = len(s)
    quote_indices = [i for i, c in enumerate(chars) if c == '"']
    boundary_quotes = set()
    for idx in quote_indices:
        left_char = None
        for j in range(idx - 1, -1, -1):
            if not s[j].isspace():
                left_char = s[j]
                break
        right_char = None
        for j in range(idx + 1, n):
            if not s[j].isspace():
                right_char = s[j]
                break
        is_boundary = False
        if left_char in ('{', ',', '[', ':', None):
            is_boundary = True
        if right_char in ('}', ']', ',', ':', None):
            is_boundary = True
        if is_boundary:
            boundary_quotes.add(idx)
    result = []
    for i, c in enumerate(chars):
        if c == '"':
            if i in boundary_quotes:
                result.append('"')
            else:
                result.append('\\"')
        else:
            result.append(c)
    return "".join(result)

def repair_json_string(s):
    import re
    import json
    s = clean_json_string(s)
    match = re.search(r'"grid_size"\s*:\s*(?:\}\s*,)?\s*(.*?)\s*(?:\}\s*,)?\s*(?=\s*"[a-zA-Z0-9_-]+"\s*:|\s*\}\s*\Z|\Z)', s, re.DOTALL)
    if match:
        captured = match.group(1)
        nums = [int(n) for n in re.findall(r'\d+', captured)]
        if len(nums) >= 3:
            grid_size = nums[:3]
        elif len(nums) == 2:
            grid_size = [nums[0], nums[1], nums[0]]
        elif len(nums) == 1:
            grid_size = [nums[0], nums[0], nums[0]]
        else:
            grid_size = [32, 32, 32]
        start = match.start()
        end = match.end()
        replacement = f'"grid_size": {json.dumps(grid_size)} }},'
        s = s[:start] + replacement + s[end:]
    s = clean_json_string(s)
    return s

def parse_with_recovery(s):
    import json
    cleaned = repair_json_string(s)
    try:
        return json.loads(cleaned)
    except Exception:
        pass
    try:
        repaired_quotes = repair_unescaped_quotes(cleaned)
        return json.loads(repaired_quotes)
    except Exception:
        pass
    chars = []
    stack = []
    in_string = False
    escaped = False
    i = 0
    n = len(cleaned)
    while i < n:
        c = cleaned[i]
        if in_string:
            if escaped:
                chars.append(c)
                escaped = False
            elif c == '\\':
                chars.append(c)
                escaped = True
            elif c == '"':
                chars.append(c)
                in_string = False
            else:
                chars.append(c)
        else:
            if c == '"':
                chars.append(c)
                in_string = True
            elif c in ('{', '['):
                chars.append(c)
                stack.append(c)
            elif c in ('}', ']'):
                match_char = '{' if c == '}' else '['
                found = False
                temp_stack = []
                while stack:
                    top = stack.pop()
                    if top == match_char:
                        found = True
                        break
                    else:
                        temp_stack.append(top)
                if found:
                    chars.append(c)
                else:
                    stack.extend(reversed(temp_stack))
            else:
                chars.append(c)
        i += 1
    if in_string:
        if escaped:
            chars.pop()
        chars.append('"')
    import re
    repaired = "".join(chars).rstrip()
    while repaired:
        last_word_match = re.search(r'(,\s*|:\s*|[a-zA-Z0-9_\-\.\#]+|"[^"]*")$', repaired)
        if not last_word_match:
            break
        last_token = last_word_match.group(1)
        if repaired.endswith(',') or repaired.endswith(':'):
            repaired = repaired[:-1].rstrip()
        elif re.match(r'^[a-zA-Z0-9_\-\.\#]+$', last_token):
            if last_token not in ('true', 'false', 'null') and not re.match(r'^-?\d+(\.\d+)?$', last_token):
                repaired = repaired[:-len(last_token)].rstrip()
            else:
                break
        else:
            break
    while stack:
        top = stack.pop()
        if top == '{':
            repaired += '}'
        elif top == '[':
            repaired += ']'
    repaired = clean_json_string(repaired)
    return json.loads(repaired)

def _scan_balanced_end(b, start_idx):
    """Indice di chiusura del valore JSON che inizia a `start_idx`, o -1.

    Scansione consapevole delle stringhe (e degli escape) identica a quella
    storica di extract_json_candidate: serve sia per gli oggetti `{...}` che per
    gli array `[...]`.
    """
    opener = b[start_idx]
    closer = '}' if opener == '{' else ']'
    stack = []
    in_string = False
    escaped = False
    for idx in range(start_idx, len(b)):
        c = b[idx]
        if in_string:
            if escaped:
                escaped = False
            elif c == '\\':
                escaped = True
            elif c == '"':
                in_string = False
            continue
        if c == '"':
            in_string = True
        elif c in ('{', '['):
            stack.append(c)
        elif c in ('}', ']'):
            if stack:
                stack.pop()
            if not stack:
                # Chiudiamo solo sul delimitatore coerente con l'apertura,
                # altrimenti un `]` spaiato troncherebbe un oggetto.
                if c == closer:
                    return idx
                return -1
    return -1


def extract_json_candidate(text):
    """Ritaglia dal testo del modello tutti i possibili payload JSON.

    Vengono emessi PIU' candidati, nell'ordine in cui vanno provati:
      1. il primo `{` di ogni blocco (comportamento storico);
      2. gli eventuali `{`/`[` successivi NON annidati in un candidato gia'
         emesso.
    Il punto 2 copre due casi reali: prosa che contiene graffe prima del JSON
    vero (es. "Uso la struttura {name, duration, tracks}. Ecco:\\n{...}"), che
    prima faceva fallire tutto sull'unico candidato sbagliato, e una risposta
    con array JSON al top level (nessun `{` iniziale valido).
    """
    import re
    blocks = []
    matches = list(re.finditer(r'```(?:json)?\s*(.*?)\s*```', text, re.DOTALL))
    for m in matches:
        blocks.append(m.group(1))
    if not blocks:
        open_block_match = re.search(r'```(?:json)?\s*(.*)', text, re.DOTALL)
        if open_block_match:
            blocks.append(open_block_match.group(1))
    if not blocks:
        blocks = [text]
    candidates = []
    for b in blocks:
        spans = []          # (start, end_or_len) dei candidati accettati
        first_brace = b.find('{')
        if first_brace != -1:
            end = _scan_balanced_end(b, first_brace)
            if end != -1:
                candidates.append(b[first_brace:end + 1])
                spans.append((first_brace, end))
            else:
                candidates.append(b[first_brace:])
                spans.append((first_brace, len(b) - 1))
        for idx, c in enumerate(b):
            if c not in ('{', '['):
                continue
            if idx == first_brace:
                continue
            if any(s <= idx <= e for s, e in spans):
                continue    # annidato in un candidato gia' emesso
            end = _scan_balanced_end(b, idx)
            if end != -1:
                candidates.append(b[idx:end + 1])
                spans.append((idx, end))
            else:
                candidates.append(b[idx:])
                spans.append((idx, len(b) - 1))
    return candidates

def extract_and_parse_json(text):
    candidates = extract_json_candidate(text)
    if not candidates:
        start_idx = text.find('{')
        if start_idx != -1:
            candidates = [text[start_idx:]]
    last_error = None
    parsed_objects = []
    parsed_arrays = []
    for cand in candidates:
        try:
            parsed = parse_with_recovery(cand)
        except Exception as e:
            last_error = e
            continue
        if isinstance(parsed, dict):
            if "voxels" in parsed or "ops" in parsed or "parts" in parsed:
                return expand_ops(parsed)
            parsed_objects.append(parsed)
        elif isinstance(parsed, list) and parsed:
            # Risposta con array al top level (tipico delle animazioni: una
            # lista di track). expand_ops lascia passare i non-dict, quindi la
            # restituiamo solo se non c'e' nessun oggetto utilizzabile.
            parsed_arrays.append(parsed)
    if parsed_objects:
        return expand_ops(parsed_objects[0])
    if parsed_arrays:
        return parsed_arrays[0]
    if last_error:
        raise last_error
    raise ValueError("No valid JSON found in response.")

def export_voxels_to_obj(voxel_data, obj_filename, mtl_filename):
    voxels = voxel_data.get("voxels", [])
    visible_voxels = compute_visibility(voxels)
    
    # Extract unique colors to generate materials
    unique_colors = list(set([v["color"].upper() for v in visible_voxels]))
    color_to_mat_name = {color: f"Material_{color.replace('#', '')}" for color in unique_colors}
    
    # Write MTL file
    with open(mtl_filename, 'w') as mtl_file:
        mtl_file.write("# Voxel Materials File\n")
        for color in unique_colors:
            r, g, b = hex_to_rgb(color)
            mat_name = color_to_mat_name[color]
            mtl_file.write(f"newmtl {mat_name}\n")
            mtl_file.write(f"Kd {r:.3f} {g:.3f} {b:.3f}\n") # Diffuse color
            mtl_file.write("Ka 0.100 0.100 0.100\n")      # Ambient
            mtl_file.write("Ks 0.500 0.500 0.500\n")      # Specular
            mtl_file.write("Ns 96.078\n")                 # Specular exponent
            mtl_file.write("d 1.0\n")                     # Dissolve (Opacity)
            mtl_file.write("illum 2\n\n")
            
    # Write OBJ file
    with open(obj_filename, 'w') as obj_file:
        obj_file.write(f"# Voxel 3D Model\n")
        obj_file.write(f"mtllib {os.path.basename(mtl_filename)}\n\n")
        
        vertex_offset = 1
        for i, voxel in enumerate(visible_voxels):
            x, y, z = voxel["x"], voxel["y"], voxel["z"]
            color = voxel["color"].upper()
            mat_name = color_to_mat_name[color]
            
            vertices, faces = generate_cube_geometry(x, y, z)
            
            obj_file.write(f"g Voxel_{i}\n")
            # Write vertices
            for v in vertices:
                obj_file.write(f"v {v[0]:.3f} {v[1]:.3f} {v[2]:.3f}\n")
            
            # Specify material
            obj_file.write(f"usemtl {mat_name}\n")
            
            # Write faces (adjusting index offset)
            for face in faces:
                adjusted_face = [idx + vertex_offset - 1 for idx in face]
                obj_file.write(f"f {' '.join(map(str, adjusted_face))}\n")
            
            vertex_offset += 8
            obj_file.write("\n")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        json_path = sys.argv[1]
        with open(json_path, 'r') as f:
            data = json.load(f)
        name = data.get("metadata", {}).get("name", "voxel_model").replace(" ", "_")
        export_voxels_to_obj(data, f"{name}.obj", f"{name}.mtl")
        print(f"Modello esportato correttamente: {name}.obj e {name}.mtl")
    else:
        print("Uso: python parser.py <file.json>")