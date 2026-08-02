import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = [('32-rig-tools.js',[(444,456),(460,472),(478,490),(510,516),(526,532),(546,552),(672,680),(738,746),(800,808)])]
out=[]
for fn, rngs in SPEC:
    src = open(os.path.join(ROOT,'ui','src','lib',fn), encoding='utf-8').read().split('\n')
    out.append('===== '+fn)
    for a,b in rngs:
        out.append('--')
        for l in range(a,b+1):
            out.append('L%-5d %s' % (l, src[l-1].strip()[:200]))
open(os.path.join(ROOT,'tests','.i18n_lines_out.txt'),'w',encoding='utf-8').write('\n'.join(out))
print('ok')
