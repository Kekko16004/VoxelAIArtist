import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = json.load(open(os.path.join(ROOT,'ui/locales/it.json'), encoding='utf-8'))
out=[]
for k in sorted(d):
    v=d[k].replace('\n',' | ')
    out.append('%-34s %s' % (k, v[:88]))
out.append('--- %d chiavi ---' % len(d))
open(os.path.join(ROOT,'tests','.i18n_dump_out.txt'),'w',encoding='utf-8').write('\n'.join(out))
print(len(d))
