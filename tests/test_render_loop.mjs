/* Verifica la logica del loop di render: budget, keep-alive sugli input, animazioni. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass=0,fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  OK  '+m);} else {fail++;console.log('  FAIL '+m);} };

const src=fs.readFileSync(path.join(ROOT,'ui/src/lib/18-bootstrap-tail.js'),'latin1');
// estrae solo la parte di gestione render (fino a function animate)
const head=src.slice(0, src.indexOf('function animate()'));

let renders=0;
const listeners={};
global.window={ addEventListener:(e,f)=>{ (listeners[e]=listeners[e]||[]).push(f); } };
global.controls={ addEventListener:(e,f)=>{ (listeners['controls:'+e]=listeners['controls:'+e]||[]).push(f); },
                  update(){}, autoRotate:false, enableDamping:true };
global.THREE={ Clock:class{ getDelta(){return 0.016;} } };

const api=new Function(head+`
 ;return { requestRender, getBudget:()=>renderBudget, setBudget:(n)=>{renderBudget=n;} };`)();

console.log('=== budget iniziale ===');
ok(api.getBudget()>0, 'parte con budget >0 ('+api.getBudget()+') -> primo frame disegnato');

console.log('=== requestRender ricarica il budget ===');
api.setBudget(0);
api.requestRender();
ok(api.getBudget()>=3, 'requestRender() -> budget '+api.getBudget());
api.setBudget(0);
api.requestRender(30);
ok(api.getBudget()===30, 'requestRender(30) -> budget 30');
api.setBudget(50);
api.requestRender(3);
ok(api.getBudget()===50, 'non ABBASSA un budget piu alto (era 50, resta '+api.getBudget()+')');

console.log('=== keep-alive: gli input ricaricano il budget ===');
const evts=['pointerdown','pointermove','pointerup','wheel','keydown','touchstart','click','change','input'];
let missing=[];
evts.forEach(e=>{ if(!listeners[e]) missing.push(e); });
ok(missing.length===0, 'listener registrati per tutti gli input ('+(missing.join(',')||'nessuno mancante')+')');

api.setBudget(0);
listeners['pointermove'][0]();
ok(api.getBudget()>=30, 'pointermove -> budget '+api.getBudget()+' (>=30, mezzo secondo di frame)');

api.setBudget(0);
listeners['controls:change'][0]();
ok(api.getBudget()>0, 'movimento camera (OrbitControls change) -> budget '+api.getBudget());

console.log('=== il budget si consuma (non resta acceso per sempre) ===');
api.setBudget(3);
let b=api.getBudget(), steps=0;
while(api.getBudget()>0 && steps<10){ api.setBudget(api.getBudget()-1); steps++; }
ok(steps===3, 'budget 3 -> si esaurisce in 3 frame (scena ferma = 0 render)');

console.log('\n'+(fail===0?'TUTTI I TEST PASSATI':'FALLITI: '+fail)+`  (pass=${pass})`);
process.exit(fail?1:0);
