// =======================================================================
//  07 - Materiali procedurale (rumore in object space, niente UV)
// =======================================================================

const _matCache = new Map();

function hexToRgb(hex) {
    const h = String(hex || '#CCCCCC').replace('#', '');
    const n = parseInt(h.length === 3
        ? h[0]+h[0]+h[1]+h[1]+h[2]+h[2] : h, 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// Chunk GLSL di value-noise / fbm / cell, in object space.
const NOISE_GLSL = `
float _samHash(vec3 p){
  p = fract(p*0.3183099+0.1);
  p *= 17.0;
  return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
}
float _samNoise(vec3 x){
  vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(_samHash(i+vec3(0,0,0)),_samHash(i+vec3(1,0,0)),f.x),
                 mix(_samHash(i+vec3(0,1,0)),_samHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(_samHash(i+vec3(0,0,1)),_samHash(i+vec3(1,0,1)),f.x),
                 mix(_samHash(i+vec3(0,1,1)),_samHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float _samFbm(vec3 p){
  float a=0.5; float v=0.0;
  for(int i=0;i<4;i++){ v+=a*_samNoise(p); p*=2.02; a*=0.5; }
  return v;
}
float _samCell(vec3 p){
  vec3 i=floor(p); vec3 f=fract(p);
  float md=1.0;
  for(int z=-1;z<=1;z++) for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec3 g=vec3(float(x),float(y),float(z));
    vec3 o=vec3(_samHash(i+g),_samHash(i+g+1.3),_samHash(i+g+2.7));
    vec3 r=g+o-f; md=min(md,dot(r,r));
  }
  return sqrt(md);
}
`;

function makeGradientEnv() {
    // CubeTexture a gradiente su canvas: metalness senza envMap rende NERO
    // (e' fisicamente giusto: niente da riflettere). Il cielo e' chiaro in alto
    // e il terreno scuro in basso, cosi' un metallo mostra un orizzonte invece
    // di una tinta piatta — e' l'orizzonte a farlo leggere come metallo.
    const size = 64;
    const faces = [];
    const spec = [
        { top: [150, 168, 190], bot: [70, 74, 86] },    // +x
        { top: [130, 148, 172], bot: [62, 66, 78] },    // -x
        { top: [205, 222, 240], bot: [190, 205, 225] }, // +y (cielo)
        { top: [40, 40, 48], bot: [26, 26, 32] },       // -y (terra)
        { top: [140, 158, 182], bot: [66, 70, 82] },    // +z
        { top: [120, 138, 162], bot: [58, 62, 74] },    // -z
    ];
    for (let f = 0; f < 6; f++) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 0, size);
        const s = spec[f];
        g.addColorStop(0, 'rgb(' + s.top.join(',') + ')');
        g.addColorStop(1, 'rgb(' + s.bot.join(',') + ')');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        // Una macchia chiara: e' il riflesso speculare che da' la "luce"
        // ai metalli e alle vernici lucide.
        if (f === 2 || f === 4) {
            const rg = ctx.createRadialGradient(size * 0.35, size * 0.3, 1,
                                                size * 0.35, size * 0.3, size * 0.5);
            rg.addColorStop(0, 'rgba(255,255,255,0.9)');
            rg.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = rg;
            ctx.fillRect(0, 0, size, size);
        }
        faces.push(c);
    }
    const tex = new THREE.CubeTexture(faces);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

let _envMap = null;
function getEnvMap() {
    if (!_envMap) _envMap = makeGradientEnv();
    return _envMap;
}

function buildMaterial(def, style) {
    def = def || { col: '#CCCCCC' };
    style = style || 'lowpoly';
    const key = JSON.stringify(def) + '|' + style;
    if (_matCache.has(key)) return _matCache.get(key);

    const rgb = hexToRgb(def.col || '#CCCCCC');
    const rough = def.rough != null ? def.rough : 0.7;
    const metal = def.metal != null ? def.metal : 0;
    const emit = def.emit || 0;
    const opacity = def.opacity != null ? def.opacity : 1;
    const noise = def.noise || null;

    let mat;
    if (style === 'toon') {
        mat = new THREE.MeshToonMaterial({
            color: new THREE.Color(rgb.r, rgb.g, rgb.b),
            transparent: opacity < 1,
            opacity: opacity,
        });
    } else if (style === 'pbr') {
        // MeshPhysicalMaterial: il clearcoat e' cio' che fa leggere una vernice
        // come vernice e un metallo lucidato come lucidato. Su MeshStandard non
        // c'e', e il risultato e' "plastica opaca" qualunque valore si metta.
        mat = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color(rgb.r, rgb.g, rgb.b),
            roughness: rough,
            metalness: metal,
            transparent: opacity < 1,
            opacity: opacity,
            envMap: getEnvMap(),
            envMapIntensity: 1.15,
            clearcoat: metal > 0.5 ? 0.35 : (rough < 0.4 ? 0.5 : 0.08),
            clearcoatRoughness: Math.max(0.04, rough * 0.5),
            sheen: rough > 0.75 ? 0.25 : 0,   // tessuti, cuoio, legno grezzo
            sheenColor: new THREE.Color(rgb.r, rgb.g, rgb.b),
            flatShading: false,
        });
    } else {
        mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(rgb.r, rgb.g, rgb.b),
            roughness: rough,
            metalness: metal,
            flatShading: true,
            transparent: opacity < 1,
            opacity: opacity,
            envMap: getEnvMap(),
            envMapIntensity: metal > 0.1 ? 0.85 : 0.4,
        });
    }
    if (emit > 0 && mat.emissive) {
        const ec = def.emitCol ? hexToRgb(def.emitCol) : rgb;
        mat.emissive = new THREE.Color(ec.r, ec.g, ec.b);
        mat.emissiveIntensity = emit;
    }

    // Rumore procedurale via onBeforeCompile (object-space, triplanare).
    if (noise && noise.t && noise.t !== 'none' && style !== 'toon') {
        const scale = noise.scale || 12;
        const amp = noise.amp != null ? noise.amp : 0.18;
        const seed = noise.seed || 0;
        const col2 = noise.col2 ? hexToRgb(noise.col2) : {
            r: rgb.r * 0.6, g: rgb.g * 0.6, b: rgb.b * 0.6,
        };
        const nType = noise.t;
        mat.onBeforeCompile = (shader) => {
            shader.uniforms.samScale = { value: scale };
            shader.uniforms.samAmp = { value: amp };
            shader.uniforms.samSeed = { value: seed * 0.17 };
            shader.uniforms.samCol2 = { value: new THREE.Vector3(col2.r, col2.g, col2.b) };
            shader.uniforms.samBands = { value: noise.bands || 0 };
            shader.uniforms.samRoughAmp = {
                value: noise.roughAmp != null ? noise.roughAmp
                     : (style === 'pbr' ? 0.35 : 0.15),
            };
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>',
                    '#include <common>\nvarying vec3 samObjPos;')
                .replace('#include <begin_vertex>',
                    '#include <begin_vertex>\nsamObjPos = position;');
            let noiseFn = '_samFbm';
            if (nType === 'cell') noiseFn = '_samCell';
            else if (nType === 'scratch') noiseFn = '_samNoise';
            else if (nType === 'stripe') noiseFn = 'stripeN';
            else if (nType === 'spot') noiseFn = 'spotN';
            else if (nType === 'grain') noiseFn = '_samNoise';
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>',
                    '#include <common>\n' + NOISE_GLSL + `
varying vec3 samObjPos;
uniform float samScale, samAmp, samSeed, samBands, samRoughAmp;
uniform vec3 samCol2;
float stripeN(vec3 p){ return step(0.5, fract(p.x*0.5+samSeed)); }
float spotN(vec3 p){ return step(0.65, _samNoise(p)); }
`)
                .replace('#include <color_fragment>',
                    `#include <color_fragment>
{
  vec3 p = samObjPos * samScale + samSeed;
  float n = ${noiseFn}(p);
  if (samBands > 0.5) n = floor(n * samBands) / samBands;
  // amp come CONTRASTO centrato: il rumore si allontana da 0.5 in entrambi i
  // versi. La vecchia formula (n * amp * 2) su un fbm - che sta quasi sempre
  // fra 0.25 e 0.75 - dava una banda strettissima, e a valori bassi la
  // variazione era invisibile: la superficie sembrava tinta piatta e si
  // concludeva che il rumore non funzionasse.
  float t = clamp(0.5 + (n - 0.5) * samAmp * 3.0, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, samCol2, t);
}
`);
            // La ruvidita' variabile e' cio' che distingue una superficie usata
            // da una verniciata a spruzzo: senza, il riflesso e' uniforme su
            // tutto il pezzo e il materiale sembra plastica.
            if (shader.fragmentShader.indexOf('#include <roughnessmap_fragment>') >= 0) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <roughnessmap_fragment>',
                    `#include <roughnessmap_fragment>
{
  float rn = ${noiseFn}(samObjPos * samScale * 1.7 + samSeed + 3.1);
  roughnessFactor = clamp(roughnessFactor + (rn - 0.5) * samRoughAmp, 0.03, 1.0);
}
`);
            }
        };
        mat.customProgramCacheKey = () => key;
    }

    mat.userData.samDef = def;
    mat.userData.samStyle = style;
    _matCache.set(key, mat);
    return mat;
}

function clearMaterialCache() {
    for (const m of _matCache.values()) {
        if (m && m.dispose) m.dispose();
    }
    _matCache.clear();
}

function meshToThree(mesh, mats, style) {
    if (meshIsEmpty(mesh)) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
        mesh.pos instanceof Float32Array ? mesh.pos : new Float32Array(mesh.pos), 3));
    geo.setIndex(new THREE.BufferAttribute(
        mesh.idx instanceof Uint32Array ? mesh.idx : new Uint32Array(mesh.idx), 1));
    const normals = meshNormals(mesh);
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    const def = (mats && mesh.mat && mats[mesh.mat]) || { col: '#CCCCCC' };
    const mat = buildMaterial(def, style);
    const obj = new THREE.Mesh(geo, mat);
    obj.name = mesh.name || '';
    obj.userData.samMat = mesh.mat || '';
    obj.userData.samBone = mesh.bone || '';
    obj.castShadow = true;
    obj.receiveShadow = true;
    return obj;
}
