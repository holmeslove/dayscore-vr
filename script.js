/**
 * DayScore VR — script.js
 *
 * A 3D tactile version of DayScore for Meta Quest 3 (and any WebXR-capable headset).
 * Talks to the same Supabase backend as the web app, so habits sync in real time.
 *
 * URL: /{planId}  — loads today's habits for that plan.
 *      /          — generates a new planId and redirects.
 *
 * Interaction: point with a controller, pull trigger to toggle a habit.
 */

import * as THREE                  from 'three';
import { VRButton }                 from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { RoundedBoxGeometry }       from 'three/addons/geometries/RoundedBoxGeometry.js';

// ─── Supabase config (shared with dayscore.holmes.love) ─────────────────────
const SUPABASE_URL      = 'https://kyekshvamhvkhfgkcrrk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5ZWtzaHZhbWh2a2hmZ2tjcnJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3MTIzNzcsImV4cCI6MjA5NDI4ODM3N30.CX2RRrn5psCW5PuxYXK4RaStpZ6pF-I63p7Pi3UKSE8';

// ─── localStorage ───────────────────────────────────────────────────────────
const KEYS = { planId: 'dayscore_vr_plan_id' };

// ─── Default habits (used only when generating a fresh plan) ────────────────
const DEFAULT_PLAN = `Drink a full glass of water (3)
Morning stretch or movement (5)
Eat a healthy breakfast (6)
Review goals for the day (7)
Take a short walk outside (8)
Meditate or breathe for 5 min (6)
Read something interesting (5)
No scrolling before 10am (7)
Cook a real meal (6)
Wind down before midnight (4)`;

// ─── Palette (DayScore dark, lifted a few stops so panels read in VR) ───────
const COLORS = {
  bg:           0x0d0d0b,
  panelBg:      '#2a2a26',
  panelHover:   '#3a3a34',
  panelBorder:  '#4a4a44',
  panelHoverBorder: '#ebebdf',
  textPrimary:  '#ebebdf',
  textSecondary:'#a8a89a',
  textMuted:    '#777770',
  textDone:     '#5a5a54',
  ringTrack:    0x1e1e1a,
  ringFill:     0xebebdf,
  checkFill:    '#ebebdf',
};

// ─── Geometry constants ─────────────────────────────────────────────────────
const RING_RADIUS    = 0.32;
const RING_TUBE      = 0.018;
const RING_POSITION  = new THREE.Vector3(0, 1.85, -1.15);
const HABIT_W        = 0.44;
const HABIT_H        = 0.11;
const HABIT_D        = 0.028;  // panel thickness — gives real 3D depth
const CANVAS_W       = 2048;
const CANVAS_H       = Math.round(CANVAS_W * (HABIT_H / HABIT_W));

// ─── URL / planId resolution ────────────────────────────────────────────────
const pathParts = window.location.pathname.replace(/^\//, '').split('/').filter(Boolean);
let planId      = pathParts[0] || null;
let currentDate = pathParts[1] || todayStr();
let remoteContent = null;

// ─── Three.js state ─────────────────────────────────────────────────────────
let scene, camera, renderer, raycaster;
let ringTrack, ringFill;
let scorePlane, scoreCanvas, scoreCtx, scoreTexture;
let habitPanels = [];      // { group, caseMesh, screenMesh, canvas, ctx, texture, habit, hovered, scale, scaleVel, pressBoost, emissiveTarget }
let controllers = [];
let skyMat, sparkleMat, floorMat;
let lastScoreNormalized = 0;
let audioCtx = null;
const clock = new THREE.Clock();

// ─── DOM ────────────────────────────────────────────────────────────────────
const overlay    = document.getElementById('overlay');
const statusEl   = document.getElementById('status');
const vrBtnWrap  = document.getElementById('vr-button-wrap');

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  await document.fonts.ready;

  // Resolve planId (generate new + redirect if missing)
  if (!planId) {
    const saved = localStorage.getItem(KEYS.planId);
    const target = saved || generateId(20);
    if (!saved) localStorage.setItem(KEYS.planId, target);
    window.location.replace(`/${target}`);
    return;
  }
  localStorage.setItem(KEYS.planId, planId);

  statusEl.textContent = 'fetching habits…';

  // Load content for today, carrying forward the most recent row if needed
  let content = await sbFetch(planId, currentDate);
  if (content === null) {
    const template = await sbFetchLatest(planId);
    const fresh = template ? clearCheckboxes(template) : DEFAULT_PLAN;
    await sbSave(planId, currentDate, fresh);
    content = fresh;
  }
  remoteContent = content;

  initScene();
  buildHabitPanels(parse(remoteContent));

  statusEl.innerHTML = 'ready · <strong>enter VR</strong> to begin';
  vrBtnWrap.appendChild(VRButton.createButton(renderer));

  // Poll for collaborative edits from the web app every 10s
  setInterval(async () => {
    const latest = await sbFetch(planId, currentDate);
    if (latest !== null && latest !== remoteContent) {
      remoteContent = latest;
      buildHabitPanels(parse(remoteContent));
    }
  }, 10000);
}

// ─── Scene setup ────────────────────────────────────────────────────────────
function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.bg);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
  camera.position.set(0, 1.6, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  document.body.appendChild(renderer.domElement);

  // Lights — soft and even
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(2, 4, 2);
  scene.add(dir);

  buildFloor();
  buildSky();
  buildSparkles();
  buildRing();
  buildScorePlane();
  setupControllers();

  raycaster = new THREE.Raycaster();

  window.addEventListener('resize', onResize);

  renderer.xr.addEventListener('sessionstart', () => {
    document.body.classList.add('in-vr');
    overlay.classList.add('fade-out');
    const ctx = ensureAudio();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  });
  renderer.xr.addEventListener('sessionend', () => {
    document.body.classList.remove('in-vr');
    overlay.classList.remove('fade-out');
  });

  renderer.setAnimationLoop(tick);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ─── Ring (track + animated fill) ───────────────────────────────────────────
function buildRing() {
  const trackGeo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 18, 96);
  const trackMat = new THREE.MeshStandardMaterial({
    color: COLORS.ringTrack, roughness: 0.7, metalness: 0.1,
  });
  ringTrack = new THREE.Mesh(trackGeo, trackMat);
  ringTrack.position.copy(RING_POSITION);
  scene.add(ringTrack);

  const fillMat = new THREE.MeshStandardMaterial({
    color: COLORS.ringFill,
    emissive: 0x1a1a18,
    roughness: 0.25, metalness: 0.15,
    side: THREE.DoubleSide,
  });
  ringFill = new THREE.Mesh(
    new THREE.TorusGeometry(RING_RADIUS, RING_TUBE * 1.12, 18, 96, 0.001),
    fillMat
  );
  ringFill.position.copy(RING_POSITION);
  // Start fill at 12 o'clock, grow clockwise (when viewed from +Z)
  ringFill.rotation.z = Math.PI / 2;
  ringFill.scale.x    = -1;
  scene.add(ringFill);
}

function updateRing(score) {
  const arc = Math.max(0.001, (Math.min(100, score) / 100) * Math.PI * 2);
  ringFill.geometry.dispose();
  ringFill.geometry = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE * 1.12, 18, 96, arc);
}

// ─── Score plane (sits inside the ring) ─────────────────────────────────────
function buildScorePlane() {
  scoreCanvas = document.createElement('canvas');
  scoreCanvas.width = 512;
  scoreCanvas.height = 512;
  scoreCtx = scoreCanvas.getContext('2d');

  scoreTexture = new THREE.CanvasTexture(scoreCanvas);
  scoreTexture.colorSpace = THREE.SRGBColorSpace;

  const planeSize = RING_RADIUS * 1.7;
  scorePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(planeSize, planeSize),
    new THREE.MeshBasicMaterial({ map: scoreTexture, transparent: true })
  );
  scorePlane.position.copy(RING_POSITION);
  scorePlane.position.z += 0.002;
  scene.add(scorePlane);
}

function updateScorePlane(score, subtext) {
  const c = scoreCtx;
  const w = scoreCanvas.width;
  const h = scoreCanvas.height;
  c.clearRect(0, 0, w, h);

  // Score number
  c.fillStyle    = COLORS.textPrimary;
  c.font         = '500 220px "IBM Plex Mono", monospace';
  c.textAlign    = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(Math.round(score)), w / 2, h / 2 - 30);

  // /100 unit
  c.fillStyle = COLORS.textMuted;
  c.font      = '500 50px "IBM Plex Mono", monospace';
  c.fillText('/ 100', w / 2, h / 2 + 100);

  // Subtext
  c.fillStyle = COLORS.textSecondary;
  c.font      = '500 34px "IBM Plex Mono", monospace';
  c.fillText(subtext.toLowerCase(), w / 2, h / 2 + 180);

  scoreTexture.needsUpdate = true;
}

// ─── Floor (frosted glass with futuristic pattern) ─────────────────────────
// A flat disc rendered with a shader that combines a faint hex grid,
// concentric pulse rings flowing outward, twelve radial spokes, a slow
// central glow, and a soft outer fade so the disc dissolves into the sky.
function buildFloor() {
  const FLOOR_VERT = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const FLOOR_FRAG = `
    uniform float uTime;
    uniform float uScore;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 c = vUv - vec2(0.5);
      float r = length(c) * 2.0;
      if (r > 1.0) discard;

      float ang = atan(c.y, c.x);

      // Base frosted color — cool teal, warms slightly with score.
      vec3 cool = vec3(0.045, 0.085, 0.115);
      vec3 warm = vec3(0.18, 0.13, 0.08);
      vec3 col  = mix(cool, warm, smoothstep(0.0, 0.7, uScore) * 0.5);

      // Concentric pulse rings flowing outward
      float ringPhase = r * 14.0 - uTime * 0.55;
      float rings = pow(sin(ringPhase) * 0.5 + 0.5, 10.0);
      vec3 ringTint = mix(vec3(0.30, 0.65, 0.95), vec3(1.00, 0.75, 0.35), uScore);
      col += ringTint * rings * 0.35;

      // 12 radial spokes — soft bright lines
      float spokeMask = pow(1.0 - abs(sin(ang * 6.0)), 90.0);
      col += vec3(0.35, 0.65, 0.90) * spokeMask * 0.12;

      // Faint hex grid
      vec2 hp = c * 22.0;
      vec2 q  = vec2(hp.x * 1.1547005, hp.y + hp.x * 0.5);
      vec2 qf = fract(q) - 0.5;
      float hexEdge = smoothstep(0.42, 0.50, max(abs(qf.x), abs(qf.y)));
      col += vec3(0.12, 0.20, 0.28) * hexEdge * 0.45;

      // Central pulsing core
      float corePulse = 0.5 + 0.5 * sin(uTime * 1.4);
      float core = smoothstep(0.28, 0.0, r);
      col += vec3(0.40, 0.70, 1.00) * core * (0.25 + 0.30 * corePulse);

      // Frosted-glass micro-noise for surface texture
      float n = hash(floor(vUv * 1400.0));
      col += vec3(n - 0.5) * 0.025;

      // Soft outer fade so disc dissolves into the void
      float alpha = smoothstep(1.0, 0.78, r);

      gl_FragColor = vec4(col, alpha);
    }
  `;

  floorMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:  { value: 0 },
      uScore: { value: 0 },
    },
    vertexShader:   FLOOR_VERT,
    fragmentShader: FLOOR_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const floor = new THREE.Mesh(new THREE.CircleGeometry(3.0, 96), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.001;
  scene.add(floor);
}

// ─── Sky dome (score-reactive gradient) ────────────────────────────────────
// A large inverted sphere with a shader that fades the void from black up
// through gold and warm hues into a deep magenta/purple as the score grows.
// At high scores a slow rainbow shimmer plays across the sky.
function buildSky() {
  const SKY_VERT = `
    varying vec3 vWorldDir;
    void main() {
      vWorldDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  // y here goes from -1 (straight down) to +1 (straight up); we remap to 0..1.
  const SKY_FRAG = `
    uniform float uScore;   // 0..1
    uniform float uTime;
    varying vec3 vWorldDir;

    vec3 darkAt(float h) {
      // very dark, slight warmth at the horizon
      vec3 floor = vec3(0.020, 0.020, 0.024);
      vec3 horz  = vec3(0.045, 0.040, 0.035);
      vec3 top   = vec3(0.010, 0.010, 0.020);
      if (h < 0.5) return mix(floor, horz, h * 2.0);
      return mix(horz, top, (h - 0.5) * 2.0);
    }

    vec3 brightAt(float h) {
      // bottom: deep amber → horizon: bright gold → mid: rose →
      // upper: violet → top: indigo
      vec3 amber  = vec3(0.55, 0.25, 0.06);
      vec3 gold   = vec3(1.00, 0.72, 0.22);
      vec3 rose   = vec3(0.95, 0.40, 0.55);
      vec3 violet = vec3(0.45, 0.20, 0.70);
      vec3 indigo = vec3(0.10, 0.05, 0.30);
      if (h < 0.30) return mix(amber, gold, h / 0.30);
      if (h < 0.55) return mix(gold, rose,   (h - 0.30) / 0.25);
      if (h < 0.80) return mix(rose, violet, (h - 0.55) / 0.25);
      return mix(violet, indigo, (h - 0.80) / 0.20);
    }

    void main() {
      float h = clamp(vWorldDir.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 dark   = darkAt(h);
      vec3 bright = brightAt(h);
      vec3 col    = mix(dark, bright, smoothstep(0.0, 1.0, uScore));

      // Subtle rainbow shimmer at the top of the score range.
      float shimmerStrength = smoothstep(0.65, 1.0, uScore) * 0.18;
      float a = vWorldDir.x * 1.7 + vWorldDir.z * 0.9 + uTime * 0.25;
      vec3 rainbow = vec3(
        0.5 + 0.5 * sin(a),
        0.5 + 0.5 * sin(a + 2.094),
        0.5 + 0.5 * sin(a + 4.189)
      );
      col += rainbow * shimmerStrength * h;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uScore: { value: 0 },
      uTime:  { value: 0 },
    },
    vertexShader:   SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(40, 48, 32), skyMat);
  sky.renderOrder = -1; // draw first so everything else composites over it
  scene.add(sky);
}

// ─── Sparkles (score-reactive) ─────────────────────────────────────────────
// Points scattered around the upper hemisphere. Their size and opacity scale
// with score, and each one twinkles on its own phase.
function buildSparkles() {
  const COUNT = 700;
  const positions = new Float32Array(COUNT * 3);
  const offsets   = new Float32Array(COUNT);
  const tints     = new Float32Array(COUNT * 3);

  for (let i = 0; i < COUNT; i++) {
    // Roughly upper-hemisphere distribution, biased a bit upward
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(1 - Math.random() * 1.15); // 0 (up) .. ~π/2 (horizon)
    const r     = 14 + Math.random() * 14;
    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    offsets[i] = Math.random() * Math.PI * 2;

    // Slight color variety: gold, rose, violet, white
    const palette = [
      [1.00, 0.85, 0.45],
      [1.00, 0.55, 0.60],
      [0.75, 0.60, 1.00],
      [1.00, 1.00, 0.95],
    ];
    const p = palette[i % palette.length];
    tints[i * 3 + 0] = p[0];
    tints[i * 3 + 1] = p[1];
    tints[i * 3 + 2] = p[2];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('offset',   new THREE.BufferAttribute(offsets, 1));
  geo.setAttribute('tint',     new THREE.BufferAttribute(tints, 3));

  sparkleMat = new THREE.ShaderMaterial({
    uniforms: {
      uScore: { value: 0 },
      uTime:  { value: 0 },
      uPixelRatio: { value: window.devicePixelRatio },
    },
    vertexShader: `
      uniform float uScore;
      uniform float uTime;
      uniform float uPixelRatio;
      attribute float offset;
      attribute vec3 tint;
      varying float vAlpha;
      varying vec3 vTint;
      void main() {
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPos;
        float twinkle = 0.4 + 0.6 * sin(uTime * 1.8 + offset * 6.0);
        float gate = smoothstep(0.05, 0.9, uScore);
        vAlpha = gate * twinkle;
        vTint = tint;
        gl_PointSize = (4.0 + 10.0 * twinkle) * gate * uPixelRatio;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      varying vec3 vTint;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        // Soft round dot with a hot center
        float a = pow(1.0 - d * 2.0, 1.8) * vAlpha;
        gl_FragColor = vec4(vTint, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const sparkles = new THREE.Points(geo, sparkleMat);
  scene.add(sparkles);
}

// ─── Score → visuals (single source of truth for ring, score, sky, sparkles) ─
function updateScoreVisuals(score, subtext) {
  updateRing(score);
  updateScorePlane(score, subtext);
  const normalized = Math.max(0, Math.min(1, score / 100));
  lastScoreNormalized = normalized;
  if (skyMat)     skyMat.uniforms.uScore.value     = normalized;
  if (sparkleMat) sparkleMat.uniforms.uScore.value = normalized;
  if (floorMat)   floorMat.uniforms.uScore.value   = normalized;
}

// ─── Audio (Web Audio synth — no asset file) ───────────────────────────────
function ensureAudio() {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  audioCtx = new AC();
  return audioCtx;
}

// A rising arpeggio of sparkly triangle waves — C5-E5-G5-C6-E6 — with a
// short shimmer of higher partials on top. Cheap, no asset, plays in VR.
function playMagicChime() {
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const now = ctx.currentTime;

  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
  notes.forEach((freq, i) => {
    const start = now + i * 0.045;
    const end   = start + 0.55;
    const osc   = ctx.createOscillator();
    const gain  = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.18, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(end + 0.02);

    // Shimmer partial at 2x freq, quieter
    const osc2 = ctx.createOscillator();
    const g2   = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2;
    g2.gain.setValueAtTime(0, start);
    g2.gain.linearRampToValueAtTime(0.05, start + 0.01);
    g2.gain.exponentialRampToValueAtTime(0.0001, end - 0.1);
    osc2.connect(g2).connect(master);
    osc2.start(start);
    osc2.stop(end);
  });
}

// ─── Habit panels ───────────────────────────────────────────────────────────
// Each panel is a Group with two children:
//   • caseMesh   — RoundedBoxGeometry, gives real 3D depth + rounded corners.
//                  Lit via MeshStandardMaterial so the side faces shade.
//   • screenMesh — a Plane with the canvas texture, floating just in front
//                  of the case (so it reads as the "screen" of a device).
// Hover and press are driven by a damped spring on `scale` (see tick()).
function buildHabitPanels(habits) {
  habitPanels.forEach(p => {
    scene.remove(p.group);
    p.caseMesh.geometry.dispose();
    p.caseMesh.material.dispose();
    p.screenMesh.geometry.dispose();
    p.screenMesh.material.dispose();
    p.texture.dispose();
  });
  habitPanels = [];

  const enriched = enrichWithPoints(habits);

  enriched.forEach((habit, i) => {
    const panel = buildPanel(habit, i, enriched.length);
    habitPanels.push(panel);
    scene.add(panel.group);
  });

  const score = calcScore(enriched);
  updateScoreVisuals(score, scoreSubtext(enriched, score));
}

function buildPanel(habit, index, total) {
  const canvas = document.createElement('canvas');
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  // Rounded 3D case — the physical "device" backing
  const caseMesh = new THREE.Mesh(
    new RoundedBoxGeometry(HABIT_W, HABIT_H, HABIT_D, 4, 0.018),
    new THREE.MeshStandardMaterial({
      color:    0x2f2f2a,
      roughness: 0.55,
      metalness: 0.30,
      emissive: new THREE.Color(0xebebdf),
      emissiveIntensity: 0.0,   // dialled up on hover
    })
  );

  // Front-facing canvas screen, floating just in front of the case
  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(HABIT_W * 0.94, HABIT_H * 0.86),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    })
  );
  screenMesh.position.z = HABIT_D / 2 + 0.001;
  screenMesh.renderOrder = 1;

  const group = new THREE.Group();
  group.add(caseMesh);
  group.add(screenMesh);

  positionPanel(group, index, total);

  const panel = {
    group, caseMesh, screenMesh, canvas, ctx, texture, habit,
    hovered: false,
    // Spring state for the bouncy hover/press animation
    scale:    1.0,
    scaleVel: 0.0,
    pressBoost: 0.0,
    emissiveTarget: 0.0,
  };
  drawPanel(panel);
  return panel;
}

function positionPanel(group, index, total) {
  // Layout strategy:
  //   ≤5 habits   → 1 row
  //   6–10 habits → 2 rows
  //   11+         → 3 rows
  const rows = total <= 5 ? 1 : total <= 10 ? 2 : 3;
  const cols = Math.ceil(total / rows);
  const row  = Math.floor(index / cols);
  const col  = index % cols;
  const colsInThisRow = (row === rows - 1)
    ? (total - row * cols) || cols
    : cols;

  // Spacing math: at radius `distance`, each panel needs at least
  // (HABIT_W + gap) / distance radians to sit edge-to-edge with a gap.
  const distance = 1.5;
  const minAnglePerPanel = (HABIT_W + 0.10) / distance; // ~0.36 rad ≈ 21°
  const arcRad = Math.max(
    THREE.MathUtils.degToRad(40),
    minAnglePerPanel * Math.max(1, colsInThisRow - 1) + THREE.MathUtils.degToRad(8)
  );

  const angle = colsInThisRow > 1
    ? -arcRad / 2 + (col / (colsInThisRow - 1)) * arcRad
    : 0;

  const baseY  = 1.40;
  const rowGap = 0.17;
  // Top row above baseY, bottom row below, middle row at baseY (for 3 rows)
  const yOffset = rows === 1
    ? 0
    : rows === 2
      ? (row === 0 ? rowGap / 2 : -rowGap / 2)
      : (row - 1) * rowGap; // row 0 → +gap, row 1 → 0, row 2 → -gap
  const y = baseY + yOffset;

  group.position.set(
    Math.sin(angle) * distance,
    y,
    -Math.cos(angle) * distance
  );

  // Face the user. For meshes/groups, lookAt() points the +Z axis (front face
  // of the case + screen) AT the target — aim at the origin column at panel height.
  group.lookAt(0, group.position.y, 0);
}

function drawPanel(panel) {
  const { ctx, habit, hovered } = panel;
  const w = CANVAS_W;
  const h = CANVAS_H;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = hovered ? COLORS.panelHover : COLORS.panelBg;
  roundRect(ctx, 0, 0, w, h, 28);
  ctx.fill();

  // Border (brightens dramatically on hover)
  ctx.strokeStyle = hovered ? COLORS.panelHoverBorder : COLORS.panelBorder;
  ctx.lineWidth   = hovered ? 12 : 5;
  roundRect(ctx, 6, 6, w - 12, h - 12, 26);
  ctx.stroke();

  // Layout
  const padX = 60;
  const cy   = h / 2;
  const cbSize = h * 0.44;
  const cbX = padX;
  const cbY = cy - cbSize / 2;

  // Checkbox
  if (habit.done) {
    ctx.fillStyle = COLORS.checkFill;
    roundRect(ctx, cbX, cbY, cbSize, cbSize, 10);
    ctx.fill();
    // Checkmark
    ctx.strokeStyle = COLORS.panelBg;
    ctx.lineWidth   = 11;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(cbX + cbSize * 0.22, cbY + cbSize * 0.55);
    ctx.lineTo(cbX + cbSize * 0.45, cbY + cbSize * 0.76);
    ctx.lineTo(cbX + cbSize * 0.80, cbY + cbSize * 0.28);
    ctx.stroke();
  } else {
    ctx.strokeStyle = COLORS.textMuted;
    ctx.lineWidth   = 5;
    roundRect(ctx, cbX, cbY, cbSize, cbSize, 10);
    ctx.stroke();
  }

  // Habit name (left-aligned, after checkbox)
  const nameX = cbX + cbSize + 40;
  ctx.fillStyle    = habit.done ? COLORS.textDone : COLORS.textPrimary;
  ctx.font         = '500 90px "IBM Plex Sans", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'left';
  const maxNameWidth = w - nameX - 360;
  let name = habit.name;
  while (ctx.measureText(name).width > maxNameWidth && name.length > 1) {
    name = name.slice(0, -1);
  }
  if (name !== habit.name) name = name.slice(0, -1) + '…';
  ctx.fillText(name, nameX, cy);

  if (habit.done) {
    const nameWidth = ctx.measureText(name).width;
    ctx.strokeStyle = COLORS.textDone;
    ctx.lineWidth   = 4;
    ctx.beginPath();
    ctx.moveTo(nameX, cy + 4);
    ctx.lineTo(nameX + nameWidth, cy + 4);
    ctx.stroke();
  }

  // Right side: points
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.textMuted;
  ctx.font      = '500 56px "IBM Plex Mono", monospace';
  const pts     = habit.points;
  const ptsText = pts >= 1 ? `+${Math.round(pts)} pts` : `+${pts.toFixed(1)} pts`;
  ctx.fillText(ptsText, w - padX, cy);

  panel.texture.needsUpdate = true;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Controllers + raycasting ───────────────────────────────────────────────
function setupControllers() {
  const factory = new XRControllerModelFactory();

  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    controller.userData.index = i;
    controller.addEventListener('selectstart', onSelectStart);
    scene.add(controller);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(factory.createControllerModel(grip));
    scene.add(grip);

    // Laser pointer
    const laser = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -3),
      ]),
      new THREE.LineBasicMaterial({ color: 0xebebdf, transparent: true, opacity: 0.35 })
    );
    controller.add(laser);

    // Tip dot
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.008, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xebebdf })
    );
    tip.position.z = -0.05;
    controller.add(tip);

    controllers.push(controller);
  }
}

function onSelectStart(event) {
  const hit = pickPanel(event.target);
  if (!hit) return;
  toggleHabit(hit.panel);
  // Inward "press" impulse — the spring in tick() snaps it back with overshoot
  hit.panel.pressBoost  = -0.12;
  hit.panel.scaleVel   -= 0.04;
}

function pickPanel(controller) {
  const tempMatrix = new THREE.Matrix4();
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

  // Cast against both the case and the screen plane of every panel
  const meshes = [];
  habitPanels.forEach(p => { meshes.push(p.caseMesh, p.screenMesh); });
  const hits = raycaster.intersectObjects(meshes);
  if (hits.length === 0) return null;
  const obj = hits[0].object;
  const panel = habitPanels.find(p => p.caseMesh === obj || p.screenMesh === obj);
  return panel ? { panel, hit: hits[0] } : null;
}

function updateHover() {
  const hitSet = new Set();
  for (const ctrl of controllers) {
    const hit = pickPanel(ctrl);
    if (hit) hitSet.add(hit.panel);
  }
  habitPanels.forEach(p => {
    const shouldHover = hitSet.has(p);
    p.emissiveTarget = shouldHover ? 0.55 : 0.0;
    if (p.hovered !== shouldHover) {
      p.hovered = shouldHover;
      drawPanel(p);
    }
  });
}

// Damped-spring hover/press animation. Runs on every panel every frame.
//   - When `hovered`, target scale = 1.08; otherwise 1.0.
//   - pressBoost is a transient negative offset (kicked by onSelectStart)
//     that decays back to 0 so the panel bounces in then springs out.
//   - emissiveIntensity lerps toward emissiveTarget so the case glows
//     softly on hover.
const SPRING_STIFFNESS = 0.18;
const SPRING_DAMPING   = 0.72;

function animatePanels() {
  for (const p of habitPanels) {
    const target = (p.hovered ? 1.08 : 1.0) + p.pressBoost;

    // Damped harmonic oscillator on scale
    p.scaleVel += (target - p.scale) * SPRING_STIFFNESS;
    p.scaleVel *= SPRING_DAMPING;
    p.scale    += p.scaleVel;
    p.group.scale.setScalar(p.scale);

    // Decay press boost back to 0
    if (p.pressBoost < 0) {
      p.pressBoost = Math.min(0, p.pressBoost + 0.012);
    }

    // Lerp emissive intensity for a smooth glow on/off
    const m = p.caseMesh.material;
    m.emissiveIntensity += (p.emissiveTarget - m.emissiveIntensity) * 0.18;
  }
}

// ─── Toggle (optimistic local update + Supabase write) ──────────────────────
function toggleHabit(panel) {
  const habit = panel.habit;
  const rawLines = remoteContent.split('\n');
  const line = rawLines[habit.lineIndex];
  const cbMatch = line.trim().match(/^\[( ?|x|X)\]/i);
  let newLine;
  if (cbMatch) {
    const isDone = cbMatch[1].trim().toLowerCase() === 'x';
    newLine = line.replace(/^\s*\[( ?|x|X)\]\s*/i, isDone ? '[ ] ' : '[x] ');
  } else {
    newLine = '[x] ' + line.trimStart();
  }
  rawLines[habit.lineIndex] = newLine;
  remoteContent = rawLines.join('\n');

  habit.done = !habit.done;
  drawPanel(panel);

  // Celebrate on the upward toggle only
  if (habit.done) playMagicChime();

  // Recompute score from the freshly-toggled content
  const enriched = enrichWithPoints(parse(remoteContent));
  const score = calcScore(enriched);
  updateScoreVisuals(score, scoreSubtext(enriched, score));

  sbSave(planId, currentDate, remoteContent);
}

// ─── Animation loop ─────────────────────────────────────────────────────────
function tick() {
  const t = clock.getElapsedTime();
  if (skyMat)     skyMat.uniforms.uTime.value     = t;
  if (sparkleMat) sparkleMat.uniforms.uTime.value = t;
  if (floorMat)   floorMat.uniforms.uTime.value   = t;
  if (renderer.xr.isPresenting) updateHover();
  animatePanels();
  renderer.render(scene, camera);
}

// ─── DayScore parser / scoring (identical to web app) ───────────────────────
function parse(raw) {
  const lines = raw.split('\n');
  const habits = [];
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const cbMatch = trimmed.match(/^\[( ?|x|X)\]\s*/i);
    let rest = trimmed;
    let done = false;
    if (cbMatch) {
      done = cbMatch[1].trim().toLowerCase() === 'x';
      rest = trimmed.slice(cbMatch[0].length);
    }
    const ratingMatch = rest.match(/^(.*?)\s*\((\d+)\)\s*$/);
    if (!ratingMatch) return;
    const name   = ratingMatch[1].trim();
    const rating = Math.max(1, Math.min(10, parseInt(ratingMatch[2], 10)));
    if (!name) return;
    habits.push({ name, rating, done, lineIndex, raw: line });
  });
  return habits;
}

function enrichWithPoints(habits) {
  const totalRating = habits.reduce((s, h) => s + h.rating, 0);
  if (totalRating === 0) return [];
  return habits.map(h => ({ ...h, points: (h.rating / totalRating) * 100 }));
}

function calcScore(enriched) {
  const raw = enriched.filter(h => h.done).reduce((s, h) => s + h.points, 0);
  return Math.round(raw * 10) / 10;
}

function scoreSubtext(habits, score) {
  const doneCount = habits.filter(h => h.done).length;
  const display = Math.round(score);
  if (habits.length === 0) return 'add some habits';
  if (display === 100)     return '✓ perfect day';
  if (display >= 80)       return 'great day so far';
  if (display >= 50)       return 'keep going';
  if (doneCount === 0)     return 'start checking off';
  return 'making progress';
}

// ─── Supabase ───────────────────────────────────────────────────────────────
function sbHeaders() {
  return {
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type':  'application/json',
  };
}

async function sbFetch(id, date) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?id=eq.${enc(id)}&date=eq.${enc(date)}&select=content`,
      { headers: sbHeaders() }
    );
    const rows = await res.json();
    return rows.length ? rows[0].content : null;
  } catch { return null; }
}

async function sbFetchLatest(id) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?id=eq.${enc(id)}&select=content,date&order=date.desc&limit=1`,
      { headers: sbHeaders() }
    );
    const rows = await res.json();
    return rows.length ? rows[0].content : null;
  } catch { return null; }
}

async function sbSave(id, date, content) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/plans`, {
      method:  'POST',
      headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body:    JSON.stringify({ id, date, content, updated_at: new Date().toISOString() }),
    });
  } catch {}
}

function enc(s) { return encodeURIComponent(s); }

// ─── Helpers ────────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function generateId(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr   = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

function clearCheckboxes(raw) {
  return raw.split('\n').map(line => line.replace(/^(\s*)\[x\]\s*/i, '$1')).join('\n');
}

// ─── Go ─────────────────────────────────────────────────────────────────────
boot();
