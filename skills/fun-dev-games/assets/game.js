// Optional standalone bundle starter: copy this file as your game's game.js.
export function createGame({ THREE, scene, camera, canvas, signal, track, invalidate, reducedMotion }) {
  const geometry = track(new THREE.BoxGeometry(1.4, 1.4, 1.4));
  const material = track(new THREE.MeshStandardMaterial({ color: 0x9c3a12, roughness: 0.7 }));
  const cube = new THREE.Mesh(geometry, material);
  const light = new THREE.HemisphereLight(0xffffff, 0x5c5133, 3);
  scene.background = new THREE.Color(0xffd43b);
  scene.add(cube, light);
  let turns = 0, moving = false, paused = true, locale = 'en';
  function labels() {
    canvas.setAttribute('aria-label', locale === 'zh' ? `点击或按空格旋转。已旋转 ${turns} 次` : `Click or press Space to rotate. ${turns} turns`);
  }
  function turn() {if (paused) return; turns++;moving = true;labels();invalidate();}
  canvas.addEventListener('click',turn,{signal});
  canvas.addEventListener('keydown',event=>{
    if ((event.code === 'Space' || event.code === 'Enter') && !event.repeat) {event.preventDefault();turn();}
  },{signal});
  return {
    renderMode: 'on-demand',
    update(delta) {
      const target = turns * Math.PI / 2;
      cube.rotation.x = 0.4;
      cube.rotation.y = reducedMotion ? target : THREE.MathUtils.damp(cube.rotation.y, target, 12, delta);
      moving = Math.abs(cube.rotation.y - target) > 0.001;
      if (!moving) cube.rotation.y = target;
      return moving;
    },
    resize({width,height}) {camera.position.z = 4 / Math.min(1,width/height);},
    pause() {paused = true;},
    resume() {paused = false;},
    localeChanged(value) {locale = value;labels();},
    dispose() {scene.remove(cube,light);},
  };
}
