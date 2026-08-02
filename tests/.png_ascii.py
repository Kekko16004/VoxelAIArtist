# Disegna in ASCII una finestra del canale alpha di un PNG RGBA: '#' pieno,
# '.' vuoto. Serve a capire A OCCHIO che cos'e' una zona vuota trovata dallo
# script dei buchi. Uso: python .png_ascii.py <png> [x0 y0 x1 y1]
import sys
sys.path.insert(0, __file__.rsplit('\\', 1)[0] if '\\' in __file__ else '.')
exec(open(__file__.replace('.png_ascii.py', '.png_holes_where.py')).read().split("W, H, alpha = read_png")[0])

W, H, alpha = read_png(sys.argv[1])
if len(sys.argv) > 5:
    x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6])
else:
    x0, y0, x1, y1 = 0, 0, W - 1, H - 1
sx = max(1, (x1 - x0 + 1) // 110)
sy = max(1, (y1 - y0 + 1) // 55)
print(f'{sys.argv[1]}  finestra x[{x0},{x1}] y[{y0},{y1}]  1 char = {sx}x{sy} px')
for y in range(y0, y1 + 1, sy):
    row = ''
    for x in range(x0, x1 + 1, sx):
        on = any(alpha[(y + j) * W + (x + i)] > 127
                 for j in range(min(sy, y1 - y + 1)) for i in range(min(sx, x1 - x + 1)))
        row += '#' if on else '.'
    print(f'{y:4} {row}')
