// Bounded app orchestration, separate from model/World data. No DOM or code strings.
export function createTimeline(config, bindings) {
  if (config?.version !== 1 || !Number.isFinite(config.duration) || config.duration <= 0 || config.duration > 3600) throw new TypeError('Invalid timeline duration/version');
  const spec = structuredClone(config);
  if (!Array.isArray(spec.tracks) || spec.tracks.length > 128 || !Array.isArray(spec.events ?? [])) throw new TypeError('Invalid timeline tracks/events');
  const unique = new Set();
  for (const track of spec.tracks) {
    const id = `${track.target}:${track.property}`;
    if (unique.has(id) || !bindings[track.target] || !['position', 'rotation', 'scale'].includes(track.property)) throw new TypeError(`Invalid timeline binding ${id}`);
    unique.add(id);
    if (!Array.isArray(track.keys) || !track.keys.length || track.keys.length > 4096) throw new TypeError('Invalid keys');
    let previous = -1;
    for (const key of track.keys) {
      if (!Number.isFinite(key.time) || key.time < 0 || key.time > spec.duration || key.time <= previous || !Array.isArray(key.value) || key.value.length !== 3 || key.value.some(v => !Number.isFinite(v))) throw new TypeError('Invalid key time/value');
      previous = key.time;
    }
  }
  const events = spec.events ?? [];
  if (events.length > 4096 || events.some(e => !Number.isFinite(e.time) || e.time < 0 || e.time > spec.duration || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(e.key) || !['string','number','boolean'].includes(typeof e.value) || (typeof e.value === 'number' && !Number.isFinite(e.value)))) throw new TypeError('Invalid state event');
  events.sort((a,b)=>a.time-b.time);
  let time = 0, playing = false, disposed = false, state = {};
  function sample(value) {
    if (disposed) throw new Error('Timeline is disposed');
    if (!Number.isFinite(value) || value < 0 || value > spec.duration) throw new RangeError('Time is outside the timeline');
    time = value;
    for (const track of spec.tracks) {
      const a = track.keys.findLast(k => k.time <= time) ?? track.keys[0];
      const b = track.keys.find(k => k.time > time) ?? a;
      const t = a === b || time < a.time ? 0 : (time - a.time) / (b.time - a.time);
      bindings[track.target][track.property].fromArray(a.value.map((v,i)=>v + (b.value[i]-v)*t));
    }
    state = Object.fromEntries(events.filter(e=>e.time<=time).map(e=>[e.key,e.value]));
    return snapshot();
  }
  const snapshot = () => ({ time, playing, state: { ...state }, duration: spec.duration, seek: true });
  sample(0);
  return { snapshot, seek: sample,
    play() { if (disposed) throw new Error('Timeline is disposed'); playing = true; },
    pause() { playing = false; }, reset() { playing = false; return sample(0); },
    update(dt) { if (!Number.isFinite(dt) || dt < 0) throw new TypeError('Invalid delta'); if (playing) { sample(Math.min(spec.duration, time + dt)); if (time === spec.duration) playing = false; } return snapshot(); },
    dispose() { playing = false; disposed = true; },
  };
}
