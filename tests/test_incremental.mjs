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
  MeshStandardMaterial:class{constructor(o){Object.assign(this,o);this.userData=this.userData||{};this.disposed=0;}
    dispose(){disposed.push('mat');this.disposed++;}},
  Color:class{constructor(c){this.c=c;}},
  Object3D:class{constructor(){this.position={set(){}};this.matrix={};} updateMatrix(){}},
  InstancedMesh:class{constructor(g,m,c){this.geometry=g;this.material=m;this.count=c;
    this.instanceMatrix={needsUpdate:false};this.userData={};this.position={set(){}};}
    setMatrixAt(){}},
  Vector3:class{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;} copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;}},
  // Serve solo ai materiali con texture: qui basta registrare l'immagine.
  TextureLoader:class{load(url,cb){const tx={image:url,dispose(){tx.disposed=1;}};if(cb)cb(tx);return tx;}},
  NearestFilter:'NEAREST', RepeatWrapping:'REPEAT',
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
const mkEl=()=>{
  const el={textContent:'',children:[],_on:{},style:{},title:'',
    appendChild(c){this.children.push(c);},
    addEventListener(ev,fn){this._on[ev]=fn;}};
  // innerHTML='' e' come il DOM svuota il contenitore: senza simularlo le swatch
  // di una chiamata resterebbero attaccate a quelle della successiva.
  Object.defineProperty(el,'innerHTML',{get(){return '';},set(){el.children.length=0;}});
  return el;
};
global.voxelCountEl=mkEl(); global.visibleCountEl=mkEl(); global.paletteEl=mkEl();
// getElementById: un `document` vero ce l'ha sempre. refreshMaterialSelectionUI
// (36-materials.js) lo chiama e fa `if (panel)` su ognuno, quindi null basta e
// non serve simulare il pannello. La carenza era del test double, non del
// sorgente: la stessa trappola di MeshStandardMaterial senza userData.
global.document={createElement:()=>mkEl(),getElementById:()=>null};
global.setActiveColor=(c)=>{ lastActivated={kind:'color',value:c}; };
global.setActiveMaterialAndSync=(id)=>{ lastActivated={kind:'material',value:id}; };
let lastActivated=null;
// t() prima di bootI18n ritorna la chiave nuda: qui la si simula in modo
// VISIBILE (chiave + argomenti) cosi' un titolo costruito per concatenazione
// invece che con i segnaposto di t() si nota subito.
global.t=(k,vars)=>k+(vars?'('+JSON.stringify(vars)+')':'');
global.requestRender=()=>{};

// disposeMesh e getVoxelGeometry REALI da 05-build-model.js: e' la' che vive la
// protezione delle risorse CONDIVISE, e i materiali della cache ora ne dipendono
// esattamente come le geometrie.
const bmSrc=fs.readFileSync(path.join(REPO_ROOT,'ui/src/lib/05-build-model.js'),'latin1');
const api05=new Function(bmSrc.slice(bmSrc.indexOf('function disposeMesh'))+
  '\n;return {disposeMesh,getVoxelGeometry,releaseSharedVoxelGeometry};')();
global.disposeMesh=api05.disposeMesh;
global.getVoxelGeometry=api05.getVoxelGeometry;

// carica il modulo incrementale reale, CON i materiali: 28-incremental.js
// raggruppa per token e quindi dipende da 36-materials.js (nel bundle sono lo
// stesso scope, qui li si concatena nello stesso ordine del manifest).
const src=fs.readFileSync(path.join(REPO_ROOT,'ui/src/lib/28-incremental.js'),'latin1');
const matSrc=fs.readFileSync(path.join(REPO_ROOT,'ui/src/lib/36-materials.js'),'latin1');
const api=new Function(src+'\n'+matSrc+`
 ;return {primeIncrementalState,applyVoxelEdits,invalidateIncremental,isVisibleAt,syncVisibleVoxels,
          renderPaletteSwatches,addMaterial,materialById,tokenOf,threeMaterialFor,
          getActiveMaterialId,setActiveMaterial,
          getState:()=>({voxelIndex,visibleColorByKey,visibleByColor,meshByColor,incrementalReady,
                         paletteSignature})};`)();

// token di un voxel, come lo scrive tokenOf: la voxelMap contiene TOKEN.
const tokOf=(v)=>v.material?('@'+v.material):v.color.toUpperCase();

// --- riferimento: la logica COMPLETA (come computeVisibility + colorGroups) ---
// I gruppi sono per TOKEN, non per colore: e' l'invariante che questo test misura.
function voxelsFromMap(){
  return [...voxelMap.entries()].map(([k,tok])=>{
    const [x,y,z]=k.split(',').map(Number);
    const d=(tok.charAt(0)==='@') ? {color:null,material:tok.slice(1)} : {color:tok.toUpperCase(),material:null};
    const def=d.material?api.materialById(d.material):null;
    const v={x,y,z,color:d.color||(def?def.color:'#CCCCCC')};
    if(d.material) v.material=d.material;
    return v;
  });
}
function fullRebuildState(){
  const voxels=voxelsFromMap();
  const set=new Set(voxels.map(v=>`${v.x},${v.y},${v.z}`));
  const visible=voxels.filter(v=>[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    .some(o=>!set.has(`${v.x+o[0]},${v.y+o[1]},${v.z+o[2]}`)));
  const byColor={};
  visible.forEach(v=>{const k=`${v.x},${v.y},${v.z}`;(byColor[tokOf(v)]=byColor[tokOf(v)]||[]).push(k);});
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
  const voxels=voxelsFromMap();
  currentModelData.voxels=voxels;
  const set=new Set(voxels.map(v=>`${v.x},${v.y},${v.z}`));
  const visible=voxels.filter(v=>[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    .some(o=>!set.has(`${v.x+o[0]},${v.y+o[1]},${v.z+o[2]}`)));
  visibleVoxels=visible;
  const mm=new Map();
  const groups={}; visible.forEach(v=>{(groups[tokOf(v)]=groups[tokOf(v)]||[]).push(v);});
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

// --- materiali -------------------------------------------------------------
// Il percorso rapido deve raggruppare per TOKEN, non per colore: due voxel dello
// stesso colore ma con materiali diversi sono due mesh diverse, e la firma della
// palette deve accorgersene (altrimenti le swatch non si aggiornano mai).
console.log('=== 12. due voxel dello stesso colore, materiali diversi ===');
currentModelData.metadata={};
api.addMaterial({id:'m1',name:'Legno',color:'#8B5A2B',roughness:0.7});
voxelMap=new Map(); global.voxelMap=voxelMap;
voxelMap.set('0,0,0','@m1');
voxelMap.set('2,0,0','#8B5A2B');
prime();
{
  const keys=Array.from(api.getState().visibleByColor.keys()).sort();
  ok(keys.length===2 && keys.includes('@m1') && keys.includes('#8B5A2B'),
     'due voxel stesso colore ma materiale diverso danno due gruppi '+JSON.stringify(keys));
}
sameState('gruppi per token coerenti col rebuild completo');

console.log('=== 13. la firma della palette reagisce a colore -> materiale ===');
voxelMap=new Map(); global.voxelMap=voxelMap;
voxelMap.set('0,0,0','#8B5A2B');
prime();
{
  const sigPrima=api.getState().paletteSignature;
  voxelMap.set('0,0,0','@m1');
  ok(api.applyVoxelEdits([{x:0,y:0,z:0,color:'@m1'}]),'edit colore -> materiale accettato');
  const sigDopo=api.getState().paletteSignature;
  ok(sigDopo!==sigPrima,`la firma della palette reagisce (${sigPrima} -> ${sigDopo})`);
  ok(api.getState().visibleByColor.has('@m1') && !api.getState().visibleByColor.has('#8B5A2B'),
     'il voxel e\' passato al gruppo del materiale');
  sameState('dopo colore -> materiale');
}

console.log('=== 14. il token viene SCOMPOSTO nell array dei voxel ===');
{
  const v=currentModelData.voxels.find(v=>v.x===0&&v.y===0&&v.z===0);
  ok(v.material==='m1' && v.color==='#8B5A2B',
     'materiale e colore separati nel voxel: '+JSON.stringify(v));
  voxelMap.set('0,0,0','#FF0000');
  api.applyVoxelEdits([{x:0,y:0,z:0,color:'#FF0000'}]);
  const v2=currentModelData.voxels.find(v=>v.x===0&&v.y===0&&v.z===0);
  ok(!('material' in v2) && v2.color==='#FF0000',
     'tornando a un colore il campo material viene RIMOSSO: '+JSON.stringify(v2));
  sameState('dopo materiale -> colore');
}

console.log('=== 15. maiuscole: i colori si normalizzano, gli id NO ===');
api.addMaterial({id:'mAbc',name:'Pietra',color:'#112233'});
{
  voxelMap.set('4,0,0','#00ff00');
  api.applyVoxelEdits([{x:4,y:0,z:0,color:'#00ff00'}]);
  const st=api.getState();
  ok(st.visibleByColor.has('#00FF00') && !st.visibleByColor.has('#00ff00'),
     'un colore minuscolo finisce nel gruppo maiuscolo (come tokenOf)');
  voxelMap.set('6,0,0','@mAbc');
  api.applyVoxelEdits([{x:6,y:0,z:0,color:'@mAbc'}]);
  const st2=api.getState();
  ok(st2.visibleByColor.has('@mAbc') && !st2.visibleByColor.has('@MABC'),
     'un token materiale NON viene maiuscolizzato: '+JSON.stringify(Array.from(st2.visibleByColor.keys())));
  const v=currentModelData.voxels.find(v=>v.x===6&&v.y===0&&v.z===0);
  ok(v && v.material==='mAbc' && v.color==='#112233',
     'e l\'id resta quello vero, col colore della definizione: '+JSON.stringify(v));
  sameState('dopo gli edit di normalizzazione');
}

console.log('=== 16. materiale ORFANO: il colore del voxel NON va perso ===');
// decodeToken senza il colore vero degrada al grigio neutro: se il percorso
// rapido lo chiamasse cosi', assegnare un materiale non ancora caricato
// ricolorerebbe il voxel di grigio in modo definitivo (syncVoxelsFromMap salva).
{
  voxelMap.set('4,0,0','@ghost');
  api.applyVoxelEdits([{x:4,y:0,z:0,color:'@ghost'}]);
  const v=currentModelData.voxels.find(v=>v.x===4&&v.y===0&&v.z===0);
  ok(v && v.color==='#00FF00' && v.material==='ghost',
     'un id orfano conserva il colore del voxel: '+JSON.stringify(v));
  const mesh=api.getState().meshByColor.get('@ghost');
  ok(mesh && mesh.material.color && mesh.material.color.c==='#00FF00',
     'e il mesh dell orfano usa quel colore, non il grigio: '+
     JSON.stringify(mesh&&mesh.material.color));
  // Denti: il colore giusto potrebbe essere un caso. Lo stesso id orfano su un
  // voxel di colore DIVERSO deve dare un materiale di colore diverso -- e' la
  // prova che il colore VERO del voxel arriva fino a decodeToken sul percorso di
  // rendering, non che il modulo saprebbe usarlo se glielo passassero.
  voxelMap.delete('4,0,0');
  api.applyVoxelEdits([{x:4,y:0,z:0,removed:true}]);
  voxelMap.set('4,0,0','#FF00FF');
  api.applyVoxelEdits([{x:4,y:0,z:0,color:'#FF00FF'}]);
  voxelMap.set('4,0,0','@ghost');
  api.applyVoxelEdits([{x:4,y:0,z:0,color:'@ghost'}]);
  const mesh2=api.getState().meshByColor.get('@ghost');
  ok(mesh2 && mesh2.material.color.c==='#FF00FF',
     'lo stesso id orfano su un voxel viola da\' un materiale viola: '+
     JSON.stringify(mesh2&&mesh2.material.color));
  ok(mesh2.material!==mesh.material,
     'e i due orfani NON si spartiscono l\'istanza in cache');
  // La cache non deve moltiplicarsi per tinta quando il materiale ESISTE: la sua
  // chiave passa dal colore RISOLTO, non da quello grezzo del voxel campione.
  const t1=api.threeMaterialFor('@m1',{color:'#aabbcc'});
  const t2=api.threeMaterialFor('@m1',{color:'#AABBCC'});
  ok(t1===t2,'un materiale risolto non prende un\'istanza in cache per ogni tinta di voxel');
  // Il solido e il wireframe dello stesso token restano due materiali distinti:
  // la chiave della cache non deve poter collidere.
  const solido=api.threeMaterialFor('#0F0F0F',{});
  const filo=api.threeMaterialFor('#0F0F0F',{wireframe:true});
  ok(solido!==filo && solido.wireframe===false && filo.wireframe===true,
     'solido e wireframe non collidono nella cache');
}

console.log('=== 17. il materiale THREE viene dalla CACHE e sopravvive a disposeMesh ===');
{
  voxelMap.set('10,0,0','#0000FF');
  api.applyVoxelEdits([{x:10,y:0,z:0,color:'#0000FF'}]);
  const matA=api.getState().meshByColor.get('#0000FF').material;
  voxelMap.set('11,0,0','#0000FF');
  api.applyVoxelEdits([{x:11,y:0,z:0,color:'#0000FF'}]);
  const matB=api.getState().meshByColor.get('#0000FF').material;
  ok(matB===matA,'il materiale e\' riusato dalla cache, non ricreato a ogni pennellata');
  ok(!matA.disposed,'disposeMesh NON libera un materiale condiviso ('+matA.disposed+' dispose)');
  ok(matA.userData && matA.userData.shared===true,
     'il materiale della cache e\' marcato userData.shared');
}

console.log('=== 18. swatch: miniatura per i materiali, titoli da t() ===');
api.addMaterial({id:'mTex',name:'Legno',color:'#8B5A2B',
  texture:{data:'data:image/png;base64,AAAA',w:8,h:8}});
{
  api.renderPaletteSwatches(['@mTex','#123456']);
  const sw=paletteEl.children;
  ok(sw.length===2,'due swatch ('+sw.length+')');
  ok(String(sw[0].style.backgroundImage).indexOf('data:image/png;base64,AAAA')>=0,
     'la swatch di un materiale mostra la miniatura: '+sw[0].style.backgroundImage);
  ok(sw[0].style.imageRendering==='pixelated','la miniatura non viene interpolata');
  ok(sw[0].title.indexOf('materials.swatchMaterialTitle')===0,
     'il titolo del materiale passa da t(): '+sw[0].title);
  ok(sw[0].title.indexOf('Legno')>0,'il nome arriva come segnaposto {name}: '+sw[0].title);
  ok(sw[1].title.indexOf('materials.swatchColorTitle')===0,
     'il titolo del colore passa da t(): '+sw[1].title);
  ok(sw[1].title.indexOf('#123456')>0,'il colore arriva come segnaposto {color}: '+sw[1].title);
  // Si legge lo STATO vero, non la spia globale: 36-materials.js definisce una
  // setActiveMaterialAndSync dentro QUESTO scope, e in uno scope condiviso la
  // definizione locale scavalca il globale - esattamente come fara' il bundle.
  // Leggere getActiveMaterialId() e' anche piu' severo che contare la chiamata.
  api.setActiveMaterial(null); sw[0]._on.click();
  ok(api.getActiveMaterialId()==='mTex',
     'il clic su una swatch materiale seleziona il MATERIALE: '+api.getActiveMaterialId());
  lastActivated=null; sw[1]._on.click();
  ok(lastActivated && lastActivated.kind==='color' && lastActivated.value==='#123456',
     'il clic su una swatch colore seleziona il COLORE: '+JSON.stringify(lastActivated));
  // Un materiale SENZA texture resta una swatch a tinta piatta, ma agganciata al
  // materiale: altrimenti selezionarlo dalla palette sarebbe impossibile.
  api.renderPaletteSwatches(['@mAbc']);
  ok(!paletteEl.children[0].style.backgroundImage,
     'un materiale senza texture non finge una miniatura');
  api.setActiveMaterial(null); paletteEl.children[0]._on.click();
  ok(api.getActiveMaterialId()==='mAbc',
     'e il suo clic seleziona comunque il materiale: '+api.getActiveMaterialId());
}

console.log('\n'+(fail===0?'TUTTI I TEST INCREMENTALI PASSATI':'FALLITI: '+fail)+`  (pass=${pass})`);
process.exit(fail?1:0);