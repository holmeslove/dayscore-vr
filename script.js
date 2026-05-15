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

// ─── Palette (mirrors DayScore dark theme) ──────────────────────────────────
const COLORS = {
  bg:           0x0d0d0b,
  panelBg:      '#161614',
  panelHover:   '#23231f',
  panelBorder:  '#252521',
  textPrimary:  '#ebebdf',
  textSecondary:'#a8a89a',
  textMuted:    '#555550',
  textDone:     '#3a3a36',
  ringTrack:    0x1e1e1a,
  ringFill:     0xebebdf,
  checkFill:    '#a8a89a',
};

// ─── Geometry constants ─────────────────────────────────────────────────────
const RING_RADIUS    = 0.32;
const RING_TUBE      = 0.018;
const RING_POSITION  = new THREE.Vector3(0, 1.95, -1.4);
const HABIT_W        = 0.46;
const HABIT_H        = 0.11;
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
let habitPanels = [];      // { mesh, canvas, ctx, texture, habit, hovered }
let controllers = [];

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
  scene.fog        = new THREE.Fog(COLORS.bg, 2.5, 12);

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

  // Subtle floor disk for spatial anchoring
  const floor = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 4, 64),
    new THREE.MeshBasicMaterial({ color: 0x141412, side: THREE.DoubleSide })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.001;
  scene.add(floor);

  buildRing();
  buildScorePlane();
  setupControllers();

  raycaster = new THREE.Raycaster();

  window.addEventListener('resize', onResize);

  renderer.xr.addEventListener('sessionstart', () => {
    document.body.classList.add('in-vr');
    overlay.classList.add('fade-out');
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

// ─── Habit panels ───────────────────────────────────────────────────────────
function buildHabitPanels(habits) {
  habitPanels.forEach(p => {
    scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
    p.texture.dispose();
  });
  habitPanels = [];

  const enriched = enrichWithPoints(habits);

  enriched.forEach((habit, i) => {
    const panel = buildPanel(habit, i, enriched.length);
    habitPanels.push(panel);
    scene.add(panel.mesh);
  });

  const score = calcScore(enriched);
  updateRing(score);
  updateScorePlane(score, scoreSubtext(enriched, score));
}

function buildPanel(habit, index, total) {
  const canvas = document.createElement('canvas');
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(HABIT_W, HABIT_H),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true })
  );

  positionPanel(mesh, index, total);

  const panel = { mesh, canvas, ctx, texture, habit, hovered: false };
  drawPanel(panel);
  return panel;
}

function positionPanel(mesh, index, total) {
  const useTwoRows = total > 6;
  const cols = useTwoRows ? Math.ceil(total / 2) : total;
  const row  = useTwoRows ? Math.floor(index / cols) : 0;
  const col  = useTwoRows ? index % cols : index;

  const arcDeg = Math.min(150, Math.max(60, cols * 18));
  const arcRad = THREE.MathUtils.degToRad(arcDeg);
  const angle  = cols > 1
    ? -arcRad / 2 + (col / (cols - 1)) * arcRad
    : 0;

  const distance = 1.2;
  const baseY    = 1.32;
  const rowGap   = 0.16;
  const y = baseY + (useTwoRows ? (row === 0 ? rowGap / 2 : -rowGap / 2) : 0);

  mesh.position.set(
    Math.sin(angle) * distance,
    y,
    -Math.cos(angle) * distance
  );

  // Face the user (point through scene origin axis at panel's height)
  mesh.lookAt(mesh.position.x * 2, mesh.position.y, mesh.position.z * 2);
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

  // Border (brightens on hover)
  ctx.strokeStyle = hovered ? COLORS.textSecondary : COLORS.panelBorder;
  ctx.lineWidth   = hovered ? 8 : 4;
  roundRect(ctx, 4, 4, w - 8, h - 8, 28);
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
  pressAnimate(hit.panel.mesh);
}

function pressAnimate(mesh) {
  const original = mesh.scale.clone();
  mesh.scale.multiplyScalar(0.94);
  setTimeout(() => mesh.scale.copy(original), 110);
}

function pickPanel(controller) {
  const tempMatrix = new THREE.Matrix4();
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

  const meshes = habitPanels.map(p => p.mesh);
  const hits = raycaster.intersectObjects(meshes);
  if (hits.length === 0) return null;
  const panel = habitPanels.find(p => p.mesh === hits[0].object);
  return { panel, hit: hits[0] };
}

function updateHover() {
  habitPanels.forEach(p => {
    if (p.hovered) { p.hovered = false; drawPanel(p); }
  });
  for (const ctrl of controllers) {
    const hit = pickPanel(ctrl);
    if (hit && !hit.panel.hovered) {
      hit.panel.hovered = true;
      drawPanel(hit.panel);
    }
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

  // Recompute score from the freshly-toggled content
  const enriched = enrichWithPoints(parse(remoteContent));
  const score = calcScore(enriched);
  updateRing(score);
  updateScorePlane(score, scoreSubtext(enriched, score));

  sbSave(planId, currentDate, remoteContent);
}

// ─── Animation loop ─────────────────────────────────────────────────────────
function tick() {
  if (renderer.xr.isPresenting) updateHover();
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
