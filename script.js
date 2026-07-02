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
const scoreEl        = document.getElementById('score');
const highScoreEl    = document.getElementById('highScore');
const inkBarEl       = document.getElementById('inkBar');
const gameOverScreen = document.getElementById('gameOverScreen');
const finalScoreEl   = document.getElementById('finalScore');
const finalHighScoreEl = document.getElementById('finalHighScore');
const restartBtn     = document.getElementById('restartBtn');

/* ============================================================
   AUDIO MODULE (Web Audio API, no external files)
   ============================================================ */
const Audio_ = (() => {
  let actx = null;
  function ctxReady() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    return actx;
  }
  function tone(freq, duration, type, vol, delay, glideTo) {
    type  = type  || 'sine';
    vol   = vol   !== undefined ? vol   : 0.15;
    delay = delay !== undefined ? delay : 0;
    const ac = ctxReady();
    const osc  = ac.createOscillator();
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
  const noiseCache = new Map();
  function getNoiseBuffer(ac, duration) {
    const key = Math.round(duration * 1000);
    let buf = noiseCache.get(key);
    if (buf) return buf;
    const sz = Math.floor(ac.sampleRate * duration);
    buf = ac.createBuffer(1, sz, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < sz; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / sz);
    noiseCache.set(key, buf);
    return buf;
  }
  function noiseBurst(duration, vol, freq) {
    vol  = vol  !== undefined ? vol  : 0.12;
    freq = freq !== undefined ? freq : 2000;
    const ac    = ctxReady();
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
    place: function() { tone(520, 0.06, 'square', 0.05); noiseBurst(0.03, 0.03, 1800); },
    bounce: function(intensity) {
      intensity = intensity !== undefined ? intensity : 1;
      const p = 150 + intensity * 140 + Math.random() * 30;
      tone(p, 0.08, 'triangle', 0.07 + 0.05 * intensity);
      noiseBurst(0.04, 0.04 + 0.05 * intensity, 1000 + intensity * 1200);
    },
    wallBounce: function(intensity) {
      intensity = intensity !== undefined ? intensity : 0.5;
      tone(90 + intensity * 60, 0.07, 'sine', 0.05 + 0.03 * intensity);
      noiseBurst(0.03, 0.02 + 0.02 * intensity, 600);
    },
    score: function() {
      noiseBurst(0.05, 0.14, 2600);
      tone(523, 0.16, 'sine', 0.16);
      tone(659, 0.16, 'sine', 0.13, 0.03);
      tone(784, 0.22, 'sine', 0.14, 0.06);
      tone(1046, 0.28, 'triangle', 0.1, 0.09, 1400);
    },
    deny:     function() { tone(110, 0.1, 'square', 0.08); },
    gameOver: function() { tone(220, 0.25, 'sawtooth', 0.12, 0, 80); tone(160, 0.4, 'sawtooth', 0.1, 0.12, 60); },
    milestone: function() {
      noiseBurst(0.08, 0.1, 1800);
      tone(392, 0.14, 'triangle', 0.13, 0);
      tone(523, 0.14, 'triangle', 0.13, 0.09);
      tone(659, 0.18, 'triangle', 0.14, 0.18);
      tone(880, 0.3,  'sine',     0.12, 0.27, 1100);
    }
  };
})();

/* ============================================================
   CONSTANTS
   ============================================================ */
const LINE_LENGTH          = 130;
const LINE_LIFETIME        = 2200;   // ms
const MAX_LINES            = 1;
const WALL_BOUNCE          = 0.95;
const LINE_HIT_PADDING     = 6;      // px extra collision radius on player lines
const LINE_COOLDOWN_MS     = 120;    // real-wall-clock ms; prevents re-collision same line next frame
const MAX_BALL_SPEED       = 820;    // px/s hard cap
const NO_HIT_TIMEOUT_MS    = 11000;  // ms without touching a line → game over

/* ============================================================
   GAME STATE
   ============================================================ */
const state = {
  running: true,
  score: 0,
  highScore: Number(localStorage.getItem('lineaHighScore') || 0),

  ink: 100,
  maxInk: 100,
  inkRegenRate: 16,   // per second
  inkCost: 30,

  // speed curve – gentle ramp, hard cap
  speedMultiplier:    0.75,
  speedGrowth:        0.022,
  hitsPerSpeedup:     3,
  hitsSinceSpeedup:   0,
  maxSpeedMultiplier: 1.3,
  gravity:            170,

  // loss condition: game over if ball hasn't touched a player line for too long
  lastLineHitAt: 0,   // performance.now() timestamp; 0 = not yet started

  shake: 0,
  lines: [],
  particles: [],
  scorePopups: [],

  // juice / game-feel
  freezeTimer:  0,
  slowMoTimer:  0,
  timeScale:    1,
  zoom:         1,
  zoomTarget:   1,
  flash:        0,
  chroma:       0,
  displayScore: 0,
  newBestShown: false,   // true once 'new-best' class has been added this run

  // progression / milestone
  milestonesUnlocked: new Set(),
  banners:            [],
  lineLifetimeMult:   1,
  targetSpeedBoost:   1,
  magneticActive:     false,
  windActive:         false,
  windX:              0,
  windTargetX:        0,
  windTimer:          0,
  rotationActive:     false,
  worldRotation:      0,
  chaosActive:        false
};
const BASE_GRAVITY = state.gravity;
highScoreEl.textContent = state.highScore;

/* ============================================================
   ENTITIES
   ============================================================ */
function spawnBall() {
  // Always ONE ball, always spawned dead-centre; only launch direction is random.
  const b = {
    r: 12,
    x: canvas.width  / 2,
    y: canvas.height / 2,
    vx: 0, vy: 0,
    squashX: 1, squashY: 1,
    // fixed-size circular trail buffers – zero per-frame allocation
    trailX: new Array(8).fill(canvas.width  / 2),
    trailY: new Array(8).fill(canvas.height / 2),
    trailIdx: 0,
    // real-clock timestamp of last line collision; 0 = no collision yet this run.
    // Using wall-clock time (not scaled dt) so the cooldown is never prolonged
    // by hit-freeze and the ball can't get "stuck" across freeze frames.
    lastLineTouchAt: 0
  };
  const angle = Math.random() * Math.PI * 2;
  b.vx = Math.cos(angle) * 105; // ~25 % slower than original 140 px/s
  b.vy = Math.sin(angle) * 105;
  balls.push(b);
  return b;
}

function spawnTarget() {
  const t = {
    r: 22, x: 0, y: 0, vx: 0, vy: 0,
    punch: 0,
    blinkTimer: 1 + Math.random() * 2,
    blink:      0,
    panic:      0,
    idlePhase:  Math.random() * Math.PI * 2,
    floatPhase: Math.random() * Math.PI * 2
  };
  relocateTarget(t);
  targets.push(t);
  return t;
}

function relocateTarget(t) {
  const margin   = 80;
  const W        = canvas.width;
  const H        = canvas.height;
  // Early game: keep targets within reach so the first few hits feel achievable.
  // After score 8 the full arena is used and the player is already comfortable.
  const earlyGame = state.score < 8 && balls.length > 0;

  let placed = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    let tx, ty;

    if (earlyGame) {
      // Spawn 90–190 px from the current ball position
      const ball = balls[0];
      const ang  = Math.random() * Math.PI * 2;
      const dist = 90 + Math.random() * 100;
      tx = ball.x + Math.cos(ang) * dist;
      ty = ball.y + Math.sin(ang) * dist;
    } else {
      tx = margin + Math.random() * (W - margin * 2);
      ty = margin + Math.random() * (H - margin * 2);
    }

    // Must stay inside the arena
    if (tx < margin || tx > W - margin || ty < margin || ty > H - margin) continue;

    // Must not land on top of any ball (minimum 40 px clear gap)
    let overlap = false;
    for (let i = 0; i < balls.length; i++) {
      if (Math.hypot(tx - balls[i].x, ty - balls[i].y) < balls[i].r + t.r + 40) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;

    t.x     = tx;
    t.y     = ty;
    placed  = true;
    break;
  }

  // Fallback: pure random placement (should rarely be needed)
  if (!placed) {
    t.x = margin + Math.random() * (W - margin * 2);
    t.y = margin + Math.random() * (H - margin * 2);
  }

  const angle = Math.random() * Math.PI * 2;
  const spd   = (40 + Math.random() * 30) * state.targetSpeedBoost;
  t.vx = Math.cos(angle) * spd;
  t.vy = Math.sin(angle) * spd;
}

/* ============================================================
   INPUT MODULE  (mouse only)
   ============================================================ */
const input = {
  mouseX: window.innerWidth  / 2,
  mouseY: window.innerHeight / 2,
  angle: 0
};

function refreshAimAngle() {
  // Compute a line angle that is perpendicular to the vector from the
  // nearest ball to the mouse cursor. Placing the line then naturally
  // intercepts the ball without the player needing to manually rotate.
  let nearest = null, nearestDist = Infinity;
  balls.forEach(function(b) {
    const d = Math.hypot(b.x - input.mouseX, b.y - input.mouseY);
    if (d < nearestDist) { nearestDist = d; nearest = b; }
  });
  if (nearest) {
    const toMouse = Math.atan2(input.mouseY - nearest.y, input.mouseX - nearest.x);
    input.angle = toMouse + Math.PI / 2;
  }
}

window.addEventListener('mousemove', function(e) {
  input.mouseX = e.clientX;
  input.mouseY = e.clientY;
  refreshAimAngle();
});

canvas.addEventListener('click', function() {
  if (!state.running) return;
  if (state.ink < state.inkCost) { Audio_.deny(); return; }
  placeLine();
});

restartBtn.addEventListener('click', startGame);

function placeLine() {
  state.ink -= state.inkCost;
  const half = LINE_LENGTH / 2;
  const dx   = Math.cos(input.angle) * half;
  const dy   = Math.sin(input.angle) * half;
  const line = {
    x1: input.mouseX - dx,
    y1: input.mouseY - dy,
    x2: input.mouseX + dx,
    y2: input.mouseY + dy,
    createdAt:    performance.now(),
    drawProgress: 0   // animates growing in from center outward
  };
  state.lines.push(line);
  if (state.lines.length > MAX_LINES) state.lines.shift();

  // placement particles
  for (let i = 0; i < 8; i++) {
    state.particles.push(makeParticle(input.mouseX, input.mouseY, '#2962ff'));
  }
  Audio_.place();
}

/* ============================================================
   PHYSICS
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
  const nowMs = performance.now();

  // Real-clock cooldown: skip if the ball recently collided with any line.
  // Using performance.now() (not scaled dt) means a hit-freeze doesn't
  // extend the cooldown window and cause the ball to stick across frames.
  if (nowMs - ball.lastLineTouchAt < LINE_COOLDOWN_MS) return;

  const cp   = closestPointOnSegment(ball.x, ball.y, line.x1, line.y1, line.x2, line.y2);
  const ddx  = ball.x - cp.x;
  const ddy  = ball.y - cp.y;
  const dist = Math.hypot(ddx, ddy);
  const hitRadius = ball.r + LINE_HIT_PADDING;

  if (dist >= hitRadius) return; // no overlap – nothing to do

  // Build outward normal. If the ball centre is almost exactly on the line
  // (dist ≈ 0) fall back to the line's left-hand perpendicular so we never
  // divide by zero.
  let nx, ny;
  if (dist > 0.0001) {
    nx = ddx / dist;
    ny = ddy / dist;
  } else {
    const ldx = line.x2 - line.x1;
    const ldy = line.y2 - line.y1;
    const len = Math.hypot(ldx, ldy) || 1;
    nx = -ldy / len;
    ny =  ldx / len;
  }

  // Guard: only reflect if the ball is actually moving INTO the surface
  // (v · n < 0). If it is already moving away (tunnelled and exiting) we
  // just push it out without reversing its velocity so it doesn't bounce
  // back and clip through the other side.
  const dot = ball.vx * nx + ball.vy * ny;
  if (dot < 0) {
    // Standard specular reflection: v' = v - 2(v·n)n
    ball.vx -= 2 * dot * nx;
    ball.vy -= 2 * dot * ny;
    // No energy boost here – removes speed runaway over many bounces.
  }

  // Push ball fully outside the collision zone plus a small safety margin
  // so it cannot still be overlapping next frame.
  const pushOut = (hitRadius - dist) + 1.5;
  ball.x += nx * pushOut;
  ball.y += ny * pushOut;

  // Hard-cap speed immediately after reflection.
  const spd = Math.hypot(ball.vx, ball.vy);
  if (spd > MAX_BALL_SPEED) {
    const k = MAX_BALL_SPEED / spd;
    ball.vx *= k;
    ball.vy *= k;
  }

  const intensity = Math.min(1.6, spd / 400);
  ball.squashX = 1 + nx * 0.4 * intensity;
  ball.squashY = 1 + ny * 0.4 * intensity;

  state.freezeTimer        = 26;
  state.shake              = Math.max(state.shake, 4 + intensity * 4);
  ball.lastLineTouchAt     = nowMs;   // arms the cooldown
  state.lastLineHitAt      = nowMs;   // resets the "no touch" loss timer

  Audio_.bounce(intensity);
  triggerBounceFeedback(ball, intensity);
}

function triggerBounceFeedback(ball, intensity) {
  intensity = intensity !== undefined ? intensity : 1;
  const count = Math.round(5 + intensity * 5);
  for (let i = 0; i < count; i++) {
    const color = state.chaosActive
      ? ('hsl(' + Math.floor(Math.random() * 360) + ',90%,55%)')
      : '#111';
    state.particles.push(makeParticle(ball.x, ball.y, color));
  }
}

function updateBalls(dt) {
  const pendingHits = [];

  balls.forEach(function(ball) {
    // Gravity and wind
    ball.vy += state.gravity * dt;
    ball.vx += state.windX  * dt;

    // Milestone 80: gentle magnetic pull toward target
    if (state.magneticActive) {
      targets.forEach(function(t) {
        const mdx  = t.x - ball.x;
        const mdy  = t.y - ball.y;
        const mdst = Math.hypot(mdx, mdy);
        if (mdst < 220 && mdst > 1) {
          ball.vx += (mdx / mdst) * 60 * dt;
          ball.vy += (mdy / mdst) * 60 * dt;
        }
      });
    }

    // Hard-cap velocity before moving so no single frame produces a
    // displacement large enough to tunnel through a line.
    const spd = Math.hypot(ball.vx, ball.vy);
    if (spd > MAX_BALL_SPEED) {
      const k = MAX_BALL_SPEED / spd;
      ball.vx *= k;
      ball.vy *= k;
    }

    // Sub-step movement: when per-frame travel would exceed the line's
    // effective thickness we split the move into smaller chunks and check
    // collision after each one to prevent tunnelling.
    const frameTravel = Math.hypot(ball.vx, ball.vy) * dt * state.speedMultiplier;
    const steps       = Math.max(1, Math.ceil(frameTravel / 9));
    const subDt       = dt / steps;

    for (let s = 0; s < steps; s++) {
      ball.x += ball.vx * subDt * state.speedMultiplier;
      ball.y += ball.vy * subDt * state.speedMultiplier;
      for (let li = 0; li < state.lines.length; li++) {
        reflectBallOffLine(state.lines[li], ball);
      }
    }

    // Update circular trail buffer (no allocation)
    ball.trailX[ball.trailIdx] = ball.x;
    ball.trailY[ball.trailIdx] = ball.y;
    ball.trailIdx = (ball.trailIdx + 1) % ball.trailX.length;

    // Target collision detection (applied after loop to avoid mutating arrays mid-iteration)
    targets.forEach(function(t) {
      if (Math.hypot(ball.x - t.x, ball.y - t.y) < ball.r + t.r) {
        pendingHits.push(t);
      }
    });

    // Wall bounces – ball ALWAYS stays on screen; there is no death-by-wall.
    if (ball.x < ball.r) {
      ball.x  = ball.r;
      ball.vx = Math.abs(ball.vx) * WALL_BOUNCE;   // always bounce right
      onWallHit(ball, 1, 0);
    } else if (ball.x > canvas.width - ball.r) {
      ball.x  = canvas.width - ball.r;
      ball.vx = -Math.abs(ball.vx) * WALL_BOUNCE;  // always bounce left
      onWallHit(ball, -1, 0);
    }
    if (ball.y < ball.r) {
      ball.y  = ball.r;
      ball.vy = Math.abs(ball.vy) * WALL_BOUNCE;   // always bounce down
      onWallHit(ball, 0, 1);
    } else if (ball.y > canvas.height - ball.r) {
      ball.y  = canvas.height - ball.r;             // FIX: was ball.r (wrong!)
      ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE;  // always bounce up
      onWallHit(ball, 0, -1);
    }
  });

  pendingHits.forEach(onTargetHit);

  // Loss condition: player ignored the ball for too long.
  // Only start counting after the first line placement (lastLineHitAt > 0)
  // so a brand-new run never instantly triggers.
  if (state.running
      && state.lastLineHitAt > 0
      && performance.now() - state.lastLineHitAt > NO_HIT_TIMEOUT_MS) {
    endGame();
  }
}

function onWallHit(ball, nx, ny) {
  const wallSpd   = Math.hypot(ball.vx, ball.vy);
  const intensity = Math.min(1, wallSpd / 500);
  state.shake      = Math.max(state.shake, 1.5 + intensity * 2);
  ball.squashX     = 1 + Math.abs(nx) * 0.22 * intensity;
  ball.squashY     = 1 + Math.abs(ny) * 0.22 * intensity;
  Audio_.wallBounce(intensity);
  // small wall-impact sparks (reuse existing particle pool objects)
  for (let i = 0; i < 4; i++) {
    state.particles.push(makeParticle(ball.x, ball.y, '#9db8e8'));
  }
}

function updateTargets(dt) {
  targets.forEach(function(t) {
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    if (t.x < t.r || t.x > canvas.width  - t.r) t.vx *= -1;
    if (t.y < t.r || t.y > canvas.height - t.r) t.vy *= -1;
  });
}

function updateTargetPersonality(dt) {
  targets.forEach(function(t) {
    // blink cycle
    t.blinkTimer -= dt;
    if (t.blinkTimer <= 0 && t.blink === 0) {
      t.blink      = 1;
      t.blinkTimer = 2.5 + Math.random() * 3;
    }
    if (t.blink > 0) t.blink = Math.max(0, t.blink - dt * 9);

    // panic proportional to how close the nearest ball is
    let nearestDist = Infinity;
    balls.forEach(function(b) {
      const d = Math.hypot(b.x - t.x, b.y - t.y);
      if (d < nearestDist) nearestDist = d;
    });
    const panicTarget = nearestDist < 140 ? 1 - nearestDist / 140 : 0;
    t.panic += (panicTarget - t.panic) * Math.min(1, dt * 6);
  });
}

function onTargetHit(t) {
  state.score++;

  // Speed only ramps every N hits so the first minute stays comfortable
  state.hitsSinceSpeedup++;
  if (state.hitsSinceSpeedup >= state.hitsPerSpeedup) {
    state.hitsSinceSpeedup  = 0;
    state.speedMultiplier   = Math.min(
      state.maxSpeedMultiplier,
      state.speedMultiplier + state.speedGrowth
    );
  }

  state.shake       = 16;
  state.freezeTimer = 90;
  state.slowMoTimer = 260;
  state.zoomTarget  = 1.12;
  t.punch           = 1;

  Audio_.score();
  for (let i = 0; i < 30; i++) state.particles.push(makeParticle(t.x, t.y, '#ffc400', true));
  state.flash  = 0.5;
  state.chroma = 1;
  triggerScoreUIPunch();
  state.scorePopups.push({ x: t.x, y: t.y, life: 1, vy: -50, scale: 0 });
  t.blink = 1;
  t.panic = 0;
  relocateTarget(t);

  checkMilestones();
}

function updateLines(dt) {
  const now      = performance.now();
  const lifetime = LINE_LIFETIME * state.lineLifetimeMult;
  state.lines.forEach(function(l) {
    l.drawProgress = Math.min(1, l.drawProgress + dt * 7);
  });
  compactInPlace(state.lines, function(l) { return now - l.createdAt < lifetime; });
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
  void scoreEl.offsetWidth; // force reflow so CSS animation restarts
  scoreEl.classList.add('pop');
}

function updateScoreUI(dt) {
  state.displayScore += (state.score - state.displayScore) * Math.min(1, dt * 12);
  scoreEl.textContent = Math.round(state.displayScore);

  if (state.score > state.highScore) {
    highScoreEl.textContent = state.score;
    if (!state.newBestShown) {
      document.getElementById('highScoreBox').classList.add('new-best');
      state.newBestShown = true;
    }
  }
}

/* ============================================================
   PROGRESSION – MILESTONES
   One modifier per 10 points.  NO extra ball spawning.
   ============================================================ */
const MILESTONES = [
  {
    score: 10,
    label: 'TARGET SPEED UP',
    apply: function() {
      state.targetSpeedBoost = 1.5;
      targets.forEach(function(t) { t.vx *= 1.5; t.vy *= 1.5; });
    }
  },
  {
    score: 20,
    label: 'GRAVITY REVERSED',
    apply: function() { state.gravity *= -1; }
  },
  {
    score: 30,
    label: 'INK OVERFLOW',
    apply: function() { state.inkRegenRate = Math.min(state.inkRegenRate + 8, 32); }
  },
  {
    score: 40,
    label: 'WORLD SPINS',
    apply: function() { state.rotationActive = true; }
  },
  {
    score: 50,
    label: 'INK SURGE',
    apply: function() { state.inkRegenRate += 6; }   // faster ink recovery – reward, not punishment
  },
  {
    score: 60,
    label: 'FRAGILE LINES',
    apply: function() { state.lineLifetimeMult = 0.6; }
  },
  {
    score: 70,
    label: 'OVERDRIVE',
    apply: function() { state.maxSpeedMultiplier += 0.2; }
  },
  {
    score: 80,
    label: 'MAGNETIC TARGET',
    apply: function() { state.magneticActive = true; }
  },
  {
    score: 90,
    label: 'WILD WIND',
    apply: function() { state.windActive = true; }
  },
  {
    score: 100,
    label: 'CHAOS MODE',
    apply: function() { state.chaosActive = true; }
  }
];

function checkMilestones() {
  for (let i = 0; i < MILESTONES.length; i++) {
    const m = MILESTONES[i];
    if (m.score === state.score && !state.milestonesUnlocked.has(m.score)) {
      state.milestonesUnlocked.add(m.score);
      m.apply();
      spawnBanner(m.label);
      Audio_.milestone();
      break;
    }
  }
}

function spawnBanner(text) {
  state.banners.push({ text: text, time: 0 });
}

function updateBanners(dt) {
  state.banners.forEach(function(b) { b.time += dt; });
  compactInPlace(state.banners, function(b) { return b.time < 2.4; });
}

function updateWind(dt) {
  if (!state.windActive) {
    state.windX *= (1 - Math.min(1, dt * 2));
    return;
  }
  state.windTimer -= dt;
  if (state.windTimer <= 0) {
    state.windTargetX = (Math.random() - 0.5) * 200;
    state.windTimer   = 1.5 + Math.random() * 2;
  }
  state.windX += (state.windTargetX - state.windX) * Math.min(1, dt * 1.2);
}

function updateRotation(dt) {
  if (state.rotationActive) state.worldRotation += dt * 0.16;
}

function makeParticle(x, y, color, big) {
  big = !!big;
  const angle = Math.random() * Math.PI * 2;
  const spd   = big ? 90 + Math.random() * 240 : 60 + Math.random() * 140;
  return {
    x: x, y: y,
    vx: Math.cos(angle) * spd,
    vy: Math.sin(angle) * spd,
    life: 1,
    color: color,
    r:    big ? 2 + Math.random() * 5 : 1.5 + Math.random() * 2.5,
    gravity: big ? 220 : 0,
    glow:    big
  };
}

function updateParticles(dt) {
  state.particles.forEach(function(p) {
    p.vy  += p.gravity * dt;
    p.x   += p.vx * dt;
    p.y   += p.vy * dt;
    p.life -= dt * 1.6;
  });
  compactInPlace(state.particles, function(p) { return p.life > 0; });
}

function updateScorePopups(dt) {
  state.scorePopups.forEach(function(p) {
    p.y    += p.vy * dt;
    p.life  -= dt * 1.2;
    p.scale += (1.3 - p.scale) * Math.min(1, dt * 14);
  });
  compactInPlace(state.scorePopups, function(p) { return p.life > 0; });
}

function updateFlash(dt) {
  state.flash  = Math.max(0, state.flash  - dt * 2.2);
  state.chroma = Math.max(0, state.chroma - dt * 6);
}

function updateShake(dt) {
  if (state.shake > 0) state.shake = Math.max(0, state.shake - dt * 40);
}

function updateBallSquash(dt) {
  balls.forEach(function(ball) {
    ball.squashX += (1 - ball.squashX) * Math.min(1, dt * 10);
    ball.squashY += (1 - ball.squashY) * Math.min(1, dt * 10);
  });
}

function updateTargetPunch(dt) {
  targets.forEach(function(t) {
    t.punch += (0 - t.punch) * Math.min(1, dt * 8);
  });
}

function updateZoom(dt) {
  state.zoom      += (state.zoomTarget - state.zoom)      * Math.min(1, dt * 12);
  state.zoomTarget += (1 - state.zoomTarget)               * Math.min(1, dt * 4);
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
   RENDER
   ============================================================ */
function render() {
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // camera zoom punch, anchored to screen centre
  if (state.zoom !== 1) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(state.zoom, state.zoom);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }

  // milestone 40: world rotation anchored to screen centre
  if (state.rotationActive) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(state.worldRotation);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }

  // screen shake
  if (state.shake > 0) {
    ctx.translate(
      (Math.random() - 0.5) * state.shake,
      (Math.random() - 0.5) * state.shake
    );
  }

  drawLines();
  drawAimPreview();
  targets.forEach(drawTarget);
  balls.forEach(drawBall);
  drawParticles();
  drawScorePopups();

  ctx.restore();

  // flash effects drawn after restore – unaffected by shake/zoom
  drawFlash();
  drawBanners();
}

function drawFlash() {
  if (state.flash > 0) {
    ctx.fillStyle = 'rgba(255,240,180,' + (state.flash * 0.35) + ')';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (state.chroma > 0) {
    ctx.globalCompositeOperation = 'lighten';
    const off = state.chroma * 3;
    ctx.fillStyle = 'rgba(255,0,60,' + (state.chroma * 0.06) + ')';
    ctx.fillRect(-off, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,200,255,' + (state.chroma * 0.06) + ')';
    ctx.fillRect(off,  0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawLines() {
  const now      = performance.now();
  const lifetime = LINE_LIFETIME * state.lineLifetimeMult;
  ctx.lineCap = 'round';
  state.lines.forEach(function(l) {
    const age     = (now - l.createdAt) / lifetime;
    const alpha   = 1 - age;
    const flicker = age > 0.75 ? 0.55 + Math.random() * 0.45 : 1;
    const dp      = l.drawProgress;
    const mx      = (l.x1 + l.x2) / 2;
    const my      = (l.y1 + l.y2) / 2;
    const ax      = mx + (l.x1 - mx) * dp;
    const ay      = my + (l.y1 - my) * dp;
    const bx      = mx + (l.x2 - mx) * dp;
    const by      = my + (l.y2 - my) * dp;

    ctx.save();
    ctx.shadowColor = 'rgba(41,98,255,0.5)';
    ctx.shadowBlur  = 10;
    ctx.lineWidth   = 5;
    ctx.strokeStyle = 'rgba(41,98,255,' + Math.max(0.12, alpha * flicker) + ')';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.restore();
  });
}

function drawAimPreview() {
  if (!state.running) return;
  const half      = LINE_LENGTH / 2;
  const dx        = Math.cos(input.angle) * half;
  const dy        = Math.sin(input.angle) * half;
  const canAfford = state.ink >= state.inkCost;

  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';
  ctx.strokeStyle = canAfford
    ? 'rgba(120,150,220,0.42)'
    : 'rgba(200,0,0,0.28)';
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
  ctx.strokeStyle = canAfford ? 'rgba(41,98,255,0.8)' : 'rgba(200,0,0,0.7)';
  ctx.lineWidth   = 1.5;
  ctx.arc(input.mouseX, input.mouseY, baseR * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = canAfford ? '#2962ff' : '#c80000';
  ctx.arc(input.mouseX, input.mouseY, 1.6, 0, Math.PI * 2);
  ctx.fill();
}

function drawBall(ball) {
  // Motion trail: read circular buffer oldest→newest for correct fade order
  const n = ball.trailX.length;
  for (let i = 0; i < n; i++) {
    const idx = (ball.trailIdx + i) % n;
    const a   = (i / n) * 0.2;
    ctx.beginPath();
    ctx.fillStyle = 'rgba(17,17,17,' + a + ')';
    ctx.arc(ball.trailX[idx], ball.trailY[idx], ball.r * (0.4 + (i / n) * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.scale(ball.squashX, ball.squashY);
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur  = 14;
  ctx.beginPath();
  ctx.fillStyle = '#111';
  ctx.arc(0, 0, ball.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTarget(target) {
  const tsec    = performance.now() / 1000;
  const breathe = 1 + Math.sin(tsec * 1.3 + target.idlePhase) * 0.05;
  const floatY  = Math.sin(tsec * 1.1 + target.floatPhase) * 4;
  const scale   = (1 + target.punch * 0.55) * breathe;

  const jx = (Math.random() - 0.5) * target.panic * 3;
  const jy = (Math.random() - 0.5) * target.panic * 3 + floatY;

  ctx.save();
  ctx.translate(target.x + jx, target.y + jy);
  ctx.scale(scale, scale * (1 - target.panic * 0.06));

  // hit-ring glow
  if (target.punch > 0.02) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,196,0,' + (target.punch * 0.6) + ')';
    ctx.lineWidth   = 3;
    ctx.arc(0, 0, target.r + 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  // jelly-blob body
  ctx.shadowColor = 'rgba(255,196,0,0.5)';
  ctx.shadowBlur  = 16;
  ctx.beginPath();
  ctx.fillStyle = '#ffc94d';
  ctx.ellipse(0, 0, target.r, target.r * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur  = 0;
  ctx.lineWidth   = 2;
  ctx.strokeStyle = '#e0a800';
  ctx.stroke();

  drawTargetFace(target);

  ctx.restore();
}

function drawTargetFace(target) {
  // find nearest ball for eye-tracking
  let nearest = null, nearestDist = Infinity;
  balls.forEach(function(b) {
    const d = Math.hypot(b.x - target.x, b.y - target.y);
    if (d < nearestDist) { nearestDist = d; nearest = b; }
  });

  let lookX = 0, lookY = 0;
  if (nearest) {
    const edx = nearest.x - target.x;
    const edy = nearest.y - target.y;
    const ed  = Math.hypot(edx, edy) || 1;
    lookX = (edx / ed) * 3;
    lookY = (edy / ed) * 3;
  }

  const eyeSpacing = 8;
  const eyeY       = -2;
  const openness   = 1 - target.blink;
  const eyeR       = 5.5 * (0.25 + 0.75 * Math.max(0.15, openness)) * (1 + target.panic * 0.4);

  [-eyeSpacing, eyeSpacing].forEach(function(ex) {
    ctx.beginPath();
    ctx.fillStyle = '#fff';
    ctx.ellipse(ex, eyeY, 6, eyeR, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = '#111';
    ctx.arc(ex + lookX, eyeY + lookY * 0.6, Math.min(2.6, eyeR * 0.55), 0, Math.PI * 2);
    ctx.fill();
  });

  // worried eyebrows when panicked
  if (target.panic > 0.15) {
    ctx.strokeStyle = 'rgba(140,70,0,' + target.panic + ')';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(-eyeSpacing - 6, eyeY - 9);
    ctx.lineTo(-eyeSpacing + 3, eyeY - 6);
    ctx.moveTo( eyeSpacing + 6, eyeY - 9);
    ctx.lineTo( eyeSpacing - 3, eyeY - 6);
    ctx.stroke();
  }

  // mouth: calm smile → wide "oh no" as panic rises
  const mouthY = 8;
  ctx.lineWidth   = 2;
  ctx.strokeStyle = '#8a5a00';
  ctx.beginPath();
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
  const b = state.banners[state.banners.length - 1]; // only show most recent
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

  ctx.font = '800 38px Segoe UI, sans-serif';
  const tw = ctx.measureText(b.text).width;

  // rounded-rect backdrop
  ctx.fillStyle = 'rgba(17,17,17,0.88)';
  roundRect(ctx, -tw / 2 - 28, -34, tw + 56, 64, 14);
  ctx.fill();

  ctx.shadowColor = 'rgba(255,196,0,0.8)';
  ctx.shadowBlur  = 18;
  ctx.fillStyle   = '#ffc400';
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.text, 0, 0);
  ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y,     x + w, y + h, r);
  c.arcTo(x + w, y + h, x,     y + h, r);
  c.arcTo(x,     y + h, x,     y,     r);
  c.arcTo(x,     y,     x + w, y,     r);
  c.closePath();
}

function drawParticles() {
  state.particles.forEach(function(p) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.shadowBlur  = p.glow ? 10 : 0;
    if (p.glow) ctx.shadowColor = p.color;
    ctx.beginPath();
    ctx.fillStyle = p.color;
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 1;
}

function drawScorePopups() {
  ctx.textAlign = 'center';
  state.scorePopups.forEach(function(p) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.translate(p.x, p.y);
    ctx.scale(p.scale, p.scale);
    ctx.font        = '700 24px Segoe UI, sans-serif';
    ctx.shadowColor = 'rgba(255,170,0,0.6)';
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = '#ffaa00';
    ctx.fillText('+1', 0, 0);
    ctx.restore();
  });
  ctx.globalAlpha = 1;
}

/* ============================================================
   GAME LOOP
   ============================================================ */
var lastTime = performance.now();

function loop(now) {
  const realDtMs = Math.min(33, now - lastTime);
  lastTime = now;

  if (state.running) {
    updateTimeScale(realDtMs);
    const dtSec = realDtMs / 1000;
    const dt    = dtSec * state.timeScale; // 0 during freeze, 0.25× during slow-mo

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
function endGame() {
  if (!state.running) return;
  state.running = false;
  Audio_.gameOver();
  if (state.score > state.highScore) {
    state.highScore = state.score;
    localStorage.setItem('lineaHighScore', state.highScore);
  }
  finalScoreEl.textContent    = 'Score: ' + state.score;
  finalHighScoreEl.textContent = 'Best: '  + state.highScore;
  highScoreEl.textContent      = state.highScore;
  gameOverScreen.classList.remove('hidden');
}

function startGame() {
  state.running           = true;
  state.score             = 0;
  state.ink               = state.maxInk;
  state.inkRegenRate      = 16;
  state.speedMultiplier   = 0.75;
  state.hitsSinceSpeedup  = 0;
  state.maxSpeedMultiplier = 1.3;
  state.gravity           = BASE_GRAVITY;
  state.lastLineHitAt     = 0;   // 0 = timer not yet armed (first touch starts it)
  state.lines             = [];
  state.particles         = [];
  state.scorePopups       = [];
  state.freezeTimer       = 0;
  state.slowMoTimer       = 0;
  state.timeScale         = 1;
  state.zoom              = 1;
  state.zoomTarget        = 1;
  state.flash             = 0;
  state.chroma            = 0;
  state.shake             = 0;

  state.milestonesUnlocked = new Set();
  state.banners            = [];
  state.lineLifetimeMult   = 1;
  state.targetSpeedBoost   = 1;
  state.magneticActive     = false;
  state.windActive         = false;
  state.windX              = 0;
  state.windTargetX        = 0;
  state.windTimer          = 0;
  state.rotationActive     = false;
  state.worldRotation      = 0;
  state.chaosActive        = false;

  scoreEl.textContent  = 0;
  state.displayScore   = 0;
  state.newBestShown   = false;
  document.getElementById('highScoreBox').classList.remove('new-best');
  highScoreEl.textContent = state.highScore;
  gameOverScreen.classList.add('hidden');

  balls   = [];
  targets = [];
  spawnBall();    // exactly ONE ball, always
  spawnTarget();
}

startGame();
requestAnimationFrame(loop);
