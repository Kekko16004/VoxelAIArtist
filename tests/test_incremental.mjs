/*
 * Verifica che il percorso INCREMENTALE produca esattamente lo stesso stato del
 * percorso COMPLETO. E' il test che conta: se diverge, il modello sullo schermo
 * non corrisponde piu' ai dati.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const REPO_ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  OK  '+m);} else {fail++;console.log('  FAIL '+m);} };

// --- stub Three.js minimo ---
const disposed=[];
global.THREE={
  BoxGeometry:class{dispose(){disposed.push('geo');}},
  MeshStandardMaterial:class{constructor(o){Object.assign(this,o);} dispose(){disposed.push('mat');}},
  Color:class{constructor(c){this.c=c;}},
  Object3D:class{constructor(){this.position={set(){}};this.matrix={};} updateMatrix(){}},
  InstancedMesh:class{constructor(g,m,c){this.geometry=g;this.material=m;this.count=c;
    this.instanceMatrix={needsUpdate:false};this.userData={};this.position={set(){}};}
    setMatrixAt(){}},
  Vector3:class{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;} copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;}},
};
// --- scope condiviso finto ---
global.modelPivot={children:[],add(m){this.children.push(m);},remove(m){const i=this.children.indexOf(m);if(i>=0)this.children.splice(i,1);}};
global.modelPivotBaseCenter=new THREE.Vector3(0,0,0);
global.meshes=[];
global.voxelMap=new Map();
global.currentModelData={metadata:{},voxels:[]};
global.visibleVoxels=[];
global.voxelGap={value:'0'};
global.toggleWireframe={checked:false};
const mkEl=()=>({textContent:'',innerHTML:'',children:[],appendChild(c){this.children.push(c);},
  addEventListener(){},style:{},title:''});
global.voxelCountEl=mkEl(); global.visibleCountEl=mkEl(); global.paletteEl=mkEl();
global.document={createElement:()=>mkEl()};
global.setActiveColor=()=>{};
global.disposeMesh=(m)=>{ if(m&&m.geometry&&m.geometry.dispose)m.geometry.dispose();
  if(m&&m.material&&m.material.dispose)m.material.dispose(); };
global.requestRender=()=>{};
// t() vive in 23-i18n.js, non caricato qui: senza stub la palette tradotta
// lancerebbe e applyVoxelEdits tornerebbe false (fallback a buildModel).
global.t=(key,vars)=>(vars?key+'('+JSON.stringify(vars)+')':key);
// buildModel fornisce la geometria CONDIVISA: lo stub la simula, altrimenti
// l'incrementale ne creerebbe una nuova per colore.
let _sg=null;
global.getVoxelGeometry=(size)=>{ if(!_sg){ _sg=new THREE.BoxGeometry(size,size,size);
  _sg.userData={shared:true}; } return _sg; };

// carica il modulo incrementale reale
const src=fs.readFileSync(path.join(REPO_ROOT,'ui/src/lib/28-incremental.js'),'latin1');
const api=new Function(src+`
 ;return {primeIncrementalState,applyVoxelEdits,invalidateIncremental,isVisibleAt,syncVisibleVoxels,
          getState:()=>({voxelIndex,visibleColorByKey,visibleByColor,meshByColor,incrementalReady})};`)();

// --- riferimento: la logica COMPLETA (come computeVisibility + colorGroups) ---
function fullRebuildState(){
  const voxels=[...voxelMap.entries()].map(([k,c])=>{const [x,y,z]=k.split(',').map(Number);return {x,y,z,color:c};});
  const set=new Set(voxels.map(v=>`${v.x},${v.y},${v.z}`));
  const visible=voxels.filter(v=>[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    .some(o=>!set.has(`${v.x+o[0]},${v.y+o[1]},${v.z+o[2]}`)));
  const byColor={};
  visible.forEach(v=>{const k=`${v.x},${v.y},${v.z}`;const c=voxelMap.get(k).toUpperCase();(byColor[c]=byColor[c]||[]).push(k);});
  Object.keys(byColor).forEach(c=>byColor[c].sort());
  return {count:voxels.length, visible:visible.length, byColor};
}
function incrState(){
  const st=api.getState();
  const byColor={};
  st.visibleByColor.forEach((m,hex)=>{ byColor[hex]=Array.from(m.keys()).sort(); });
  return {count:currentModelData.voxels.length, visible:st.visibleColorByKey.size, byColor};
}
function canon(o){
  // ordine delle chiavi colore irrilevante: normalizzo prima di confrontare
  const keys=Object.keys(o.byColor).sort();
  return JSON.stringify({count:o.count,visible:o.visible,byColor:keys.map(k=>[k,o.byColor[k]])});
}
function sameState(label){
  const a=fullRebuildState(), b=incrState();
  const eq=canon(a)===canon(b);
  ok(eq, label+` (voxel ${b.count}/${a.count}, visibili ${b.visible}/${a.visible})`);
  if(!eq){
    const ka=Object.keys(a.byColor).sort(), kb=Object.keys(b.byColor).sort();
    console.log('    colori atteso :',ka.join(','));
    console.log('    colori ottenuto:',kb.join(','));
    ka.forEach(k=>{ const x=(a.byColor[k]||[]).join('|'), y=(b.byColor[k]||[]).join('|');
      if(x!==y){ console.log('    DIFF su',k);
        const sa=new Set(a.byColor[k]||[]), sb=new Set(b.byColor[k]||[]);
        console.log('      solo atteso :',[...sa].filter(v=>!sb.has(v)).slice(0,8));
        console.log('      solo ottenuto:',[...sb].filter(v=>!sa.has(v)).slice(0,8)); } });
  }
}
// helper: inizializza lo stato da voxelMap (simula buildModel completo)
function prime(){
  const voxels=[...voxelMap.entries()].map(([k,c])=>{const [x,y,z]=k.split(',').map(Number);return {x,y,z,color:c};});
  currentModelData.voxels=voxels;
  const set=new Set(voxels.map(v=>`${v.x},${v.y},${v.z}`));
  const visible=voxels.filter(v=>[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    .some(o=>!set.has(`${v.x+o[0]},${v.y+o[1]},${v.z+o[2]}`)));
  visibleVoxels=visible;
  const mm=new Map();
  const groups={}; visible.forEach(v=>{const c=v.color.toUpperCase();(groups[c]=groups[c]||[]).push(v);});
  Object.keys(groups).forEach(c=>mm.set(c,new THREE.InstancedMesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial({}),groups[c].length)));
  api.primeIncrementalState(voxels,visible,mm);
}

console.log('=== 1. cubo 5x5x5 pieno: stato iniziale coerente ===');
voxelMap=new Map(); global.voxelMap=voxelMap;
for(let x=0;x<5;x++)for(let y=0;y<5;y++)for(let z=0;z<5;z++) voxelMap.set(`${x},${y},${z}`,'#FF0000');
prime();
sameState('stato iniziale');
ok(fullRebuildState().visible===125-27,'guscio visibile = 98 (interno 3^3 nascosto)');

console.log('=== 2. AGGIUNTA di un voxel esterno ===');
voxelMap.set('6,0,0','#00FF00');
ok(api.applyVoxelEdits([{x:6,y:0,z:0,color:'#00FF00'}]),'applyVoxelEdits accettato');
sameState('dopo aggiunta esterna');

console.log('=== 3. RIMOZIONE di un voxel di superficie (scopre un interno) ===');
voxelMap.delete('2,4,2');
ok(api.applyVoxelEdits([{x:2,y:4,z:2,removed:true}]),'rimozione applicata');
sameState('dopo rimozione: il voxel sotto deve diventare visibile');

console.log('=== 4. RICOLORAZIONE (cambia colore, non geometria) ===');
voxelMap.set('0,0,0','#0000FF');
ok(api.applyVoxelEdits([{x:0,y:0,z:0,color:'#0000FF'}]),'ricolorazione applicata');
sameState('dopo ricolorazione');

console.log('=== 5. RIEMPIMENTO di un buco (nasconde di nuovo) ===');
voxelMap.set('2,4,2','#FF0000');
ok(api.applyVoxelEdits([{x:2,y:4,z:2,color:'#FF0000'}]),'riempimento applicato');
sameState('dopo riempimento: torna allo stato del punto 2+4');

console.log('=== 6. edit MULTIPLI in un colpo (pennello grande) ===');
const batch=[];
for(let y=0;y<5;y++){ voxelMap.delete(`4,${y},4`); batch.push({x:4,y,z:4,removed:true}); }
ok(api.applyVoxelEdits(batch),'batch di 5 rimozioni applicato');
sameState('dopo batch');

console.log('=== 7. rimozione di TUTTI i voxel di un colore (mesh eliminato) ===');
const greens=[{x:6,y:0,z:0,removed:true}];
voxelMap.delete('6,0,0');
api.applyVoxelEdits(greens);
sameState('dopo rimozione ultimo verde');
ok(!api.getState().visibleByColor.has('#00FF00'),'il colore sparito non resta in visibleByColor');
ok(!api.getState().meshByColor.has('#00FF00'),'il mesh del colore sparito e rimosso');

console.log('=== 8. visibleVoxels aggiornato in modo PIGRO (serve all export GLB) ===');
// Ricostruirlo a ogni edit costava O(voxel visibili) PER PENNELLATA e faceva
// bloccare l'editing: ora si marca sporco e si sincronizza solo alla lettura.
api.syncVisibleVoxels();
ok(visibleVoxels.length===fullRebuildState().visible,
   `visibleVoxels allineato dopo syncVisibleVoxels(): ${visibleVoxels.length} = ${fullRebuildState().visible}`);

console.log('=== 9. sequenza lunga casuale (100 edit) vs rebuild completo ===');
let seed=42; const rnd=()=>((seed=seed*1103515245+12345&0x7fffffff)/0x7fffffff);
for(let i=0;i<100;i++){
  const x=Math.floor(rnd()*7),y=Math.floor(rnd()*7),z=Math.floor(rnd()*7);
  const k=`${x},${y},${z}`;
  if(voxelMap.has(k)&&rnd()<0.5){ voxelMap.delete(k); api.applyVoxelEdits([{x,y,z,removed:true}]); }
  else { const c=['#FF0000','#00FF00','#0000FF','#FFFF00'][Math.floor(rnd()*4)];
         voxelMap.set(k,c); api.applyVoxelEdits([{x,y,z,color:c}]); }
}
sameState('dopo 100 edit casuali');

console.log('=== 10. limite di sicurezza: batch enorme -> fallback ===');
const huge=Array.from({length:5000},(_,i)=>({x:i,y:0,z:0,color:'#FFFFFF'}));
ok(api.applyVoxelEdits(huge)===false,'batch > 4000 rifiutato (usa il rebuild completo)');

console.log('=== 11. invalidazione ===');
api.invalidateIncremental();
ok(api.applyVoxelEdits([{x:0,y:0,z:0,color:'#FFFFFF'}])===false,'dopo invalidate torna al percorso completo');

console.log('\n'+(fail===0?'TUTTI I TEST INCREMENTALI PASSATI':'FALLITI: '+fail)+`  (pass=${pass})`);
process.exit(fail?1:0);
