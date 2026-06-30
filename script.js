/* ============================================================
   BOUNCE TRAP - core prototype
   Modules: Audio | Physics | Input | Entities | Render | Game Loop
   ============================================================ */

// ---------- Canvas setup ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// declared early (before resizeCanvas runs) since resize clamps these arrays
let balls = [];
let targets = [];

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  // keep existing entities inside the new bounds so shrinking the window
  // doesn't strand a ball outside and trigger an instant, unfair game over
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
  // short burst of filtered white noise - adds "crunch"/"snap" to impacts.
  // buffers are cached by (duration,freq) since bounces can fire rapidly and
  // regenerating + filling a Float32Array from scratch every time is wasted work
  const noiseBufferCache = new Map();
  function getNoiseBuffer(ac, duration) {
    const key = Math.round(duration * 1000); // bucket by ms, ignores freq (filter handles tone)
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
    place: () => tone(500, 0.07, 'square', 0.07),
    // pitch rises with impact intensity - fast hits sound sharper/brighter
    bounce: (intensity = 1) => {
      const basePitch = 150 + intensity * 140 + Math.random() * 30;
      tone(basePitch, 0.08, 'triangle', 0.07 + 0.05 * intensity);
      noiseBurst(0.04, 0.04 + 0.05 * intensity, 1000 + intensity * 1200);
    },
    // layered "satisfying pop" chord + bright chime + crunch, the core reward sound
    score: () => {
      noiseBurst(0.05, 0.14, 2600);
      tone(523, 0.16, 'sine', 0.16);
      tone(659, 0.16, 'sine', 0.13, 0.03);
      tone(784, 0.22, 'sine', 0.14, 0.06);
      tone(1046, 0.28, 'triangle', 0.1, 0.09, 1400);
    },
    gameOver: () => { tone(220, 0.25, 'sawtooth', 0.12, 0, 80); tone(160, 0.4, 'sawtooth', 0.1, 0.12, 60); },
    deny: () => tone(110, 0.1, 'square', 0.08),
    // short ascending arpeggio - distinct from the score sound, feels like an "unlock"
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
  highScore: Number(localStorage.getItem('bounceTrapHighScore') || 0),
  ink: 100,
  maxInk: 100,
  inkRegenRate: 14,     // per second
  inkCost: 34,          // cost per line placed
  speedMultiplier: 1,
speedMultiplier: 0.65,       // Much slower start
speedGrowth: 0.008,          // Gentle progression
gravity: 180,                // Easier physics
  shake: 0,
  lines: [],             // active player lines
  particles: [],
  scorePopups: [],

  // --- juice / game-feel state ---
  freezeTimer: 0,        // ms remaining of total hit-stop (time fully paused)
  slowMoTimer: 0,        // ms remaining of slow motion after a hit
  timeScale: 1,          // current playback speed multiplier (1 = normal)
  zoom: 1,               // current camera zoom level
  zoomTarget: 1,         // zoom eases toward this value each frame
  flash: 0,              // soft white/yellow screen flash on score, eases to 0
  chroma: 0,             // tiny RGB-split flash on score, eases to 0
  displayScore: 0,       // eases toward state.score for a count-up animation
  newBestFlash: 0,       // pulses once the run's score first overtakes the saved high score

  // --- progression / milestone state ---
  milestonesUnlocked: new Set(),  // score thresholds already applied this run
  banners: [],                    // queued milestone announcement banners
  lineLifetimeMult: 1,            // shrinks at milestone 60 (lines decay faster)
  targetSpeedBoost: 1,            // grows at milestone 10
  magneticActive: false,          // milestone 80
  windActive: false,              // milestone 90
  windX: 0,                       // current wind force applied to balls
  windTargetX: 0,                 // wind eases toward this, re-rolled periodically
  windTimer: 0,
  rotationActive: false,          // milestone 40
  worldRotation: 0,
  chaosActive: false              // milestone 100 - cosmetic flair only
};
const BASE_GRAVITY = state.gravity; // remembered so a restart can undo "gravity reversed"
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
    squashX: 1, squashY: 1   // eased toward 1 each frame; punched on bounce
  };
  const angle = Math.random() * Math.PI * 2;
  const speed = 140;
  b.vx = Math.cos(angle) * speed;
  b.vy = Math.sin(angle) * speed;
  balls.push(b);
  return b;
}

function spawnTarget() {
  const t = {
    r: 22, x: 0, y: 0, vx: 0, vy: 0, punch: 0,
    blinkTimer: 1 + Math.random() * 2,  // countdown to next blink
    blink: 0,                            // 0 = eyes open, 1 = fully closed
    panic: 0,                            // eases up when a ball gets close
    idlePhase: Math.random() * Math.PI * 2 // offsets breathing animation per target
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
  const speed = (50 + Math.random() * 40) * state.targetSpeedBoost;
  t.vx = Math.cos(angle) * speed;
  t.vy = Math.sin(angle) * speed;
}

/* ============================================================
   INPUT MODULE
   - Mouse moves the aim cursor
   - A/D or Q/E or scroll wheel rotate the placement line
   - Click places a line (max 3 active, oldest replaced)
   ============================================================ */
// NEW
const LINE_LENGTH = 120;          // Easier to catch the ball
const LINE_LIFETIME = 1800;       // Shorter lifetime keeps gameplay active
const MAX_LINES = 1;              // Only one active line
const WALL_BOUNCE = 0.98;         // Wall energy retention

const input = {
  mouseX: window.innerWidth / 2,
  mouseY: window.innerHeight / 2,
  angle: 0
};

window.addEventListener('mousemove',(e)=>{

    input.mouseX=e.clientX;
    input.mouseY=e.clientY;

    const ball=balls[0];

    if(ball){

        input.angle=Math.atan2(
            input.mouseY-ball.y,
            input.mouseX-ball.x
        );

    }

});

, (e) => {
  const step = 0.12; // radians
  if (e.key === 'a' || e.key === 'q') input.angle -= step;
  if (e.key === 'd' || e.key === 'e') input.angle += step;
});

// BUGFIX: was attached to `window`, so clicking the score/ink UI or the
// restart button also placed a line underneath it. Scoped to the canvas
// itself so only clicks on the actual play area count.
canvas.addEventListener('click', () => {
  if (!state.running) return;
  if (state.ink < state.inkCost) { Audio_.deny(); return; }
  placeLine();
});

// { passive: false } + preventDefault stops the wheel gesture from also
// scrolling/zooming the page while the player is rotating their line
, (e) => {
  e.preventDefault();
  input.angle += e.deltaY * 0.0025;
}, { passive: false });

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
    createdAt: performance.now()
  };
  state.lines.push(line);
  if (state.lines.length > MAX_LINES) state.lines.shift(); // remove oldest
  Audio_.place();
}

restartBtn.addEventListener('click', startGame);

/* ============================================================
   PHYSICS MODULE
   ============================================================ */

// removes elements that fail `keep` IN PLACE - avoids allocating a new
// array every frame the way .filter() would (these run every frame)
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
  if (dist < ball.r && dist > 0.0001) {
    // normal vector
    const nx = dx / dist;
    const ny = dy / dist;
    // push ball out of the line
    const overlap = ball.r - dist;
    ball.x += nx * overlap;
    ball.y += ny * overlap;
    // reflect velocity: v' = v - 2(v.n)n
    const dot = ball.vx * nx + ball.vy * ny;
    ball.vx -= 2 * dot * nx;
    ball.vy -= 2 * dot * ny;
    // slight energy boost for "satisfying" bounce feel
    ball.vx *= 1.02;
    ball.vy *= 1.02;

    const speed = Math.hypot(ball.vx, ball.vy);
    const intensity = Math.min(1.6, speed / 400);

    // squash perpendicular to normal, stretch along it - classic "splat" feel
    ball.squashX = 1 + nx * 0.4 * intensity;
    ball.squashY = 1 + ny * 0.4 * intensity;

    // tiny hit-stop on every bounce makes each impact read clearly
    state.freezeTimer = 28;
    state.shake = Math.max(state.shake, 4 + intensity * 4);

    Audio_.bounce(intensity);
    triggerBounceFeedback(ball, intensity);
  }
}

function triggerBounceFeedback(ball, intensity = 1) {
  const count = Math.round(5 + intensity * 5);
  for (let i = 0; i < count; i++) {
    // chaos mode tints bounce sparks rainbow instead of plain black
    const color = state.chaosActive ? `hsl(${Math.random() * 360}, 90%, 55%)` : '#111';
    state.particles.push(makeParticle(ball.x, ball.y, color));
  }
}

const MAX_BALL_SPEED = 1100; // px/s - prevents runaway velocity (wind+magnet+overdrive stacking) and line tunneling

function updateBalls(dt) {
  // collect collisions/out-of-bounds during iteration, apply them AFTER both
  // forEach loops finish - milestone effects (spawnBall/spawnTarget) mutate
  // these same arrays, and doing that mid-iteration is undefined-ish behavior
  const hits = [];
  let anyOutOfBounds = false;

  balls.forEach(ball => {
    ball.vy += state.gravity * dt;
    ball.vx += state.windX * dt;

    // milestone 80: nearby targets gently pull the ball toward them
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

    // clamp speed - stops wind/magnet/overdrive from compounding into a ball
    // moving so fast per-frame that it tunnels straight through thin lines
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > MAX_BALL_SPEED) {
      const k = MAX_BALL_SPEED / speed;
      ball.vx *= k;
      ball.vy *= k;
    }

    ball.x += ball.vx * dt * state.speedMultiplier;
    ball.y += ball.vy * dt * state.speedMultiplier;

    for (const line of state.lines) reflectBallOffLine(line, ball);

    targets.forEach(t => {
      const dist = Math.hypot(ball.x - t.x, ball.y - t.y);
      if (dist < ball.r + t.r) hits.push(t);
    });

   // LEFT
if(ball.x < ball.r){
    ball.x = ball.r;
    ball.vx *= -WALL_BOUNCE;
    Audio_.bounce(0.7);
}

// RIGHT
if(ball.x > canvas.width-ball.r){
    ball.x = canvas.width-ball.r;
    ball.vx *= -WALL_BOUNCE;
    Audio_.bounce(0.7);
}

// TOP
if(ball.y < ball.r){
    ball.y = ball.r;
    ball.vy *= -WALL_BOUNCE;
    Audio_.bounce(0.7);
}

// BOTTOM
if(ball.y > canvas.height-ball.r){
    ball.y = canvas.height-ball.r;
    ball.vy *= -WALL_BOUNCE;
    Audio_.bounce(0.7);
}
  });

  hits.forEach(onTargetHit);
  if (anyOutOfBounds) endGame();
}

function updateTargets(dt) {
  targets.forEach(t => {
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    if (t.x < t.r || t.x > canvas.width - t.r) t.vx *= -1;
    if (t.y < t.r || t.y > canvas.height - t.r) t.vy *= -1;
  });
}

// gives each target a bit of life: blinking eyes + panic when a ball closes in
function updateTargetPersonality(dt) {
  targets.forEach(t => {
    // blink cycle
    t.blinkTimer -= dt;
    if (t.blinkTimer <= 0 && t.blink === 0) {
      t.blink = 1;
      t.blinkTimer = 2.5 + Math.random() * 3;
    }
    if (t.blink > 0) {
      t.blink = Math.max(0, t.blink - dt * 9); // quick close+open
    }

    // panic rises the closer the nearest ball gets
    let nearestDist = Infinity;
    balls.forEach(b => {
      const d = Math.hypot(b.x - t.x, b.y - t.y);
      if (d < nearestDist) nearestDist = d;
    });
    const panicTarget = nearestDist < 130 ? 1 - nearestDist / 130 : 0;
    t.panic += (panicTarget - t.panic) * Math.min(1, dt * 6);
  });
}

function onTargetHit(t) {
  state.score++;
  scoreEl.textContent = state.score;
state.speedMultiplier = Math.min(
    1.5,
    state.speedMultiplier + state.speedGrowth
);

  // the "big" feedback stack - this is the moment that should feel addictive
  state.shake = 16;
  state.freezeTimer = 90;        // longer hit-stop than a normal bounce
  state.slowMoTimer = 260;       // brief slow-mo as the game un-freezes
  state.zoomTarget = 1.12;       // punch the camera in
  t.punch = 1;

  Audio_.score();
  for (let i = 0; i < 30; i++) {
    state.particles.push(makeParticle(t.x, t.y, '#ffc400', true));
  }
  state.flash = 0.5;     // soft full-screen flash, eases out fast
  state.chroma = 1;      // tiny RGB-split flash, eases out even faster
  triggerScoreUIPunch();
  state.scorePopups.push({ x: t.x, y: t.y, life: 1, vy: -50, scale: 0 });
  t.blink = 1;          // momentary "stunned" eye-close reaction
  t.panic = 0;
  relocateTarget(t);

  checkMilestones();
}

function updateLines() {
  const now = performance.now();
  const lifetime = LINE_LIFETIME * state.lineLifetimeMult;
  compactInPlace(state.lines, l => now - l.createdAt < lifetime);
}

function updateInk(dt) {
  state.ink = Math.min(state.maxInk, state.ink + state.inkRegenRate * dt);
  inkBarEl.style.width = (state.ink / state.maxInk) * 100 + '%';
  // low-ink warning tint, eases via CSS transition on the element itself
  inkBarEl.style.background = state.ink < state.inkCost ? '#ff5252' : '#2962ff';
}

// quick scale-pop on the score number itself; retriggerable via reflow hack
function triggerScoreUIPunch() {
  scoreEl.classList.remove('pop');
  void scoreEl.offsetWidth; // force reflow so the animation can restart
  scoreEl.classList.add('pop');
}

// eases the displayed score toward the real score (count-up), and live-celebrates
// the moment the current run's score overtakes the saved high score
function updateScoreUI(dt) {
  state.displayScore += (state.score - state.displayScore) * Math.min(1, dt * 12);
  scoreEl.textContent = Math.round(state.displayScore);

  if (state.score > state.highScore) {
    highScoreEl.textContent = state.score;
    if (state.newBestFlash <= 0) {
      highScoreEl.classList.add('new-best');
    }
    state.newBestFlash = 1;
  }
}

/* ============================================================
   PROGRESSION MODULE
   - Every 10 points unlocks exactly ONE surprise modifier.
   - Never revealed in advance: the banner only appears the moment
     the threshold is crossed, so the player can't see it coming.
   ============================================================ */
const MILESTONES = [
  { score: 10, label: 'TARGET SPEED UP', apply: () => { state.targetSpeedBoost = 1.6; targets.forEach(t => { t.vx *= 1.6; t.vy *= 1.6; }); } },
  { score: 20, label: 'GRAVITY REVERSED', apply: () => { state.gravity *= -1; } },
  { score: 30, label: 'DOUBLE TROUBLE', apply: () => { spawnTarget(); } },
  { score: 40, label: 'WORLD SPINS', apply: () => { state.rotationActive = true; } },
  { score: 50, label: 'SECOND BALL', apply: () => { spawnBall(); } },
  { score: 60, label: 'FRAGILE LINES', apply: () => { state.lineLifetimeMult = 0.5; } },
  { score: 70, label: 'OVERDRIVE', apply: () => { state.speedMultiplier += 0.4; } },
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

function spawnBanner(text) {
  state.banners.push({ text, time: 0 });
}

function updateBanners(dt) {
  state.banners.forEach(b => { b.time += dt; });
  compactInPlace(state.banners, b => b.time < 2.4);
}

// milestone 90: wind direction/strength re-rolls every couple seconds,
// state.windX eases toward it so the push feels organic, not instant
function updateWind(dt) {
  if (!state.windActive) { state.windX *= (1 - Math.min(1, dt * 2)); return; }
  state.windTimer -= dt;
  if (state.windTimer <= 0) {
    state.windTargetX = (Math.random() - 0.5) * 240;
    state.windTimer = 1.5 + Math.random() * 2;
  }
  state.windX += (state.windTargetX - state.windX) * Math.min(1, dt * 1.2);
}

// milestone 40: the whole world slowly spins for disorientation
function updateRotation(dt) {
  if (state.rotationActive) state.worldRotation += dt * 0.18;
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
    // elastic-ish overshoot: scale punches past 1 then settles
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

// ease ball squash/stretch back toward 1 (normal circle)
function updateBallSquash(dt) {
  balls.forEach(ball => {
    ball.squashX += (1 - ball.squashX) * Math.min(1, dt * 10);
    ball.squashY += (1 - ball.squashY) * Math.min(1, dt * 10);
  });
}

// ease target "punch" scale back toward 0
function updateTargetPunch(dt) {
  targets.forEach(t => { t.punch += (0 - t.punch) * Math.min(1, dt * 8); });
}

// ease camera zoom toward its target, then relax target back to 1
function updateZoom(dt) {
  state.zoom += (state.zoomTarget - state.zoom) * Math.min(1, dt * 12);
  state.zoomTarget += (1 - state.zoomTarget) * Math.min(1, dt * 4);
}

// resolves hit-freeze (full pause) and slow-motion into a single timeScale
// used to scale every other update this frame - this is what makes impacts pop
function updateTimeScale(realDtMs) {
  if (state.freezeTimer > 0) {
    state.freezeTimer -= realDtMs;
    state.timeScale = 0;          // total freeze - nothing moves
    return;
  }
  if (state.slowMoTimer > 0) {
    state.slowMoTimer -= realDtMs;
    state.timeScale = 0.25;       // brief slow motion as we recover from freeze
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

  // camera zoom punch, anchored to screen center
  if (state.zoom !== 1) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(state.zoom, state.zoom);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }

  // milestone 40: slow world rotation, anchored to screen center
  if (state.rotationActive) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(state.worldRotation);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }

  // screen shake
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

  // screen flash + chromatic flash - drawn AFTER restore so shake/zoom don't affect them
  drawFlash();
  drawBanners();
}

function drawFlash() {
  if (state.flash > 0) {
    ctx.fillStyle = `rgba(255, 240, 180, ${state.flash * 0.35})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (state.chroma > 0) {
    // cheap RGB-split: two tinted, offset, screen-blended rectangles
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
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  state.lines.forEach(l => {
    const age = (now - l.createdAt) / lifetime;
    const alpha = 1 - age; // fade as it nears expiry
    ctx.strokeStyle = `rgba(41, 98, 255, ${Math.max(0.15, alpha)})`;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  });
}

function drawAimPreview() {
  if (!state.running) return;
  const half = LINE_LENGTH / 2;
  const dx = Math.cos(input.angle) * half;
  const dy = Math.sin(input.angle) * half;
  const canAfford = state.ink >= state.inkCost;
  ctx.lineWidth = 4;
  ctx.strokeStyle = canAfford ? 'rgba(41, 98, 255, 0.35)' : 'rgba(200, 0, 0, 0.3)';
  ctx.beginPath();
  ctx.moveTo(input.mouseX - dx, input.mouseY - dy);
  ctx.lineTo(input.mouseX + dx, input.mouseY + dy);
  ctx.stroke();

  drawCursor(canAfford);
}

// custom reactive cursor - replaces the system pointer, pulses gently,
// and shifts color/size when the player can't afford a line right now
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
  const breathe = 1 + Math.sin(performance.now() / 480 + target.idlePhase) * 0.04;
  const scale = (1 + target.punch * 0.6) * breathe;

  // panic adds a small fast jitter on top of its real position
  const panicShake = target.panic * 3;
  const jx = (Math.random() - 0.5) * panicShake;
  const jy = (Math.random() - 0.5) * panicShake;

  ctx.save();
  ctx.translate(target.x + jx, target.y + jy);
  ctx.scale(scale, scale);

  // soft glow ring that expands and fades right after a hit
  if (target.punch > 0.02) {
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255, 196, 0, ${target.punch * 0.6})`;
    ctx.lineWidth = 3;
    ctx.arc(0, 0, target.r + 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.shadowColor = 'rgba(255, 196, 0, 0.6)';
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.fillStyle = '#ffc400';
  ctx.arc(0, 0, target.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e0a800';
  ctx.stroke();

  drawTargetEyes(target);

  ctx.restore();
}

// cartoon eyes that look toward the nearest ball, blink, and widen when panicked
function drawTargetEyes(target) {
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
  const openness = 1 - target.blink;          // 1 = open, 0 = closed
  const eyeR = 5.5 * (0.25 + 0.75 * Math.max(0.15, openness)) * (1 + target.panic * 0.3);

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

  // worried eyebrows appear as panic rises
  if (target.panic > 0.15) {
    ctx.strokeStyle = `rgba(120, 60, 0, ${target.panic})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-eyeSpacing - 6, eyeY - 9);
    ctx.lineTo(-eyeSpacing + 3, eyeY - 6);
    ctx.moveTo(eyeSpacing + 6, eyeY - 9);
    ctx.lineTo(eyeSpacing - 3, eyeY - 6);
    ctx.stroke();
  }
}

// milestone announcement banner - big centered text, elastic pop-in, then fades
function drawBanners() {
  if (state.banners.length === 0) return;
  const b = state.banners[state.banners.length - 1]; // show most recent only
  const t = b.time;
  let scale, alpha;
  if (t < 0.25) {
    scale = (t / 0.25) * 1.15;       // quick overshoot in
    alpha = t / 0.25;
  } else if (t < 0.4) {
    scale = 1.15 - ((t - 0.25) / 0.15) * 0.15; // settle back to 1
    alpha = 1;
  } else if (t < 1.8) {
    scale = 1;
    alpha = 1;
  } else {
    scale = 1;
    alpha = 1 - (t - 1.8) / 0.6;     // fade out over the last 0.6s
  }

  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.translate(canvas.width / 2, canvas.height * 0.32);
  ctx.scale(scale, scale);

  // dark backdrop bar for contrast against a white background
  const text = b.text;
  ctx.font = '800 38px Segoe UI, sans-serif';
  const textWidth = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(17, 17, 17, 0.88)';
  ctx.fillRect(-textWidth / 2 - 28, -34, textWidth + 56, 64);

  ctx.shadowColor = 'rgba(255, 196, 0, 0.8)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffc400';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
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
  const realDtMs = Math.min(33, now - lastTime); // real elapsed time, clamped
  lastTime = now;

  if (state.running) {
    updateTimeScale(realDtMs);       // resolves hit-freeze / slow-mo into state.timeScale
    const dtSec = realDtMs / 1000;   // real elapsed seconds (unaffected by freeze/slow-mo)
    const dt = dtSec * state.timeScale; // gameplay-affecting elapsed seconds

    updateBalls(dt);
    updateTargets(dt);
    updateTargetPersonality(dtSec);
    updateLines();
    updateInk(dtSec);                // ink keeps regenerating in real-time, even during freeze
    updateParticles(dt);
    updateScorePopups(dt);
    updateShake(dtSec);              // shake decays in real-time so it doesn't get "stuck" by freeze
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
function endGame() {
  if (!state.running) return;
  state.running = false;
  Audio_.gameOver();
  if (state.score > state.highScore) {
    state.highScore = state.score;
    localStorage.setItem('bounceTrapHighScore', state.highScore);
  }
  finalScoreEl.textContent = 'Score: ' + state.score;
  finalHighScoreEl.textContent = 'Best: ' + state.highScore;
  highScoreEl.textContent = state.highScore;
  gameOverScreen.classList.remove('hidden');
}

function startGame() {
  state.running = true;
  state.score = 0;
  state.ink = state.maxInk;
  state.speedMultiplier = 1;
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

  // reset all progression / milestone state for a clean run
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
  highScoreEl.classList.remove('new-best');
  highScoreEl.textContent = state.highScore;
  gameOverScreen.classList.add('hidden');

  balls = [];
  targets = [];
  spawnBall();
  spawnTarget();
}

startGame();
requestAnimationFrame(loop);
