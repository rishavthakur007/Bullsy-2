/* Bullsy 3D market (three.js). Decoration only (clouds, coins, mascots) uses
   randomness; tower heights and colours are set from real index data by sync(). */
/* ================= 3D world ================= */
const World = (() => {
  const cv = $('#c3d'), stage = $('#stage'), reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TAU = Math.PI * 2;
  let ok = false, R, scene, cam, bull, bear, ring, coinGeo, goldMat, redMat, ray, towers = {}, extras = [], clouds = [], burst = [], onPick = null, onHover = null;
  let theta = .7, thetaTo = null, idle = 9, drag = null, moved = 0, ptr = null, hoverId = null, last = 0, time = 0, shakeT = 0, vy = 0, by = 0, bearVy = 0, bearY = 0, sadT = 0, zoom = 0, zoomTo = 0, dist = 1, distTo = 1, cw = 0, ch = 0;

  const mat = (color, o) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: .6 }, o || {}));
  function box(w, h, d, color, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color)); m.position.set(x, y, z); return m; }
  function makeBull() {
    const g = new THREE.Group(), body = 0xFF8A1F, dark = 0xB85A0A, cream = 0xFFF6E5, ink = 0x120E33, pink = 0xFF8FB1;
    [box(2.2, 1.3, 1.2, body, 0, 1.5, 0), box(1, 1, 1, body, 1.5, 2.05, 0), box(.5, .5, .7, cream, 2.1, 1.85, 0),
     box(.36, .9, .36, dark, .75, .45, .4), box(.36, .9, .36, dark, .75, .45, -.4), box(.36, .9, .36, dark, -.75, .45, .4), box(.36, .9, .36, dark, -.75, .45, -.4),
     box(.06, .16, .16, ink, 2.01, 2.3, .28), box(.06, .16, .16, ink, 2.01, 2.3, -.28), box(.05, .16, .12, pink, 2.01, 2.02, .44), box(.05, .16, .12, pink, 2.01, 2.02, -.44)].forEach(m => g.add(m));
    const tail = box(.12, .8, .12, dark, -1.25, 1.6, 0); tail.rotation.z = -.5; g.add(tail);
    [.42, -.42].forEach(z => { const h = new THREE.Mesh(new THREE.ConeGeometry(.15, .7, 8), mat(cream)); h.position.set(1.5, 2.85, z); h.rotation.x = z > 0 ? .45 : -.45; g.add(h); });
    const nose = new THREE.Mesh(new THREE.TorusGeometry(.13, .035, 8, 18), mat(0xFFB627, { metalness: .6, roughness: .3 })); nose.position.set(2.37, 1.68, 0); nose.rotation.y = Math.PI / 2; g.add(nose);
    return g;
  }
  function makeBear() {
    const g = new THREE.Group(), fur = 0x8B5E3C, dark = 0x5E3D24, cream = 0xF3D9B1, ink = 0x120E33;
    [box(1.5, 1.6, 1.3, fur, 0, 1.1, 0), box(1.1, 1, 1.1, fur, .25, 2.4, 0), box(.4, .4, .5, cream, .95, 2.25, 0), box(.3, .3, .3, dark, .25, 3, .42), box(.3, .3, .3, dark, .25, 3, -.42),
     box(.4, .9, .35, dark, .55, 1.2, .78), box(.4, .9, .35, dark, .55, 1.2, -.78), box(.55, .35, .45, dark, .5, .18, .4), box(.55, .35, .45, dark, .5, .18, -.4),
     box(.06, .14, .14, ink, .81, 2.6, .28), box(.06, .14, .14, ink, .81, 2.6, -.28), box(.12, .12, .16, ink, 1.16, 2.35, 0)].forEach(m => g.add(m));
    g.scale.set(.8, .8, .8); return g;
  }
  function label(txt, big) {
    const c = document.createElement('canvas'); c.width = big ? 512 : 256; c.height = big ? 96 : 80; const x = c.getContext('2d'), mid = c.width / 2;
    x.font = '700 ' + (big ? 46 : 38) + 'px "Baloo 2", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    const w = Math.min(c.width - 6, x.measureText(txt).width + 34);
    x.fillStyle = big ? 'rgba(255,246,229,.92)' : 'rgba(18,14,51,.8)'; x.fillRect(mid - w / 2, 10, w, c.height - 22);
    x.fillStyle = big ? '#120E33' : '#FFF6E5'; x.fillText(txt, mid, c.height / 2 + 2, c.width - 20);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    s.scale.set(big ? 6 : 2.7, big ? 1.12 : .84, 1); return s;
  }
  function hit(x, y) {
    const r = cv.getBoundingClientRect(); ray.setFromCamera(new THREE.Vector2((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1), cam);
    const list = []; Object.keys(towers).forEach(k => { list.push(towers[k].body); list.push(towers[k].roof); });
    const h = ray.intersectObjects(list)[0]; return h ? h.object.userData.id : null;
  }
  function init(pick, hover) {
    onPick = pick; onHover = hover;
    try {
      if (!window.THREE) throw new Error('three.js did not load');
      R = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
      R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); R.setClearColor(0x000000, 0);
      scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x4B2A8A, 34, 85);
      cam = new THREE.PerspectiveCamera(46, 2, .1, 300); ray = new THREE.Raycaster();
      scene.add(new THREE.HemisphereLight(0xD9D0FF, 0x3A2A7A, 1));
      const sun = new THREE.DirectionalLight(0xFFD0A0, 1.1); sun.position.set(8, 14, 6); scene.add(sun);
      const ground = new THREE.Mesh(new THREE.CylinderGeometry(14, 14.8, .6, 64), mat(0x2F2580, { roughness: .9 })); ground.position.y = -.3; scene.add(ground);
      const lawn = new THREE.Mesh(new THREE.CylinderGeometry(13.3, 13.3, .06, 64), mat(0x3B309C, { roughness: .9 })); lawn.position.y = .02; scene.add(lawn);
      const path = new THREE.Mesh(new THREE.TorusGeometry(8.2, .05, 6, 80), new THREE.MeshBasicMaterial({ color: 0x8C7FF0 })); path.rotation.x = Math.PI / 2; path.position.y = .07; scene.add(path);
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.6, .4, 32), mat(0xFFB627, { roughness: .4, metalness: .3 })); ped.position.y = .25; scene.add(ped);
      bull = makeBull(); scene.add(bull);
      bear = makeBear(); bear.visible = false; scene.add(bear);
      const moon = new THREE.Mesh(new THREE.SphereGeometry(3.4, 24, 16), new THREE.MeshBasicMaterial({ color: 0xFFF3C9, fog: false })); moon.position.set(-36, 26, -40); scene.add(moon);
      const pts = []; for (let i = 0; i < 320; i++) { const a = Math.random() * TAU, e = Math.random() * 1.2 + .25; pts.push(Math.cos(a) * Math.cos(e) * 95, Math.sin(e) * 95, Math.sin(a) * Math.cos(e) * 95); }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xFFF6E5, size: .5, fog: false })));
      const puff = new THREE.SphereGeometry(1, 10, 8), cloudMat = mat(0xFFE9F3, { roughness: 1, transparent: true, opacity: .93, fog: false });
      for (let i = 0; i < 7; i++) {
        const g = new THREE.Group();
        [[0, 0, 0, 1.5], [1.4, -.2, .2, 1.1], [-1.4, -.25, -.1, 1], [.4, .5, 0, 1]].forEach(p => { const m = new THREE.Mesh(puff, cloudMat); m.position.set(p[0], p[1], p[2]); m.scale.set(p[3], p[3] * .7, p[3]); g.add(m); });
        scene.add(g); clouds.push({ g, a: i / 7 * TAU + Math.random(), r: 17 + Math.random() * 9, y: 9 + Math.random() * 6, sp: .02 + Math.random() * .04 });
      }
      const leaf = [0x3DDC97, 0xFF8FB1, 0x7BE0C3];
      for (let k = 0; k < 5; k++) [-.2, 0, .2].forEach((off, j) => {
        const a = (k + .5) / 5 * TAU + off, t = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(.12, .16, .7, 8), mat(0x7A4A2A)); trunk.position.y = .35;
        const crown = new THREE.Mesh(new THREE.ConeGeometry(.65, 1.4, 7), mat(leaf[(k + j) % 3])); crown.position.y = 1.35;
        t.add(trunk); t.add(crown); t.position.set(Math.cos(a) * 11.6, .05, Math.sin(a) * 11.6); scene.add(t);
      });
      ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, .1, 8, 36), new THREE.MeshBasicMaterial({ color: 0xFFB627 })); ring.rotation.x = Math.PI / 2; ring.position.y = .16; ring.visible = false; scene.add(ring);
      coinGeo = new THREE.CylinderGeometry(.42, .42, .1, 20); goldMat = mat(0xFFB627, { metalness: .6, roughness: .3, emissive: 0x6B4A00 }); redMat = mat(0xFF6B81, { roughness: .4, emissive: 0x7A1F30 });
      for (let i = 0; i < 20; i++) { const m = new THREE.Mesh(coinGeo, goldMat); m.scale.set(.5, .5, .5); m.visible = false; scene.add(m); burst.push({ m, v: [0, 0, 0] }); }
      cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, t: theta }; moved = 0; idle = 0; thetaTo = null; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
      cv.addEventListener('pointermove', e => {
        if (drag) { const dx = e.clientX - drag.x; moved = Math.max(moved, Math.abs(dx) + Math.abs(e.clientY - drag.y)); theta = drag.t + dx * .008; idle = 0; }
        else ptr = { x: e.clientX, y: e.clientY, dirty: true };
      });
      cv.addEventListener('pointerup', e => { if (!drag) return; drag = null; if (moved < 7) { const id = hit(e.clientX, e.clientY); if (id && onPick) { focus(id); onPick(id); } } });
      cv.addEventListener('pointercancel', () => { drag = null; });
      cv.addEventListener('pointerleave', () => { ptr = null; hoverId = null; cv.style.cursor = 'grab'; if (onHover) onHover(null); });
      ok = true; requestAnimationFrame(loop);
    } catch (e) { ok = false; stage.classList.add('no3d'); }
  }
  function clear() {
    if (!ok) return;
    Object.keys(towers).forEach(k => scene.remove(towers[k].g)); extras.forEach(o => scene.remove(o));
    towers = {}; extras = []; ring.visible = false; bear.visible = false; hoverId = null; stage.classList.remove('storm');
  }
  /* items: [{ id, label, color }] - one tower per index, evenly spaced */
  function build(items) {
    if (!ok) return; clear();
    items.forEach((a, i) => {
      const ang = i / items.length * TAU, x = Math.cos(ang) * 8.2, z = Math.sin(ang) * 8.2;
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, .1, 30), mat(a.color, { transparent: true, opacity: .45 })); pad.position.set(x, .1, z); scene.add(pad); extras.push(pad);
      const g = new THREE.Group(); g.position.set(x, .15, z);
      const geo = new THREE.BoxGeometry(1.7, 1, 1.7); geo.translate(0, .5, 0);
      const body = new THREE.Mesh(geo, mat(a.color, { roughness: .5, metalness: .1 })); body.userData.id = a.id;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.45, 1, 4), mat(0xFFF6E5, { roughness: .5 })); roof.rotation.y = Math.PI / 4; roof.userData.id = a.id;
      const cg = new THREE.Group(), coin = new THREE.Mesh(coinGeo, goldMat); coin.rotation.x = Math.PI / 2; cg.add(coin); cg.visible = false;
      const sh = new THREE.Mesh(new THREE.ConeGeometry(.42, .85, 14), redMat); sh.rotation.x = Math.PI; sh.visible = false;
      const lb = label(a.label, true); lb.scale.set(4.6, .86, 1);
      g.add(body); g.add(roof); g.add(cg); g.add(sh); g.add(lb); scene.add(g);
      towers[a.id] = { g, body, roof, cg, sh, lb, ang, h: .1, to: 2, s: 1, flash: 0, fc: new THREE.Color(0x000000), ph: i };
    });
  }
  /* Tower height shows REAL performance. items: [{ id, perf, last, pos }]
     perf = real % change being shown (null when the index has no data),
     last = real % move of the round that just ended (for the flash), pos = units held (+long, -short).
     perPct = tower height added per 1% of real change. */
  function sync(items, sel, flash, perPct) {
    if (!ok) return; let anyShort = false;
    items.forEach(a => {
      const t = towers[a.id]; if (!t) return; if (a.pos < 0) anyShort = true;
      t.to = a.perf == null ? .8 : Math.max(.6, Math.min(9, 3 + a.perf * perPct));
      t.cg.visible = a.pos > 0; t.sh.visible = a.pos < 0;
      t.roof.material.color.setHex(a.perf == null ? 0x8C7FF0 : a.perf >= 0 ? 0x2EE6A6 : 0xFF6B81);
      if (flash && a.last != null) { t.flash = 1; t.fc.setHex(a.last >= 0 ? 0x2EE6A6 : 0xFF6B81); }
      if (a.id === sel) { ring.visible = true; ring.position.x = t.g.position.x; ring.position.z = t.g.position.z; }
    });
    bear.visible = anyShort;
  }
  function focus(id) { if (ok && towers[id]) { thetaTo = towers[id].ang; idle = 0; } }
  function spray(x, y, z) { if (!ok || reduce) return; burst.forEach(b => { b.m.visible = true; b.m.position.set(x, y, z); b.v = [(Math.random() - .5) * 6, 5 + Math.random() * 5, (Math.random() - .5) * 6]; }); }
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(.05, (now - last) / 1000 || 0); last = now; time += dt; idle += dt;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (w && h && (w !== cw || h !== ch)) { cw = w; ch = h; R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    if (thetaTo != null) { let d = (thetaTo - theta) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; theta += d * Math.min(1, dt * 3); if (Math.abs(d) < .01) thetaTo = null; }
    else if (!drag && !reduce && idle > 3) theta += dt * .08;
    zoom += (zoomTo - zoom) * Math.min(1, dt * 2.5); dist += (distTo - dist) * Math.min(1, dt * 5);
    const k = 1 + (dist - 1) * zoom, rad = (8.5 + zoom * (cam.aspect < 1 ? 17 : 12.5)) * k, hgt = (3.6 + zoom * 6.6) * k, look = 1.7 + zoom * 1.2;
    shakeT *= Math.pow(.05, dt);
    const sx = reduce ? 0 : (Math.random() - .5) * shakeT, sy = reduce ? 0 : (Math.random() - .5) * shakeT;
    cam.position.set(Math.cos(theta) * rad + sx, hgt + sy, Math.sin(theta) * rad); cam.lookAt(0, look, 0);
    if (ptr && ptr.dirty && !drag) { ptr.dirty = false; const id = hit(ptr.x, ptr.y); hoverId = id; cv.style.cursor = id ? 'pointer' : 'grab'; if (onHover) onHover(id, ptr.x, ptr.y); }
    vy -= 22 * dt; by = Math.max(0, by + vy * dt); if (by === 0) vy = 0;
    bearVy -= 22 * dt; bearY = Math.max(0, bearY + bearVy * dt); if (bearY === 0) bearVy = 0;
    sadT *= Math.pow(.25, dt);
    bull.position.y = .45 + by + (reduce ? 0 : Math.sin(time * 2) * .04);
    bull.rotation.y = -theta + .6; bull.rotation.z = reduce ? 0 : Math.sin(time * 26) * .07 * sadT;
    bear.position.set(Math.cos(theta + 1.1) * 3.6, .05 + bearY, Math.sin(theta + 1.1) * 3.6); bear.rotation.y = -theta + .2;
    clouds.forEach(c => { if (!reduce) c.a += dt * c.sp; c.g.position.set(Math.cos(c.a) * c.r, c.y, Math.sin(c.a) * c.r); });
    Object.keys(towers).forEach(id => {
      const t = towers[id]; t.h += (t.to - t.h) * Math.min(1, dt * 3.5); t.s += ((id === hoverId ? 1.16 : 1) - t.s) * Math.min(1, dt * 10);
      t.g.scale.set(t.s, 1, t.s); t.body.scale.y = t.h; t.roof.position.y = t.h + .5; t.lb.position.y = t.h + 1.55;
      const bob = t.h + 2.75 + Math.sin(time * 2 + t.ph) * .12;
      t.cg.position.y = bob; t.cg.rotation.y += dt * 2.2; t.sh.position.y = bob; t.sh.rotation.y += dt * 2.2;
      t.flash *= Math.pow(.3, dt); t.body.material.emissive.copy(t.fc).multiplyScalar(t.flash * .7);
    });
    burst.forEach(b => { if (!b.m.visible) return; b.v[1] -= 16 * dt; b.m.position.x += b.v[0] * dt; b.m.position.y += b.v[1] * dt; b.m.position.z += b.v[2] * dt; b.m.rotation.x += dt * 9; b.m.rotation.z += dt * 7; if (b.m.position.y < 0) b.m.visible = false; });
    R.render(scene, cam);
  }
  return { init, build, clear, sync, focus,
    coins(id) { const t = towers[id]; if (t) spray(t.g.position.x, t.h + 1.5, t.g.position.z); },
    celebrate() { spray(0, 3.2, 0); vy = 9; },
    jump() { vy = 8; }, bearJump() { bearVy = 7; }, sad() { sadT = 1; }, shake() { shakeT = 1.2; },
    storm(on) { stage.classList.toggle('storm', !!on); }, wide(on) { zoomTo = on ? 1 : 0; distTo = 1; },
    zoomBy(d) { distTo = Math.max(.55, Math.min(1.45, distTo + d)); idle = 0; } };
})();

