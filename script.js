/* ============================================================
   LINEA - core game
   Modules: Audio | Physics | Input | Entities | Render | Game Loop
   ============================================================ */

// ---------- Canvas setup ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

let balls = [];
let targets = [];

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  balls.forEach(b => {
    b.x = Math.min(Math.max(b.x, b.r), canvas.width - b.r);
    b.y = Math.min(Math.max(b.y, b.r), canvas.height - b.r);
  });
  targets.forEach(t => {
    t.x = Math.min(Math.max(t.x, t.r), canvas.width - t.r);
    t.y = Math.min(Math.max(t.y, t.r), canvas.height - t.r);
  });
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ---------- DOM refs ----------
const scoreEl = document.getElementById('score');
const highScoreEl = document.getElementById('highScore');
const inkBarEl = document.getElementById('inkBar');
const gameOverScreen = document.getElementById('gameOverScreen');
const finalScoreEl = document.getElementById('finalScore');
const finalHighScoreEl = document.getElementById('finalHighScore');
const restartBtn = document.getElementById('restartBtn');

/* ============================================================
   AUDIO MODULE (Web Audio API, no external files)
   ============================================================ */
const Audio_ = (() => {
  let actx = null;
  function ctxReady() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    return actx;
  }
  function tone(freq, duration, type = 'sine', vol = 0.15, delay = 0, glideTo = null) {
    const ac = ctxReady();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const startAt = ac.currentTime + delay;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startAt);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, startAt + duration);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(vol, startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }
  const noiseBufferCache = new Map();
  function getNoiseBuffer(ac, duration) {
    const key = Math.round(duration * 1000);
    let buf = noiseBufferCache.get(key);
    if (buf) return buf;
    const bufferSize = Math.floor(ac.sampleRate * duration);
    buf = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    noiseBufferCache.set(key, buf);
    return buf;
  }
  function noiseBurst(duration, vol = 0.12, freq = 2000) {
    const ac = ctxReady();
    const noise = ac.createBufferSource();
    noise.buffer = getNoiseBuffer(ac, duration);
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(vol, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ac.destination);
    noise.start();
  }
  return {
    place: () => { tone(520, 0.06, 'square', 0.05); noiseBurst(0.03, 0.03, 1800); },
    bounce: (intensity = 1) => {
      const basePitch = 150 + intensity * 140 + Math.random() * 30;
      tone(basePitch, 0.08, 'triangle', 0.07 + 0.05 * intensity);
      noiseBurst(0.04, 0.04 + 0.05 * intensity, 1000 + intensity * 1200);
    },
    wallBounce: (intensity = 0.5) => {
      tone(90 + intensity * 60, 0.07, 'sine', 0.05 + 0.03 * intensity);
      noiseBurst(0.03, 0.02 + 0.02 * intensity, 600);
    },
    score: () => {
      noiseBurst(0.05, 0.14, 2600);
      tone(523, 0.16, 'sine', 0.16);
      tone(659, 0.16, 'sine', 0.13, 0.03);
      tone(784, 0.22, 'sine', 0.14, 0.06);
      tone(1046, 0.28, 'triangle', 0.1, 0.09, 1400);
    },
    deny: () => tone(110, 0.1, 'square', 0.08),
    milestone: () => {
      noiseBurst(0.08, 0.1, 1800);
      tone(392, 0.14, 'triangle', 0.13, 0);
      tone(523, 0.14, 'triangle', 0.13, 0.09);
      tone(659, 0.18, 'triangle', 0.14, 0.18);
      tone(880, 0.3, 'sine', 0.12, 0.27, 1100);
    }
  };
})();

/* ============================================================
   GAME STATE
   ============================================================ */
const state = {
  running: true,
  score: 0,
  highScore: Number(localStorage.getItem('lineaHighScore') || 0),
  ink: 100,
  maxInk: 100,
  inkRegenRate: 16,
  inkCost: 30,

  // gentler curve: start slow, grow very gradually, cap well below "crazy"
  speedMultiplier: 0.6,
  speedGrowth: 0.0045,
  maxSpeedMultiplier: 1.35,
  gravity: 170,

  shake: 0,
  lines: [],
  particles: [],
  scorePopups: [],

  freezeTimer: 0,
  slowMoTimer: 0,
  timeScale: 1,
  zoom: 1,
  zoomTarget: 1,
  flash: 0,
  chroma: 0,
  displayScore: 0,
  newBestFlash: 0,

  milestonesUnlocked: new Set(),
  banners: [],
  lineLifetimeMult: 1,
  targetSpeedBoost: 1,
  magneticActive: false,
  windActive: false,
  windX: 0,
  windTargetX: 0,
  windTimer: 0,
  rotationActive: false,
  worldRotation: 0,
  chaosActive: false
};
const BASE_GRAVITY = state.gravity;
highScoreEl.textContent = state.highScore;

/* ============================================================
   ENTITIES
   ============================================================ */
function spawnBall() {
  const b = {
    r: 12,
    x: canvas.width / 2 + (Math.random() - 0.5) * 120,
    y: canvas.height / 3 + (Math.random() - 0.5) * 60,
    vx: 0, vy: 0,
    squashX: 1, squashY: 1,
    trail: []
  };
  const angle = Math.random() * Math.PI * 2;
  const speed = 84; // ~40% slower than the original 140
  b.vx = Math.cos(angle) * speed;
  b.vy = Math.sin(angle) * speed;
  balls.push(b);
  return b;
}

function spawnTarget() {
  const t = {
    r: 22, x: 0, y: 0, vx: 0, vy: 0, punch: 0,
    blinkTimer: 1 + Math.random() * 2,
    blink: 0,
    panic: 0,
    idlePhase: Math.random() * Math.PI * 2,
    floatPhase: Math.random() * Math.PI * 2
  };
  relocateTarget(t);
  targets.push(t);
  return t;
}

function relocateTarget(t) {
  const margin = 80;
  t.x = margin + Math.random() * (canvas.width - margin * 2);
  t.y = margin + Math.random() * (canvas.height - margin * 2);
  const angle = Math.random() * Math.PI * 2;
  const speed = (40 + Math.random() * 30) * state.targetSpeedBoost;
  t.vx = Math.cos(angle) * speed;
  t.vy = Math.sin(angle) * speed;
}

/* ============================================================
   INPUT MODULE
   Mouse only: cursor position sets the line's pivot, angle is computed
   from the nearest ball toward the cursor. Click places the line.
   ============================================================ */
const LINE_LENGTH = 130;
const LINE_LIFETIME = 2200;
const MAX_LINES = 1;
const WALL_BOUNCE = 0.96;
const LINE_HIT_PADDING = 4; // extra forgiveness so near-miss placements still count

const input = {
  mouseX: window.innerWidth / 2,
  mouseY: window.innerHeight / 2,
  angle: 0,
  active: false
};

function updateAimAngle() {
  // angle perpendicular-ish to the nearest ball's approach, so the placed
  // line naturally tends to face the ball without requiring manual rotation
  let nearest = null, nearestDist = Infinity;
  balls.forEach(b => {
    const d = Math.hypot(b.x - input.mouseX, b.y - input.mouseY);
    if (d < nearestDist) { nearestDist = d; nearest = b; }
  });
  if (nearest) {
    const toMouse = Math.atan2(input.mouseY - nearest.y, input.mouseX - nearest.x);
    input.angle = toMouse + Math.PI / 2; // line sits perpendicular to the ball's direction
  }
}

window.addEventListener('mousemove', (e) => {
  input.mouseX = e.clientX;
  input.mouseY = e.clientY;
  input.active = true;
  updateAimAngle();
});

canvas.addEventListener('click', () => {
  if (!state.running) return;
  if (state.ink < state.inkCost) { Audio_.deny(); return; }
  placeLine();
});

function placeLine() {
  state.ink -= state.inkCost;
  const half = LINE_LENGTH / 2;
  const dx = Math.cos(input.angle) * half;
  const dy = Math.sin(input.angle) * half;
  const line = {
    x1: input.mouseX - dx,
    y1: input.mouseY - dy,
    x2: input.mouseX + dx,
    y2: input.mouseY + dy,
    createdAt: performance.now(),
    drawProgress: 0 // animates the line growing in from its center
  };
  state.lines.push(line);
  if (state.lines.length > MAX_LINES) state.lines.shift();
  for (let i = 0; i < 8; i++) state.particles.push(makeParticle(input.mouseX, input.mouseY, '#2962ff'));
  Audio_.place();
}

restartBtn.addEventListener('click', startGame);

/* ============================================================
   PHYSICS MODULE
   ============================================================ */
function compactInPlace(arr, keep) {
  let w = 0;
  for (let r = 0; r < arr.length; r++) {
    if (keep(arr[r])) arr[w++] = arr[r];
  }
  arr.length = w;
}

function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + dx * t, y: y1 + dy * t };
}

function reflectBallOffLine(line, ball) {
  const cp = closestPointOnSegment(ball.x, ball.y, line.x1, line.y1, line.x2, line.y2);
  const dx = ball.x - cp.x;
  const dy = ball.y - cp.y;
  const dist = Math.hypot(dx, dy);
  const hitRadius = ball.r + LINE_HIT_PADDING; // forgiving collision thickness
  if (dist < hitRadius && dist > 0.0001) {
    const nx = dx / dist;
    const ny = dy / dist;
    const overlap = hitRadius - dist;
    ball.x += nx * overlap;
    ball.y += ny * overlap;
    const dot = ball.vx * nx + ball.vy * ny;
    ball.vx -= 2 * dot * nx;
    ball.vy -= 2 * dot * ny;
    ball.vx *= 1.02;
    ball.vy *= 1.02;

    const speed = Math.hypot(ball.vx, ball.vy);
    const intensity = Math.min(1.6, speed / 400);

    ball.squashX = 1 + nx * 0.4 * intensity;
    ball.squashY = 1 + ny * 0.4 * intensity;

    state.freezeTimer = 26;
    state.shake = Math.max(state.shake, 4 + intensity * 4);

    Audio_.bounce(intensity);
    triggerBounceFeedback(ball, intensity, '#111');
  }
}

function triggerBounceFeedback(ball, intensity = 1, color = '#111') {
  const count = Math.round(5 + intensity * 5);
  for (let i = 0; i < count; i++) {
    const c = state.chaosActive ? `hsl(${Math.random() * 360}, 90%, 55%)` : color;
    state.particles.push(makeParticle(ball.x, ball.y, c));
  }
}

const MAX_BALL_SPEED = 1000;

function updateBalls(dt) {
  const hits = [];

  balls.forEach(ball => {
    ball.vy += state.gravity * dt;
    ball.vx += state.windX * dt;

    if (state.magneticActive) {
      targets.forEach(t => {
        const dx = t.x - ball.x, dy = t.y - ball.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 220 && dist > 1) {
          ball.vx += (dx / dist) * 60 * dt;
          ball.vy += (dy / dist) * 60 * dt;
        }
      });
    }

    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > MAX_BALL_SPEED) {
      const k = MAX_BALL_SPEED / speed;
      ball.vx *= k;
      ball.vy *= k;
    }

    ball.x += ball.vx * dt * state.speedMultiplier;
    ball.y += ball.vy * dt * state.speedMultiplier;

    // lightweight motion trail
    ball.trail.push({ x: ball.x, y: ball.y });
    if (ball.trail.length > 8) ball.trail.shift();

    for (const line of state.lines) reflectBallOffLine(line, ball);

    targets.forEach(t => {
      const dist = Math.hypot(ball.x - t.x, ball.y - t.y);
      if (dist < ball.r + t.r) hits.push(t);
    });

    // walls: the ball always bounces back in, the game never ends from this
    if (ball.x < ball.r) {
      ball.x = ball.r;
      ball.vx *= -WALL_BOUNCE;
      onWallHit(ball, 1, 0);
    } else if (ball.x > canvas.width - ball.r) {
      ball.x = canvas.width - ball.r;
      ball.vx *= -WALL_BOUNCE;
      onWallHit(ball, -1, 0);
    }
    if (ball.y < ball.r) {
      ball.y = ball.r;
      ball.vy *= -WALL_BOUNCE;
      onWallHit(ball, 0, 1);
    } else if (ball.y > canvas.height - ball.r) {
      ball.y = ball.r;
      ball.vy *= -WALL_BOUNCE;
      onWallHit(ball, 0, -1);
    }
  });

  hits.forEach(onTargetHit);
}

function onWallHit(ball, nx, ny) {
  const speed = Math.hypot(ball.vx, ball.vy);
  const intensity = Math.min(1, speed / 500);
  state.shake = Math.max(state.shake, 1.5 + intensity * 2);
  ball.squashX = 1 + Math.abs(nx) * 0.25 * intensity;
  ball.squashY = 1 + Math.abs(ny) * 0.25 * intensity;
  Audio_.wallBounce(intensity);
  for (let i = 0; i < 4; i++) state.particles.push(makeParticle(ball.x, ball.y, '#9db8e8'));
}

function updateTargets(dt) {
  targets.forEach(t => {
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    if (t.x < t.r || t.x > canvas.width - t.r) t.vx *= -1;
    if (t.y < t.r || t.y > canvas.height - t.r) t.vy *= -1;
  });
}

function updateTargetPersonality(dt) {
  targets.forEach(t => {
    t.blinkTimer -= dt;
    if (t.blinkTimer <= 0 && t.blink === 0) {
      t.blink = 1;
      t.blinkTimer = 2.5 + Math.random() * 3;
    }
    if (t.blink > 0) t.blink = Math.max(0, t.blink - dt * 9);

    let nearestDist = Infinity;
    balls.forEach(b => {
      const d = Math.hypot(b.x - t.x, b.y - t.y);
      if (d < nearestDist) nearestDist = d;
    });
    const panicTarget = nearestDist < 140 ? 1 - nearestDist / 140 : 0;
    t.panic += (panicTarget - t.panic) * Math.min(1, dt * 6);
  });
}

function onTargetHit(t) {
  state.score++;
  state.speedMultiplier = Math.min(state.maxSpeedMultiplier, state.speedMultiplier + state.speedGrowth);

  state.shake = 16;
  state.freezeTimer = 90;
  state.slowMoTimer = 260;
  state.zoomTarget = 1.12;
  t.punch = 1;

  Audio_.score();
  for (let i = 0; i < 30; i++) state.particles.push(makeParticle(t.x, t.y, '#ffc400', true));
  state.flash = 0.5;
  state.chroma = 1;
  triggerScoreUIPunch();
  state.scorePopups.push({ x: t.x, y: t.y, life: 1, vy: -50, scale: 0 });
  t.blink = 1;
  t.panic = 0;
  relocateTarget(t);

  checkMilestones();
}

function updateLines(dt) {
  const now = performance.now();
  const lifetime = LINE_LIFETIME * state.lineLifetimeMult;
  state.lines.forEach(l => { l.drawProgress = Math.min(1, l.drawProgress + dt * 7); });
  compactInPlace(state.lines, l => now - l.createdAt < lifetime);
}

function updateInk(dt) {
  state.ink = Math.min(state.maxInk, state.ink + state.inkRegenRate * dt);
  inkBarEl.style.width = (state.ink / state.maxInk) * 100 + '%';
  inkBarEl.style.background = state.ink < state.inkCost
    ? 'linear-gradient(90deg,#ff5252,#ff8a80)'
    : 'linear-gradient(90deg,#2962ff,#5b8aff)';
}

function triggerScoreUIPunch() {
  scoreEl.classList.remove('pop');
  void scoreEl.offsetWidth;
  scoreEl.classList.add('pop');
}

function updateScoreUI(dt) {
  state.displayScore += (state.score - state.displayScore) * Math.min(1, dt * 12);
  scoreEl.textContent = Math.round(state.displayScore);

  if (state.score > state.highScore) {
    highScoreEl.textContent = state.score;
    if (state.newBestFlash <= 0) highScoreEl.parentElement === null ? null : null;
    if (state.newBestFlash <= 0) document.getElementById('highScoreBox').classList.add('new-best');
    state.newBestFlash = 1;
  }
}

/* ============================================================
   PROGRESSION MODULE
   ============================================================ */
const MILESTONES = [
  { score: 10, label: 'TARGET SPEED UP', apply: () => { state.targetSpeedBoost = 1.5; targets.forEach(t => { t.vx *= 1.5; t.vy *= 1.5; }); } },
  { score: 20, label: 'GRAVITY REVERSED', apply: () => { state.gravity *= -1; } },
  { score: 30, label: 'DOUBLE TROUBLE', apply: () => { spawnTarget(); } },
  { score: 40, label: 'WORLD SPINS', apply: () => { state.rotationActive = true; } },
  { score: 50, label: 'SECOND BALL', apply: () => { spawnBall(); } },
  { score: 60, label: 'FRAGILE LINES', apply: () => { state.lineLifetimeMult = 0.6; } },
  { score: 70, label: 'OVERDRIVE', apply: () => { state.maxSpeedMultiplier += 0.25; } },
  { score: 80, label: 'MAGNETIC TARGET', apply: () => { state.magneticActive = true; } },
  { score: 90, label: 'WILD WIND', apply: () => { state.windActive = true; } },
  { score: 100, label: 'CHAOS MODE', apply: () => { state.chaosActive = true; } }
];

function checkMilestones() {
  const hit = MILESTONES.find(m => m.score === state.score && !state.milestonesUnlocked.has(m.score));
  if (!hit) return;
  state.milestonesUnlocked.add(hit.score);
  hit.apply();
  spawnBanner(hit.label);
  Audio_.milestone();
}

function spawnBanner(text) { state.banners.push({ text, time: 0 }); }

function updateBanners(dt) {
  state.banners.forEach(b => { b.time += dt; });
  compactInPlace(state.banners, b => b.time < 2.4);
}

function updateWind(dt) {
  if (!state.windActive) { state.windX *= (1 - Math.min(1, dt * 2)); return; }
  state.windTimer -= dt;
  if (state.windTimer <= 0) {
    state.windTargetX = (Math.random() - 0.5) * 220;
    state.windTimer = 1.5 + Math.random() * 2;
  }
  state.windX += (state.windTargetX - state.windX) * Math.min(1, dt * 1.2);
}

function updateRotation(dt) {
  if (state.rotationActive) state.worldRotation += dt * 0.16;
}

function makeParticle(x, y, color, big = false) {
  const angle = Math.random() * Math.PI * 2;
  const speed = big ? 90 + Math.random() * 240 : 60 + Math.random() * 140;
  return {
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: 1,
    color,
    r: big ? 2 + Math.random() * 5 : 1.5 + Math.random() * 2.5,
    gravity: big ? 220 : 0,
    glow: big
  };
}

function updateParticles(dt) {
  state.particles.forEach(p => {
    p.vy += p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt * 1.6;
  });
  compactInPlace(state.particles, p => p.life > 0);
}

function updateScorePopups(dt) {
  state.scorePopups.forEach(p => {
    p.y += p.vy * dt;
    p.life -= dt * 1.2;
    p.scale += (1.3 - p.scale) * Math.min(1, dt * 14);
  });
  compactInPlace(state.scorePopups, p => p.life > 0);
}

function updateFlash(dt) {
  state.flash = Math.max(0, state.flash - dt * 2.2);
  state.chroma = Math.max(0, state.chroma - dt * 6);
}

function updateShake(dt) {
  if (state.shake > 0) state.shake = Math.max(0, state.shake - dt * 40);
}

function updateBallSquash(dt) {
  balls.forEach(ball => {
    ball.squashX += (1 - ball.squashX) * Math.min(1, dt * 10);
    ball.squashY += (1 - ball.squashY) * Math.min(1, dt * 10);
  });
}

function updateTargetPunch(dt) {
  targets.forEach(t => { t.punch += (0 - t.punch) * Math.min(1, dt * 8); });
}

function updateZoom(dt) {
  state.zoom += (state.zoomTarget - state.zoom) * Math.min(1, dt * 12);
  state.zoomTarget += (1 - state.zoomTarget) * Math.min(1, dt * 4);
}

function updateTimeScale(realDtMs) {
  if (state.freezeTimer > 0) {
    state.freezeTimer -= realDtMs;
    state.timeScale = 0;
    return;
  }
  if (state.slowMoTimer > 0) {
    state.slowMoTimer -= realDtMs;
    state.timeScale = 0.25;
    return;
  }
  state.timeScale = 1;
}

/* ============================================================
   RENDER MODULE
   ============================================================ */
function render() {
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.zoom !== 1) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(state.zoom, state.zoom);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }

  if (state.rotationActive) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(state.worldRotation);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }

  if (state.shake > 0) {
    const sx = (Math.random() - 0.5) * state.shake;
    const sy = (Math.random() - 0.5) * state.shake;
    ctx.translate(sx, sy);
  }

  drawLines();
  drawAimPreview();
  targets.forEach(drawTarget);
  balls.forEach(drawBall);
  drawParticles();
  drawScorePopups();

  ctx.restore();

  drawFlash();
  drawBanners();
}

function drawFlash() {
  if (state.flash > 0) {
    ctx.fillStyle = `rgba(255, 240, 180, ${state.flash * 0.35})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (state.chroma > 0) {
    ctx.globalCompositeOperation = 'lighten';
    const offset = state.chroma * 3;
    ctx.fillStyle = `rgba(255, 0, 60, ${state.chroma * 0.06})`;
    ctx.fillRect(-offset, 0, canvas.width, canvas.height);
    ctx.fillStyle = `rgba(0, 200, 255, ${state.chroma * 0.06})`;
    ctx.fillRect(offset, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawLines() {
  const now = performance.now();
  const lifetime = LINE_LIFETIME * state.lineLifetimeMult;
  ctx.lineCap = 'round';
  state.lines.forEach(l => {
    const age = (now - l.createdAt) / lifetime;
    const alpha = 1 - age;
    const flicker = age > 0.75 ? 0.6 + Math.random() * 0.4 : 1; // flicker as it nears expiry
    const dp = l.drawProgress;
    const mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2;
    const dx1 = mx + (l.x1 - mx) * dp, dy1 = my + (l.y1 - my) * dp;
    const dx2 = mx + (l.x2 - mx) * dp, dy2 = my + (l.y2 - my) * dp;

    ctx.save();
    ctx.shadowColor = 'rgba(41,98,255,0.55)';
    ctx.shadowBlur = 10;
    ctx.lineWidth = 5;
    ctx.strokeStyle = `rgba(41, 98, 255, ${Math.max(0.15, alpha * flicker)})`;
    ctx.beginPath();
    ctx.moveTo(dx1, dy1);
    ctx.lineTo(dx2, dy2);
    ctx.stroke();
    ctx.restore();
  });
}

function drawAimPreview() {
  if (!state.running) return;
  const half = LINE_LENGTH / 2;
  const dx = Math.cos(input.angle) * half;
  const dy = Math.sin(input.angle) * half;
  const canAfford = state.ink >= state.inkCost;
  ctx.lineWidth = 3;
  ctx.strokeStyle = canAfford ? 'rgba(120, 150, 220, 0.45)' : 'rgba(200, 0, 0, 0.3)';
  ctx.beginPath();
  ctx.moveTo(input.mouseX - dx, input.mouseY - dy);
  ctx.lineTo(input.mouseX + dx, input.mouseY + dy);
  ctx.stroke();

  drawCursor(canAfford);
}

function drawCursor(canAfford) {
  const pulse = 1 + Math.sin(performance.now() / 220) * 0.12;
  const baseR = canAfford ? 5 : 4;
  ctx.beginPath();
  ctx.strokeStyle = canAfford ? 'rgba(41, 98, 255, 0.8)' : 'rgba(200, 0, 0, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.arc(input.mouseX, input.mouseY, baseR * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = canAfford ? '#2962ff' : '#c80000';
  ctx.arc(input.mouseX, input.mouseY, 1.6, 0, Math.PI * 2);
  ctx.fill();
}

function drawBall(ball) {
  // motion trail
  ball.trail.forEach((p, i) => {
    const a = (i / ball.trail.length) * 0.25;
    ctx.beginPath();
    ctx.fillStyle = `rgba(17,17,17,${a})`;
    ctx.arc(p.x, p.y, ball.r * (0.5 + i / ball.trail.length * 0.5), 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.scale(ball.squashX, ball.squashY);
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.fillStyle = '#111';
  ctx.arc(0, 0, ball.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTarget(target) {
  const t = performance.now() / 1000;
  const breathe = 1 + Math.sin(t * 1.3 + target.idlePhase) * 0.05;
  const float = Math.sin(t * 1.1 + target.floatPhase) * 4;
  const scale = (1 + target.punch * 0.6) * breathe;

  const panicShake = target.panic * 3;
  const jx = (Math.random() - 0.5) * panicShake;
  const jy = (Math.random() - 0.5) * panicShake + float;

  ctx.save();
  ctx.translate(target.x + jx, target.y + jy);
  ctx.scale(scale, scale * (1 - target.panic * 0.06));

  if (target.punch > 0.02) {
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255, 196, 0, ${target.punch * 0.6})`;
    ctx.lineWidth = 3;
    ctx.arc(0, 0, target.r + 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  // jelly blob body - soft squash on the vertical axis driven by breathing
  ctx.shadowColor = 'rgba(255, 196, 0, 0.5)';
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.fillStyle = '#ffc94d';
  ctx.ellipse(0, 0, target.r, target.r * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e0a800';
  ctx.stroke();

  drawTargetFace(target);

  ctx.restore();
}

function drawTargetFace(target) {
  let nearest = null, nearestDist = Infinity;
  balls.forEach(b => {
    const d = Math.hypot(b.x - target.x, b.y - target.y);
    if (d < nearestDist) { nearestDist = d; nearest = b; }
  });

  let lookX = 0, lookY = 0;
  if (nearest) {
    const dx = nearest.x - target.x, dy = nearest.y - target.y;
    const d = Math.hypot(dx, dy) || 1;
    lookX = (dx / d) * 3;
    lookY = (dy / d) * 3;
  }

  const eyeSpacing = 8;
  const eyeY = -2;
  const openness = 1 - target.blink;
  const eyeR = 5.5 * (0.25 + 0.75 * Math.max(0.15, openness)) * (1 + target.panic * 0.4);

  [-eyeSpacing, eyeSpacing].forEach(ex => {
    ctx.beginPath();
    ctx.fillStyle = '#fff';
    ctx.ellipse(ex, eyeY, 6, eyeR, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = '#111';
    ctx.arc(ex + lookX, eyeY + lookY * 0.6, Math.min(2.6, eyeR * 0.55), 0, Math.PI * 2);
    ctx.fill();
  });

  if (target.panic > 0.15) {
    ctx.strokeStyle = `rgba(140, 70, 0, ${target.panic})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-eyeSpacing - 6, eyeY - 9);
    ctx.lineTo(-eyeSpacing + 3, eyeY - 6);
    ctx.moveTo(eyeSpacing + 6, eyeY - 9);
    ctx.lineTo(eyeSpacing - 3, eyeY - 6);
    ctx.stroke();
  }

  // mouth: calm smile, widens to an "oh no" when panicked
  ctx.beginPath();
  ctx.strokeStyle = '#8a5a00';
  ctx.lineWidth = 2;
  const mouthY = 8;
  if (target.panic > 0.4) {
    ctx.ellipse(0, mouthY + 2, 3 + target.panic * 2, 3 + target.panic * 3, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.arc(0, mouthY - 3, 5, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }
}

function drawBanners() {
  if (state.banners.length === 0) return;
  const b = state.banners[state.banners.length - 1];
  const t = b.time;
  let scale, alpha;
  if (t < 0.25) {
    scale = (t / 0.25) * 1.15;
    alpha = t / 0.25;
  } else if (t < 0.4) {
    scale = 1.15 - ((t - 0.25) / 0.15) * 0.15;
    alpha = 1;
  } else if (t < 1.8) {
    scale = 1;
    alpha = 1;
  } else {
    scale = 1;
    alpha = 1 - (t - 1.8) / 0.6;
  }

  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.translate(canvas.width / 2, canvas.height * 0.32);
  ctx.scale(scale, scale);

  const text = b.text;
  ctx.font = '800 38px Segoe UI, sans-serif';
  const textWidth = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(17, 17, 17, 0.88)';
  const r = 14;
  roundRect(ctx, -textWidth / 2 - 28, -34, textWidth + 56, 64, r);
  ctx.fill();

  ctx.shadowColor = 'rgba(255, 196, 0, 0.8)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffc400';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawParticles() {
  state.particles.forEach(p => {
    ctx.globalAlpha = Math.max(0, p.life);
    if (p.glow) {
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
    } else {
      ctx.shadowBlur = 0;
    }
    ctx.beginPath();
    ctx.fillStyle = p.color;
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

function drawScorePopups() {
  ctx.textAlign = 'center';
  state.scorePopups.forEach(p => {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.translate(p.x, p.y);
    ctx.scale(p.scale, p.scale);
    ctx.font = '700 24px Segoe UI, sans-serif';
    ctx.shadowColor = 'rgba(255,170,0,0.6)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ffaa00';
    ctx.fillText('+1', 0, 0);
    ctx.restore();
  });
  ctx.globalAlpha = 1;
}

/* ============================================================
   GAME LOOP
   ============================================================ */
let lastTime = performance.now();

function loop(now) {
  const realDtMs = Math.min(33, now - lastTime);
  lastTime = now;

  if (state.running) {
    updateTimeScale(realDtMs);
    const dtSec = realDtMs / 1000;
    const dt = dtSec * state.timeScale;

    updateBalls(dt);
    updateTargets(dt);
    updateTargetPersonality(dtSec);
    updateLines(dtSec);
    updateInk(dtSec);
    updateParticles(dt);
    updateScorePopups(dt);
    updateShake(dtSec);
    updateBallSquash(dtSec);
    updateTargetPunch(dtSec);
    updateZoom(dtSec);
    updateFlash(dtSec);
    updateWind(dtSec);
    updateRotation(dtSec);
    updateBanners(dtSec);
    updateScoreUI(dtSec);
  }

  render();
  requestAnimationFrame(loop);
}

/* ============================================================
   GAME FLOW
   ============================================================ */
function startGame() {
  state.running = true;
  state.score = 0;
  state.ink = state.maxInk;
  state.speedMultiplier = 0.6;
  state.maxSpeedMultiplier = 1.35;
  state.gravity = BASE_GRAVITY;
  state.lines = [];
  state.particles = [];
  state.scorePopups = [];
  state.freezeTimer = 0;
  state.slowMoTimer = 0;
  state.timeScale = 1;
  state.zoom = 1;
  state.zoomTarget = 1;
  state.flash = 0;
  state.chroma = 0;
  state.shake = 0;

  state.milestonesUnlocked = new Set();
  state.banners = [];
  state.lineLifetimeMult = 1;
  state.targetSpeedBoost = 1;
  state.magneticActive = false;
  state.windActive = false;
  state.windX = 0;
  state.windTargetX = 0;
  state.windTimer = 0;
  state.rotationActive = false;
  state.worldRotation = 0;
  state.chaosActive = false;

  scoreEl.textContent = 0;
  state.displayScore = 0;
  state.newBestFlash = 0;
  document.getElementById('highScoreBox').classList.remove('new-best');
  highScoreEl.textContent = state.highScore;
  gameOverScreen.classList.add('hidden');

  balls = [];
  targets = [];
  spawnBall();
  spawnTarget();
}

startGame();
requestAnimationFrame(loop);
