(() => {
'use strict';

/* ============================================================
   RANGE // 靶场
   ============================================================ */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp  = (a, b, t) => a + (b - a) * t;
const rand  = (a, b) => a + Math.random() * (b - a);
const now   = () => performance.now();
const TAU   = Math.PI * 2;
const DEG   = Math.PI / 180;

/* ------------------------------------------------------------
   设置
   ------------------------------------------------------------ */
const SKEY = 'range.settings.v1';
const SDEF = { dpi: 800, csSens: 2.0, fov: 72, volume: 0.75, invertY: false, tier: 'std' };
let S = Object.assign({}, SDEF);
try { Object.assign(S, JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch (e) {}
const saveS = () => { try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch (e) {} };

// CS 的 yaw 常数是 0.022 度 / count（灵敏度 1）
const degPerCount = () => 0.022 * S.csSens;
const cm360 = () => 360 * 2.54 / (0.022 * S.csSens * S.dpi);

/* ------------------------------------------------------------
   音频（全部 WebAudio 合成，不依赖音频文件）
   ------------------------------------------------------------ */
const SFX = (() => {
  let ac = null, master = null, rev = null, revSend = null, noise = null, amb = null;
  const buf = {};        // 真实采样（CC0 单发），没有就走纯合成
  let loaded = false;
  const SAMPLE_FILE = { usp: 'audio/shot-usp.wav', ak: 'audio/shot-ak.wav', awm: 'audio/shot-awm.wav' };

  function makeNoise(sec) {
    const n = Math.floor(ac.sampleRate * sec);
    const b = ac.createBuffer(1, n, ac.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function makeIR(sec, decay) {
    const n = Math.floor(ac.sampleRate * sec);
    const b = ac.createBuffer(2, n, ac.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 200 ? i / 200 : 1);
      }
    }
    return b;
  }

  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = S.volume;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 22; comp.ratio.value = 7;
    comp.attack.value = 0.002; comp.release.value = 0.18;
    master.connect(comp); comp.connect(ac.destination);

    rev = ac.createConvolver();
    rev.buffer = makeIR(1.5, 2.6);
    revSend = ac.createGain();
    revSend.gain.value = 0.85;
    rev.connect(revSend); revSend.connect(master);

    noise = makeNoise(2.0);
    loadSamples();
  }

  /* 真实采样：异步拉取，失败就静默降级成合成音 */
  function loadSamples() {
    if (loaded) return;
    loaded = true;
    Object.keys(SAMPLE_FILE).forEach((k) => {
      fetch(SAMPLE_FILE[k])
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
        .then((ab) => new Promise((res, rej) => ac.decodeAudioData(ab, res, rej)))
        .then((b) => { buf[k] = b; })
        .catch(() => { buf[k] = null; });
    });
  }

  /* 把采样叠在合成层上：轻微变速 + 低通，避免每次一模一样 */
  function sampleShot(gun, t, gain) {
    const b = buf[gun];
    if (!b) return;
    const src = ac.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rand(0.96, 1.04);
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = gun === 'awm' ? 9000 : 12000;
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
  }

  function env(g, t, peak, attack, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function click(t, freq, gain, dur, q) {
    const src = ac.createBufferSource(); src.buffer = noise;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = freq; bp.Q.value = q || 3;
    const g = ac.createGain(); env(g, t, gain, 0.002, dur);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  function tone(t, freq, dur, gain, type, endFreq) {
    const o = ac.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ac.createGain(); env(g, t, gain, 0.004, dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function shot(gun) {
    init(); if (!ac) return;
    const t = ac.currentTime;
    const cfg = {
      usp: { dur: 0.085, lp: 2800, g: 0.20, thump: 0.10, f0: 140, f1: 90, send: 0.25, crack: 0.0 },
      ak:  { dur: 0.20,  lp: 3600, g: 0.40, thump: 0.45, f0: 120, f1: 48, send: 0.55, crack: 0.18 },
      awm: { dur: 0.58,  lp: 2100, g: 0.48, thump: 0.65, f0: 95,  f1: 34, send: 0.95, crack: 0.0 }
    }[gun];

    const src = ac.createBufferSource(); src.buffer = noise; src.loop = true;
    src.playbackRate.value = rand(0.92, 1.08);
    const f = ac.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(cfg.lp, t);
    f.frequency.exponentialRampToValueAtTime(cfg.lp * 0.28, t + cfg.dur);
    const g = ac.createGain(); env(g, t, cfg.g, 0.003, cfg.dur);
    src.connect(f); f.connect(g); g.connect(master);
    if (cfg.send > 0) { const sg = ac.createGain(); sg.gain.value = cfg.send; g.connect(sg); sg.connect(rev); }
    src.start(t); src.stop(t + cfg.dur + 0.03);

    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(cfg.f0, t);
    o.frequency.exponentialRampToValueAtTime(cfg.f1, t + cfg.dur * 0.9);
    const og = ac.createGain(); env(og, t, cfg.thump, 0.002, cfg.dur);
    o.connect(og); og.connect(master); o.start(t); o.stop(t + cfg.dur + 0.02);

    if (cfg.crack > 0) click(t, 5200, cfg.crack, 0.03, 1.2);
    if (gun === 'usp') click(t + 0.012, 2600, 0.10, 0.05, 2.5);

    // 真实枪口瞬态（CC0 采样）压在上面
    sampleShot(gun, t, { usp: 0.42, ak: 0.52, awm: 0.60 }[gun]);
  }

  function hit(head) {
    init(); if (!ac) return;
    const t = ac.currentTime;
    if (head) { tone(t, 2500, 0.13, 0.15, 'sine'); tone(t + 0.04, 3500, 0.10, 0.10, 'sine'); }
    else { tone(t, 1450, 0.07, 0.10, 'sine'); }
  }
  function kill() {
    init(); if (!ac) return;
    const t = ac.currentTime;
    tone(t, 200, 0.16, 0.16, 'triangle', 120);
    tone(t + 0.02, 1600, 0.10, 0.07, 'sine');
  }
  function reload() {
    init(); if (!ac) return;
    const t = ac.currentTime;
    click(t, 1800, 0.16, 0.04, 4);
    click(t + 0.35, 900, 0.13, 0.05, 3);
    click(t + 0.9, 2400, 0.12, 0.03, 5);
  }
  function bolt() {
    init(); if (!ac) return;
    const t = ac.currentTime;
    click(t, 2200, 0.10, 0.03, 5);
    click(t + 0.18, 1500, 0.09, 0.04, 4);
  }
  function empty() {
    init(); if (!ac) return;
    click(ac.currentTime, 3200, 0.12, 0.025, 6);
  }
  function equip() {
    init(); if (!ac) return;
    const t = ac.currentTime;
    click(t, 1200, 0.10, 0.04, 3);
    click(t + 0.09, 800, 0.07, 0.05, 3);
  }
  function shell() {
    init(); if (!ac) return;
    click(ac.currentTime + 0.15, 4800, 0.05, 0.02, 8);
  }
  /* 弹匣脱扣：金属卡笋"咔"一声，带一点点低频松动 */
  function magOut() {
    init(); if (!ac) return;
    const t = ac.currentTime;
    click(t, 1500, 0.15, 0.035, 3.5);
    tone(t + 0.01, 260, 0.05, 0.05, 'triangle', 190);
  }
  /* 弹匣推入到位：短、闷、有一点金属贴合 */
  function magIn() {
    init(); if (!ac) return;
    const t = ac.currentTime;
    click(t, 900, 0.17, 0.045, 2.2);
    click(t + 0.045, 2100, 0.10, 0.03, 5);
    tone(t, 190, 0.06, 0.06, 'triangle', 130);
  }
  /* 拉枪机 / 复进：比 bolt() 更慢更重，AK 用 */
  function charge() {
    init(); if (!ac) return;
    const t = ac.currentTime;
    click(t, 1300, 0.09, 0.03, 3);
    click(t + 0.11, 2600, 0.08, 0.028, 6);
    click(t + 0.30, 1700, 0.13, 0.04, 3);
  }
  function setVolume(v) { if (master) master.gain.setTargetAtTime(v, ac.currentTime, 0.03); }
  /* 调试用：看三个采样有没有真的载入（秒数，null＝没载入） */
  function sampleInfo() {
    return Object.keys(SAMPLE_FILE).map((k) => [k, buf[k] ? +buf[k].duration.toFixed(2) : null]);
  }
  function ambient(on) {
    init(); if (!ac || !on || amb) return;
    const src = ac.createBufferSource(); src.buffer = noise; src.loop = true;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 200;
    const g = ac.createGain(); g.gain.value = 0.016;
    src.connect(f); f.connect(g); g.connect(master); src.start();
    amb = g;
  }

  return { init, shot, hit, kill, reload, bolt, empty, equip, shell, setVolume, ambient, magOut, magIn, charge, sampleInfo };
})();

/* ------------------------------------------------------------
   材质
   ------------------------------------------------------------ */
const M = {
  metal:   new THREE.MeshStandardMaterial({ color: 0x2a2d32, metalness: 0.35, roughness: 0.52 }),
  dark:    new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.22, roughness: 0.62 }),
  black:   new THREE.MeshStandardMaterial({ color: 0x0a0b0d, metalness: 0.30, roughness: 0.55 }),
  wood:    new THREE.MeshStandardMaterial({ color: 0x60391e, metalness: 0.04, roughness: 0.72 }),
  woodDk:  new THREE.MeshStandardMaterial({ color: 0x3f2413, metalness: 0.04, roughness: 0.78 }),
  paper:   new THREE.MeshStandardMaterial({ color: 0xd9d3c2, metalness: 0.0,  roughness: 0.9, emissive: 0x141210, emissiveIntensity: 1.0 }),
  red:     new THREE.MeshStandardMaterial({ color: 0xb0372a, roughness: 0.72, emissive: 0x300806, emissiveIntensity: 0.6 }),
  brass:   new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.85, roughness: 0.28 }),
  glass:   new THREE.MeshStandardMaterial({ color: 0x86d6ff, metalness: 0.9, roughness: 0.12, emissive: 0x1b4c66, emissiveIntensity: 1.0 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.94, metalness: 0.04 }),
  crate:   new THREE.MeshStandardMaterial({ color: 0x5d4a30, roughness: 0.82, metalness: 0.05 }),
  steel:   new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.55, metalness: 0.5 })
};

/* ------------------------------------------------------------
   程序化纹理：木纹 + 金属磨损（压掉纯色塑料感，靠 map 相乘不换基色）
   ------------------------------------------------------------ */
(function buildGrainTextures() {
  function tex(size, rep, draw) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep[0], rep[1]);
    return t;
  }
  const wood = tex(128, [2, 1], (x, n) => {
    x.fillStyle = '#d6cec2'; x.fillRect(0, 0, n, n);
    for (let i = 0; i < 110; i++) {
      const gx = Math.random() * n;
      x.strokeStyle = 'rgba(96,68,42,' + (0.08 + Math.random() * 0.20).toFixed(3) + ')';
      x.lineWidth = 0.5 + Math.random() * 2.4;
      x.beginPath();
      let y = 0, px = gx;
      x.moveTo(px, y);
      while (y < n) { y += 7; px += (Math.random() - 0.5) * 3.2; x.lineTo(px, y); }
      x.stroke();
    }
    for (let i = 0; i < 500; i++) {
      x.fillStyle = 'rgba(56,36,20,' + (Math.random() * 0.14).toFixed(3) + ')';
      x.fillRect(Math.random() * n, Math.random() * n, 1 + Math.random() * 3, 1);
    }
  });
  const wear = tex(128, [2, 2], (x, n) => {
    x.fillStyle = '#e9e9e9'; x.fillRect(0, 0, n, n);
    for (let i = 0; i < 1600; i++) {
      const v = 198 + ((Math.random() * 57) | 0);
      x.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.5)';
      x.fillRect(Math.random() * n, Math.random() * n, 1, 1);
    }
    for (let i = 0; i < 70; i++) {
      x.strokeStyle = 'rgba(255,255,255,' + (0.25 + Math.random() * 0.45).toFixed(2) + ')';
      x.lineWidth = 0.4 + Math.random() * 1.1;
      const y = Math.random() * n, x0 = Math.random() * n;
      x.beginPath(); x.moveTo(x0, y); x.lineTo(x0 + (Math.random() - 0.5) * 26, y + (Math.random() - 0.5) * 6); x.stroke();
    }
  });
  M.wood.map = wood; M.woodDk.map = wood; M.crate.map = wood;
  M.metal.map = wear; M.dark.map = wear; M.black.map = wear; M.steel.map = wear;
  [M.wood, M.woodDk, M.crate, M.metal, M.dark, M.black, M.steel].forEach(m => { m.needsUpdate = true; });
})();

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function cyl(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  return m;
}
function zcyl(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 16) {
  const m = cyl(rt, rb, h, mat, x, y, z, seg);
  m.rotation.x = Math.PI / 2;
  return m;
}

/* ------------------------------------------------------------
   武器模型（程序化低模）
   ------------------------------------------------------------ */
function buildUsp() {
  const g = new THREE.Group();

  /* 套筒：主体 + 顶面薄板（打高光用）+ 前后准星 + 抛壳口 + 防滑纹 */
  g.add(box(0.046, 0.050, 0.240, M.metal, 0, 0.034, -0.075));
  g.add(box(0.038, 0.005, 0.236, M.steel, 0, 0.060, -0.075));
  g.add(box(0.009, 0.012, 0.013, M.black, 0, 0.071, -0.180));            // 前准星
  g.add(box(0.010, 0.011, 0.014, M.black, -0.014, 0.071, 0.008));        // 后准星左
  g.add(box(0.010, 0.011, 0.014, M.black, 0.014, 0.071, 0.008));         // 后准星右
  g.add(box(0.003, 0.019, 0.068, M.black, 0.023, 0.040, -0.055));        // 抛壳口
  for (let i = 0; i < 6; i++) {
    g.add(box(0.002, 0.032, 0.004, M.black, 0.024, 0.034, 0.010 + i * 0.009));
    g.add(box(0.002, 0.032, 0.004, M.black, -0.024, 0.034, 0.010 + i * 0.009));
  }
  g.add(box(0.014, 0.016, 0.012, M.black, 0, 0.058, 0.056));             // 击锤

  /* 套筒座 + 防尘盖 */
  g.add(box(0.042, 0.024, 0.190, M.dark, 0, 0.002, -0.055));
  g.add(box(0.039, 0.019, 0.088, M.dark, 0, -0.001, -0.128));

  /* 扳机护圈：三段围出开口，比一块平板好读 */
  g.add(box(0.030, 0.005, 0.078, M.dark, 0, -0.033, 0.012));             // 圈底
  g.add(box(0.030, 0.036, 0.006, M.dark, 0, -0.016, -0.024));            // 圈前
  const trigger = box(0.010, 0.024, 0.008, M.metal, 0, -0.016, 0.000);
  trigger.rotation.x = 0.22; g.add(trigger);

  /* 握把：上段骨架 + 下段弹匣（可抽） */
  const gripFrame = box(0.046, 0.060, 0.078, M.dark, 0, -0.052, 0.048);
  gripFrame.rotation.x = -0.20; g.add(gripFrame);
  const panel = box(0.050, 0.052, 0.050, M.black, 0, -0.056, 0.050);
  panel.rotation.x = -0.20; g.add(panel);                                 // 握把防滑板
  const back = box(0.044, 0.084, 0.012, M.dark, 0, -0.050, 0.084);
  back.rotation.x = -0.20; g.add(back);                                   // 后背带

  const magGroup = new THREE.Group();
  magGroup.position.set(0, -0.075, 0.048);
  magGroup.rotation.x = -0.20;
  magGroup.add(box(0.044, 0.098, 0.066, M.dark, 0, -0.030, -0.012));
  magGroup.add(box(0.048, 0.010, 0.072, M.black, 0, -0.078, -0.014));    // 弹匣底板
  g.add(magGroup);

  /* 枪管 + 消音器 */
  g.add(zcyl(0.012, 0.012, 0.060, M.metal, 0, 0.034, -0.200, 16));
  g.add(zcyl(0.026, 0.026, 0.150, M.black, 0, 0.034, -0.290, 22));
  g.add(zcyl(0.024, 0.024, 0.008, M.steel, 0, 0.034, -0.368, 22));       // 消音器端盖

  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.034, -0.40); g.add(muzzle);
  const eject  = new THREE.Object3D(); eject.position.set(0.026, 0.048, -0.030); g.add(eject);
  return {
    group: g, muzzle, eject, scale: 0.55, mag: magGroup,
    grip: new THREE.Vector3(0, -0.112, 0.052),
    magA: new THREE.Vector3(0, -0.150, 0.058)
  };
}

function buildAk() {
  const g = new THREE.Group();
  g.add(box(0.062, 0.095, 0.34, M.metal, 0, 0.03, -0.05));
  g.add(box(0.064, 0.028, 0.30, M.dark, 0, 0.085, -0.06));       // dust cover
  g.add(box(0.072, 0.075, 0.23, M.wood, 0, 0.026, -0.32));       // handguard
  g.add(zcyl(0.017, 0.017, 0.40, M.dark, 0, 0.058, -0.60, 14));  // barrel
  g.add(zcyl(0.024, 0.024, 0.07, M.metal, 0, 0.058, -0.80, 14)); // muzzle nut
  g.add(box(0.012, 0.065, 0.014, M.black, 0, 0.10, -0.77));      // front sight
  g.add(box(0.034, 0.02, 0.02, M.black, 0, 0.094, -0.20));       // rear sight
  const stock = box(0.05, 0.082, 0.25, M.woodDk, 0, 0.012, 0.20);
  stock.rotation.x = -0.06; g.add(stock);
  g.add(box(0.052, 0.02, 0.06, M.dark, 0, 0.05, 0.33));
  const grip = box(0.045, 0.115, 0.055, M.woodDk, 0, -0.062, 0.055);
  grip.rotation.x = -0.28; g.add(grip);
  const magGroup = new THREE.Group();
  magGroup.position.set(0, -0.02, -0.085);
  const mag = box(0.048, 0.19, 0.075, M.dark, 0, -0.075, -0.015);
  mag.rotation.x = -0.30; magGroup.add(mag);
  const mag2 = box(0.048, 0.075, 0.07, M.dark, 0, -0.165, -0.070);
  mag2.rotation.x = -0.55; magGroup.add(mag2);
  g.add(magGroup);
  g.add(box(0.02, 0.004, 0.12, M.metal, 0, -0.036, -0.01));
  g.add(box(0.008, 0.03, 0.008, M.metal, 0, -0.02, -0.02));      // trigger

  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.058, -0.84); g.add(muzzle);
  const eject  = new THREE.Object3D(); eject.position.set(0.036, 0.06, -0.04); g.add(eject);
  return {
    group: g, muzzle, eject, scale: 0.50, mag: magGroup,
    grip: new THREE.Vector3(0, -0.070, 0.060),
    magA: new THREE.Vector3(0, -0.105, -0.090)
  };
}

function buildAwm() {
  const g = new THREE.Group();
  const olive   = new THREE.MeshStandardMaterial({ color: 0x424c30, roughness: 0.78, metalness: 0.08 });
  const oliveDk = new THREE.MeshStandardMaterial({ color: 0x2e3621, roughness: 0.85, metalness: 0.06 });
  const blued   = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.38, metalness: 0.62 });
  const matte   = new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.66, metalness: 0.25 });
  const magMat  = new THREE.MeshStandardMaterial({ color: 0x2c323a, roughness: 0.50, metalness: 0.55 });

  /* 程序化噪点贴图：轻微色斑，压掉纯色塑料感 */
  const grain = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 2600; i++) {
      const v = 176 + ((Math.random() * 78) | 0);
      x.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.55)';
      x.fillRect((Math.random() * 64) | 0, (Math.random() * 64) | 0, 1, 1);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 3);
    return t;
  })();
  [olive, oliveDk, blued, magMat].forEach(m => { m.map = grain; m.needsUpdate = true; });

  /* 枪托：侧视轮廓挤出，带拇指孔；厚度 0.046，四周倒角 */
  const prof = [
    [0.200,  0.048], [0.244,  0.058], [0.278,  0.076], [0.300,  0.090],
    [0.452,  0.092], [0.520,  0.080], [0.560,  0.062], [0.584,  0.024],
    [0.580, -0.030], [0.542, -0.068],
    [0.330, -0.052], [0.300, -0.028], [0.292, -0.104], [0.256, -0.112],
    [0.242, -0.058], [0.231, -0.008], [0.206,  0.002]
  ];
  const shape = new THREE.Shape(prof.map(p => new THREE.Vector2(p[0], p[1])));
  const hole = new THREE.Path();
  const hc = [0.288, 0.020], hr = [0.032, 0.018];
  for (let k = 0; k <= 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    const px = hc[0] + Math.cos(a) * hr[0], py = hc[1] + Math.sin(a) * hr[1];
    if (k === 0) hole.moveTo(px, py); else hole.lineTo(px, py);
  }
  shape.holes.push(hole);
  const stockGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.046, bevelEnabled: true, bevelSize: 0.0035, bevelThickness: 0.0035, bevelSegments: 1, curveSegments: 8
  });
  stockGeo.rotateY(-Math.PI / 2);
  stockGeo.translate(0.023, 0, 0);
  g.add(new THREE.Mesh(stockGeo, olive));
  const holeTube = cyl(0.0150, 0.0150, 0.050, M.black, 0, 0.020, 0.288, 16);
  holeTube.rotation.z = Math.PI / 2;
  holeTube.scale.set(1, 1, 1.0);
  holeTube.scale.x = 1.0;
  g.add(holeTube);

  /* 托底橡胶垫 */
  g.add(box(0.046, 0.050, 0.014, matte, 0, -0.003, 0.588));
  g.add(box(0.048, 0.054, 0.007, M.black, 0, -0.003, 0.598));

  /* 贴腮已并进枪托轮廓，这里只留两侧调节螺钉 */
  g.add(cyl(0.0050, 0.0050, 0.009, matte, 0.024, 0.068, 0.330, 10));
  g.add(cyl(0.0050, 0.0050, 0.009, matte, 0.024, 0.068, 0.410, 10));
  g.add(cyl(0.0050, 0.0050, 0.009, matte, -0.024, 0.068, 0.330, 10));
  g.add(cyl(0.0050, 0.0050, 0.009, matte, -0.024, 0.068, 0.410, 10));

  /* 枪管：细长哑光，口部只有台阶，无制退器 */
  g.add(box(0.052, 0.052, 0.115, blued, 0, 0.048, -0.108));            // 膛室
  g.add(zcyl(0.0135, 0.0165, 0.545, blued, 0, 0.048, -0.380, 18));     // 枪管
  g.add(zcyl(0.0175, 0.0175, 0.016, matte, 0, 0.048, -0.660, 16));     // 枪口台阶
  g.add(zcyl(0.0108, 0.0125, 0.010, matte, 0, 0.048, -0.672, 16));     // 枪口冠
  g.add(zcyl(0.0080, 0.0080, 0.006, M.black, 0, 0.048, -0.679, 14));   // 膛口
  g.add(box(0.011, 0.017, 0.020, matte, 0, 0.026, -0.500));            // 前吊环座

  /* 机匣 */
  g.add(box(0.062, 0.088, 0.330, oliveDk, 0, 0.010, 0.052));
  g.add(box(0.060, 0.026, 0.210, blued, 0, 0.044, 0.044));             // 上盖
  g.add(box(0.046, 0.007, 0.250, matte, 0, 0.058, 0.052));             // 导轨
  for (let i = 0; i < 8; i++) g.add(box(0.047, 0.005, 0.006, matte, 0, 0.063, -0.050 + i * 0.030));
  g.add(box(0.002, 0.040, 0.150, olive, 0.030, 0.010, 0.070));         // 侧面加强板
  g.add(cyl(0.006, 0.006, 0.062, blued, 0.031, 0.008, 0.070, 10));     // 侧面销

  /* 瞄准镜：后移下移，贴住导轨 */
  const SCZ = 0.018, SCY = 0.112;
  g.add(box(0.048, 0.024, 0.016, matte, 0, 0.070, SCZ - 0.118));       // 前镜座
  g.add(box(0.048, 0.024, 0.016, matte, 0, 0.070, SCZ + 0.112));       // 后镜座
  g.add(cyl(0.0245, 0.0245, 0.020, matte, 0, SCY, SCZ - 0.118, 18));   // 前镜环
  g.add(cyl(0.0245, 0.0245, 0.020, matte, 0, SCY, SCZ + 0.112, 18));   // 后镜环
  g.add(zcyl(0.0190, 0.0190, 0.290, blued, 0, SCY, SCZ, 22));          // 镜筒
  g.add(zcyl(0.0310, 0.0198, 0.092, blued, 0, SCY, SCZ - 0.190, 22));  // 物镜外扩
  g.add(zcyl(0.0322, 0.0322, 0.012, matte, 0, SCY, SCZ - 0.238, 22));  // 物镜口
  g.add(zcyl(0.0200, 0.0268, 0.082, blued, 0, SCY, SCZ + 0.168, 22));  // 目镜外扩
  g.add(zcyl(0.0280, 0.0280, 0.012, matte, 0, SCY, SCZ + 0.213, 22));  // 目镜口
  const capF = new THREE.Mesh(new THREE.CircleGeometry(0.0276, 22), M.black);
  capF.position.set(0, SCY, SCZ - 0.241); capF.rotation.y = Math.PI; g.add(capF);
  const capB = new THREE.Mesh(new THREE.CircleGeometry(0.0240, 22), M.black);
  capB.position.set(0, SCY, SCZ + 0.211); g.add(capB);
  g.add(cyl(0.0150, 0.0150, 0.022, matte, 0, SCY + 0.030, SCZ, 16));   // 上调节钮
  g.add(cyl(0.0112, 0.0112, 0.010, blued, 0, SCY + 0.045, SCZ, 14));
  const sideTurret = cyl(0.0125, 0.0125, 0.020, matte, 0.022, SCY, SCZ, 16);
  sideTurret.rotation.z = Math.PI / 2; g.add(sideTurret);

  /* 枪托侧面细节：接缝线 + 吊环板 */
  g.add(box(0.047, 0.004, 0.150, oliveDk, 0, -0.024, 0.420));
  g.add(box(0.012, 0.018, 0.014, matte, 0.020, 0.030, 0.545));

  /* 扳机护圈 / 扳机 / 弹匣 */
  g.add(box(0.013, 0.006, 0.070, matte, 0, -0.044, 0.172));
  g.add(box(0.013, 0.026, 0.006, matte, 0, -0.031, 0.140));
  g.add(box(0.013, 0.006, 0.020, matte, 0, -0.020, 0.148));
  const trigger = box(0.006, 0.020, 0.007, M.metal, 0, -0.026, 0.178);
  trigger.rotation.x = 0.15; g.add(trigger);
  g.add(box(0.046, 0.032, 0.080, oliveDk, 0, -0.038, 0.086));          // 弹匣井
  const magGroup = new THREE.Group();
  magGroup.position.set(0, -0.045, 0.086);
  const mag = box(0.038, 0.086, 0.070, magMat, 0, -0.029, 0);
  mag.rotation.x = -0.07; magGroup.add(mag);
  magGroup.add(box(0.042, 0.009, 0.074, matte, 0, -0.073, 0.001));     // 弹匣底板
  g.add(magGroup);
  g.add(box(0.030, 0.006, 0.026, matte, 0.021, -0.020, 0.150));        // 弹匣卡笋

  /* 拉机柄：右侧后拉 + 球头（整组可绕 X 轴掀起） */
  g.add(box(0.052, 0.040, 0.030, blued, 0, 0.030, 0.198));             // 机匣尾座
  const boltGroup = new THREE.Group();
  boltGroup.position.set(0.030, 0.044, 0.076);
  boltGroup.add(zcyl(0.0140, 0.0140, 0.105, blued, 0, 0, 0, 12));
  const va = new THREE.Vector3(0.008, -0.002, 0.070), vb = new THREE.Vector3(0.060, -0.048, 0.114);
  const d = new THREE.Vector3().subVectors(vb, va);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, d.length(), 10), blued);
  m.position.copy(va).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  boltGroup.add(m);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.018, 14, 12), matte);
  knob.position.set(0.062, -0.050, 0.116); boltGroup.add(knob);
  g.add(boltGroup);

  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.048, -0.686); g.add(muzzle);
  const eject  = new THREE.Object3D(); eject.position.set(0.038, 0.048, 0.080); g.add(eject);
  return {
    group: g, muzzle, eject, scale: 0.46, mag: magGroup, bolt: boltGroup,
    grip: new THREE.Vector3(0, -0.052, 0.140),
    magA: new THREE.Vector3(0, -0.100, 0.088),
    boltA: new THREE.Vector3(0.092, -0.006, 0.192)
  };
}

/* ------------------------------------------------------------
   渲染器 / 场景
   ------------------------------------------------------------ */
const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080b);
scene.fog = new THREE.FogExp2(0x08090c, 0.020);

const camera = new THREE.PerspectiveCamera(S.fov, innerWidth / innerHeight, 0.05, 140);
camera.rotation.order = 'YXZ';
camera.position.set(0, 1.62, 0);
scene.add(camera);

const WALL_Z = -13.6;
const PLAYER = { x: 0, z: 0, vx: 0, vz: 0 };
const BOUNDS = { x: 8.2, zMin: -3.4, zMax: 4.2 };

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);

/* ------------------------------------------------------------
   世界
   ------------------------------------------------------------ */
function gridTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#141619'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 7000; i++) {
    const v = (Math.random() * 34) | 0;
    g.fillStyle = 'rgba(' + v + ',' + v + ',' + (v + 3) + ',0.35)';
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 2;
  g.strokeRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(255,255,255,0.018)'; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i * 128); g.lineTo(512, i * 128); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(16, 16);
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

function woodTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#5b4429'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 7; i++) {
    g.fillStyle = 'rgba(30,18,8,' + (0.12 + Math.random() * 0.12) + ')';
    g.fillRect(0, i * 36 + 4, 256, 3);
  }
  for (let i = 0; i < 1600; i++) {
    g.fillStyle = 'rgba(120,90,55,' + (Math.random() * 0.16) + ')';
    g.fillRect(Math.random() * 256, Math.random() * 256, 12, 1);
  }
  g.fillStyle = 'rgba(20,12,5,0.35)';
  g.fillRect(0, 0, 4, 256); g.fillRect(252, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.encoding = THREE.sRGBEncoding;
  return t;
}

const world = new THREE.Group();
scene.add(world);
const hitWorld = [];   // 可以留弹孔的表面
const nearOnly = [];   // 只在近靶区出现的可视件：切到长枪线时整组隐藏

// 地面
const floorMat = new THREE.MeshStandardMaterial({ map: gridTexture(), color: 0xffffff, roughness: 0.93, metalness: 0.06 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
world.add(floor); hitWorld.push(floor);

// 后墙 / 侧墙 / 顶
const wallMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.95, metalness: 0.03 });
const backWall = box(32, 10, 0.6, wallMat, 0, 5, WALL_Z - 0.35);
backWall.receiveShadow = true; world.add(backWall); hitWorld.push(backWall);
nearOnly.push(backWall);

[-15.2, 15.2].forEach(x => {
  const w = box(0.6, 10, 30, wallMat, x, 5, -7);
  w.receiveShadow = true; world.add(w); hitWorld.push(w);
});

const ceil = box(32, 0.4, 30, new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 1 }), 0, 9.4, -7);
world.add(ceil);

// 天花板横梁
for (let i = 0; i < 5; i++) {
  world.add(box(30, 0.4, 0.5, M.steel, 0, 8.9, -2 - i * 4));
}

// 靶区面板
const panelMat = new THREE.MeshStandardMaterial({ color: 0x191b1f, roughness: 0.85, metalness: 0.15 });
const edgeMat = new THREE.MeshBasicMaterial({ color: 0xff7a2f, transparent: true, opacity: 0.55 });
for (let i = -1; i <= 1; i++) {
  const p = box(9.4, 5.6, 0.12, panelMat, i * 9.6, 3.2, WALL_Z + 0.04);
  p.receiveShadow = true; world.add(p); hitWorld.push(p);
  const e1 = box(9.5, 0.03, 0.03, edgeMat, i * 9.6, 0.4, WALL_Z + 0.12);
  const e2 = box(9.5, 0.03, 0.03, edgeMat, i * 9.6, 6.0, WALL_Z + 0.12);
  world.add(e1); world.add(e2);
  nearOnly.push(p, e1, e2);
}

// 地面警戒线
world.add(box(26, 0.012, 0.1, new THREE.MeshBasicMaterial({ color: 0xff7a2f, transparent: true, opacity: 0.35 }), 0, 0.012, -4.6));

/* ---- 标线 / 地贴 / 墙面字 ---- */
function textTexture(txt, { w = 1024, h = 256, size = 150, color = '#ff7a2f', weight = 700 } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = weight + ' ' + size + 'px Bahnschrift,"Arial Narrow",Arial,sans-serif';
  g.fillText(txt, w / 2, h / 2 + size * 0.04);
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function decal(tex, w, h, x, y, z, opacity = 0.9, rot = 0) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false })
  );
  m.position.set(x, y, z);
  if (rot) m.rotation.z = rot;
  world.add(m);
  return m;
}

// 墙头大写字
nearOnly.push(
  decal(textTexture('RANGE 07', { w: 1024, h: 220, size: 168, color: '#b8481a' }), 7.6, 1.63, 0, 7.45, WALL_Z + 0.02, 0.42),
  decal(textTexture('LIVE FIRE · TRAINING', { w: 1024, h: 128, size: 64, color: '#9aa1ab' }), 5.4, 0.68, 0, 6.55, WALL_Z + 0.02, 0.3)
);

// 靶板编号
[-1, 0, 1].forEach(i => {
  nearOnly.push(decal(textTexture('0' + (i + 2), { w: 256, h: 256, size: 150, color: '#c9855f' }),
    1.0, 1.0, i * 9.6, 5.45, WALL_Z + 0.14, 0.45));
});

// 地面距离标记（5M / 10M）
[[-6.6, '5 M'], [-11.2, '10 M']].forEach(([z, txt]) => {
  const m = decal(textTexture(txt, { w: 512, h: 256, size: 132, color: '#9aa1ab' }), 3.0, 1.5, 0, 0.025, z, 0.55);
  m.rotation.x = -Math.PI / 2;
  nearOnly.push(m);
});

// 地面斜纹警戒带
(() => {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#121110'; g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#8a6a2a';
  for (let x = -64; x < 320; x += 64) {
    g.beginPath();
    g.moveTo(x, 64); g.lineTo(x + 32, 64); g.lineTo(x + 64, 0); g.lineTo(x + 32, 0);
    g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(52, 1);
  t.encoding = THREE.sRGBEncoding;
  const band = new THREE.Mesh(new THREE.PlaneGeometry(26, 0.55),
    new THREE.MeshStandardMaterial({ map: t, roughness: 0.95, metalness: 0.05 }));
  band.rotation.x = -Math.PI / 2;
  band.position.set(0, 0.014, -5.4);
  band.receiveShadow = true;
  world.add(band); hitWorld.push(band);
})();

// 射击位地面线
[-4.9, 4.9].forEach(x => {
  world.add(box(0.03, 0.01, 9.4, new THREE.MeshBasicMaterial({ color: 0xff7a2f, transparent: true, opacity: 0.16 }), x, 0.012, -9.2));
});

// 木箱
const wtex = woodTexture();
const crateMat = new THREE.MeshStandardMaterial({ map: wtex, roughness: 0.86, metalness: 0.04 });
[
  [-11, 0.55, -6, 1.1, 0.4], [-11.5, 1.65, -6.2, 0.9, -0.3],
  [11, 0.55, -7.5, 1.2, 0.2], [10.6, 1.7, -7.6, 0.9, 0.6],
  [-10.5, 0.5, -11.5, 1.0, -0.5], [10.8, 0.5, -11.2, 1.0, 0.4]
].forEach(([x, y, z, s, r]) => {
  const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
  c.position.set(x, y, z); c.rotation.y = r;
  c.castShadow = true; c.receiveShadow = true;
  world.add(c); hitWorld.push(c);
});

// 灯
const lampMat = new THREE.MeshBasicMaterial({ color: 0xffd0a0 });
const lampHousing = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.6, metalness: 0.4 });
[[-6, -5], [6, -5], [-6, -10.5], [6, -10.5]].forEach(([x, z]) => {
  world.add(box(1.0, 0.12, 0.5, lampHousing, x, 7.6, z));
  const bulb = box(0.86, 0.03, 0.38, lampMat, x, 7.52, z);
  world.add(bulb);
  world.add(box(0.03, 1.3, 0.03, M.steel, x, 8.3, z));
  const pl = new THREE.PointLight(0xffb070, 1.15, 20, 2);
  pl.position.set(x, 7.2, z);
  world.add(pl);
});

// 光
const hemi = new THREE.HemisphereLight(0x6f86a8, 0x120f0c, 0.26);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffe8d0, 0.34);
key.position.set(6, 12, 5);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -20; key.shadow.camera.right = 20;
key.shadow.camera.top = 20; key.shadow.camera.bottom = -20;
key.shadow.camera.near = 1; key.shadow.camera.far = 40;
key.shadow.bias = -0.0008;
scene.add(key);

const rim = new THREE.PointLight(0x3a6a9a, 0.5, 22);
rim.position.set(0, 3.2, 7);
scene.add(rim);

const fill = new THREE.PointLight(0xff8a4a, 0.16, 26);
fill.position.set(0, 2.2, WALL_Z + 1.5);
scene.add(fill);

// 彩色轮廓光：左冷右暖，把灰度房间拉开
const accentL = new THREE.PointLight(0x2b8fa8, 0.9, 13, 2);
accentL.position.set(-8.6, 2.4, -11.4);
scene.add(accentL);
const accentR = new THREE.PointLight(0xff6a2a, 0.55, 12, 2);
accentR.position.set(8.4, 1.5, -6.4);
scene.add(accentR);

// 靶墙洗墙灯
[[-5.6, 7.4, -8.6], [5.6, 7.4, -8.6]].forEach(([x, y, z]) => {
  const sp = new THREE.SpotLight(0xfff1dc, 1.15, 30, 0.66, 0.85, 1);
  sp.position.set(x, y, z);
  sp.target.position.set(x * 0.35, 2.3, WALL_Z);
  scene.add(sp); scene.add(sp.target);
});

// 尘埃
const DUST_N = 260;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_N * 3);
const dustSeed = [];
for (let i = 0; i < DUST_N; i++) {
  dustPos[i * 3] = rand(-9, 9);
  dustPos[i * 3 + 1] = rand(0.2, 6.5);
  dustPos[i * 3 + 2] = rand(-13, -1.2);
  dustSeed.push(rand(0, TAU), rand(0.1, 0.5));
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dustTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  color: 0xffe0b0, size: 0.05, map: dustTex, transparent: true, opacity: 0.5,
  depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
}));
scene.add(dust);

/* ------------------------------------------------------------
   长枪线：在近靶区后面再接一段 20 米的走廊，只在 LONG RANGE 模式显示。
   这样同一套玩家位置 / 手感不动，靶子直接挪到 34 米外。
   ------------------------------------------------------------ */
const DEEP_WALL_Z = -34.6;
const deep = new THREE.Group();
deep.visible = false;
world.add(deep);

(function buildDeepLane() {
  const dwall = box(32, 10, 0.6, wallMat, 0, 5, DEEP_WALL_Z);
  dwall.receiveShadow = true; deep.add(dwall); hitWorld.push(dwall);

  // 走廊侧墙 / 顶：接着近区（z 到 -22）继续铺到 -38
  [-15.2, 15.2].forEach(x => {
    const w = box(0.6, 10, 16, wallMat, x, 5, -30);
    w.receiveShadow = true; deep.add(w); hitWorld.push(w);
    deep.add(box(0.05, 0.9, 16, edgeMat, x - Math.sign(x) * 0.34, 0.46, -30));
  });
  deep.add(box(32, 0.4, 16, new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 1 }), 0, 9.4, -30));
  for (let i = 0; i < 4; i++) deep.add(box(30, 0.4, 0.5, M.steel, 0, 8.9, -23 - i * 4));

  // 远端三块靶板
  for (let i = -1; i <= 1; i++) {
    const p = box(9.4, 5.6, 0.12, panelMat, i * 9.6, 3.2, DEEP_WALL_Z + 0.34);
    p.receiveShadow = true; deep.add(p); hitWorld.push(p);
    deep.add(box(9.5, 0.03, 0.03, edgeMat, i * 9.6, 0.4, DEEP_WALL_Z + 0.42));
    deep.add(box(9.5, 0.03, 0.03, edgeMat, i * 9.6, 6.0, DEEP_WALL_Z + 0.42));
  }

  // 远端灯（四个灯头 + 两个聚光，把 34 米处的靶照亮）
  [[-7, -24], [7, -24], [-7, -31], [7, -31]].forEach(([x, z]) => {
    deep.add(box(1.0, 0.12, 0.5, lampHousing, x, 7.6, z));
    deep.add(box(0.86, 0.03, 0.38, lampMat, x, 7.52, z));
    deep.add(box(0.03, 1.3, 0.03, M.steel, x, 8.3, z));
    const pl = new THREE.PointLight(0xffb070, 0.85, 18, 2);
    pl.position.set(x, 7.2, z); deep.add(pl);
  });
  [[-5, -27], [5, -31]].forEach(([x, z]) => {
    const sp = new THREE.SpotLight(0xffe0c0, 1.35, 30, Math.PI / 5.2, 0.6, 1.2);
    sp.position.set(x, 8.4, z);
    sp.target.position.set(x * 0.4, 2.3, DEEP_WALL_Z);
    deep.add(sp); deep.add(sp.target);
  });

  // 地面里程贴 + 远端文字
  const m20 = decal(textTexture('20 M', { w: 512, h: 256, size: 132, color: '#9aa1ab' }), 3.0, 1.5, 0, 0.025, -21.6, 0.5);
  m20.rotation.x = -Math.PI / 2;
  const m30 = decal(textTexture('30 M', { w: 512, h: 256, size: 132, color: '#9aa1ab' }), 3.0, 1.5, 0, 0.025, -31.4, 0.5);
  m30.rotation.x = -Math.PI / 2;
  world.remove(m20); world.remove(m30); deep.add(m20); deep.add(m30);
  deep.add(decal(textTexture('LONG RANGE · 35 M', { w: 1024, h: 160, size: 92, color: '#b8481a' }), 7.0, 0.9, 0, 7.05, DEEP_WALL_Z + 0.06, 0.42));

  // 远端角落木箱，给纵深一点参照
  [[-11.5, 0.55, -26], [11.6, 0.55, -28.5]].forEach(([x, y, z]) => {
    const c = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), crateMat);
    c.position.set(x, y, z); c.rotation.y = Math.random(); c.castShadow = true;
    deep.add(c); hitWorld.push(c);
  });
})();

/* ------------------------------------------------------------
   走廊切角（CORNER）：20 米窄走廊，两侧交替开 5 个门洞。
   靶子从门洞里横移出来 —— 练"先预瞄再切角"。
   ------------------------------------------------------------ */
const CORR_W = 2.30;                       // 走廊半宽
const CORNERS = [
  { z: -7.0,  sgn:  1 }, { z: -10.6, sgn: -1 }, { z: -14.2, sgn: 1 },
  { z: -17.6, sgn: -1 }, { z: -21.0, sgn: 1 },
];
const DOOR_W = 1.15, DOOR_H = 2.45;
const cornerView = new THREE.Group();
cornerView.visible = false;
world.add(cornerView);

(function buildCorridor() {
  const cmat = new THREE.MeshStandardMaterial({ color: 0x191b20, roughness: 0.95, metalness: 0.04 });
  const cfloor = new THREE.MeshStandardMaterial({ color: 0x141619, roughness: 1 });
  const zA = 1.4, zB = -23.4, cz = (zA + zB) / 2, len = zA - zB;

  const fl = box(CORR_W * 2, 0.05, len, cfloor, 0, 0.02, cz);
  fl.receiveShadow = true; cornerView.add(fl);

  [-1, 1].forEach(sgn => {
    const cuts = CORNERS.filter(c => c.sgn === sgn).map(c => c.z).sort((a, b) => b - a);
    const edges = [zA];
    cuts.forEach(z => { edges.push(z + DOOR_W / 2); edges.push(z - DOOR_W / 2); });
    edges.push(zB);
    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i], b = edges[i + 1];
      const segLen = a - b;
      if (segLen < 0.05) continue;
      const w = box(0.28, 3.3, segLen, cmat, sgn * (CORR_W + 0.14), 1.65, (a + b) / 2);
      w.receiveShadow = true; cornerView.add(w); hitWorld.push(w);
      cornerView.add(box(0.32, 0.10, segLen, M.black, sgn * (CORR_W + 0.13), 1.02, (a + b) / 2));
    }
    cuts.forEach(z => {
      cornerView.add(box(0.28, 3.3 - DOOR_H, DOOR_W, cmat, sgn * (CORR_W + 0.14), DOOR_H + (3.3 - DOOR_H) / 2, z));
      cornerView.add(box(0.34, 0.07, DOOR_W + 0.1, M.steel, sgn * (CORR_W + 0.12), DOOR_H, z));
      // 门洞后的暗室
      cornerView.add(box(1.5, 0.05, DOOR_W, cfloor, sgn * (CORR_W + 0.9), 0.02, z));
      cornerView.add(box(1.5, DOOR_H, 0.16, cmat, sgn * (CORR_W + 0.9), DOOR_H / 2, z - DOOR_W / 2));
      cornerView.add(box(1.5, DOOR_H, 0.16, cmat, sgn * (CORR_W + 0.9), DOOR_H / 2, z + DOOR_W / 2));
      const bw = box(0.16, DOOR_H, DOOR_W, cmat, sgn * (CORR_W + 1.62), DOOR_H / 2, z);
      bw.receiveShadow = true; cornerView.add(bw); hitWorld.push(bw);
      cornerView.add(box(0.10, DOOR_H, DOOR_W, M.black, sgn * (CORR_W + 1.66), DOOR_H / 2, z));
      // 门框两侧的窄边光：暗走廊里靠这一道亮边读出"门在哪、靶从哪出来"
      [-1, 1].forEach(k => {
        cornerView.add(box(0.06, DOOR_H - 0.06, 0.045, M.steel,
          sgn * (CORR_W + 0.04), (DOOR_H - 0.06) / 2, z + k * (DOOR_W / 2 - 0.02)));
      });
      const glow = new THREE.PointLight(0xffb070, 0.30, 4.4, 2);
      glow.position.set(sgn * (CORR_W + 0.75), 2.1, z);
      glow.userData.cornerLight = true;
      cornerView.add(glow);
    });
  });

  cornerView.add(box(CORR_W * 2 + 0.6, 0.3, len, cmat, 0, 3.45, cz));
  for (let i = 0; i < 5; i++) {
    const z = -6.0 - i * 4.0;
    cornerView.add(box(0.9, 0.05, 0.12, new THREE.MeshBasicMaterial({ color: 0x9c7c58 }), 0, 3.28, z));
    const pl = new THREE.PointLight(0xffe4c4, 0.34, 9, 2);
    pl.position.set(0, 3.0, z);
    pl.userData.cornerLight = true;
    cornerView.add(pl);
  }

  const ew = box(CORR_W * 2 + 0.6, 3.4, 0.3, cmat, 0, 1.7, zB);
  ew.receiveShadow = true; cornerView.add(ew); hitWorld.push(ew);
  cornerView.add(box(0.06, 0.02, len - 1.2, edgeMat, 0, 0.05, cz));

  // 顶部管线：两条长管，压住空荡感也给纵深参照
  [-1.78, 1.78].forEach(x => {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, len - 0.6, 12),
      new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.8, metalness: 0.35 }));
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(x, 3.34, cz);
    cornerView.add(pipe);
    for (let k = 0; k < 5; k++) cornerView.add(box(0.10, 0.05, 0.08, M.black, x, 3.30, -3.4 - k * 4.4));
  });

  // 贴图辅助：decal() 默认挂 world，这里改挂 cornerView
  const cdecal = (txt, w, h, x, y, z, op, flat, faceY, sz) => {
    const m = decal(textTexture(txt, { w: 512, h: 256, size: sz || 138, color: '#c2c8d0' }), w, h, x, y, z, op);
    world.remove(m); cornerView.add(m);
    if (flat) m.rotation.x = -Math.PI / 2;
    if (faceY) m.rotation.y = faceY;
    return m;
  };

  // 地面距离标（放在中缝两侧交替）
  [[-5.0, '5 M', -1], [-11.0, '10 M', 1], [-16.4, '15 M', -1], [-21.2, '20 M', 1]].forEach(([z, txt, sd]) => {
    cdecal(txt, 1.9, 0.95, sd * 1.35, 0.035, z, 0.5, true);
  });

  // 侧墙门洞编号（02 起，跟靶场房里的牌号同一套观感）
  CORNERS.forEach((c, i) => {
    cdecal('0' + (i + 2), 0.74, 0.74, c.sgn * (CORR_W - 0.01), 2.86, c.z, 0.30, false, c.sgn > 0 ? -Math.PI / 2 : Math.PI / 2);
  });

  // 尽头墙字
  cdecal('SEC · 20 M', 3.6, 0.9, 0, 2.15, zB + 0.16, 0.34, false, 0, 84);
  cdecal('CQB LANE', 2.4, 0.6, 0, 1.42, zB + 0.16, 0.20, false, 0, 76);
})();

function cornerQueue() {
  return [0, 2, 4].concat([1, 3].sort(() => Math.random() - 0.5));
}

function spawnCorner(t, ci) {
  const c = CORNERS[ci] || CORNERS[0];
  const showX = c.sgn * (CORR_W - 0.30);
  const hideX = c.sgn * (CORR_W + 0.72);
  activateTarget(t, showX, 1.42, c.z);
  t.group.position.x = hideX;
  t.slide = { from: hideX, to: showX, t0: now() };
  G.spawnAt = now();
}

/* ------------------------------------------------------------
   靶子
   ------------------------------------------------------------ */
const NEAR_Z = -13.15;
const DEEP_Z = -34.15;
let TARGET_Z = NEAR_Z;      // 按模式切换：近靶区 / 长枪线
const TARGET_SCALE = 1.35;

function makeTarget() {
  const g = new THREE.Group();
  g.scale.setScalar(TARGET_SCALE);

  const mat = M.paper.clone();
  const face = new THREE.Group();
    g.add(face);

  const shape = new THREE.Shape();
  shape.moveTo(-0.20, -0.58);
  shape.lineTo(0.20, -0.58);
  shape.lineTo(0.26, -0.38);
  shape.lineTo(0.31, 0.02);
  shape.lineTo(0.33, 0.26);
  shape.lineTo(0.24, 0.33);
  shape.lineTo(0.10, 0.36);
  shape.lineTo(-0.10, 0.36);
  shape.lineTo(-0.24, 0.33);
  shape.lineTo(-0.33, 0.26);
  shape.lineTo(-0.31, 0.02);
  shape.lineTo(-0.26, -0.38);
  shape.closePath();

  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false }), mat);
  body.name = 'body';
  body.castShadow = true;
  face.add(body);

  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 28), mat);
  head.rotation.x = Math.PI / 2;
  head.position.set(0, 0.53, 0.025);
  head.name = 'head';
  head.castShadow = true;
  face.add(head);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.082, 26), M.red);
  ring.position.set(0, 0.02, 0.052); face.add(ring);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.024, 18), M.red);
  dot.position.set(0, 0.02, 0.052); face.add(dot);
  const hdot = new THREE.Mesh(new THREE.CircleGeometry(0.038, 20), M.red);
  hdot.position.set(0, 0.53, 0.052); face.add(hdot);

  const post = cyl(0.018, 0.018, 0.68, M.steel, 0, -0.92, 0, 8);
  g.add(post);
  const base = box(0.42, 0.028, 0.3, M.black, 0, -1.26, 0);
  g.add(base);

  const t = { group: g, face, body, head, mat, post, base, hp: 100, alive: false, flash: 0, respawnAt: 0, kind: 'body' };
  body.userData.target = t;
  head.userData.target = t;
  g.visible = false;
  scene.add(g);
  return t;
}

const targetPool = [];
for (let i = 0; i < 8; i++) targetPool.push(makeTarget());
const activeTargets = [];

const GRID_SLOTS = [];
// 交错两排：下排 4 槽贴地，上排 3 槽错开半格，避免上下同列叠在一起
[-6.6, -2.2, 2.2, 6.6].forEach(x => GRID_SLOTS.push({ x, y: 1.35 }));
[-4.4, 0, 4.4].forEach(x => GRID_SLOTS.push({ x, y: 3.05 }));

// 长枪线：同样七槽，但摊得更开（34 米处 ±8.4 大约是 14 度视角）
const DEEP_SLOTS = [];
[-8.4, -2.8, 2.8, 8.4].forEach(x => DEEP_SLOTS.push({ x, y: 1.45 }));
[-5.6, 0, 5.6].forEach(x => DEEP_SLOTS.push({ x, y: 3.15 }));
const slotsFor = () => (G.mode === 'long' ? DEEP_SLOTS : GRID_SLOTS);

/* 靶子横向漂移：easy 不动，std 单频，hard 叠二次谐波让变向更频繁。
   整组一起动（靶面 + 靶杆），看着像挂在轨道上的活动靶；相位按出生时刻随机。 */
const LONG_MOVE = {
  easy: { spd: 0.0, amp: 0.0 },
  std:  { spd: 1.30, amp: 3.2 },
  hard: { spd: 2.20, amp: 3.2 }
};

/* 长枪线的靶子：在 homeX ± amp 之间来回走，走到头会停一下，
   半路也有小概率突然停住（随机停顿），逼你等它稳了再开枪。 */
function moveLong(tg, dt, tNow) {
  const mv = LONG_MOVE[S.tier] || LONG_MOVE.std;
  if (!mv.spd || !mv.amp) { tg.group.position.x = tg.homeX; return; }
  if (!tg.mv) tg.mv = { vx: Math.random() < 0.5 ? -1 : 1, until: 0 };
  const m = tg.mv;
  if (tNow < m.until) return;
  tg.group.position.x += m.vx * mv.spd * dt;
  const lo = tg.homeX - mv.amp, hi = tg.homeX + mv.amp;
  if (tg.group.position.x >= hi) {
    tg.group.position.x = hi; m.vx = -1; m.until = tNow + 320 + Math.random() * 900;
  } else if (tg.group.position.x <= lo) {
    tg.group.position.x = lo; m.vx = 1; m.until = tNow + 320 + Math.random() * 900;
  } else if (Math.random() < dt * 0.16) {
    m.until = tNow + 380 + Math.random() * 1100;
  }
}

function moveTarget(tg, tNow, dt) {
  if (G.mode === 'long') { moveLong(tg, dt || 0.016, tNow); return; }
  if (G.mode === 'corner') {
    if (tg.slide) {
      const p = Math.min(1, (tNow - tg.slide.t0) / 260);
      const e = 1 - Math.pow(1 - p, 3);
      tg.group.position.x = tg.slide.from + (tg.slide.to - tg.slide.from) * e;
      if (p >= 1) tg.slide = null;
    }
    return;
  }
  const tr = tierOf();
  if (!tr.speed) { tg.group.position.x = tg.homeX; return; }
  const age = Math.max(0, (tNow - tg.born) / 1000);
  const w = tr.speed;
  const drift = tr.speed > 1
    ? (Math.sin(age * w + tg.mPhase) + 0.22 * Math.sin(age * w * 2.3 + tg.mPhase * 1.7)) / 1.22
    : Math.sin(age * w + tg.mPhase);
  tg.group.position.x = clamp(tg.homeX + tr.amp * drift, -8.4, 8.4);
}
function activateTarget(t, x, y, z) {
  t.group.position.set(x, y, z === undefined ? TARGET_Z : z);
  const tr = tierOf();
  t.group.scale.setScalar(TARGET_SCALE * tr.scale);
  t.face.position.x = 0;
  t.homeX = x;
  t.born = now();
  t.mPhase = Math.random() * Math.PI * 2;
  t.mv = null;
  t.slide = null;
  t.group.visible = true;
  const floating = y > 2.4;
  t.post.visible = !floating;
  t.base.visible = !floating;
  t.hp = 100;
  t.alive = true;
  t.flash = 0;
  G.engage = { t, used: false };
  t.spawnId = (G.spawnSeq = (G.spawnSeq || 0) + 1);
  t.mat.emissive.setHex(0x000000);
  t.mat.emissiveIntensity = 0;
}

function deactivateTarget(t) {
  t.alive = false;
  t.group.visible = false;
}

function allHitMeshes() {
  const arr = hitWorld.filter(o => o.visible && (!o.parent || o.parent.visible));
  activeTargets.forEach(t => { arr.push(t.body, t.head); });
  return arr;
}

/* ------------------------------------------------------------
   特效：弹孔 / 火花 / 曳光 / 弹壳 / 枪口火焰
   ------------------------------------------------------------ */
const decalTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(0,0,0,0.95)');
  grd.addColorStop(0.45, 'rgba(10,8,6,0.75)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

const decals = [];
const DECAL_MAX = 140;

function addDecal(point, normal) {
  const mat = new THREE.MeshBasicMaterial({ map: decalTex, transparent: true, depthWrite: false, opacity: 0.9 });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.075), mat);
  m.position.copy(point).addScaledVector(normal, 0.006);
  m.lookAt(point.clone().add(normal));
  scene.add(m);
  decals.push({ mesh: m, t: 0, life: 12 });
  if (decals.length > DECAL_MAX) {
    const old = decals.shift();
    scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose();
  }
}

const fxList = [];

function spawnSparks(point, normal, n, color) {
  const pos = new Float32Array(n * 3);
  const vel = [];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = point.x; pos[i * 3 + 1] = point.y; pos[i * 3 + 2] = point.z;
    const v = normal.clone().multiplyScalar(rand(0.6, 2.2));
    v.x += rand(-1.6, 1.6); v.y += rand(-0.4, 2.0); v.z += rand(-1.6, 1.6);
    vel.push(v);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: color || 0xffb066, size: 0.032, transparent: true, opacity: 1,
    depthWrite: false, blending: THREE.AdditiveBlending
  });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  fxList.push({ type: 'sparks', obj: pts, vel, t: 0, life: 0.45 });
}

function spawnTracer(a, b, color) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineBasicMaterial({
    color: color || 0xffd9a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false
  });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  fxList.push({ type: 'tracer', obj: line, t: 0, life: 0.07 });
}

const shellGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.026, 8);
const shells = [];

function spawnShell(origin, dir) {
  if (shells.length > 24) {
    const s = shells.shift(); scene.remove(s.mesh); s.mesh.geometry.dispose();
  }
  const m = new THREE.Mesh(shellGeo, M.brass);
  m.position.copy(origin);
  m.rotation.set(rand(0, TAU), rand(0, TAU), rand(0, TAU));
  scene.add(m);
  shells.push({
    mesh: m,
    v: new THREE.Vector3(dir.x * rand(1.5, 2.6) + 1.2, rand(1.2, 2.4), dir.z * rand(1.5, 2.6)),
    spin: new THREE.Vector3(rand(-14, 14), rand(-14, 14), rand(-14, 14)),
    t: 0, life: 1.6, bounced: false
  });
}

const flashTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,235,1)');
  grd.addColorStop(0.25, 'rgba(255,200,120,0.95)');
  grd.addColorStop(0.6, 'rgba(255,120,40,0.35)');
  grd.addColorStop(1, 'rgba(255,80,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,220,160,0.7)';
  g.fillRect(62, 8, 4, 112); g.fillRect(8, 62, 112, 4);
  return new THREE.CanvasTexture(c);
})();

const flashMat = new THREE.SpriteMaterial({
  map: flashTex, color: 0xffffff, transparent: true,
  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
});
const flashSprite = new THREE.Sprite(flashMat);
flashSprite.visible = false;
scene.add(flashSprite);

const flashLight = new THREE.PointLight(0xffb060, 0, 6, 2);
scene.add(flashLight);
let flashUntil = 0;

function muzzleFlash(pos, size) {
  flashSprite.position.copy(pos);
  flashSprite.scale.setScalar(size * rand(0.85, 1.2));
  flashSprite.visible = true;
  flashSprite.material.rotation = rand(0, TAU);
  flashLight.position.copy(pos);
  flashLight.intensity = 6;
  flashUntil = now() + 45;
}

/* ------------------------------------------------------------
   伤害数字 / 击杀提示
   ------------------------------------------------------------ */
const floaterHost = $('#floaters');
function worldToScreen(v) {
  const p = v.clone().project(camera);
  return { x: (p.x * 0.5 + 0.5) * innerWidth, y: (-p.y * 0.5 + 0.5) * innerHeight, z: p.z };
}
function floatText(point, text, cls) {
  const s = worldToScreen(point);
  const el = document.createElement('span');
  el.className = 'float ' + (cls || '');
  el.textContent = text;
  el.style.left = s.x + 'px';
  el.style.top = s.y + 'px';
  floaterHost.appendChild(el);
  setTimeout(() => el.remove(), 780);
}

const killfeedHost = $('#killfeed');
function killFeed(text, cls) {
  const el = document.createElement('div');
  el.className = 'kf ' + (cls || '');
  el.textContent = text;
  killfeedHost.appendChild(el);
  setTimeout(() => el.remove(), 950);
  while (killfeedHost.children.length > 4) killfeedHost.firstChild.remove();
}

/* ------------------------------------------------------------
   武器数据
   ------------------------------------------------------------ */
const GUNS = {
  usp: {
    name: 'USP-S', auto: false, rpm: 380, mag: 12, reserve: 999,
    body: 34, head: 120, spread: 0.0012, bloom: 0.0011, maxBloom: 0.006,
    recoilUp: 1.0, recoilSide: 0.22, reload: 2.1, zoom: 0, bolt: 0
  },
  ak: {
    name: 'AK-47', auto: true, rpm: 600, mag: 30, reserve: 999,
    body: 36, head: 144, spread: 0.0018, bloom: 0.0013, maxBloom: 0.014,
    recoilUp: 0.42, recoilSide: 0.42, reload: 2.4, zoom: 0, bolt: 0
  },
  awm: {
    name: 'AWM', auto: false, rpm: 45, mag: 5, reserve: 999,
    body: 120, head: 450, spread: 0.0002, bloom: 0.0025, maxBloom: 0.02,
    recoilUp: 3.2, recoilSide: 0.35, reload: 3.0, zoom: 18, bolt: 1.15
  }
};
const MODE_NAME = { grid: 'GRIDSHOT', flick: 'FLICK', spray: 'SPRAY', long: 'LONG RANGE', corner: 'CORNER' };

/* 难度：按靶子的移动速度与变向频率分档（用户裁决），顺带收紧靶面与重生间隔。
   speed 是正弦横向漂移的角速度，amp 是漂移半幅（世界米），refresh 是击杀后重生延迟（毫秒）。
   hard 再叠一层 2.3 倍的二次谐波，变向更碎；easy 完全不漂。 */
const TIERS = {
  easy: { name: '入门', scale: 1.22, speed: 0.00, amp: 0.00, refresh: 950 },
  std:  { name: '标准', scale: 1.00, speed: 0.90, amp: 0.62, refresh: 600 },
  hard: { name: '硬核', scale: 0.84, speed: 2.20, amp: 0.70, refresh: 380 }
};
const tierOf = () => TIERS[S.tier] || TIERS.std;

/* 弹道偏移（度/发，累加）：确定性图案，玩家要靠压枪去抵消。
   AK 前 3 发直上，之后左右摆；USP 点射小抬；AWM 栓动无图案（[0,0]）。 */
function sprayOffset(gun, i) {
  if (gun === 'ak') {
    if (i < 3) return [0, 0.62];
    if (i < 8) return [Math.sin(i * 0.7) * 0.18, 0.52];
    if (i < 14) return [Math.sin(i * 1.1) * 0.55, 0.30];
    return [Math.sin(i * 1.35) * 0.75 + Math.sin(i * 2.7) * 0.25, 0.16];
  }
  if (gun === 'usp') return [Math.sin(i * 1.7) * 0.18, 0.55];
  /* 栓动：一枪一拉栓，没有"连发图案"这回事，子弹必须打在准星上 */
  return [0, 0];
}

/* 逐发随机抖动（度）：图案只给"大概形状"，真实枪械每发都不会走同一条线。
   幅度很小，压枪的手感仍然由固定图案承担；栓动枪减半，别把狙击枪变成抽奖。 */
const RECOIL_JITTER = { x: 0.10, y: 0.08 };
function jitterOf(gun) {
  const k = gun === 'awm' ? 0.5 : 1;
  return [rand(-1, 1) * RECOIL_JITTER.x * k, rand(-1, 1) * RECOIL_JITTER.y * k];
}

/* ------------------------------------------------------------
   状态
   ------------------------------------------------------------ */
const G = {
  state: 'menu', mode: 'grid', gun: 'usp',
  score: 0, kills: 0, heads: 0, shots: 0, hits: 0, streak: 0, bestStreak: 0,
  timeLeft: 60, startAt: 0, pauseAt: 0,
  reaction: [], spawnAt: 0,
  ammo: { usp: 12, ak: 30, awm: 5 },
  yaw: 0, pitch: 0, recoilPitch: 0, recoilYaw: 0, sprayPitch: 0, sprayYaw: 0,
  ads: false, adsT: 0, firing: false,
  nextShot: 0, reloadUntil: 0, reloadStart: 0, reloadDur: 0, reloadCue: 0,
  boltUntil: 0, equipping: 0, lastShot: 0,
  bloom: 0, shotIndex: 0,
  vmKick: 0, swayX: 0, swayY: 0, bob: 0,
  shake: 0, locked: false, ignoreUnlock: false,
  sprayHits: 0, sprayOffsets: [], pauseSource: 'game', elapsed: 0,
  dots: [], firstOffsets: [], engage: null
};

const keys = Object.create(null);
const VIEWS = {};
let handR = null, handL = null;
const vmRoot = new THREE.Group();
camera.add(vmRoot);

/* 程序化手套：换弹时才出现，右手抓握把、左手抓弹匣 */
function buildGlove(side) {
  const g = new THREE.Group();
  const gloveM = new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.82, metalness: 0.06 });
  const padM   = new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.94, metalness: 0.03 });
  const cuffM  = new THREE.MeshStandardMaterial({ color: 0x474f42, roughness: 1.0, metalness: 0.0 });
  const arm = cyl(0.030, 0.042, 0.13, cuffM, 0, 0, 0.075, 12);
  arm.rotation.x = Math.PI / 2; g.add(arm);
  g.add(box(0.086, 0.018, 0.038, padM, 0, 0.004, 0.148));
  g.add(box(0.074, 0.043, 0.092, gloveM, 0, -0.004, -0.046));
  for (let i = 0; i < 4; i++) {
    const f = box(0.015, 0.026, 0.050, gloveM, -0.024 + i * 0.016, -0.014, -0.104);
    f.rotation.x = 0.36; g.add(f);
  }
  const th = box(0.020, 0.024, 0.046, gloveM, 0.040 * side, 0.004, -0.058);
  th.rotation.z = -0.6 * side; g.add(th);
  g.scale.setScalar(0.62);
  return g;
}

/* 枪本地坐标 → vmRoot 局部坐标（含 holder 位置/旋转与模型缩放） */
function anchorOf(holder, scale, v) {
  const p = v.clone().multiplyScalar(scale);
  p.applyEuler(holder.rotation);
  return p.add(holder.position);
}

function mountViews() {
  const tune = {
    usp: { s: 1.12, x: 0.185, y: -0.150, z: -0.330, rx: -0.012, ry: 0.10, rz: 0.015 },
    ak:  { s: 0.731, x: 0.17, y: -0.09, z: -0.38, rx: -0.04, ry: 0.10, rz: 0.02 },
    awm: { s: 0.60, x: 0.185, y: -0.105, z: -0.440, rx: -0.030, ry: 0.28, rz: 0.018 }
  };
  [['usp', buildUsp], ['ak', buildAk], ['awm', buildAwm]].forEach(([k, fn]) => {
    const b = fn();
    const s = b.scale * tune[k].s;
    b.group.scale.setScalar(s);
    const holder = new THREE.Group();
    holder.add(b.group);
    holder.position.set(tune[k].x, tune[k].y, tune[k].z);
    holder.rotation.set(tune[k].rx, tune[k].ry, tune[k].rz);
    holder.visible = false;
    vmRoot.add(holder);
    VIEWS[k] = {
      holder, muzzle: b.muzzle, eject: b.eject,
      mag: b.mag, bolt: b.bolt,
      grip: anchorOf(holder, s, b.grip),
      magA: anchorOf(holder, s, b.magA),
      boltA: b.boltA ? anchorOf(holder, s, b.boltA) : null,
      magHome: b.mag ? b.mag.position.clone() : null,
      magRot0: b.mag ? b.mag.rotation.x : 0,
      boltHome: b.bolt ? b.bolt.position.clone() : null
    };
  });
  handR = buildGlove(1);
  handL = buildGlove(-1);
  handR.visible = false; handL.visible = false;
  vmRoot.add(handR); vmRoot.add(handL);
  const vmLight = new THREE.PointLight(0xffe2c4, 0.45, 1.1, 2);
  vmLight.position.set(0.24, -0.01, 0.02);
  vmRoot.add(vmLight);
}

function setGun(k, silent) {
  if (!GUNS[k]) return;
  G.gun = k;
  Object.keys(VIEWS).forEach(x => { VIEWS[x].holder.visible = (x === k); });
  G.ads = false;
  G.bloom = 0;
  G.shotIndex = 0;
  G.sprayPitch = 0; G.sprayYaw = 0;
  G.equipping = now() + 380;
  $('#hudGun').textContent = GUNS[k].name;
  $('#hudGun2').textContent = GUNS[k].name;
  if (!silent) SFX.equip();
  updateAmmo();
}

/* ------------------------------------------------------------
   HUD
   ------------------------------------------------------------ */
const hudEl = $('#hud');
const crossEl = $('#crosshair');
const scopeEl = $('#scope');

function updateAmmo() {
  const n = G.ammo[G.gun];
  const el = $('#hudAmmo');
  el.textContent = n;
  el.classList.toggle('empty', n === 0);
  $('#hudReserve').textContent = '/ ∞';
}

function updateHUD() {
  $('#hudScore').textContent = G.score;
  if (G.mode === 'spray') $('#hudTimer').textContent = '60.0';
  else $('#hudTimer').textContent = Math.max(0, G.timeLeft).toFixed(1);
  $('#hudTimerWrap').classList.toggle('low', G.timeLeft <= 10);
  $('#hudAcc').textContent = G.shots ? Math.round(100 * G.hits / G.shots) + '%' : '—';
  $('#hudKills').textContent = G.mode === 'spray' ? G.hits : G.kills;
  $('#hudHs').textContent = (G.hits ? Math.round(100 * G.heads / G.hits) : 0) + '%';
  const mult = 1 + Math.min(2, Math.floor(G.streak / 4) * 0.5);
  $('#hudStreak').textContent = G.streak > 1 ? 'STREAK ' + G.streak + '  ×' + mult.toFixed(1) : '';
  const gap = 4 + G.bloom * 1600 + (Math.hypot(PLAYER.vx, PLAYER.vz) > 0.6 ? 3 : 0);
  crossEl.style.setProperty('--gap', gap.toFixed(1) + 'px');
}

const hmEl = $('#hitmarker');
function hitmarker(head) {
  hmEl.classList.remove('on', 'head');
  void hmEl.offsetWidth;
  hmEl.classList.add('on');
  if (head) hmEl.classList.add('head');
}

/* ------------------------------------------------------------
   回合 / 模式
   ------------------------------------------------------------ */
function clearRoundFx() {
  decals.forEach(d => { scene.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.material.dispose(); });
  decals.length = 0;
  fxList.forEach(f => { scene.remove(f.obj); if (f.obj.geometry) f.obj.geometry.dispose(); if (f.obj.material) f.obj.material.dispose(); });
  fxList.length = 0;
  shells.forEach(s => scene.remove(s.mesh));
  shells.length = 0;
}

function applyLane() {
  const deepMode = G.mode === 'long';
  const corrMode = G.mode === 'corner';
  TARGET_Z = deepMode ? DEEP_Z : NEAR_Z;
  deep.visible = deepMode;
  cornerView.visible = corrMode;
  nearOnly.forEach(o => { o.visible = !deepMode && !corrMode; });
  scene.traverse(o => {
    if (!o.isLight || o.userData.cornerLight) return;
    if (o.userData.baseI === undefined) o.userData.baseI = o.intensity;
    o.intensity = corrMode ? o.userData.baseI * 0.22 : o.userData.baseI;
  });
  scene.fog.density = deepMode ? 0.012 : (corrMode ? 0.026 : 0.020);
}

function startMode() {
  applyLane();
  activeTargets.length = 0;
  targetPool.forEach(t => { t.group.visible = false; t.alive = false; t.respawnAt = 0; });
  clearRoundFx();
  G.sprayHits = 0;

  if (G.mode === 'grid' || G.mode === 'long') {
    const slots = slotsFor().slice();
    for (let i = slots.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [slots[i], slots[j]] = [slots[j], slots[i]]; }
    for (let i = 0; i < 6; i++) {
      const t = targetPool[i];
      activateTarget(t, slots[i].x, slots[i].y);
      activeTargets.push(t);
    }
  } else if (G.mode === 'corner') {
    G.cornerQ = cornerQueue();
    G.cornerI = 0;
    PLAYER.x = 0; PLAYER.z = -0.7;
    const t = targetPool[0];
    spawnCorner(t, G.cornerQ[0]);
    activeTargets.push(t);
  } else if (G.mode === 'flick') {
    const t = targetPool[0];
    activateTarget(t, rand(-7, 7), rand(1.35, 2.7));
    activeTargets.push(t);
    G.spawnAt = now();
  } else {
    const t = targetPool[0];
    activateTarget(t, 0, 1.72);
    t.hp = 1e9;
    activeTargets.push(t);
  }
}

function respawnFree(t) {
  if (G.mode === 'corner') {
    G.cornerI = (G.cornerI + 1) % G.cornerQ.length;
    if (G.cornerI === 0) G.cornerQ = cornerQueue();
    spawnCorner(t, G.cornerQ[G.cornerI]);
    return;
  }
  if (G.mode === 'flick') {
    activateTarget(t, rand(-7.2, 7.2), rand(1.32, 2.72));
    G.spawnAt = now();
    return;
  }
  const used = activeTargets.filter(o => o !== t && o.alive)
    .map(o => ({ x: o.group.position.x, y: o.group.position.y }));
  const pool = slotsFor();
  const free = pool.filter(s => !used.some(u => Math.abs(u.x - s.x) < 0.6 && Math.abs(u.y - s.y) < 0.6));
  const s = free.length ? free[(Math.random() * free.length) | 0] : pool[(Math.random() * pool.length) | 0];
  activateTarget(t, s.x, s.y);
}

function startRound() {
  G.score = 0; G.kills = 0; G.heads = 0; G.shots = 0; G.hits = 0;
  G.streak = 0; G.bestStreak = 0; G.reaction.length = 0;
  G.dots.length = 0; G.firstOffsets.length = 0; G.engage = null;
  G.timeLeft = 60; G.elapsed = 0;
  G.yaw = 0; G.pitch = 0; G.recoilPitch = 0; G.recoilYaw = 0; G.sprayPitch = 0; G.sprayYaw = 0;
  G.bloom = 0; G.shotIndex = 0; G.vmKick = 0;
  G.ads = false; G.firing = false;
  G.nextShot = 0; G.reloadUntil = 0; G.boltUntil = 0; G.equipping = 0;
  G.ammo = { usp: 12, ak: 30, awm: 5 };
  PLAYER.x = 0; PLAYER.z = 0; PLAYER.vx = 0; PLAYER.vz = 0;
  G.state = 'playing';
  G.startAt = now() + 1900;

  $('#menu').classList.add('hidden');
  $('#result').classList.add('hidden');
  $('#pause').classList.add('hidden');
  hudEl.classList.add('on');
  crossEl.style.display = 'block';
  scopeEl.classList.remove('on');
  $('#hint').classList.remove('fade');
  $('#hudMode').textContent = MODE_NAME[G.mode] + ' · ' + tierOf().name;
  setGun(G.gun, true);
  startMode();
  updateAmmo();
  updateHUD();

  countdown();
  lockPointer();
  setTimeout(() => { $('#hint').classList.add('fade'); }, 7000);
}

function clearCountdown() {
  const host = $('#countdown');
  if (host) host.innerHTML = '';
}

function countdown() {
  const host = $('#countdown');
  host.innerHTML = '';
  ['3', '2', '1', 'GO'].forEach((s, i) => {
    setTimeout(() => {
      if (G.state !== 'playing') return;
      const el = document.createElement('span');
      el.textContent = s;
      host.innerHTML = '';
      host.appendChild(el);
      if (s === 'GO') setTimeout(() => { if (host.firstChild === el) host.innerHTML = ''; }, 700);
    }, i * 600);
  });
}

function endRound() {
  if (G.state !== 'playing') return;
  G.state = 'result';
  G.ignoreUnlock = true;
  clearCountdown();
  if (document.pointerLockElement) document.exitPointerLock();
  hudEl.classList.remove('on');
  crossEl.style.display = 'none';
  scopeEl.classList.remove('on');
  G.elapsed = clamp(60 - G.timeLeft, 1, 60);

  const acc = G.shots ? G.hits / G.shots : 0;
  const hsRate = G.hits ? G.heads / G.hits : 0;
  const kpm = G.mode === 'spray' ? 0 : G.kills / (G.elapsed / 60);
  const avgRt = G.reaction.length ? G.reaction.reduce((a, b) => a + b, 0) / G.reaction.length : 0;

  $('#resSub').textContent = MODE_NAME[G.mode] + ' · ' + tierOf().name + ' · ' + GUNS[G.gun].name;
  $('#resScore').textContent = G.score;
  $('#resAcc').textContent = Math.round(acc * 100) + '%';
  $('#resKills').textContent = G.mode === 'spray' ? G.hits : G.kills;
  $('#resKills').parentElement.querySelector('.k').textContent = G.mode === 'spray' ? '命中' : '击杀';
  $('#resHs').textContent = Math.round(hsRate * 100) + '%';
  $('#resKpm').textContent = kpm ? kpm.toFixed(1) : '—';
  $('#resRt').textContent = avgRt ? Math.round(avgRt) + 'ms' : '—';
  $('#resStreak').textContent = G.bestStreak;

  const grade = G.score >= 1800 ? 'S' : G.score >= 1200 ? 'A' : G.score >= 700 ? 'B' : G.score >= 350 ? 'C' : 'D';
  $('#resGrade').textContent = grade + ' 级';

  // 诊断：首发偏离 + 弹着热区
  const ht = $('#heatTitle');
  if (ht) ht.textContent = G.mode === 'corner' ? '弹着分布 · 相对靶心' : '弹着热区 · 墙面投影';
  const fo = G.firstOffsets;
  if (fo.length) {
    const sorted = fo.slice().sort((a, b) => a - b);
    const avg = fo.reduce((a, b) => a + b, 0) / fo.length;
    const med = sorted[Math.floor(sorted.length / 2)];
    $('#resFirst').textContent = '首发偏离 平均 ' + Math.round(avg) + ' cm · 中位 ' + Math.round(med) + ' cm';
  } else {
    $('#resFirst').textContent = '首发偏离 —';
  }
  drawHeat();

  const b = bests();
  const bk = G.mode + '|' + S.tier;
  if (!b[bk] || G.score > b[bk]) { b[bk] = G.score; try { localStorage.setItem(BKEY, JSON.stringify(b)); } catch (e) {} }

  drawCard(grade, acc, hsRate, kpm, avgRt);
  $('#result').classList.remove('hidden');
}

function quitToMenu() {
  G.state = 'menu';
  G.ignoreUnlock = true;
  clearCountdown();
  if (document.pointerLockElement) document.exitPointerLock();
  hudEl.classList.remove('on');
  crossEl.style.display = 'none';
  scopeEl.classList.remove('on');
  $('#pause').classList.add('hidden');
  $('#result').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  syncMenu();
}

function pauseGame() {
  if (G.state !== 'playing') return;
  G.state = 'paused';
  G.pauseAt = now();
  G.ads = false;
  G.firing = false;
  clearCountdown();
  $('#pause').classList.remove('hidden');
  syncPauseUI();
}

function resumeGame() {
  $('#pause').classList.add('hidden');
  if (G.state === 'paused') {
    G.startAt += now() - G.pauseAt;
    G.nextShot += now() - G.pauseAt;
    G.reloadUntil += now() - G.pauseAt;
    G.boltUntil += now() - G.pauseAt;
    G.state = 'playing';
    lockPointer();
  } else if (G.state === 'settings') {
    G.state = 'menu';
    if (G.pauseSource === 'menu') $('#menu').classList.remove('hidden');
  }
}

/* ------------------------------------------------------------
   武器操作
   ------------------------------------------------------------ */
function currentSpread() {
  const w = GUNS[G.gun];
  let s = w.spread + G.bloom;
  if (G.ads) s = w.spread * 0.15;
  if (Math.hypot(PLAYER.vx, PLAYER.vz) > 0.6) s += 0.0045;
  /* 不开镜有一点散布，但不做 CS 那种"腰射基本打不中"的惩罚：这是练习工具，子弹要可预期 */
  if (G.gun === 'awm' && !G.ads) s = 0.006;
  return s;
}

function tryFire() {
  const w = GUNS[G.gun];
  const t = now();
  if (G.state !== 'playing' || t < G.startAt) return;
  if (t < G.reloadUntil || t < G.boltUntil || t < G.equipping) return;
  if (t < G.nextShot) return;
  if (G.ammo[G.gun] <= 0) { SFX.empty(); G.nextShot = t + 220; return; }

  G.nextShot = t + 60000 / w.rpm;
  G.ammo[G.gun]--;
  G.shots++;
  G.lastShot = t;
  G.shotIndex++;
  G.bloom = Math.min(w.maxBloom, G.bloom + w.bloom);

  const spread = currentSpread();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  // 准星方向（不含散布/弹道图案）：首发偏离量的是"你瞄得准不准"，不是子弹飘不飘
  const crossDir = dir.clone();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  dir.addScaledVector(right, rand(-1, 1) * spread)
     .addScaledVector(up, rand(-1, 1) * spread)
     .normalize();

  // 弹道图案：偏移加到子弹方向上，准星不跟着走 —— 想打中就得自己压枪
  const so = sprayOffset(G.gun, G.shotIndex - 1);
  const jt = jitterOf(G.gun);
  const soX = so[0] + jt[0], soY = so[1] + jt[1];
  const LIM = 24 * DEG;
  G.sprayPitch = clamp(G.sprayPitch + soY * DEG * (G.ads ? 0.8 : 1), -LIM, LIM);
  G.sprayYaw = clamp(G.sprayYaw + soX * DEG, -LIM, LIM);
  if (G.sprayPitch || G.sprayYaw) {
    dir.applyAxisAngle(right, G.sprayPitch);
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), G.sprayYaw);
    dir.normalize();
  }

  camera.updateMatrixWorld(true);
  const muzzlePos = new THREE.Vector3();
  VIEWS[G.gun].muzzle.getWorldPosition(muzzlePos);

  const ray = new THREE.Raycaster(camera.position, dir, 0, 90);
  const hits = ray.intersectObjects(allHitMeshes(), false);
  const hit = hits.length ? hits[0] : null;
  const endPoint = hit ? hit.point.clone() : camera.position.clone().addScaledVector(dir, 70);

  // 诊断基准：这一枪"瞄着谁"——取准星离得最近的那个活靶，而不是刚刷出来的那个
  // （以前用 G.engage，靶子在别处刷新时会把偏离量记成整条靶道那么宽）
  let near = null;
  if (Math.abs(crossDir.z) > 1e-4) {
    let bestD = Infinity;
    activeTargets.forEach(tg => {
      if (!tg.alive) return;
      const kk = (tg.group.position.z - camera.position.z) / crossDir.z;
      if (kk <= 0.5 || kk >= 90) return;
      const px = camera.position.x + crossDir.x * kk;
      const py = camera.position.y + crossDir.y * kk;
      const bx = new THREE.Box3().setFromObject(tg.body);
      bx.expandByObject(tg.head);
      const qx = clamp(px, bx.min.x, bx.max.x);
      const qy = clamp(py, bx.min.y, bx.max.y);
      const d = Math.hypot(px - qx, py - qy);
      if (d < bestD) { bestD = d; near = { t: tg, px, py, qx, qy, d, bx }; }
    });
    if (near && near.d > 6) near = null; // 差得离谱就不算瞄着它，基准留空
  }

  // 诊断：把每一发投到靶面所在平面，结算时画热区（不参与判定，纯记录）
  if (Math.abs(dir.z) > 1e-4) {
    const planeZ = (G.mode === 'corner' && near) ? near.t.group.position.z : TARGET_Z;
    const k = (planeZ - camera.position.z) / dir.z;
    if (k > 0.5 && k < 90) {
      const px = camera.position.x + dir.x * k;
      const py = camera.position.y + dir.y * k;
      // 相对靶心的偏移（米）：走廊五个门洞不在同一平面，只有相对量可比
      let dx = null, dy = null;
      if (near) {
        const c2 = near.bx.getCenter(new THREE.Vector3());
        dx = px - c2.x; dy = py - c2.y;
      }
      G.dots.push({
        x: px,
        y: py,
        dx, dy,
        hit: !!(hit && hit.object.userData.target),
        head: !!(hit && hit.object.name === 'head')
      });
      if (G.dots.length > 600) G.dots.shift();
    }
  }

  // 诊断：这一枪的准星离靶子有多远（cm，量到靶身包围盒的最近距离）
  // 用厘米不用角度——角度会被距离放大，同一次手抖在 7 米和 35 米读数完全不同
  // 基准靶：打中了就用命中的那个；没中只有"擦边"(≤1.5m)才记，否则算在看别处，不计入
  const refT = (hit && hit.object.userData.target) ? hit.object.userData.target
             : (near && near.d <= 1.5 ? near.t : null);
  if (refT && Math.abs(crossDir.z) > 1e-4) {
    // 每个靶"刚出现后的第一枪"算一次首发，同一目标后续的枪不重复计入
    if (refT.spawnId !== G.lastFirstSpawn) {
      const kc = (refT.group.position.z - camera.position.z) / crossDir.z;
      if (kc > 0.5 && kc < 90) {
        const px = camera.position.x + crossDir.x * kc;
        const py = camera.position.y + crossDir.y * kc;
        const bc = new THREE.Box3().setFromObject(refT.body).getCenter(new THREE.Vector3());
        G.lastFirstSpawn = refT.spawnId;
        G.firstOffsets.push(Math.hypot(px - bc.x, py - bc.y) * 100);
        if (G.firstOffsets.length > 200) G.firstOffsets.shift();
      }
    }
  }

  spawnTracer(muzzlePos, endPoint, G.gun === 'awm' ? 0xfff0c8 : 0xffc98a);
  SFX.shot(G.gun);
  muzzleFlash(muzzlePos, G.gun === 'awm' ? 0.55 : G.gun === 'ak' ? 0.3 : 0.22);
  SFX.shell();
  spawnShell(VIEWS[G.gun].eject.getWorldPosition(new THREE.Vector3()), dir);
  G.vmKick = Math.min(1.6, G.vmKick + (G.gun === 'awm' ? 1.3 : 0.45));
  G.shake = Math.min(0.05, G.shake + (G.gun === 'awm' ? 0.035 : 0.008));

  // 后坐力（视觉上的枪口跳动；真正的弹道偏移由 sprayPitch/Yaw 负责）
  const kick = w.recoilUp * 0.35 * (G.ads ? 0.8 : 1);
  const side = rand(-1, 1) * w.recoilSide * 0.5;
  G.recoilPitch += kick * DEG * rand(0.9, 1.1);
  G.recoilYaw += side * DEG;

  if (G.gun === 'awm') {
    G.boltUntil = t + 1150;
    setTimeout(() => SFX.bolt(), 520);
  }

  if (hit) {
    const obj = hit.object;
    const tgt = obj.userData.target;
    if (tgt) {
      const isHead = obj.name === 'head';
      const dmg = isHead ? w.head : w.body;
      tgt.hp -= dmg;
      tgt.flash = 1;
      tgt.mat.emissive.setHex(0xff2a18);
      tgt.mat.emissiveIntensity = 1.0;
      G.hits++;
      if (isHead) G.heads++;
      SFX.hit(isHead);
      hitmarker(isHead);
      floatText(hit.point, String(dmg), isHead ? 'head' : '');
      const n = new THREE.Vector3(0, 0, 1).transformDirection(obj.matrixWorld);
      spawnSparks(hit.point, n, isHead ? 18 : 10, isHead ? 0xffd24a : 0xffb066);
      if (G.mode === 'spray') {
        G.score += 12;
        G.sprayHits++;
        addDecal(hit.point, n);
      }
      if (tgt.hp <= 0) killTarget(tgt, isHead);
    } else {
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
      addDecal(hit.point, n);
      spawnSparks(hit.point, n, 7, 0xff9a55);
    }
  }
  updateAmmo();
}

function killTarget(t, head) {
  deactivateTarget(t);
  G.kills++;
  G.streak++;
  if (G.streak > G.bestStreak) G.bestStreak = G.streak;
  const mult = 1 + Math.min(2, Math.floor(G.streak / 4) * 0.5);
  const pts = Math.round((head ? 150 : 100) * mult);
  G.score += pts;
  SFX.kill();
  killFeed((head ? 'HEADSHOT' : 'KILL') + '  +' + pts, head ? 'head' : '');
  if (G.mode === 'flick') G.reaction.push(now() - G.spawnAt);
  // 走廊要的是"一个门接一个门"的节奏，间隔比靶场短
  t.respawnAt = now() + (G.mode === 'corner' ? Math.max(300, tierOf().refresh - 200) : tierOf().refresh);
}

function reload() {
  const w = GUNS[G.gun];
  const t = now();
  if (G.state !== 'playing' || t < G.startAt) return;
  if (t < G.reloadUntil || t < G.boltUntil) return;
  if (G.ammo[G.gun] >= w.mag) return;
  G.reloadStart = t;
  G.reloadDur = w.reload * 1000;
  G.reloadUntil = t + G.reloadDur;
  G.reloadCue = 0;
  SFX.reload();
  const bar = $('#reloadBar');
  bar.classList.remove('hidden');
}

function finishReload() {
  G.ammo[G.gun] = GUNS[G.gun].mag;
  G.reloadUntil = 0;
  $('#reloadBar').classList.add('hidden');
  updateAmmo();
}

/* ------------------------------------------------------------
   指针锁定
   ------------------------------------------------------------ */
function lockPointer() {
  G.ignoreUnlock = false;
  const p = canvas.requestPointerLock && canvas.requestPointerLock();
  if (p && p.catch) p.catch(() => {});
}

document.addEventListener('pointerlockchange', () => {
  G.locked = document.pointerLockElement === canvas;
  if (!G.locked && G.state === 'playing' && !G.ignoreUnlock) pauseGame();
});

document.addEventListener('pointerlockerror', () => {
  if (G.state === 'playing') {
    const hint = $('#hint');
    hint.textContent = '鼠标锁定失败 —— 点一下画面再试';
    hint.classList.remove('fade');
  }
});

canvas.addEventListener('click', () => {
  if (G.state === 'playing' && !G.locked) lockPointer();
});

/* ------------------------------------------------------------
   输入
   ------------------------------------------------------------ */
addEventListener('mousemove', e => {
  if (!G.locked || G.state !== 'playing') return;
  const zoomK = G.ads && GUNS[G.gun].zoom ? (camera.fov / S.fov) : 1;
  const k = degPerCount() * DEG * zoomK * (S.invertY ? -1 : 1);
  G.yaw -= e.movementX * k;
  G.pitch -= e.movementY * k;
  G.pitch = clamp(G.pitch, -1.45, 1.45);
  G.swayX = clamp(G.swayX + e.movementX * 0.0005, -0.06, 0.06);
  G.swayY = clamp(G.swayY - e.movementY * 0.0005, -0.05, 0.05);
});

addEventListener('mousedown', e => {
  if (G.state !== 'playing') return;
  if (e.button === 0) { G.firing = true; G.shotIndex = 0; tryFire(); }
  if (e.button === 2) { if (GUNS[G.gun].zoom) { G.ads = true; } }
});
addEventListener('mouseup', e => {
  if (e.button === 0) G.firing = false;
  if (e.button === 2) G.ads = false;
});
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('blur', () => { G.firing = false; G.ads = false; });

addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    if (G.state === 'playing' && !document.pointerLockElement) pauseGame();
    return;
  }
  if (G.state !== 'playing') return;
  keys[e.code] = true;
  if (e.code === 'KeyR') reload();
  if (e.code === 'Digit1') setGun('usp');
  if (e.code === 'Digit2') setGun('ak');
  if (e.code === 'Digit3') setGun('awm');
});
addEventListener('keyup', e => { keys[e.code] = false; });

/* ------------------------------------------------------------
   更新
   ------------------------------------------------------------ */
function updatePlayer(dt) {
  let ix = 0, iz = 0;
  if (keys.KeyW) iz -= 1;
  if (keys.KeyS) iz += 1;
  if (keys.KeyA) ix -= 1;
  if (keys.KeyD) ix += 1;
  const len = Math.hypot(ix, iz) || 1;
  ix /= len; iz /= len;
  const spd = (keys.ShiftLeft || keys.ShiftRight) ? 2.0 : 4.2;
  const sin = Math.sin(G.yaw), cos = Math.cos(G.yaw);
  const wx = (cos * ix + sin * iz) * spd;
  const wz = (-sin * ix + cos * iz) * spd;
  const a = 1 - Math.exp(-dt * 12);
  PLAYER.vx = lerp(PLAYER.vx, wx, a);
  PLAYER.vz = lerp(PLAYER.vz, wz, a);
  const corr = G.mode === 'corner';
  const bx = corr ? 1.45 : BOUNDS.x;
  const bzMin = corr ? -20.6 : BOUNDS.zMin;
  const bzMax = corr ? 0.9 : BOUNDS.zMax;
  PLAYER.x = clamp(PLAYER.x + PLAYER.vx * dt, -bx, bx);
  PLAYER.z = clamp(PLAYER.z + PLAYER.vz * dt, bzMin, bzMax);
  const sp = Math.hypot(PLAYER.vx, PLAYER.vz);
  G.bob += dt * sp * 2.4;
}

function smooth01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }

/* 换弹相位：0–0.14 下沉 / 0.20 脱扣 / 0.20–0.50 抽匣下落 / 0.50–0.52 空档 /
   0.52–0.70 新匣上移 / 0.70–0.84 推入 / 0.86–1.0 回位；AK 末尾拉枪机，AWM 末尾拉栓 */
function poseReload(V, p) {
  const drop = smooth01((p - 0.20) / 0.30);
  const rise = smooth01((p - 0.52) / 0.18);
  const push = smooth01((p - 0.70) / 0.14);
  const travel = -0.42 * drop * (1 - rise * push);

  if (V.mag) {
    V.mag.position.y = V.magHome.y + travel;
    V.mag.position.z = V.magHome.z + drop * (1 - rise) * 0.02;
    V.mag.rotation.x = V.magRot0 + drop * (1 - rise) * 0.34;
    V.mag.visible = !(p > 0.485 && p < 0.545);
  }
  if (V.bolt) {
    const lift = smooth01((p - 0.72) / 0.08) * (1 - smooth01((p - 0.94) / 0.06));
    const pull = smooth01((p - 0.76) / 0.08) * (1 - smooth01((p - 0.88) / 0.06));
    V.bolt.rotation.x = -0.34 * lift;
    if (V.boltHome) V.bolt.position.z = V.boltHome.z + 0.085 * pull;
  }

  if (handR && handL) {
    const fin = smooth01((p - 0.04) / 0.10);
    const fout = smooth01((p - 0.90) / 0.08);
    const on = fin * (1 - fout);
    handR.visible = handL.visible = on > 0.02;
    handR.position.copy(V.grip).add(new THREE.Vector3(0.014, -0.004 - (1 - on) * 0.12, 0.060));
    handR.rotation.set(-0.26, 0.16, 0.14);
    const tgt = (V.bolt && p > 0.74 ? V.boltA : V.magA).clone();
    tgt.y += travel + 0.012;
    const low = tgt.clone().add(new THREE.Vector3(-0.20, -0.26, 0.08));
    handL.position.lerpVectors(low, tgt, on);
    handL.rotation.set(-0.70, -0.26, -0.22);
  }

  if (p >= 0.20 && G.reloadCue < 1) { G.reloadCue = 1; SFX.magOut(); }
  if (p >= 0.72 && G.reloadCue < 2) { G.reloadCue = 2; SFX.magIn(); }
  if (p >= 0.86 && G.reloadCue < 3) {
    G.reloadCue = 3;
    if (G.gun === 'ak') SFX.charge();
    else if (G.gun === 'awm') SFX.bolt();
  }
}

function restViewModel(V) {
  if (!V) return;
  if (V.mag && V.magHome) {
    if (!V.mag.visible) V.mag.visible = true;
    V.mag.position.copy(V.magHome);
    V.mag.rotation.x = V.magRot0;
  }
  if (V.bolt && V.boltHome) {
    V.bolt.rotation.x = 0;
    V.bolt.position.copy(V.boltHome);
  }
  if (handR && handR.visible) { handR.visible = false; handL.visible = false; }
}

function updateView(dt) {
  G.vmKick = lerp(G.vmKick, 0, 1 - Math.exp(-dt * 13));
  G.swayX = lerp(G.swayX, 0, 1 - Math.exp(-dt * 7));
  G.swayY = lerp(G.swayY, 0, 1 - Math.exp(-dt * 7));

  let dip = 0, twist = 0, lift = 0, shiftX = 0;
  const V = VIEWS[G.gun];
  if (now() < G.reloadUntil && V) {
    const p = clamp(1 - (G.reloadUntil - now()) / Math.max(1, G.reloadDur), 0, 1);
    const env = smooth01(p / 0.14) * (1 - smooth01((p - 0.86) / 0.14));
    dip = env * 0.085;
    twist = env * 0.30;
    lift = env * 0.075;
    shiftX = -env * 0.045;
    poseReload(V, p);
  } else {
    restViewModel(V);
  }
  if (now() < G.boltUntil) {
    const p = 1 - (G.boltUntil - now()) / 1150;
    dip = Math.max(dip, Math.sin(clamp(p, 0, 1) * Math.PI) * 0.05);
    twist = Math.max(twist, Math.sin(clamp(p, 0, 1) * Math.PI) * 0.28);
  }
  const sp = Math.hypot(PLAYER.vx, PLAYER.vz);
  vmRoot.position.set(
    Math.sin(G.bob) * 0.005 * (sp / 4.2) + G.swayX * 0.35 + shiftX,
    -dip * 0.55 + Math.cos(G.bob * 2) * 0.003 * (sp / 4.2) + lift,
    G.vmKick * 0.055
  );
  vmRoot.rotation.set(-dip * 1.4 + G.vmKick * 0.10, G.swayX * 0.9, twist * 0.6);
  vmRoot.visible = !(G.gun === 'awm' && G.adsT > 0.55);
}

function updateFX(dt) {
  // 弹孔淡出
  for (let i = decals.length - 1; i >= 0; i--) {
    const d = decals[i];
    d.t += dt;
    if (d.t > d.life) {
      scene.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.material.dispose();
      decals.splice(i, 1);
    } else if (d.t > d.life - 3) {
      d.mesh.material.opacity = 0.9 * (d.life - d.t) / 3;
    }
  }
  // 火花 / 曳光
  for (let i = fxList.length - 1; i >= 0; i--) {
    const f = fxList[i];
    f.t += dt;
    if (f.type === 'sparks') {
      const arr = f.obj.geometry.attributes.position.array;
      for (let j = 0; j < f.vel.length; j++) {
        const v = f.vel[j];
        v.y -= 9.8 * dt;
        arr[j * 3] += v.x * dt; arr[j * 3 + 1] += v.y * dt; arr[j * 3 + 2] += v.z * dt;
      }
      f.obj.geometry.attributes.position.needsUpdate = true;
      f.obj.material.opacity = Math.max(0, 1 - f.t / f.life);
    } else {
      f.obj.material.opacity = Math.max(0, 0.85 * (1 - f.t / f.life));
    }
    if (f.t >= f.life) {
      scene.remove(f.obj);
      if (f.obj.geometry) f.obj.geometry.dispose();
      if (f.obj.material) f.obj.material.dispose();
      fxList.splice(i, 1);
    }
  }
  // 弹壳
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i];
    s.t += dt;
    const p = s.mesh.position;
    s.v.y -= 9.8 * dt;
    p.addScaledVector(s.v, dt);
    s.mesh.rotation.x += s.spin.x * dt;
    s.mesh.rotation.y += s.spin.y * dt;
    s.mesh.rotation.z += s.spin.z * dt;
    if (p.y < 0.02) { p.y = 0.02; s.v.y *= -0.32; s.v.x *= 0.6; s.v.z *= 0.6; s.spin.multiplyScalar(0.6); }
    if (s.t > s.life) { scene.remove(s.mesh); shells.splice(i, 1); }
  }
  // 枪口闪光
  if (now() > flashUntil) {
    flashSprite.visible = false;
    flashLight.intensity = 0;
  }
}

function update(dt) {
  const t = now();

  if (G.state === 'playing') {
    if (t > G.startAt) {
      G.timeLeft -= dt;
      if (G.timeLeft <= 0) { G.timeLeft = 0; updateHUD(); endRound(); }
    }
    updatePlayer(dt);

    // 连发
    if (G.firing && GUNS[G.gun].auto && t > G.startAt) tryFire();

    // 换弹完成
    if (G.reloadUntil && t >= G.reloadUntil) finishReload();

    // 空仓自动换弹
    if (G.ammo[G.gun] === 0 && !G.reloadUntil && t > G.nextShot + 250 && t < G.boltUntil + 1e9) reload();

    // 后坐力恢复
    if (t - G.lastShot > 140) {
      G.recoilPitch *= Math.exp(-dt * 7);
      G.recoilYaw *= Math.exp(-dt * 7);
    }
    // 弹道偏移回落：停火 260ms 后开始收，约 0.4s 收回准星
    if (t - G.lastShot > 260) {
      const k2 = Math.exp(-dt * 5.5);
      G.sprayPitch *= k2; G.sprayYaw *= k2;
      if (Math.abs(G.sprayPitch) < 1e-4) G.sprayPitch = 0;
      if (Math.abs(G.sprayYaw) < 1e-4) G.sprayYaw = 0;
    }
    G.bloom = Math.max(0, G.bloom - dt * 0.018);
    if (t - G.lastShot > 400) G.shotIndex = 0;

    // 目标闪红 / 重生
    for (const tg of activeTargets) {
    if (tg.alive) moveTarget(tg, t, dt);
      if (tg.flash > 0) {
        tg.flash = Math.max(0, tg.flash - dt * 5.5);
        tg.mat.emissiveIntensity = tg.flash;
        if (tg.flash === 0) tg.mat.emissive.setHex(0x000000);
      }
      if (!tg.alive && tg.respawnAt && t >= tg.respawnAt && G.mode !== 'spray') {
        tg.respawnAt = 0;
        respawnFree(tg);
      }
    }

    // 换弹进度条
    if (G.reloadUntil) {
      const p = 1 - (G.reloadUntil - t) / G.reloadDur;
      $('#reloadFill').style.width = (clamp(p, 0, 1) * 100) + '%';
    }

    const wantAds = G.ads && !!GUNS[G.gun].zoom;
    G.adsT = lerp(G.adsT, wantAds ? 1 : 0, 1 - Math.exp(-dt * 16));
    const targetFov = wantAds ? GUNS[G.gun].zoom : S.fov;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov = lerp(camera.fov, targetFov, 1 - Math.exp(-dt * 18));
      camera.updateProjectionMatrix();
    }
    scopeEl.classList.toggle('on', G.adsT > 0.55);
    crossEl.style.opacity = G.adsT > 0.5 ? 0 : 1;

    const sh = G.shake;
    G.shake = Math.max(0, G.shake - dt * 0.35);
    camera.position.set(
      PLAYER.x + rand(-1, 1) * sh,
      1.62 + Math.sin(G.bob) * 0.018,
      PLAYER.z + rand(-1, 1) * sh
    );
    camera.rotation.set(G.pitch + G.recoilPitch, G.yaw + G.recoilYaw, 0);

    // 计时器颜色
    if (G.timeLeft <= 10) $('#hudTimerWrap').classList.add('low');
    updateHUD();
  } else if (G.state === 'result' || G.state === 'menu') {
    // 菜单时缓慢环视，别让背景死掉
    if (G.state === 'menu') {
      G.yaw = Math.sin(t * 0.00006) * 0.12;
      G.pitch = Math.sin(t * 0.00004) * 0.03;
      camera.position.set(0, 1.62, 0);
      camera.rotation.set(G.pitch, G.yaw, 0);
      camera.fov = lerp(camera.fov, S.fov, 0.05);
      camera.updateProjectionMatrix();
    }
  }

  // 尘埃
  const dp = dust.geometry.attributes.position.array;
  for (let i = 0; i < DUST_N; i++) {
    dp[i * 3 + 1] += Math.sin(t * 0.0004 + dustSeed[i * 2]) * 0.0006 + 0.0004;
    if (dp[i * 3 + 1] > 7) dp[i * 3 + 1] = 0.2;
    dp[i * 3] += Math.sin(t * 0.0003 + dustSeed[i * 2 + 1]) * 0.0005;
  }
  dust.geometry.attributes.position.needsUpdate = true;

  updateView(dt);
  updateFX(dt);
}

/* ------------------------------------------------------------
   结算卡
   ------------------------------------------------------------ */
const BKEY = 'range.best.v1';
function bests() { try { return JSON.parse(localStorage.getItem(BKEY) || '{}'); } catch (e) { return {}; } }

/* 结算页的弹着热区：把每发子弹按靶面平面投影，画出偏哪儿 */
function drawHeat() {
  const cv = $('#heatCanvas');
  if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const X0 = -10.0, X1 = 10.0, Y0 = 0.2, Y1 = 4.4;
  const sx = x => (x - X0) / (X1 - X0) * W;
  const sy = y => H - (y - Y0) / (Y1 - Y0) * H;

  g.fillStyle = '#08090b';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.045)';
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = H * i / 4; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }

  // 走廊模式：靶心散点图（不同门洞距离不同，绝对投影没意义）
  if (G.mode === 'corner') {
    const cx = W / 2, cy = H * 0.62;
    const pxm = 70;                      // 每米像素
    // 参照系 = 靶身+头的包围盒中心（和 dots 的 dx/dy 同一原点）
    const bw2 = 0.74 * pxm, top = 0.44 * pxm, bot = 0.83 * pxm;
    g.strokeStyle = 'rgba(150,162,180,.55)';
    g.fillStyle = 'rgba(255,255,255,.035)';
    g.fillRect(cx - bw2 / 2, cy - top, bw2, top + bot);
    g.strokeRect(cx - bw2 / 2, cy - top, bw2, top + bot);
    g.beginPath();
    g.arc(cx, cy - 0.67 * pxm, 0.155 * pxm, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([3, 5]);
    g.strokeStyle = 'rgba(140,150,165,.22)';
    [0.15, 0.35].forEach(r => { g.beginPath(); g.arc(cx, cy - 0.67 * pxm, r * pxm, 0, Math.PI * 2); g.stroke(); });
    g.setLineDash([]);
    g.beginPath(); g.moveTo(cx, 4); g.lineTo(cx, H - 4); g.stroke();
    g.beginPath(); g.moveTo(4, cy); g.lineTo(W - 4, cy); g.stroke();

    G.dots.forEach(d => {
      if (d.dx == null) return;
      const x = cx + d.dx * pxm, y = cy - d.dy * pxm;
      const R2 = 11;
      const grd = g.createRadialGradient(x, y, 0, x, y, R2);
      if (d.head) { grd.addColorStop(0, 'rgba(255,214,80,.66)'); grd.addColorStop(1, 'rgba(255,214,80,0)'); }
      else if (d.hit) { grd.addColorStop(0, 'rgba(255,122,47,.6)'); grd.addColorStop(1, 'rgba(255,122,47,0)'); }
      else { grd.addColorStop(0, 'rgba(150,160,175,.34)'); grd.addColorStop(1, 'rgba(150,160,175,0)'); }
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, R2, 0, Math.PI * 2); g.fill();
    });

    g.fillStyle = 'rgba(230,235,240,.38)';
    g.font = '10px Bahnschrift, "Segoe UI", sans-serif';
    g.fillText('相对靶心 · 每格 0.35 m', 8, 14);
    return;
  }

  // 靶位轮廓（体型 + 头），让你知道这些点相对靶子落在哪
  const bh = 1.27 * H / (Y1 - Y0);
  const bw = 0.55 * W / (X1 - X0);
  const midX = sx(0);
  g.strokeStyle = 'rgba(255,255,255,.10)';
  g.setLineDash([4, 6]);
  g.beginPath(); g.moveTo(midX, 0); g.lineTo(midX, H); g.stroke();
  g.setLineDash([]);
  slotsFor().forEach(s => {
    const cx = sx(s.x), cy = sy(s.y - 0.145);
    g.strokeStyle = 'rgba(140,150,165,.32)';
    g.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
    g.beginPath();
    g.arc(cx, sy(s.y + 0.72), Math.max(3, bh * 0.115), 0, Math.PI * 2);
    g.stroke();
  });

  const R = 14;
  G.dots.forEach(d => {
    const x = sx(d.x), y = sy(d.y);
    if (x < -R || x > W + R || y < -R || y > H + R) return;
    const grd = g.createRadialGradient(x, y, 0, x, y, R);
    if (d.head) { grd.addColorStop(0, 'rgba(255,214,80,.62)'); grd.addColorStop(1, 'rgba(255,214,80,0)'); }
    else if (d.hit) { grd.addColorStop(0, 'rgba(255,122,47,.55)'); grd.addColorStop(1, 'rgba(255,122,47,0)'); }
    else { grd.addColorStop(0, 'rgba(150,160,175,.30)'); grd.addColorStop(1, 'rgba(150,160,175,0)'); }
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
  });

  g.fillStyle = 'rgba(230,235,240,.35)';
  g.font = '10px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText('左', 6, H / 2 + 4);
  g.fillText('右', W - 16, H / 2 + 4);
}

function drawCard(grade, acc, hsRate, kpm, avgRt) {
  const c = $('#cardCanvas');
  const g = c.getContext('2d');
  const W = 640, H = 800;
  g.fillStyle = '#0a0b0e'; g.fillRect(0, 0, W, H);
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, 'rgba(255,122,47,0.10)');
  grd.addColorStop(0.45, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ff7a2f'; g.fillRect(0, 0, W, 6);

  g.fillStyle = '#e9e7e1'; g.font = '600 26px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText('RANGE', 40, 78);
  g.fillStyle = '#868b93'; g.font = '400 12px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText('靶 场 · TRAINING RECORD', 40, 100);

  const d = new Date();
  const ds = d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
  g.textAlign = 'right';
  g.fillText(ds, W - 40, 78);
  g.textAlign = 'left';

  g.fillStyle = '#868b93'; g.font = '400 12px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText(MODE_NAME[G.mode] + ' · ' + GUNS[G.gun].name, 40, 160);

  g.fillStyle = '#e9e7e1'; g.font = '700 150px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText(String(G.score), 36, 300);
  g.fillStyle = '#868b93'; g.font = '400 13px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText('SCORE', 42, 330);

  g.strokeStyle = '#ff7a2f'; g.lineWidth = 1;
  g.strokeRect(W - 120, 196, 80, 80);
  g.fillStyle = '#ff7a2f'; g.font = '700 44px Bahnschrift, "Segoe UI", sans-serif';
  g.textAlign = 'center'; g.fillText(grade, W - 80, 250); g.textAlign = 'left';

  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.beginPath(); g.moveTo(40, 380); g.lineTo(W - 40, 380); g.stroke();

  const stats = [
    ['命中率', Math.round(acc * 100) + '%'],
    ['击杀', String(G.mode === 'spray' ? G.hits : G.kills)],
    ['爆头率', Math.round(hsRate * 100) + '%'],
    ['每分钟击杀', kpm ? kpm.toFixed(1) : '—'],
    ['平均反应', avgRt ? Math.round(avgRt) + ' ms' : '—'],
    ['最高连击', String(G.bestStreak)]
  ];
  stats.forEach(([k, v], i) => {
    const col = i % 2, row = (i / 2) | 0;
    const x = 40 + col * 290, y = 440 + row * 88;
    g.fillStyle = '#868b93'; g.font = '400 12px Bahnschrift, "Segoe UI", sans-serif';
    g.fillText(k, x, y);
    g.fillStyle = '#e9e7e1'; g.font = '600 30px Bahnschrift, "Segoe UI", sans-serif';
    g.fillText(v, x, y + 40);
  });

  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.beginPath(); g.moveTo(40, 700); g.lineTo(W - 40, 700); g.stroke();
  g.fillStyle = '#868b93'; g.font = '400 12px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText('cm/360  ' + cm360().toFixed(1) + '   ·   DPI ' + S.dpi + '   ·   CS ' + S.csSens.toFixed(2), 40, 742);
  g.fillStyle = '#ff7a2f'; g.font = '400 11px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText('LOCAL RECORD — 打开网页就能练', 40, 766);
}

function saveCard() {
  const a = document.createElement('a');
  a.download = 'range-' + G.mode + '-' + G.score + '.png';
  a.href = $('#cardCanvas').toDataURL('image/png');
  a.click();
}

/* ------------------------------------------------------------
   设置 / 菜单绑定
   ------------------------------------------------------------ */
function syncMenu() {
  $$('#tierRow .tier').forEach(x => x.classList.toggle('sel', x.dataset.tier === S.tier));
  $('#dpiInput').value = S.dpi;
  $('#sensInput').value = S.csSens.toFixed(2);
  $('#cmOut').textContent = cm360().toFixed(1);
  const b = bests();
  ['grid', 'flick', 'spray'].forEach(m => { if (b[m] && !b[m + '|std']) b[m + '|std'] = b[m]; });
  const parts = ['grid', 'flick', 'spray']
    .map(m => [m, b[m + '|' + S.tier]])
    .filter(([, v]) => v)
    .map(([m, v]) => MODE_NAME[m] + ' ' + v);
  $('#menuBest').textContent = parts.length ? '本机最佳 · ' + TIERS[S.tier].name + ' · ' + parts.join('  /  ') : '';
}

function syncPauseUI() {
  $('#volRange').value = S.volume;
  $('#fovRange').value = S.fov;
  $('#invertChk').checked = S.invertY;
  $('#pDpi').value = S.dpi;
  $('#pSens').value = S.csSens.toFixed(2);
  $('#pCm').textContent = cm360().toFixed(1) + ' cm';
}

function applySettings() {
  saveS();
  $('#cmOut').textContent = cm360().toFixed(1);
  SFX.setVolume(S.volume);
  if (!G.ads) { camera.fov = S.fov; camera.updateProjectionMatrix(); }
}

$$('#gunCards .gun').forEach(el => {
  el.addEventListener('click', () => {
    $$('#gunCards .gun').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    G.gun = el.dataset.gun;
  });
});

$$('#modeRow .mode').forEach(el => {
  el.addEventListener('click', () => {
    $$('#modeRow .mode').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    G.mode = el.dataset.mode;
  });
});

$$('#tierRow .tier').forEach(el => {
  el.addEventListener('click', () => {
    $$('#tierRow .tier').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    S.tier = el.dataset.tier;
    saveS();
    syncMenu();
  });
});
$('#dpiInput').addEventListener('input', e => {
  const v = clamp(parseInt(e.target.value, 10) || 800, 100, 6400);
  S.dpi = v; applySettings();
});
$('#sensInput').addEventListener('input', e => {
  const v = clamp(parseFloat(e.target.value) || 2, 0.1, 10);
  S.csSens = v; applySettings();
});

$('#btnStart').addEventListener('click', () => {
  SFX.init();
  SFX.ambient(true);
  startRound();
});

$('#btnPauseSettings').addEventListener('click', () => {
  G.pauseSource = 'menu';
  G.state = 'settings';
  $('#menu').classList.add('hidden');
  $('#pause').classList.remove('hidden');
  syncPauseUI();
});

$('#btnResume').addEventListener('click', () => {
  if (G.state === 'settings') {
    $('#pause').classList.add('hidden');
    G.state = 'menu';
    $('#menu').classList.remove('hidden');
    G.pauseSource = 'game';
  } else {
    resumeGame();
  }
});
$('#btnRestart').addEventListener('click', () => { startRound(); });
$('#btnQuit').addEventListener('click', () => { quitToMenu(); });
$('#btnRetry').addEventListener('click', () => { startRound(); });
$('#btnMenu').addEventListener('click', () => { quitToMenu(); });
$('#btnSaveCard').addEventListener('click', saveCard);

$('#volRange').addEventListener('input', e => { S.volume = parseFloat(e.target.value); applySettings(); });
$('#fovRange').addEventListener('input', e => { S.fov = parseInt(e.target.value, 10); applySettings(); });
$('#invertChk').addEventListener('change', e => { S.invertY = e.target.checked; applySettings(); });
$('#pDpi').addEventListener('input', e => { S.dpi = clamp(parseInt(e.target.value, 10) || 800, 100, 6400); applySettings(); syncPauseUI(); });
$('#pSens').addEventListener('input', e => { S.csSens = clamp(parseFloat(e.target.value) || 2, 0.1, 10); applySettings(); syncPauseUI(); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden && G.state === 'playing') pauseGame();
});

/* ------------------------------------------------------------
   启动
   ------------------------------------------------------------ */
mountViews();
setGun('usp', true);
syncMenu();
camera.fov = S.fov;
camera.updateProjectionMatrix();
scopeEl.classList.remove('on');
crossEl.style.display = 'none';

let lastT = 0;
const fpsEl = document.getElementById('hudFps');
let fpsAcc = 0, fpsN = 0, fpsClock = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, lastT ? (t - lastT) / 1000 : 0.016);
  lastT = t;
  update(dt);
  renderer.render(scene, camera);

  /* 帧率：每 0.5s 取一次平均，掉帧能被看见 */
  fpsAcc += dt; fpsN++; fpsClock += dt;
  if (fpsClock >= 0.5 && fpsEl) {
    const fps = fpsN / Math.max(0.001, fpsAcc);
    fpsEl.textContent = fps.toFixed(0) + ' FPS';
    fpsEl.style.color = fps < 45 ? '#ff8a5c' : '#5d646e';
    fpsAcc = 0; fpsN = 0; fpsClock = 0;
  }
}
requestAnimationFrame(frame);

/* 调试入口：控制台里能直接读写状态、跳过指针锁定做自动化测试 */
window.RANGE = {
  G, S, GUNS, THREE, scene, camera, renderer,
  get slots() { return slotsFor(); },
  get deepSlots() { return DEEP_SLOTS; },
  get lane() { return { TARGET_Z, deepVisible: deep.visible, cornerVisible: cornerView.visible, corners: CORNERS }; },
  get targets() { return activeTargets; },
  get vm() { return { handR, handL, VIEWS, vmRoot }; },
  get samples() { return SFX.sampleInfo(); },
  sprayOffset, jitterOf, currentSpread,
  startRound, endRound, pauseGame, resumeGame, quitToMenu,
  setGun, tryFire, reload, applySettings, syncMenu,
  setMode(k) { const el = $('#modeRow .mode[data-mode="' + k + '"]'); if (el) el.click(); },
  fireOnce(ms) {
    G.firing = true; G.shotIndex = 0;
    const t0 = performance.now();
    const tick = () => {
      if (performance.now() - t0 > (ms || 120)) { G.firing = false; return; }
      requestAnimationFrame(tick);
    };
    tick();
  }
};

})();
