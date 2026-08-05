import path from 'node:path';
import {fileURLToPath} from 'node:url';
const REPO_ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/*
 * Test della logica di 27-pack.js con un DOM finto minimale + fetch finto.
 * Verifica: righe +/-, raccolta oggetti, stima, avvio pack, rendering lista,
 * click su asset pronto -> carica SOLO quel modello pulendo la scena.
 */
import fs from 'node:fs';
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  OK  '+m);} else {fail++;console.log('  FAIL '+m);} };

// ---- DOM finto ----
class El {
  constructor(tag){ this.tagName=(tag||'div').toUpperCase(); this.children=[]; this.style={cssText:''};
    this._cls=new Set(); this.dataset={}; this._html=''; this._text=''; this.listeners={};
    this.value=''; this.disabled=false; this.checked=false; this.title=''; this.placeholder=''; this.type=''; }
  get classList(){ const s=this._cls; return {
    add:(...c)=>c.forEach(x=>s.add(x)), remove:(...c)=>c.forEach(x=>s.delete(x)),
    contains:c=>s.has(c), toggle:(c,f)=>{ const on = (f===undefined)? !s.has(c) : !!f; on?s.add(c):s.delete(c); return on; } }; }
  get className(){ return [...this._cls].join(' '); }
  set className(v){ this._cls=new Set(String(v).split(/\s+/).filter(Boolean)); }
  set innerHTML(v){ this._html=v; if(v==='') this.children=[]; }
  get innerHTML(){ return this._html; }
  set textContent(v){ this._text=String(v); }
  get textContent(){ return this._text; }
  appendChild(c){ this.children.push(c); c.parentElement=this; return c; }
  remove(){ if(this.parentElement){ const i=this.parentElement.children.indexOf(this); if(i>=0) this.parentElement.children.splice(i,1); } }
  addEventListener(e,f){ (this.listeners[e]=this.listeners[e]||[]).push(f); }
  // Ogni Element vero li ha: la carenza era dello stub, non del sorgente.
  // Servono da quando le righe del pack si annotano con data-i18n-* invece di
  // essere ridisegnate a ogni cambio lingua (ridisegnarle cancellerebbe il
  // testo digitato dall'utente).
  setAttribute(k,v){ this._attrs=this._attrs||{}; this._attrs[k]=String(v);
    if(k.indexOf('data-')===0){ this.dataset[k.slice(5).replace(/-([a-z])/g,(m,c)=>c.toUpperCase())]=String(v); } }
  getAttribute(k){ return (this._attrs&&k in this._attrs)?this._attrs[k]:null; }
  hasAttribute(k){ return !!(this._attrs&&k in this._attrs); }
  dispatch(e,ev){ (this.listeners[e]||[]).forEach(f=>f(ev||{preventDefault(){},stopPropagation(){}})); }
  click(){ this.dispatch('click'); }
  get nextElementSibling(){ if(!this.parentElement) return null;
    const i=this.parentElement.children.indexOf(this); return this.parentElement.children[i+1]||null; }
  focus(){}
  _all(){ const out=[]; const walk=n=>n.children.forEach(c=>{out.push(c); walk(c);}); walk(this); return out; }
  querySelectorAll(sel){ const want=sel.replace(/^\./,''); 
    if(sel.startsWith('.')) return this._all().filter(e=>e._cls.has(want));
    if(sel==='input') return this._all().filter(e=>e.tagName==='INPUT');
    return []; }
  querySelector(sel){ return this.querySelectorAll(sel)[0]||null; }
}
const registry={};
const mk=id=>{ const e=new El('div'); e.id=id; registry[id]=e; return e; };
[ 'packRefInput','packAddRefBtn','packRefList','packRefHint','packObjectList','packAddObjBtn',
  'packVariants','packModelSelect','packGridSelect','packEnforcePalette','packEstimate',
  'packStartBtn','packCancelBtn','packResultsPanel','packResultsList','packProgressText',
  'packProgressBar','packPanelClose','packLoadAllBtn','packExportAllBtn','genModeSwitch',
  'genModeSingle','genModePack' ].forEach(mk);
registry.packVariants.value='3';
registry.packGridSelect.value='48x48x48';
registry.packEnforcePalette.checked=true;
// due seg-btn dentro genModeSwitch
['single','pack'].forEach((m,i)=>{ const b=new El('button'); b.className='seg-btn'+(i===0?' active':'');
  b.dataset.genmode=m; registry.genModeSwitch.appendChild(b); });

global.document={ getElementById:id=>registry[id]||null, createElement:t=>new El(t),
  querySelectorAll:()=>[], querySelector:()=>null, addEventListener(){} };
global.window={ __API_BASE__:'' };
global.alert=m=>{ global.__lastAlert=m; };
global.confirm=()=>true;
global.FileReader=class{ readAsText(){} readAsDataURL(){} };
global.atob=s=>Buffer.from(s,'base64').toString('binary');
global.escape=s=>s; global.unescape=s=>s;
global.setInterval=()=>0; global.clearInterval=()=>{};
// NB: NON sostituisco setTimeout con una versione sincrona: le funzioni async
// del modulo hanno bisogno che i microtask girino davvero, altrimenti l'handler
// dell'export si ferma alla prima await e il test misura il nulla.
const realSetTimeout=global.setTimeout;

// deps che il modulo si aspetta dallo scope condiviso
global.geminiModels=[{val:'gemini-3.1-pro',label:'Gemini 3.1 Pro'}];
let loadedScene=null, buildCalls=0, downloads=[];
global.loadSceneFromParsed=p=>{ loadedScene=p; };
global.buildModel=()=>{ buildCalls++; };
global.downloadFile=(c,n)=>downloads.push(n);
let zipCalls=[], blobDownloads=[];
global.createZipBlob=(files)=>{ zipCalls.push(files); return {__zip:true}; };
global.downloadBlob=(blob,name)=>blobDownloads.push(name);
global.expandOps=(d)=>({...d, voxels:(d&&d.voxels)||[{x:0,y:0,z:0,color:'#FF0000'}]});
global.encodeVox=()=>new Uint8Array([1,2,3]);
global.buildObjText=()=>'# obj';
global.buildMtlText=()=>'# mtl';
global.t=(k,v)=>{ let s=k; if(v) Object.keys(v).forEach(x=>s+=':'+v[x]); return s; };

// fetch finto che replica il contratto del backend
let startedBody=null;
const JOBS=[
  {id:'j1',objectName:'Vaso fiori',variant:1,label:'Vaso_Fiori_1',status:'done',duration:42},
  {id:'j2',objectName:'Vaso fiori',variant:2,label:'Vaso_Fiori_2',status:'running'},
  {id:'j3',objectName:'Televisore',variant:1,label:'Televisore_1',status:'queued'},
  {id:'j4',objectName:'Televisore',variant:2,label:'Televisore_2',status:'error',error:'JSON rotto'}
];
const MODEL={metadata:{name:'Vaso_Fiori_1',grid_size:[48,48,48]},palette:{a:'#8B4513'},ops:[['fill',0,0,0,4,4,4,'a']]};
global.fetch=async(url,opt)=>{
  const j=b=>({ok:true,status:200,json:async()=>b});
  if(url.includes('/api/pack/start')){ startedBody=JSON.parse(opt.body);
    return j({id:'run1',status:'running',total:4,counts:{queued:2,running:1,done:1,error:0,cancelled:0},jobs:JOBS,etaSeconds:120}); }
  if(url.includes('/api/pack/status')) return j({id:'run1',status:'running',total:4,counts:{queued:1,running:1,done:1,error:1,cancelled:0},jobs:JOBS,etaSeconds:90});
  if(url.includes('/api/pack/result')) return j({job:JOBS[0],model:MODEL});
  if(url.includes('/api/pack/all')) return j({runId:'run1',count:2,assets:[
      {label:'Vaso_Fiori_1',objectName:'Vaso fiori',variant:1,model:MODEL},
      {label:'Televisore_1',objectName:'Televisore',variant:1,model:{...MODEL,metadata:{name:'Televisore_1',grid_size:[48,48,48]}}}]});
  if(url.includes('/api/pack/retry')) return j({id:'run1',status:'running',total:4,counts:{},jobs:JOBS});
  return j({});
};

// carica il modulo reale (frammento di scope: lo avvolgo in una funzione)
const src=fs.readFileSync(path.join(REPO_ROOT,'ui/src/lib/27-pack.js'),'latin1');
const mod=new Function(src+'\n;return {packGetObjects,packAddObjectRow,packRenderStatus,packLoadJob,packUpdateEstimate};');
const api=mod();
await new Promise(r=>setTimeout(r,0));

console.log('=== 1. riga oggetto iniziale ===');
const rows=()=>registry.packObjectList.querySelectorAll('.pack-obj-row');
ok(rows().length===1,'una riga presente all\'avvio');
ok(rows()[0].querySelector('.pack-row-btn').disabled===true,'bottone meno disabilitato con 1 sola riga');

console.log('=== 2. aggiunta righe con + ===');
registry.packAddObjBtn.click(); registry.packAddObjBtn.click();
ok(rows().length===3,'3 righe dopo due click su + (trovate '+rows().length+')');
ok(rows()[0].querySelector('.pack-row-btn').disabled===false,'bottone meno ora abilitato');

console.log('=== 3. compilazione e raccolta oggetti ===');
const inputs=registry.packObjectList.querySelectorAll('input');
inputs[0].value='Vaso fiori'; inputs[1].value='Televisore'; inputs[2].value='Auricolare bluetooth';
const got=api.packGetObjects();
ok(JSON.stringify(got)===JSON.stringify(['Vaso fiori','Televisore','Auricolare bluetooth']),'oggetti raccolti in ordine: '+JSON.stringify(got));

console.log('=== 4. rimozione di una riga a scelta ===');
rows()[1].querySelector('.pack-row-btn').click();
ok(rows().length===2,'2 righe dopo rimozione');
ok(JSON.stringify(api.packGetObjects())===JSON.stringify(['Vaso fiori','Auricolare bluetooth']),'rimossa la riga giusta (quella centrale)');

console.log('=== 5. campi vuoti ignorati ===');
registry.packAddObjBtn.click();
ok(api.packGetObjects().length===2,'riga vuota non conta come oggetto');

console.log('=== 6. stima del lavoro ===');
api.packUpdateEstimate();
ok(registry.packEstimate.textContent.includes('6'),'stima con 2 oggetti x 3 varianti = 6 asset ('+registry.packEstimate.textContent+')');

console.log('=== 7. avvio pack: payload inviato al backend ===');
await registry.packStartBtn.dispatch('click');
await new Promise(r=>setTimeout(r,0));
ok(startedBody!==null,'richiesta di start inviata');
ok(JSON.stringify(startedBody.objects)===JSON.stringify(['Vaso fiori','Auricolare bluetooth']),'objects corretti nel payload');
ok(startedBody.variants===3,'variants=3');
ok(startedBody.gridSize==='48x48x48','gridSize propagata');
ok(startedBody.enforcePalette===true,'enforcePalette propagato');
ok(registry.packResultsPanel.classList.contains('open'),'pannello risultati aperto');

console.log('=== 8. rendering della lista ===');
api.packRenderStatus({id:'run1',status:'running',total:4,counts:{queued:1,running:1,done:1,error:1},jobs:JOBS,etaSeconds:90});
const items=registry.packResultsList.querySelectorAll('.pack-item');
ok(items.length===4,'4 asset in lista (trovati '+items.length+')');
const byLabel={}; items.forEach(i=>{ const l=i.querySelectorAll('.pack-item-label')[0]; byLabel[l.textContent]=i; });
ok(!!byLabel['Vaso_Fiori_1']&&!!byLabel['Televisore_2'],'label Vaso_Fiori_1 / Televisore_2 presenti');
ok(byLabel['Vaso_Fiori_1']._cls.has('is-done'),'asset pronto = is-done (cliccabile)');
ok(!byLabel['Vaso_Fiori_2']._cls.has('is-done'),'asset in corso NON cliccabile');
ok(byLabel['Vaso_Fiori_2'].querySelectorAll('.pack-spin').length===1,'asset in corso mostra lo spinner');
ok(byLabel['Televisore_2']._cls.has('is-error'),'asset fallito = is-error');
ok(registry.packResultsList.querySelectorAll('.pack-group-label').length===2,'raggruppato per oggetto (2 gruppi)');
ok(registry.packProgressBar.style.width==='25.0%','barra di avanzamento 1/4 = '+registry.packProgressBar.style.width);

console.log('=== 9. click su asset pronto -> carica SOLO quel modello ===');
loadedScene=null; buildCalls=0;
await byLabel['Vaso_Fiori_1'].dispatch('click');
await new Promise(r=>setTimeout(r,0));
ok(loadedScene!==null,'loadSceneFromParsed chiamata');
ok(!loadedScene.objects,'payload single-object => la griglia viene PULITA (no objects[])');
ok(loadedScene.metadata.name==='Vaso_Fiori_1','caricato il modello giusto');
ok(buildCalls===1,'buildModel chiamata una volta');
{
  const cur={}; registry.packResultsList.querySelectorAll('.pack-item').forEach(i=>{
    const l=i.querySelectorAll('.pack-item-label')[0]; cur[l.textContent]=i; });
  const act=Object.keys(cur).filter(k=>cur[k]._cls.has('is-active'));
  ok(act.length===1 && act[0]==='Vaso_Fiori_1','asset evidenziato come attivo (attivi: '+JSON.stringify(act)+')');
}

console.log('=== 10. click su asset in corso non fa nulla ===');
loadedScene=null;
await byLabel['Vaso_Fiori_2'].dispatch('click');
ok(loadedScene===null,'asset non pronto: nessun caricamento');

console.log('=== 11. carica tutti nella scena (affiancati) ===');
loadedScene=null;
await registry.packLoadAllBtn.dispatch('click');
await new Promise(r=>setTimeout(r,0));
ok(loadedScene&&Array.isArray(loadedScene.objects),'scena multi-oggetto');
ok(loadedScene.objects.length===2,'2 asset caricati');
const xs=loadedScene.objects.map(o=>o.transform.position.x);
ok(xs[0]===0&&xs[1]>0,'asset affiancati sull\'asse X: '+JSON.stringify(xs));

console.log('=== 12. esporta tutto il pack come UNICO ZIP (idea #5) ===');
// L'export non produce piu' N download separati: costruisce un solo archivio.
zipCalls=[]; blobDownloads=[];
await registry.packExportAllBtn.dispatch('click');
await new Promise(r=>realSetTimeout(r,60));
ok(zipCalls.length===1,'createZipBlob chiamato una volta ('+zipCalls.length+')');
const zipFiles=(zipCalls[0]||[]).map(f=>f.name);
ok(zipFiles.includes('pack.json'),'manifest pack.json incluso');
ok(zipFiles.some(n=>n.startsWith('Vaso_Fiori_1/')),'cartella per asset ('+zipFiles.slice(0,4).join(', ')+')');
ok(zipFiles.some(n=>n.endsWith('.json')&&n!=='pack.json'),'JSON del modello incluso');
ok(blobDownloads.length===1&&/\.zip$/.test(blobDownloads[0]),'un solo download .zip: '+blobDownloads[0]);

console.log('=== 13. sotto-navigazione Singolo/Pack ===');
const segs=registry.genModeSwitch.querySelectorAll('.seg-btn');
segs[1].click();
ok(registry.genModeSingle.style.display==='none','modalita singola nascosta');
ok(registry.genModePack.style.display==='','pannello pack visibile');
segs[0].click();
ok(registry.genModeSingle.style.display===''&&registry.genModePack.style.display==='none','ritorno a singolo ok');

console.log('\n'+(fail===0?'TUTTI I TEST UI PASSATI':'FALLITI: '+fail)+'  (pass='+pass+')');
process.exit(fail?1:0);
