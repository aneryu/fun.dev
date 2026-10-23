// One trusted built-in TSL effect. Assets supply parameters; the application
// explicitly registers this module. No code is loaded or evaluated from assets.
export const RIPPLE_ID = 'fun3d.ripple';
export const RIPPLE_CONTRACT = Object.freeze({ id: RIPPLE_ID, version: 1, backends: ['webgpu', 'webgl'], tiers: ['low', 'high'], resources: ['material'], fallback: ['base', 'reject'],
  parameters: { material: 'material ID', amplitude: [0,10], frequency: [.1,100], speed: [-10,10], color: '#rrggbb' } });
export function normalizeRipple(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['version','material','amplitude','frequency','speed','color','fallback'].includes(k))) throw new TypeError('Invalid ripple parameters');
  if (value.version !== 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.material)) throw new TypeError('Invalid ripple version/material');
  const result = {version:1,material:value.material,color:value.color??'#4ba3c7',fallback:value.fallback??'reject'};
  if(!/^#[a-f\d]{6}$/i.test(result.color)||!['base','reject'].includes(result.fallback))throw new TypeError('Invalid ripple color/fallback');
  for(const [key,min,max,defaultValue] of [['amplitude',0,10,1],['frequency',.1,100,8],['speed',-10,10,2]]){
    const n=value[key]??defaultValue;if(!Number.isFinite(n)||n<min||n>max)throw new TypeError(`Invalid ripple ${key}`);result[key]=n;
  }
  return result;
}
export function createRippleExtension({ THREE, TSL, backend }) {
  return {
    id:RIPPLE_ID,version:1,validate:normalizeRipple,
    attach(model, input) {
      const spec=normalizeRipple(input), found=new Set();
      model.root.traverse(o=>{for(const m of [o.material??[]].flat())if(m.userData?.fun3d?.id===spec.material)found.add(m);});
      if(!found.size)throw new Error(`Missing ripple material ${spec.material}`);
      if(!RIPPLE_CONTRACT.backends.includes(backend)||!TSL||[...found].some(m=>!m.isNodeMaterial)) {
        if(spec.fallback==='reject')throw new Error(`Ripple unsupported on backend ${backend}`);
        model.warnings.push(`Ripple ${spec.material}: base-material fallback on ${backend}`);
        return {status:'unsupported',update(){},dispose(){}};
      }
      const time=TSL.uniform(0),previous=new Map();let disposed=false;
      const descriptor=model.materials.get(spec.material),priorFeature=descriptor.features[RIPPLE_ID];
      descriptor.features[RIPPLE_ID]=spec; // keep this material out of generic batching
      const wave=TSL.positionLocal.xz.length().mul(spec.frequency).sub(time.mul(spec.speed)).sin().mul(.5).add(.5).mul(spec.amplitude);
      const glow=TSL.vec3(...new THREE.Color(spec.color).toArray()).mul(wave);
      for(const m of found){previous.set(m,m.emissiveNode);m.emissiveNode=(m.emissiveNode??TSL.materialEmissive).add(glow);m.needsUpdate=true;}
      return {status:'pass',uniforms:{time},update(seconds){if(disposed)throw new Error('Ripple disposed');if(!Number.isFinite(seconds)||seconds<0)throw new TypeError('Invalid ripple time');time.value=seconds;},
        dispose(){if(disposed)return;disposed=true;for(const [m,node] of previous){m.emissiveNode=node;m.needsUpdate=true;}previous.clear();if(priorFeature===undefined)delete descriptor.features[RIPPLE_ID];else descriptor.features[RIPPLE_ID]=priorFeature;}};
    },
  };
}
