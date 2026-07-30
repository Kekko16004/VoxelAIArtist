/*
 * Verifica il voxelizzatore su mesh di forma NOTA: se un cubo non produce un
 * cubo, il bug si vede subito. Include il caso patologico che ha rotto la
 * versione a raggi (scena con nodi lontanissimi e Line/Points).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  OK  '+m);} else {fail++;console.log('  FAIL '+m);} };

// --- stub Three.js minimo ma fedele ---
class V3 {
  constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
  fromBufferAttribute(a,i){this.x=a.getX(i);this.y=a.getY(i);this.z=a.getZ(i);return this;}
  applyMatrix4(m){ // m = {e:[...]} colonna-major come three
    const e=m.e, x=this.x,y=this.y,z=this.z;
    const w=1/((e[3]*x+e[7]*y+e[11]*z+e[15])||1);
    this.x=(e[0]*x+e[4]*y+e[8]*z+e[12])*w;
    this.y=(e[1]*x+e[5]*y+e[9]*z+e[13])*w;
    this.z=(e[2]*x+e[6]*y+e[10]*z+e[14])*w;
    return this;
  }
}
const IDENT={e:[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]};
const TRANS=(tx,ty,tz)=>({e:[1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1]});
global.THREE={ Vector3:V3 };

// canvas finto (nessuna texture nei test)
global.document={ createElement:()=>({getContext:()=>null, width:0, height:0}) };
const els={};
['importOverlay','importProgressBar','importProgressText'].forEach(id=>{
  els[id]={style:{},textContent:''};
});
global.document.getElementById=(id)=>els[id]||null;

function attr(arr,item=3){
  return { count: arr.length/item,
    getX:i=>arr[i*item], getY:i=>arr[i*item+1], getZ:i=>arr[i*item+2] };
}
// Mesh cubo [0..s]^3 (12 triangoli)
function cubeMesh(s, matrix=IDENT, color={r:1,g:0,b:0}){
  const v=[[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const faces=[[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],
               [3,2,6],[3,6,7],[0,3,7],[0,7,4],[1,5,6],[1,6,2]];
  const pos=[]; faces.forEach(f=>f.forEach(i=>pos.push(...v[i])));
  return { isMesh:true, matrixWorld:matrix, material:{color},
           geometry:{ attributes:{position:attr(pos)}, index:null } };
}
function scene(children){
  return { children, updateMatrixWorld(){}, traverse(cb){ cb(this); children.forEach(c=>cb(c)); } };
}

// carica il modulo reale
const src=fs.readFileSync(path.join(ROOT,'ui/src/lib/30-import-glb.js'),'latin1');
global.window={};
// Stub di i18n: i messaggi di errore/progresso passano da t(), qui non si
// verificano le traduzioni ma la geometria, quindi basta la chiave in chiaro.
global.t=(key,vars)=>(vars?key+'('+JSON.stringify(vars)+')':key);
const api=new Function(src+';return {voxelizeScene, reducePalette, paletteKeyFor};')();

function expand(model){ // espande le ops "set" come fa l'app
  const out=[];
  for(const op of model.ops){
    const hex=model.palette[op[1]];
    for(let i=2;i+2<op.length;i+=3) out.push({x:op[i],y:op[i+1],z:op[i+2],color:hex});
  }
  return out;
}
function bounds(vox){
  const xs=vox.map(v=>v.x), ys=vox.map(v=>v.y), zs=vox.map(v=>v.z);
  return [Math.min(...xs),Math.min(...ys),Math.min(...zs),Math.max(...xs),Math.max(...ys),Math.max(...zs)];
}

console.log('=== 1. cubo semplice -> griglia cubica piena ===');
let m=await api.voxelizeScene(scene([cubeMesh(10)]),{maxGridSize:16,fillInterior:true});
let [W,H,D]=m.metadata.grid_size;
let vox=expand(m);
ok(W===16&&H===16&&D===16, `griglia 16^3 (ottenuto ${W}x${H}x${D})`);
let b=bounds(vox);
ok(b[0]===0&&b[1]===0&&b[2]===0, `parte da 0,0,0 (${b.slice(0,3)})`);
ok(b[3]===W-1&&b[4]===H-1&&b[5]===D-1, `arriva a ${W-1},${H-1},${D-1} (${b.slice(3)})`);
const inside=vox.filter(v=>v.x>=0&&v.x<W&&v.y>=0&&v.y<H&&v.z>=0&&v.z<D).length;
ok(inside===vox.length, `TUTTI i ${vox.length} voxel dentro la griglia (era 0% col raycasting)`);
ok(vox.length>=W*H*D*0.9, `cubo pieno: ${vox.length} voxel su ${W*H*D} attesi (${Math.round(100*vox.length/(W*H*D))}%)`);

console.log('=== 2. cubo NON riempito: solo il guscio ===');
m=await api.voxelizeScene(scene([cubeMesh(10)]),{maxGridSize:16,fillInterior:false});
vox=expand(m);
const shell=16*16*16-14*14*14;
ok(vox.length<16*16*16*0.6, `guscio: ${vox.length} voxel (pieno sarebbe 4096, guscio ~${shell})`);
ok(vox.length>=shell*0.8, `guscio completo, nessun buco (${vox.length} >= ${Math.round(shell*0.8)})`);

console.log('=== 3. IL CASO PATOLOGICO: nodo sperduto a 5000 unita ===');
// E' cio' che rompeva la versione a raggi. Caso realistico: un modello vero
// (molti triangoli) con POCHI nodi sperduti, non due meta' uguali.
// Costruisco un modello con 5 cubi vicini + 1 cubo lontanissimo.
const near=[cubeMesh(10), cubeMesh(10,TRANS(11,0,0)), cubeMesh(10,TRANS(0,11,0)),
            cubeMesh(10,TRANS(11,11,0)), cubeMesh(10,TRANS(5,5,11))];
const lost=cubeMesh(2, TRANS(5000,3000,0), {r:0,g:1,b:0});
m=await api.voxelizeScene(scene([...near, lost]),{maxGridSize:32,fillInterior:false});
[W,H,D]=m.metadata.grid_size;
vox=expand(m);
b=bounds(vox);
ok(b[0]>=0&&b[1]>=0&&b[2]>=0, `nessuna coordinata negativa (min ${b.slice(0,3)})`);
ok(b[3]<W&&b[4]<H&&b[5]<D, `nessuna coordinata oltre la griglia ${W}x${H}x${D} (max ${b.slice(3)})`);
ok(vox.every(v=>v.x>=0&&v.x<W&&v.y>=0&&v.y<H&&v.z>=0&&v.z<D),
   `TUTTI i ${vox.length} voxel dentro la griglia`);
// Il nodo sperduto va SCARTATO: altrimenti la griglia inquadra il vuoto e il
// modello si riduce a pochi voxel.
ok(vox.length>500, `il modello reale sopravvive: ${vox.length} voxel (col nodo sperduto incluso sarebbero <10)`);
ok(W<=32 && H<=32 && D<=32, `griglia sul modello, non sul vuoto: ${W}x${H}x${D}`);

console.log('=== 3b. due meta legittime NON vengono scartate ===');
// Un modello in due pezzi distanti e' legittimo: il criterio non deve tagliarlo.
m=await api.voxelizeScene(scene([cubeMesh(10), cubeMesh(10,TRANS(40,0,0))]),
                          {maxGridSize:32,fillInterior:false});
vox=expand(m);
const [W2,H2,D2]=m.metadata.grid_size;
const half=vox.filter(v=>v.x>W2/2).length;
ok(half>0, `entrambi i pezzi conservati (${half} voxel nella meta lontana)`);

console.log('=== 4. mesh non-isMesh vengono ignorate (Line/Points) ===');
const line={ isLine:true, geometry:{attributes:{position:attr([0,0,0, 9999,9999,9999])}}, matrixWorld:IDENT };
const pts={ isPoints:true, geometry:{attributes:{position:attr([-8888,0,0])}}, matrixWorld:IDENT };
m=await api.voxelizeScene(scene([cubeMesh(10), line, pts]),{maxGridSize:16,fillInterior:false});
[W,H,D]=m.metadata.grid_size;
vox=expand(m);
ok(W===16&&H===16&&D===16, `Line e Points ignorati: griglia resta ${W}x${H}x${D}`);
ok(vox.every(v=>v.x<W&&v.y<H&&v.z<D&&v.x>=0), 'nessun voxel dai nodi non-mesh');

console.log('=== 5. forma NON cubica: proporzioni rispettate ===');
// parallelepipedo 20 x 5 x 10
const v=[[0,0,0],[20,0,0],[20,5,0],[0,5,0],[0,0,10],[20,0,10],[20,5,10],[0,5,10]];
const faces=[[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[3,2,6],[3,6,7],[0,3,7],[0,7,4],[1,5,6],[1,6,2]];
const pos=[]; faces.forEach(f=>f.forEach(i=>pos.push(...v[i])));
const box={isMesh:true,matrixWorld:IDENT,material:{color:{r:.5,g:.5,b:.5}},
           geometry:{attributes:{position:attr(pos)},index:null}};
m=await api.voxelizeScene(scene([box]),{maxGridSize:20,fillInterior:false});
[W,H,D]=m.metadata.grid_size;
ok(W===20, `lato lungo -> 20 celle (${W})`);
ok(H===Math.round(5/20*19)+1, `proporzione Y corretta: ${H} (atteso ${Math.round(5/20*19)+1})`);
ok(D===Math.round(10/20*19)+1, `proporzione Z corretta: ${D} (atteso ${Math.round(10/20*19)+1})`);

console.log('=== 6. riduzione palette ===');
const counts=new Map();
for(let i=0;i<200;i++) counts.set(`${i},${(i*7)%256},${(i*13)%256}`, 1+i%5);
let red=api.reducePalette(counts, 16);
ok(new Set([...red.values()].map(v=>v.join(','))).size<=16, `200 colori -> max 16 (${new Set([...red.values()].map(v=>v.join(','))).size})`);
ok(red.size===200, 'ogni colore originale ha un rappresentante');
const few=new Map([['10,20,30',5],['200,100,50',3]]);
red=api.reducePalette(few,16);
ok(red.get('10,20,30').join(',')==='10,20,30', 'sotto soglia i colori restano intatti');

console.log('=== 7. chiavi palette valide oltre le 26 lettere ===');
const keys=new Set();
for(let i=0;i<100;i++) keys.add(api.paletteKeyFor(i));
ok(keys.size===100, `100 chiavi tutte distinte (${keys.size})`);
ok(api.paletteKeyFor(0)==='a' && api.paletteKeyFor(26)==='a1', `a, a1 (${api.paletteKeyFor(0)}, ${api.paletteKeyFor(26)})`);

console.log('=== 8. il payload e nel formato compatto dell app ===');
m=await api.voxelizeScene(scene([cubeMesh(8)]),{maxGridSize:12,fillInterior:false});
ok(m.metadata && Array.isArray(m.metadata.grid_size), 'metadata.grid_size presente');
ok(m.palette && Object.keys(m.palette).length>0, 'palette presente');
ok(Array.isArray(m.ops) && m.ops.every(o=>o[0]==='set'), 'ops tutte "set"');
ok(m.ops.every(o=>m.palette[o[1]]!==undefined), 'ogni op punta a una chiave palette esistente');
ok(m.ops.every(o=>(o.length-2)%3===0), 'coordinate a terne complete');

console.log('=== 9. errori chiari invece di modelli vuoti ===');
for(const [sc,why] of [[scene([]),'scena senza mesh']]){
  try { await api.voxelizeScene(sc,{maxGridSize:16}); ok(false, why+' -> doveva fallire'); }
  catch(e){ ok(/mesh|vuot/i.test(e.message), `${why}: "${e.message}"`); }
}

console.log('\n'+(fail===0?'TUTTI I TEST PASSATI':'FALLITI: '+fail)+`  (pass=${pass})`);
process.exit(fail?1:0);
