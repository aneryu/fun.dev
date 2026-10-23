// Shared by classic and TSL material consumers. Hosts may explicitly refuse or
// downgrade transmission; no renderer feature silently disappears.
export function applyTransmission(material, desc, policy, warn) {
  const spec = desc.features.transmission;
  if (!spec) return;
  if (!['physical', 'opaque', 'reject'].includes(policy)) throw new TypeError('Invalid transmission policy');
  if (policy === 'reject') throw new Error(`material "${desc.id}": transmission refused by host policy`);
  if (policy === 'opaque') {
    warn(`material "${desc.id}": transmission downgraded to opaque by host policy`);
    return;
  }
  if (!('transmission' in material)) throw new Error(`material "${desc.id}": physical transmission unavailable`);
  material.transmission = spec.amount ?? 1;
  material.ior = spec.ior ?? 1.5;
  material.thickness = spec.thickness ?? 0;
  material.attenuationColor.set(spec.attenuation ?? '#ffffff');
  material.attenuationDistance = spec.attenuationDistance || Infinity;
}
