/*
 * Riproduce lo scenario reale segnalato: piazza / rompi / colora ripetuti,
 * anche con pennello grande (selezione multipla).
 * Verifica le TRE regressioni: geometria condivisa distrutta, frame non
 * richiesto, e costo O(N) per pennellata.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));  // radice del repo
const REPO = ROOT;
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  OK  '+m);} else {fail++;console.log('  FAIL '+m);} };

// --- stub Three.js che TRACCIA i dispose ---
const disposedGeometries = new Set();
let geometriesCreated = 0;
class FakeGeom {
  constructor(){ this.id = ++geometriesCreated; this.userData = {}; this.disposed=false; }
  dispose(){ this.disposed=true; disposedGeometries.add(this.id); }
}
global.THREE = {
  BoxGeometry: FakeGeom,
  MeshStandardMaterial: class { constructor(o){Object.assign(this,o);} dispose(){} },
  Color: class { constructor(c){this.c=c;} },
  Object3D: class { constructor(){this.position={set(){}};this.matrix={};} updateMatrix(){} },
  InstancedMesh: class {
    constructor(g,m,c){ this.geometry=g; this.material=m; this.count=c;
      this.instanceMatrix={needsUpdate:false}; this.userData={}; this.position={set(){}}; }
    setMatrixAt(){}
  },
  Vector3: class { constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;} copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;} },
};
global.modelPivot = { children:[], add(m){this.children.push(m);},
  remove(m){const i=this.children.indexOf(m); if(i>=0)this.children.splice(i,1);} };
global.modelPivotBaseCenter = new THREE.Vector3(0,0,0);
global.meshes = [];
global.voxelMap = new Map();
global.currentModelData = { metadata:{grid_size:[32,32,32]}, voxels:[] };
global.visibleVoxels = [];
global.voxelGap = { value:'0' };
global.toggleWireframe = { checked:false };
const mk = () => ({textContent:'',innerHTML:'',appendChild(){},addEventListener(){},style:{},title:''});
global.voxelCountEl=mk(); global.visibleCountEl=mk(); global.paletteEl=mk();
global.document={createElement:mk};
global.setActiveColor=()=>{};

// requestRender TRACCIATO: e' il cuore del bug "schermo congelato"
let renderRequests = 0;
global.requestRender = () => { renderRequests++; };

// carica disposeMesh + getVoxelGeometry REALI da 05-build-model.js
const bm = fs.readFileSync(REPO+'/ui/src/lib/05-build-model.js','latin1');
const start = bm.indexOf('function disposeMesh');
const shared = bm.slice(start);
const api05 = new Function(shared + '\n; return {disposeMesh, getVoxelGeometry, releaseSharedVoxelGeometry};')();
global.disposeMesh = api05.disposeMesh;
global.getVoxelGeometry = api05.getVoxelGeometry;

const inc = fs.readFileSync(REPO+'/ui/src/lib/28-incremental.js','latin1');
const api = new Function(inc + `
 ;return {primeIncrementalState, applyVoxelEdits, syncVisibleVoxels,
          getState:()=>({visibleByColor, meshByColor, incrementalReady, visibleColorByKey})};`)();

// --- prepara un modello con PIU' COLORI (il caso che rompeva) ---
function prime(){
  const voxels=[...voxelMap.entries()].map(([k,c])=>{const[x,y,z]=k.split(',').map(Number);return{x,y,z,color:c};});
  currentModelData.voxels = voxels;
  const set = new Set(voxels.map(v=>`${v.x},${v.y},${v.z}`));
  const vis = voxels.filter(v=>[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    .some(o=>!set.has(`${v.x+o[0]},${v.y+o[1]},${v.z+o[2]}`)));
  visibleVoxels = vis;
  const groups={}; vis.forEach(v=>{const c=v.color.toUpperCase();(groups[c]=groups[c]||[]).push(v);});
  // Come fa buildModel: UNA geometria condivisa per tutti i colori
  const geom = getVoxelGeometry(1.0);
  const mm = new Map();
  meshes.length = 0;
  Object.keys(groups).forEach(c=>{
    const im = new THREE.InstancedMesh(geom, new THREE.MeshStandardMaterial({}), groups[c].length);
    im.userData.voxels = groups[c];
    mm.set(c, im); meshes.push(im); modelPivot.add(im);
  });
  api.primeIncrementalState(voxels, vis, mm);
  return geom;
}

console.log('=== scenario: cubo 12x12x12 con 4 colori ===');
const COLORS=['#FF0000','#00FF00','#0000FF','#FFFF00'];
for(let x=0;x<12;x++)for(let y=0;y<12;y++)for(let z=0;z<12;z++)
  voxelMap.set(`${x},${y},${z}`, COLORS[(x+y+z)%4]);
const sharedGeom = prime();
ok(api.getState().incrementalReady, 'stato incrementale pronto');
ok(api.getState().meshByColor.size===4, '4 mesh, uno per colore');
ok(meshes.every(m=>m.geometry===sharedGeom), 'tutti i mesh CONDIVIDONO una geometria');

console.log('=== REGRESSIONE 1: la geometria condivisa sopravvive agli edit? ===');
renderRequests=0;
voxelMap.set('0,0,0','#00FF00');
api.applyVoxelEdits([{x:0,y:0,z:0,color:'#00FF00'}]);
ok(!sharedGeom.disposed, 'geometria condivisa NON distrutta dopo un edit');
ok(meshes.every(m=>m.geometry && !m.geometry.disposed),
   'nessun mesh punta a una geometria liberata ('+meshes.length+' mesh)');

console.log('=== REGRESSIONE 2: viene chiesto un nuovo frame? ===');
ok(renderRequests>0, 'requestRender chiamato ('+renderRequests+') -> schermo si aggiorna');

console.log('=== REGRESSIONE 3: costo per pennellata indipendente dal modello ===');
// visibleVoxels NON deve essere ricostruito a ogni edit
const before = visibleVoxels;
voxelMap.set('1,0,0','#FFFF00');
api.applyVoxelEdits([{x:1,y:0,z:0,color:'#FFFF00'}]);
ok(visibleVoxels === before, 'visibleVoxels NON ricostruito a ogni edit (lazy)');
api.syncVisibleVoxels();
ok(visibleVoxels !== before, 'ma sincronizzato quando serve (export GLB)');

console.log('=== 100 edit consecutivi: geometria e mesh restano validi ===');
let seed=7; const rnd=()=>((seed=seed*1103515245+12345&0x7fffffff)/0x7fffffff);
let broken=0;
for(let i=0;i<100;i++){
  const x=Math.floor(rnd()*12), y=Math.floor(rnd()*12), z=Math.floor(rnd()*12);
  const k=`${x},${y},${z}`;
  const r=rnd();
  if(r<0.33 && voxelMap.has(k)){ voxelMap.delete(k); api.applyVoxelEdits([{x,y,z,removed:true}]); }
  else { const c=COLORS[Math.floor(rnd()*4)]; voxelMap.set(k,c); api.applyVoxelEdits([{x,y,z,color:c}]); }
  if(meshes.some(m=>!m.geometry || m.geometry.disposed)) broken++;
}
ok(broken===0, 'dopo 100 edit: 0 mesh con geometria invalida (trovati '+broken+')');
ok(!sharedGeom.disposed, 'geometria condivisa ancora viva');

console.log('=== pennello GRANDE (selezione multipla): 60 celle in un colpo ===');
const big=[];
for(let x=0;x<4;x++)for(let y=0;y<4;y++)for(let z=0;z<4;z++){
  const k=`${x+5},${y+5},${z+5}`; voxelMap.set(k,'#FF0000');
  big.push({x:x+5,y:y+5,z:z+5,color:'#FF0000'});
}
renderRequests=0;
const t0=Date.now();
const okBig=api.applyVoxelEdits(big);
const dt=Date.now()-t0;
ok(okBig, 'batch di '+big.length+' celle accettato');
ok(dt<400, 'batch completato in '+dt+'ms (soglia 400ms)');
ok(renderRequests>0, 'frame richiesto anche per il batch');
ok(meshes.every(m=>m.geometry && !m.geometry.disposed), 'mesh validi dopo il pennello grande');

console.log('=== userData.voxels allineato agli indici delle istanze (serve al click) ===');
let mism=0;
api.getState().meshByColor.forEach((mesh,hex)=>{
  const list=mesh.userData.voxels||[];
  if(list.length!==mesh.count) mism++;
  for(let i=0;i<Math.min(list.length,5);i++){
    const v=list[i];
    if((voxelMap.get(`${v.x},${v.y},${v.z}`)||'').toUpperCase()!==hex) mism++;
  }
});
ok(mism===0, 'ogni mesh ha userData.voxels coerente con count e colore ('+mism+' anomalie)');

console.log('=== quante geometrie create in tutto? (perdite di memoria) ===');
console.log('    geometrie create:', geometriesCreated, '| distrutte:', disposedGeometries.size);
ok(geometriesCreated<=3, 'geometria riusata, non ricreata per colore/edit ('+geometriesCreated+')');

console.log('\n'+(fail===0?'TUTTI I TEST PASSATI':'FALLITI: '+fail)+`  (pass=${pass})`);
process.exit(fail?1:0);
