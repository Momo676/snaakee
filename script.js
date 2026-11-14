'use strict';

// ==========================================
// Game Constants & Pure Money / Physics Rules
// ==========================================
const ARENA_RADIUS = 2200;
const INITIAL_PLAYER_MASS = 30;
const MIN_BOOST_MASS = 16;
const BOOST_DRAIN_PER_SEC = 7.5;
const BASE_SPEED = 225;
const BOOST_SPEED = 415;
const TARGET_BOT_COUNT = 16;
const TARGET_AMBIENT_ORBS = 132; // 70% reduced pebble density
const PARTICLE_POOL_SIZE = 380;
const ROOM_STAKES = [25, 50, 100];
const CASH_OUT_HOLD_MS = 3000;
const DOUBLE_TAP_WINDOW_MS = 340;

const BOT_NAMES = [
  'NoodleKing', 'Vortex99', 'CoilZ', 'SnackAttack', 'MambaJamba', 'ByteSnek',
  'SlipperyPete', 'HexFang', 'TurboWorm', 'WiggleRoom', 'SlyCobra', 'ZebraCoil',
  'PrismBite', 'ApexTail', 'LootGoblin', 'LoopMaster', 'Sidewinder', 'NeonFang',
];

const ORB_COLORS = ['#A3E635', '#38BDF8', '#FBBF24', '#F43F5E', '#2DD4BF', '#FB923C', '#E879F9'];

const PRESET_SKINS = [
  { id: 'volt-viper', name: 'Volt Viper', colors: ['#A3E635', '#65A30D', '#ECFCCB'], pattern: 'striped', eyeStyle: 'fierce', trait: 'Electric lime scales' },
  { id: 'crimson-koi', name: 'Crimson Koi', colors: ['#F43F5E', '#F8FAFC', '#FB923C'], pattern: 'ringed', eyeStyle: 'wide', trait: 'Vermilion & pearl bands' },
  { id: 'cobalt-bolt', name: 'Cobalt Bolt', colors: ['#38BDF8', '#1D4ED8', '#A5F3FC'], pattern: 'gradient', eyeStyle: 'cyber', trait: 'Arctic blue gradient' },
  { id: 'amber-wasp', name: 'Amber Wasp', colors: ['#FBBF24', '#1E293B', '#FEF08A'], pattern: 'ringed', eyeStyle: 'fierce', trait: 'High-contrast hazard rings' },
  { id: 'coral-reef', name: 'Coral Reef', colors: ['#FB7185', '#2DD4BF', '#FDE047'], pattern: 'spotted', eyeStyle: 'cute', trait: 'Warm reef palette' },
  { id: 'mint-frost', name: 'Mint Frost', colors: ['#2DD4BF', '#0F766E', '#CCFBF1'], pattern: 'gradient', eyeStyle: 'wide', trait: 'Teal cryo sheen' },
];

function roundEgp(amount) {
  return Math.round(amount * 100) / 100;
}

function formatEgp(amount) {
  const rounded = roundEgp(amount);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function canAffordRoom(walletEgp, stake) {
  return Number.isFinite(walletEgp) && walletEgp >= stake && stake > 0;
}

function isDoubleTapWithinWindow(lastTapMs, currentTapMs, windowMs = DOUBLE_TAP_WINDOW_MS) {
  if (lastTapMs === null) return false;
  const delta = currentTapMs - lastTapMs;
  return delta >= 0 && delta <= windowMs;
}

function distributePotAcrossFragments(victimPotEgp, roomStake, fragmentCount) {
  const totalEgp = Math.max(roomStake, roundEgp(victimPotEgp));
  const count = Math.max(1, Math.floor(fragmentCount));
  const totalPiasters = Math.round(totalEgp * 100);
  const basePiasters = Math.floor(totalPiasters / count);
  const remainder = totalPiasters % count;
  const values = new Array(count);
  for (let i = 0; i < count; i++) {
    values[i] = (basePiasters + (i < remainder ? 1 : 0)) / 100;
  }
  return values;
}

function massToDisplayLength(mass) {
  return Math.max(10, Math.round(mass * 10));
}

function computeSnakeRadius(mass) {
  return Math.min(34, 11 + Math.sqrt(Math.max(10, mass)) * 0.85);
}

function computeSegmentCount(mass) {
  return Math.min(260, Math.max(10, Math.floor(8 + mass * 0.42)));
}

function computeSegmentSpacing(radius) {
  return Math.max(5.5, radius * 0.56);
}

function computeTurnRate(mass) {
  const sizeFactor = Math.min(1, Math.max(0, (mass - 20) / 400));
  return 5.4 - sizeFactor * 2.1;
}

function normalizeAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function stepAngleTowards(current, target, maxDelta) {
  const diff = normalizeAngle(target - current);
  if (Math.abs(diff) <= maxDelta) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(diff) * maxDelta);
}

function checkBoundaryCollision(headX, headY, headRadius, arenaRadius = ARENA_RADIUS) {
  const limit = arenaRadius - headRadius * 0.7;
  return headX * headX + headY * headY >= limit * limit;
}

function checkHeadBodyCollision(attackerHead, attackerRadius, defenderSegments, defenderRadius) {
  if (defenderSegments.length === 0) return false;
  const hitDist = (attackerRadius + defenderRadius) * 0.84;
  const hitDistSq = hitDist * hitDist;
  for (let i = 0; i < defenderSegments.length; i++) {
    const seg = defenderSegments[i];
    const dx = attackerHead.x - seg.x;
    const dy = attackerHead.y - seg.y;
    if (dx * dx + dy * dy <= hitDistSq) return true;
  }
  return false;
}

function findSafeSpawnPoint(snakes, arenaRadius = ARENA_RADIUS, minClearance = 320) {
  const maxSpawnR = arenaRadius * 0.65;
  let best = { x: 0, y: 0, minDistSq: -1 };
  for (let attempt = 0; attempt < 24; attempt++) {
    const theta = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * maxSpawnR;
    const cx = Math.cos(theta) * r;
    const cy = Math.sin(theta) * r;
    let nearestSq = Infinity;
    for (const s of snakes) {
      if (!s.alive) continue;
      if (s.segments.length === 0) {
        const dSq = (cx - s.x) ** 2 + (cy - s.y) ** 2;
        if (dSq < nearestSq) nearestSq = dSq;
      } else {
        for (let i = 0; i < s.segments.length; i += 3) {
          const seg = s.segments[i];
          const dSq = (cx - seg.x) ** 2 + (cy - seg.y) ** 2;
          if (dSq < nearestSq) nearestSq = dSq;
        }
      }
    }
    if (nearestSq >= minClearance * minClearance) {
      return { x: cx, y: cy, angle: normalizeAngle(Math.atan2(-cy, -cx) + (Math.random() - 0.5) * 0.9) };
    }
    if (nearestSq > best.minDistSq) best = { x: cx, y: cy, minDistSq: nearestSq };
  }
  return { x: best.x, y: best.y, angle: normalizeAngle(Math.atan2(-best.y, -best.x)) };
}

function stepTouchStick(stick, nextX, nextY, maxRadius = 48, deadzone = 6) {
  let anchorX = stick.anchorX;
  let anchorY = stick.anchorY;
  let dx = nextX - anchorX;
  let dy = nextY - anchorY;
  let dist = Math.hypot(dx, dy);

  if (dist < deadzone && !stick.hasDragged) {
    return { anchorX, anchorY, currentX: nextX, currentY: nextY, hasDragged: false, angle: stick.angle };
  }
  if (dist > maxRadius) {
    const ratio = (dist - maxRadius) / dist;
    anchorX += dx * ratio;
    anchorY += dy * ratio;
    dx = nextX - anchorX;
    dy = nextY - anchorY;
    dist = maxRadius;
  }
  const angle = dist >= deadzone ? Math.atan2(dy, dx) : stick.angle;
  return { anchorX, anchorY, currentX: nextX, currentY: nextY, hasDragged: true, angle };
}

function getSegmentColor(skin, index, totalSegments) {
  const palette = skin.colors.length ? skin.colors : ['#A3E635', '#38BDF8'];
  if (skin.pattern === 'solid') return palette[0];
  if (skin.pattern === 'ringed') return index % 4 === 0 ? palette[1] || palette[0] : palette[0];
  if (skin.pattern === 'spotted') {
    if (index % 5 === 0 && palette.length > 2) return palette[2];
    return index % 3 === 0 ? palette[1] || palette[0] : palette[0];
  }
  if (skin.pattern === 'gradient') {
    const t = totalSegments > 1 ? index / (totalSegments - 1) : 0;
    const band = Math.min(palette.length - 1, Math.floor(t * palette.length));
    return palette[band];
  }
  return palette[Math.floor(index / 2) % palette.length];
}

// ==========================================
// Web Audio Procedural Sound Effects
// ==========================================
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }
  ensureCtx() {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }
  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }
  playEat(isLoot = false) {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = isLoot ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(isLoot ? 560 : 420, now);
    osc.frequency.exponentialRampToValueAtTime(isLoot ? 840 : 620, now + 0.07);
    gain.gain.setValueAtTime(isLoot ? 0.08 : 0.045, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.085);
  }
  playKill() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.055);
      gain.gain.setValueAtTime(0.11, now + i * 0.055);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.055 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.055);
      osc.stop(now + i * 0.055 + 0.24);
    });
  }
  playDeath() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.42);
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.46);
  }
}

// ==========================================
// Slither Arena Canvas Engine
// ==========================================
class SlitherEngine {
  constructor(canvas, minimapCanvas, sound, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.minimapCanvas = minimapCanvas;
    this.sound = sound;
    this.callbacks = callbacks;

    this.phase = 'title';
    this.rafId = null;
    this.lastTime = 0;

    this.snakes = [];
    this.orbs = [];
    this.nextOrbId = 1;
    this.nextBotId = 1;

    this.particles = Array.from({ length: PARTICLE_POOL_SIZE }, () => ({
      active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 3, color: '#A3E635',
    }));
    this.particleCursor = 0;

    this.callouts = Array.from({ length: 12 }, () => ({
      active: false, x: 0, y: 0, text: '', color: '#FBBF24', life: 0, maxLife: 1,
    }));
    this.calloutCursor = 0;

    this.camX = 0;
    this.camY = 0;
    this.camZoom = 0.78;
    this.trauma = 0;
    this.tourAngle = 0;

    this.playerName = 'Bruhv';
    this.playerSkin = PRESET_SKINS[0];
    this.roomStake = 25;
    this.runElapsed = 0;
    this.peakLength = 300;
    this.peakRank = 17;
    this.bestLength = 300;
    try {
      const savedBest = Number(localStorage.getItem('damn_bruh_best_length') || '300');
      if (Number.isFinite(savedBest) && savedBest >= 300) this.bestLength = savedBest;
    } catch {}

    this.deathTimer = 0;
    this.pendingSummary = null;
    this.killNoticeText = '';
    this.killNoticeTimer = 0;
    this.hudThrottle = 0;
    this.boostDropAccum = 0;

    this.pointerActive = false;
    this.pointerScreenX = 0;
    this.pointerScreenY = 0;
    this.pointerDown = false;
    this.touchPointerId = null;
    this.touchStick = null;
    this.secondaryTouchIds = new Set();
    this.lastTouchTapMs = null;
    this.touchDoubleTapBoost = false;
    this.keysHeld = new Set();
    this.viewportWidth = window.innerWidth;
    this.viewportHeight = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.initArenaWorld();
    this.bindInputs();
    this.handleResize();
  }

  computeTargetZoom(mass) {
    const baseScale = this.viewportWidth < 640 ? 0.66 : 0.78;
    return Math.max(0.42, baseScale - Math.sqrt(Math.max(10, mass)) * 0.014);
  }

  startLoop() {
    if (this.rafId !== null) return;
    this.lastTime = performance.now();
    const tick = (now) => {
      const dt = Math.min(Math.max((now - this.lastTime) / 1000, 0.001), 0.05);
      this.lastTime = now;
      if (this.phase !== 'paused') {
        this.update(dt);
        this.render();
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  clearHeldInputs() {
    this.keysHeld.clear();
    this.pointerDown = false;
    this.touchDoubleTapBoost = false;
    this.lastTouchTapMs = null;
    this.touchPointerId = null;
    this.touchStick = null;
    this.secondaryTouchIds.clear();
  }

  startNewRun(name, skin, roomStake) {
    this.playerName = (name || '').trim().slice(0, 16) || 'Bruhv';
    this.playerSkin = skin;
    this.roomStake = roomStake;
    this.clearHeldInputs();
    this.deathTimer = 0;
    this.pendingSummary = null;
    this.killNoticeText = '';
    this.killNoticeTimer = 0;
    this.runElapsed = 0;
    this.boostDropAccum = 0;
    this.trauma = 0;

    this.initArenaWorld();
    const spawn = findSafeSpawnPoint(this.snakes, ARENA_RADIUS, 360);
    const player = this.createSnake({
      id: 'player',
      name: this.playerName,
      isPlayer: true,
      skin: this.playerSkin,
      x: spawn.x,
      y: spawn.y,
      angle: spawn.angle,
      mass: INITIAL_PLAYER_MASS,
    });
    player.spawnShield = 2.6;
    this.snakes.push(player);

    this.camX = player.x;
    this.camY = player.y;
    this.camZoom = this.computeTargetZoom(player.mass);
    this.peakLength = massToDisplayLength(player.mass);
    this.peakRank = this.snakes.length;
    this.phase = 'playing';
    this.emitHudSnapshot();
  }

  pause() {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.clearHeldInputs();
    this.render();
  }

  resume() {
    if (this.phase !== 'paused') return;
    this.clearHeldInputs();
    this.phase = 'playing';
  }

  returnToTitle() {
    this.clearHeldInputs();
    this.deathTimer = 0;
    this.pendingSummary = null;
    this.phase = 'title';
    this.snakes = this.snakes.filter((s) => !s.isPlayer && s.alive);
    while (this.snakes.length < TARGET_BOT_COUNT) this.spawnBot(false);
  }

  cashOutRun() {
    if (this.phase !== 'playing') return null;
    const player = this.snakes.find((s) => s.isPlayer && s.alive);
    if (!player) return null;

    this.clearHeldInputs();
    this.sound.playKill();

    const finalLength = massToDisplayLength(player.mass);
    const isNewBest = finalLength > this.bestLength;
    if (isNewBest) {
      this.bestLength = finalLength;
      try { localStorage.setItem('damn_bruh_best_length', String(this.bestLength)); } catch {}
    }

    const summary = {
      finalLength,
      peakLength: Math.max(this.peakLength, finalLength),
      peakRank: this.peakRank,
      kills: player.kills,
      survivedSeconds: Math.round(this.runElapsed),
      defeatedBy: 'Cashed Out',
      isNewBest,
      bestLength: this.bestLength,
      cashedOut: true,
      roomStake: this.roomStake,
      payoutEgp: roundEgp(player.potEgp),
    };

    player.alive = false;
    this.snakes = this.snakes.filter((s) => s.alive);
    this.phase = 'gameover';
    this.render();
    return summary;
  }

  initArenaWorld() {
    this.snakes = [];
    this.orbs = [];
    for (let i = 0; i < TARGET_AMBIENT_ORBS; i++) this.spawnAmbientOrb();
    for (let i = 0; i < TARGET_BOT_COUNT; i++) this.spawnBot(true);
  }

  spawnAmbientOrb() {
    const theta = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (ARENA_RADIUS - 80);
    const value = Math.random() < 0.14 ? 2.6 : 1.1;
    this.orbs.push({
      id: this.nextOrbId++,
      x: Math.cos(theta) * r,
      y: Math.sin(theta) * r,
      value,
      egpValue: 0,
      radius: value > 2 ? 7.5 : 5,
      color: ORB_COLORS[Math.floor(Math.random() * ORB_COLORS.length)],
      phase: Math.random() * Math.PI * 2,
      isLoot: false,
    });
  }

  spawnLootOrb(x, y, value, color, egpValue = 0) {
    this.orbs.push({
      id: this.nextOrbId++,
      x,
      y,
      value,
      egpValue,
      radius: Math.min(13, 6.5 + Math.sqrt(value) * 1.4),
      color,
      phase: Math.random() * Math.PI * 2,
      isLoot: true,
    });
  }

  spawnBot(initialSpread = false) {
    const policies = ['forager', 'interceptor', 'scavenger'];
    const policy = policies[Math.floor(Math.random() * policies.length)];
    const skin = PRESET_SKINS[Math.floor(Math.random() * PRESET_SKINS.length)];
    const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const spawn = findSafeSpawnPoint(this.snakes, ARENA_RADIUS, 260);
    const mass = initialSpread ? 22 + Math.random() * 140 : 20 + Math.random() * 38;
    const bot = this.createSnake({
      id: `bot-${this.nextBotId++}`,
      name,
      isPlayer: false,
      skin,
      policy,
      x: spawn.x,
      y: spawn.y,
      angle: spawn.angle,
      mass,
    });
    bot.spawnShield = 1.5;
    this.snakes.push(bot);
  }

  createSnake(opts) {
    const segCount = computeSegmentCount(opts.mass);
    const radius = computeSnakeRadius(opts.mass);
    const spacing = computeSegmentSpacing(radius);
    const path = [];
    const segments = [];
    const step = spacing / 3;
    for (let i = 0; i < segCount * 3; i++) {
      path.push({ x: opts.x - Math.cos(opts.angle) * i * step, y: opts.y - Math.sin(opts.angle) * i * step });
    }
    for (let i = 0; i < segCount; i++) {
      segments.push({ x: opts.x - Math.cos(opts.angle) * i * spacing, y: opts.y - Math.sin(opts.angle) * i * spacing });
    }
    return {
      ...opts,
      targetAngle: opts.angle,
      boosting: false,
      alive: true,
      kills: 0,
      potEgp: this.roomStake,
      spawnShield: 2.0,
      aiTimer: 0,
      aiBias: Math.random() < 0.5 ? 1 : -1,
      path,
      segments,
    };
  }

  update(dt) {
    this.trauma = Math.max(0, this.trauma - dt * 1.9);
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
    }
    for (const c of this.callouts) {
      if (!c.active) continue;
      c.life -= dt;
      c.y -= 36 * dt;
      if (c.life <= 0) c.active = false;
    }

    if (this.phase === 'playing') {
      this.runElapsed += dt;
      if (this.killNoticeTimer > 0) {
        this.killNoticeTimer = Math.max(0, this.killNoticeTimer - dt);
        if (this.killNoticeTimer === 0) this.killNoticeText = '';
      }
    }

    if (this.deathTimer > 0) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0 && this.pendingSummary) {
        const summary = this.pendingSummary;
        this.pendingSummary = null;
        this.phase = 'gameover';
        this.callbacks.onGameOver(summary);
        return;
      }
    }

    let ambientCount = 0;
    for (const o of this.orbs) if (!o.isLoot) ambientCount++;
    while (ambientCount < TARGET_AMBIENT_ORBS) { this.spawnAmbientOrb(); ambientCount++; }

    const aliveBots = this.snakes.filter((s) => !s.isPlayer && s.alive).length;
    if (aliveBots < TARGET_BOT_COUNT) this.spawnBot(false);

    for (const s of this.snakes) {
      if (!s.alive) continue;
      if (s.spawnShield > 0) s.spawnShield = Math.max(0, s.spawnShield - dt);
      if (s.isPlayer) this.updatePlayerInput(s);
      else this.updateBotDecision(s, dt);
      this.stepSnakeKinematics(s, dt);
      this.consumeNearbyOrbs(s, dt);
    }

    this.resolveCollisions();
    this.snakes = this.snakes.filter((s) => s.alive);

    const player = this.snakes.find((s) => s.isPlayer && s.alive);
    if (this.phase === 'playing' && player) {
      const lerp = 1 - Math.exp(-8.5 * dt);
      this.camX += (player.x - this.camX) * lerp;
      this.camY += (player.y - this.camY) * lerp;
      const tz = this.computeTargetZoom(player.mass);
      this.camZoom += (tz - this.camZoom) * (1 - Math.exp(-3.2 * dt));
      const len = massToDisplayLength(player.mass);
      if (len > this.peakLength) this.peakLength = len;
    } else if (this.phase === 'title') {
      this.tourAngle += dt * 0.14;
      const lerp = 1 - Math.exp(-2.0 * dt);
      this.camX += (Math.cos(this.tourAngle) * 620 - this.camX) * lerp;
      this.camY += (Math.sin(this.tourAngle * 0.8) * 620 - this.camY) * lerp;
      this.camZoom += (0.68 - this.camZoom) * lerp;
    }

    if (this.phase === 'playing') {
      this.hudThrottle += dt;
      if (this.hudThrottle >= 0.08) {
        this.hudThrottle = 0;
        this.emitHudSnapshot();
      }
    }
  }

  updatePlayerInput(player) {
    let kx = 0, ky = 0;
    if (this.keysHeld.has('KeyA') || this.keysHeld.has('ArrowLeft')) kx -= 1;
    if (this.keysHeld.has('KeyD') || this.keysHeld.has('ArrowRight')) kx += 1;
    if (this.keysHeld.has('KeyW') || this.keysHeld.has('ArrowUp')) ky -= 1;
    if (this.keysHeld.has('KeyS') || this.keysHeld.has('ArrowDown')) ky += 1;

    if (kx !== 0 || ky !== 0) {
      player.targetAngle = Math.atan2(ky, kx);
    } else if (this.touchStick) {
      if (this.touchStick.hasDragged && this.touchStick.angle !== null) {
        player.targetAngle = this.touchStick.angle;
      } else {
        const dx = this.touchStick.currentX - this.viewportWidth * 0.5;
        const dy = this.touchStick.currentY - this.viewportHeight * 0.5;
        if (dx * dx + dy * dy > 576) player.targetAngle = Math.atan2(dy, dx);
      }
    } else if (this.pointerActive) {
      const dx = this.pointerScreenX - this.viewportWidth * 0.5;
      const dy = this.pointerScreenY - this.viewportHeight * 0.5;
      if (dx * dx + dy * dy > 144) player.targetAngle = Math.atan2(dy, dx);
    }

    const wantsBoost =
      this.pointerDown ||
      this.touchDoubleTapBoost ||
      this.secondaryTouchIds.size > 0 ||
      this.keysHeld.has('Space') ||
      this.keysHeld.has('ShiftLeft') ||
      this.keysHeld.has('ShiftRight');
    player.boosting = wantsBoost && player.mass > MIN_BOOST_MASS;
  }

  updateBotDecision(bot, dt) {
    bot.aiTimer -= dt;
    if (Math.hypot(bot.x, bot.y) > ARENA_RADIUS - 300) {
      bot.targetAngle = normalizeAngle(Math.atan2(-bot.y, -bot.x) + bot.aiBias * 0.25);
      bot.boosting = false;
      return;
    }

    const lookAhead = 155 + computeSnakeRadius(bot.mass) * 3;
    const aheadX = bot.x + Math.cos(bot.angle) * lookAhead;
    const aheadY = bot.y + Math.sin(bot.angle) * lookAhead;
    let hazardX = 0, hazardY = 0, minDistSq = Infinity;

    for (const other of this.snakes) {
      if (!other.alive || other.id === bot.id) continue;
      for (let j = 0; j < other.segments.length; j += 2) {
        const seg = other.segments[j];
        const dSq = (seg.x - aheadX) ** 2 + (seg.y - aheadY) ** 2;
        if (dSq < minDistSq) { minDistSq = dSq; hazardX = seg.x; hazardY = seg.y; }
      }
    }
    if (minDistSq < 155 * 155) {
      bot.targetAngle = normalizeAngle(Math.atan2(bot.y - hazardY, bot.x - hazardX) + bot.aiBias * 0.35);
      bot.boosting = minDistSq < 85 * 85 && bot.mass > 28;
      return;
    }

    if (bot.aiTimer > 0) return;
    bot.aiTimer = 0.22 + Math.random() * 0.28;

    if (bot.policy === 'interceptor') {
      let prey = null, bestSq = 680 * 680;
      for (const other of this.snakes) {
        if (!other.alive || other.id === bot.id || other.spawnShield > 0) continue;
        const dSq = (other.x - bot.x) ** 2 + (other.y - bot.y) ** 2;
        if (dSq < bestSq) { bestSq = dSq; prey = other; }
      }
      if (prey) {
        const lx = prey.x + Math.cos(prey.angle) * 140;
        const ly = prey.y + Math.sin(prey.angle) * 140;
        bot.targetAngle = Math.atan2(ly - bot.y, lx - bot.x);
        bot.boosting = bestSq < 340 * 340 && bot.mass > 32;
        return;
      }
    }

    let bestOrb = null, bestScore = -Infinity;
    for (const o of this.orbs) {
      const d = Math.hypot(o.x - bot.x, o.y - bot.y);
      if (d > 660) continue;
      const mult = o.isLoot ? (bot.policy === 'scavenger' ? 4.5 : 3.5) : 1;
      const score = (o.value * mult) / (d + 35);
      if (score > bestScore) { bestScore = score; bestOrb = o; }
    }
    if (bestOrb) {
      bot.targetAngle = Math.atan2(bestOrb.y - bot.y, bestOrb.x - bot.x);
      bot.boosting = bestOrb.isLoot && bot.mass > 28 && (bot.policy === 'scavenger' || Math.random() < 0.35);
    } else {
      bot.targetAngle = normalizeAngle(bot.angle + (Math.random() - 0.5) * 1.1);
      bot.boosting = false;
    }
  }

  stepSnakeKinematics(snake, dt) {
    if (snake.boosting && snake.mass > MIN_BOOST_MASS) {
      const drained = BOOST_DRAIN_PER_SEC * dt;
      snake.mass = Math.max(MIN_BOOST_MASS, snake.mass - drained);
      if (snake.isPlayer) {
        this.boostDropAccum += drained;
        if (this.boostDropAccum >= 1.2) {
          this.boostDropAccum -= 1.2;
          const tail = snake.segments[snake.segments.length - 1] || snake;
          this.spawnLootOrb(tail.x + (Math.random() - 0.5) * 14, tail.y + (Math.random() - 0.5) * 14, 0.9, snake.skin.colors[0] || '#A3E635', 0);
        }
      }
      if (Math.random() < 0.45) {
        const tail = snake.segments[snake.segments.length - 1] || snake;
        this.spawnParticle(tail.x, tail.y, -Math.cos(snake.angle) * 70 + (Math.random() - 0.5) * 50, -Math.sin(snake.angle) * 70 + (Math.random() - 0.5) * 50, 0.32, 3.2, snake.skin.colors[0] || '#A3E635');
      }
    } else {
      snake.boosting = false;
    }

    snake.angle = stepAngleTowards(snake.angle, snake.targetAngle, computeTurnRate(snake.mass) * dt);
    const speed = snake.boosting ? BOOST_SPEED : BASE_SPEED;
    snake.x += Math.cos(snake.angle) * speed * dt;
    snake.y += Math.sin(snake.angle) * speed * dt;

    const head = snake.path[0];
    if (!head || Math.hypot(snake.x - head.x, snake.y - head.y) >= 3) {
      snake.path.unshift({ x: snake.x, y: snake.y });
    } else {
      head.x = snake.x;
      head.y = snake.y;
    }

    const targetCount = computeSegmentCount(snake.mass);
    const spacing = computeSegmentSpacing(computeSnakeRadius(snake.mass));
    const newSegments = [{ x: snake.x, y: snake.y }];
    let pathIdx = 0, accumulated = 0, nextTarget = spacing;

    while (newSegments.length < targetCount && pathIdx < snake.path.length - 1) {
      const p0 = snake.path[pathIdx];
      const p1 = snake.path[pathIdx + 1];
      const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (segLen < 0.0001) { pathIdx++; continue; }
      if (accumulated + segLen >= nextTarget) {
        const t = (nextTarget - accumulated) / segLen;
        newSegments.push({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t });
        nextTarget += spacing;
      } else {
        accumulated += segLen;
        pathIdx++;
      }
    }
    while (newSegments.length < targetCount) {
      const last = newSegments[newSegments.length - 1];
      newSegments.push({ x: last.x, y: last.y });
    }
    if (pathIdx + 6 < snake.path.length) snake.path.length = pathIdx + 6;
    snake.segments = newSegments;
  }

  consumeNearbyOrbs(snake, dt) {
    const radius = computeSnakeRadius(snake.mass);
    const magnetSq = (radius + 44) ** 2;
    const eatSq = (radius + 11) ** 2;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      const dx = snake.x - orb.x;
      const dy = snake.y - orb.y;
      const dSq = dx * dx + dy * dy;
      if (dSq <= eatSq) {
        snake.mass += orb.value * 0.45;
        if (orb.egpValue > 0) snake.potEgp = roundEgp(snake.potEgp + orb.egpValue);
        if (snake.isPlayer) this.sound.playEat(orb.isLoot);
        this.spawnParticle(orb.x, orb.y, (Math.random() - 0.5) * 90, (Math.random() - 0.5) * 90, 0.25, orb.isLoot ? 4.5 : 3, orb.color);
        this.orbs.splice(i, 1);
      } else if (dSq <= magnetSq) {
        const d = Math.sqrt(dSq) || 1;
        orb.x += (dx / d) * 360 * dt;
        orb.y += (dy / d) * 360 * dt;
      }
    }
  }

  resolveCollisions() {
    for (let i = 0; i < this.snakes.length; i++) {
      const attacker = this.snakes[i];
      if (!attacker.alive) continue;
      const attackerRadius = computeSnakeRadius(attacker.mass);
      if (checkBoundaryCollision(attacker.x, attacker.y, attackerRadius, ARENA_RADIUS)) {
        this.eliminateSnake(attacker, null, 'Arena Perimeter');
        continue;
      }
      if (attacker.spawnShield > 0) continue;
      for (let j = 0; j < this.snakes.length; j++) {
        if (i === j) continue;
        const defender = this.snakes[j];
        if (!defender.alive || defender.spawnShield > 0) continue;
        if (checkHeadBodyCollision({ x: attacker.x, y: attacker.y }, attackerRadius, defender.segments, computeSnakeRadius(defender.mass))) {
          this.eliminateSnake(attacker, defender, defender.name);
          break;
        }
      }
    }
  }

  eliminateSnake(victim, killer, killerLabel) {
    victim.alive = false;
    const totalSegments = victim.segments.length;
    const fragIndices = [];
    for (let i = 0; i < totalSegments; i += 2) fragIndices.push(i);
    if (fragIndices.length === 0) fragIndices.push(0);

    const fragEgp = distributePotAcrossFragments(victim.potEgp, this.roomStake, fragIndices.length);
    const droppedPot = roundEgp(Math.max(this.roomStake, victim.potEgp));

    if (killer && killer.alive) {
      killer.kills += 1;
      if (killer.isPlayer) {
        this.sound.playKill();
        this.trauma = Math.min(1, this.trauma + 0.45);
        this.killNoticeText = `Damn Bruh! Collect ${formatEgp(droppedPot)} EGP from ${victim.name}'s fragments`;
        this.killNoticeTimer = 2.6;
        this.spawnCallout(victim.x, victim.y - 24, `${formatEgp(droppedPot)} EGP DROPPED!`, '#FBBF24');
      }
    }

    const lootPerDrop = Math.max(1.8, (victim.mass * 0.68) / Math.max(4, fragIndices.length));
    for (let idx = 0; idx < fragIndices.length; idx++) {
      const segIdx = fragIndices[idx];
      const seg = victim.segments[segIdx] || { x: victim.x, y: victim.y };
      const color = getSegmentColor(victim.skin, segIdx, totalSegments);
      this.spawnLootOrb(seg.x + (Math.random() - 0.5) * 16, seg.y + (Math.random() - 0.5) * 16, lootPerDrop, color, fragEgp[idx]);
      if (segIdx % 4 === 0) {
        this.spawnParticle(seg.x, seg.y, (Math.random() - 0.5) * 220, (Math.random() - 0.5) * 220, 0.55, 5.5, color);
      }
    }

    if (victim.isPlayer && this.phase === 'playing') {
      this.sound.playDeath();
      this.trauma = 0.9;
      this.spawnCallout(victim.x, victim.y - 18, 'DAMN BRUH...', '#F43F5E');
      const finalLength = massToDisplayLength(victim.mass);
      const isNewBest = finalLength > this.bestLength;
      if (isNewBest) {
        this.bestLength = finalLength;
        try { localStorage.setItem('damn_bruh_best_length', String(this.bestLength)); } catch {}
      }
      this.pendingSummary = {
        finalLength,
        peakLength: Math.max(this.peakLength, finalLength),
        peakRank: this.peakRank,
        kills: victim.kills,
        survivedSeconds: Math.round(this.runElapsed),
        defeatedBy: killerLabel,
        isNewBest,
        bestLength: this.bestLength,
        cashedOut: false,
        roomStake: this.roomStake,
        payoutEgp: 0,
      };
      this.deathTimer = 0.52;
      this.emitHudSnapshot();
    }
  }

  spawnParticle(x, y, vx, vy, maxLife, size, color) {
    const p = this.particles[this.particleCursor];
    this.particleCursor = (this.particleCursor + 1) % PARTICLE_POOL_SIZE;
    Object.assign(p, { active: true, x, y, vx, vy, life: maxLife, maxLife, size, color });
  }

  spawnCallout(x, y, text, color) {
    const c = this.callouts[this.calloutCursor];
    this.calloutCursor = (this.calloutCursor + 1) % this.callouts.length;
    Object.assign(c, { active: true, x, y, text, color, life: 1.1, maxLife: 1.1 });
  }

  emitHudSnapshot() {
    const player = this.snakes.find((s) => s.isPlayer && s.alive);
    const alive = this.snakes.filter((s) => s.alive).sort((a, b) => b.mass - a.mass);
    let playerRank = 0;
    const top = alive.slice(0, 5).map((s, idx) => {
      if (s.isPlayer) playerRank = idx + 1;
      return { id: s.id, name: s.name, length: massToDisplayLength(s.mass), isPlayer: s.isPlayer, rank: idx + 1, accentColor: s.skin.colors[0] || '#A3E635' };
    });
    if (!playerRank && player) playerRank = alive.findIndex((s) => s.isPlayer) + 1;
    if (playerRank > 0 && playerRank < this.peakRank) this.peakRank = playerRank;
    const mass = player ? player.mass : 0;
    this.callbacks.onHudUpdate({
      length: player ? massToDisplayLength(mass) : 0,
      kills: player ? player.kills : this.pendingSummary?.kills || 0,
      rank: playerRank || alive.length,
      totalSnakes: alive.length,
      canBoost: mass > MIN_BOOST_MASS,
      boostCharge: player ? Math.min(100, Math.max(0, Math.round(((mass - MIN_BOOST_MASS) / 45) * 100))) : 0,
      roomStake: this.roomStake,
      potEgp: player ? roundEgp(player.potEgp) : 0,
      leaderboard: top,
      killNotice: this.killNoticeTimer > 0 ? this.killNoticeText : null,
    });
  }

  render() {
    const ctx = this.ctx;
    const w = this.viewportWidth;
    const h = this.viewportHeight;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = '#0B0F17';
    ctx.fillRect(0, 0, w, h);

    const shake = this.trauma * this.trauma * 16;
    ctx.translate(w * 0.5 + (shake > 0.2 ? (Math.random() - 0.5) * 2 * shake : 0), h * 0.5 + (shake > 0.2 ? (Math.random() - 0.5) * 2 * shake : 0));
    ctx.scale(this.camZoom, this.camZoom);
    ctx.translate(-this.camX, -this.camY);

    const halfW = (w * 0.5) / this.camZoom + 120;
    const halfH = (h * 0.5) / this.camZoom + 120;

    this.drawHexGrid(ctx, this.camX - halfW, this.camY - halfH, this.camX + halfW, this.camY + halfH);
    this.drawBoundary(ctx);
    this.drawOrbs(ctx, halfW, halfH);
    this.drawParticles(ctx);
    this.drawSnakes(ctx, halfW, halfH);
    this.drawCallouts(ctx);
    ctx.restore();

    if (this.phase === 'playing' && this.touchStick && this.touchStick.hasDragged) {
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      ctx.strokeStyle = 'rgba(163, 230, 53, 0.42)';
      ctx.fillStyle = 'rgba(17, 23, 34, 0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.touchStick.anchorX, this.touchStick.anchorY, 48, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(163, 230, 53, 0.85)';
      ctx.beginPath();
      ctx.arc(this.touchStick.currentX, this.touchStick.currentY, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (this.phase === 'playing' && this.minimapCanvas) this.drawMinimap();
  }

  drawHexGrid(ctx, minX, minY, maxX, maxY) {
    const r = 56, dx = r * 1.5, dy = r * Math.sqrt(3);
    ctx.strokeStyle = '#151D2B';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let col = Math.floor(minX / dx) - 1; col <= Math.ceil(maxX / dx) + 1; col++) {
      const cx = col * dx;
      const offY = (col & 1) !== 0 ? dy * 0.5 : 0;
      for (let row = Math.floor(minY / dy) - 1; row <= Math.ceil(maxY / dy) + 1; row++) {
        const cy = row * dy + offY;
        if (cx * cx + cy * cy > (ARENA_RADIUS + 140) ** 2) continue;
        for (let k = 0; k < 3; k++) {
          const a0 = (Math.PI / 3) * k, a1 = (Math.PI / 3) * (k + 1);
          ctx.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
          ctx.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
        }
      }
    }
    ctx.stroke();
  }

  drawBoundary(ctx) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, ARENA_RADIUS + 1200, 0, Math.PI * 2);
    ctx.arc(0, 0, ARENA_RADIUS, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(244, 63, 94, 0.10)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, ARENA_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = '#F43F5E';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.restore();
  }

  drawOrbs(ctx, halfW, halfH) {
    const now = performance.now() * 0.004;
    for (const o of this.orbs) {
      if (Math.abs(o.x - this.camX) > halfW || Math.abs(o.y - this.camY) > halfH) continue;
      const r = o.radius * (1 + Math.sin(now + o.phase) * 0.14);
      ctx.globalAlpha = o.isLoot ? 0.34 : 0.22;
      ctx.fillStyle = o.color;
      ctx.beginPath();
      ctx.arc(o.x, o.y, r * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawParticles(ctx) {
    for (const p of this.particles) {
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + t * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawSnakes(ctx, halfW, halfH) {
    const ordered = [...this.snakes].sort((a, b) => (a.isPlayer === b.isPlayer ? 0 : a.isPlayer ? 1 : -1));
    let leaderId = null, maxMass = -1;
    for (const s of ordered) if (s.alive && s.mass > maxMass) { maxMass = s.mass; leaderId = s.id; }

    for (const snake of ordered) {
      if (!snake.alive || snake.segments.length === 0) continue;
      const radius = computeSnakeRadius(snake.mass);
      const total = snake.segments.length;
      ctx.save();
      if (snake.spawnShield > 0) ctx.globalAlpha = 0.55 + Math.sin(performance.now() * 0.018) * 0.25;
      for (let i = total - 1; i >= 0; i--) {
        const seg = snake.segments[i];
        if (Math.abs(seg.x - this.camX) > halfW + radius || Math.abs(seg.y - this.camY) > halfH + radius) continue;
        const taper = i > total - 6 ? (total - i) / 6 : 1;
        const segR = radius * (0.45 + 0.55 * taper);
        ctx.fillStyle = '#070A10';
        ctx.beginPath();
        ctx.arc(seg.x, seg.y, segR + 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = getSegmentColor(snake.skin, i, total);
        ctx.beginPath();
        ctx.arc(seg.x, seg.y, segR, 0, Math.PI * 2);
        ctx.fill();
      }
      // Eyes
      const cos = Math.cos(snake.angle), sin = Math.sin(snake.angle);
      const fwd = radius * 0.38, side = radius * 0.44, eyeR = Math.max(3.2, radius * 0.27);
      for (const sgn of [1, -1]) {
        const ex = snake.x + cos * fwd - sin * side * sgn;
        const ey = snake.y + sin * fwd + cos * side * sgn;
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0B0F17';
        ctx.beginPath();
        ctx.arc(ex + Math.cos(snake.targetAngle) * eyeR * 0.34, ey + Math.sin(snake.targetAngle) * eyeR * 0.34, eyeR * 0.52, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.font = '600 12px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#0B0F17';
      const labelY = snake.y - radius - (snake.id === leaderId ? 24 : 12);
      ctx.strokeText(snake.name, snake.x, labelY);
      ctx.fillStyle = snake.isPlayer ? '#A3E635' : '#E2E8F0';
      ctx.fillText(snake.name, snake.x, labelY);
      ctx.restore();
    }
  }

  drawCallouts(ctx) {
    ctx.save();
    ctx.font = '700 16px "Outfit", sans-serif';
    ctx.textAlign = 'center';
    for (const c of this.callouts) {
      if (!c.active) continue;
      ctx.globalAlpha = Math.max(0, c.life / c.maxLife);
      ctx.fillStyle = c.color;
      ctx.fillText(c.text, c.x, c.y);
    }
    ctx.restore();
  }

  drawMinimap() {
    const mctx = this.minimapCanvas.getContext('2d');
    if (!mctx) return;
    const size = this.minimapCanvas.width, half = size * 0.5, mapR = half - 6;
    mctx.clearRect(0, 0, size, size);
    mctx.fillStyle = 'rgba(17, 23, 34, 0.88)';
    mctx.beginPath();
    mctx.arc(half, half, mapR, 0, Math.PI * 2);
    mctx.fill();
    mctx.strokeStyle = '#2A374E';
    mctx.lineWidth = 2;
    mctx.stroke();
    for (const s of this.snakes) {
      if (!s.alive) continue;
      const mx = half + (s.x / ARENA_RADIUS) * mapR;
      const my = half + (s.y / ARENA_RADIUS) * mapR;
      mctx.fillStyle = s.isPlayer ? '#A3E635' : '#64748B';
      mctx.beginPath();
      mctx.arc(mx, my, s.isPlayer ? 3.5 : 2, 0, Math.PI * 2);
      mctx.fill();
    }
  }

  handleResize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.viewportWidth = window.innerWidth;
    this.viewportHeight = window.innerHeight;
    this.canvas.width = Math.max(1, Math.floor(this.viewportWidth * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(this.viewportHeight * this.dpr));
    this.render();
  }

  bindInputs() {
    const rectPos = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    window.addEventListener('resize', () => this.handleResize());
    window.addEventListener('keydown', (e) => {
      this.keysHeld.add(e.code);
      if (e.code === 'Space' && this.phase === 'playing') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keysHeld.delete(e.code));
    window.addEventListener('blur', () => this.clearHeldInputs());

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.phase !== 'playing') return;
      const pos = rectPos(e.clientX, e.clientY);
      if (e.pointerType === 'touch') {
        e.preventDefault();
        if (this.touchPointerId === null) {
          const now = performance.now();
          this.touchDoubleTapBoost = isDoubleTapWithinWindow(this.lastTouchTapMs, now, DOUBLE_TAP_WINDOW_MS);
          this.lastTouchTapMs = now;
          this.touchPointerId = e.pointerId;
          this.touchStick = { anchorX: pos.x, anchorY: pos.y, currentX: pos.x, currentY: pos.y, hasDragged: false, angle: null };
        } else {
          this.secondaryTouchIds.add(e.pointerId);
        }
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
        return;
      }
      this.pointerActive = true;
      this.pointerScreenX = pos.x;
      this.pointerScreenY = pos.y;
      if (e.button === 0) this.pointerDown = true;
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const pos = rectPos(e.clientX, e.clientY);
      if (e.pointerType === 'touch') {
        e.preventDefault();
        if (this.touchPointerId === e.pointerId && this.touchStick) {
          this.touchStick = stepTouchStick(this.touchStick, pos.x, pos.y, 48, 6);
        }
        return;
      }
      this.pointerActive = true;
      this.pointerScreenX = pos.x;
      this.pointerScreenY = pos.y;
    });

    const releaseTouch = (e) => {
      if (e.pointerType === 'touch') {
        if (this.touchPointerId === e.pointerId) {
          this.touchPointerId = null;
          this.touchStick = null;
          this.touchDoubleTapBoost = false;
        } else {
          this.secondaryTouchIds.delete(e.pointerId);
        }
        return;
      }
      this.pointerDown = false;
    };
    this.canvas.addEventListener('pointerup', releaseTouch);
    this.canvas.addEventListener('pointercancel', releaseTouch);
  }
}

// ==========================================
// Client-Side Photo Skin Palette Extractor
// ==========================================
async function loadAndDownscaleImage(file, maxDim = 960) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image format.'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cctx = c.getContext('2d');
        cctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: c.toDataURL('image/jpeg', 0.85), canvas: c });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function extractLocalPaletteFromCanvas(canvas, note) {
  const sample = document.createElement('canvas');
  sample.width = 24;
  sample.height = 24;
  const sctx = sample.getContext('2d');
  sctx.drawImage(canvas, 0, 0, 24, 24);
  const data = sctx.getImageData(0, 0, 24, 24).data;
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r + g + b < 75) continue;
    const qr = Math.min(255, Math.round(r / 32) * 32);
    const qg = Math.min(255, Math.round(g / 32) * 32);
    const qb = Math.min(255, Math.round(b / 32) * 32);
    const hex = '#' + [qr, qg, qb].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    buckets.set(hex, (buckets.get(hex) || 0) + 1);
  }
  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex).slice(0, 4);
  const palette = sorted.length >= 2 ? sorted : ['#A3E635', '#38BDF8', '#F43F5E'];
  const patterns = ['striped', 'gradient', 'spotted', 'ringed'];
  const pattern = patterns[palette[0].charCodeAt(1) % patterns.length];
  return {
    title: note ? note.slice(0, 22) : 'Photo Serpent',
    description: 'Vibrant custom serpent palette sampled directly from your uploaded photo.',
    palette,
    pattern,
    eyeStyle: 'fierce',
    trait: 'Photo-mapped scales',
  };
}

// ==========================================
// App Boot & UI State Wiring
// ==========================================
(() => {
  const el = (id) => document.getElementById(id);
  let selectedRoom = 25;
  let customSkin = null;
  let selectedSkin = PRESET_SKINS[0];
  let xpayMode = null;
  let uploadedPhoto = null;
  let walletEgp = 100;
  try {
    const raw = localStorage.getItem('damn_bruh_wallet_egp');
    if (raw !== null && Number.isFinite(Number(raw)) && Number(raw) >= 0) walletEgp = roundEgp(Number(raw));
  } catch {}

  const sound = new SoundEngine();
  const engine = new SlitherEngine(el('arena-canvas'), el('minimap-canvas'), sound, {
    onHudUpdate: renderHud,
    onGameOver: showGameOver,
  });
  engine.startLoop();

  function setWallet(next) {
    walletEgp = Math.max(0, roundEgp(next));
    try { localStorage.setItem('damn_bruh_wallet_egp', String(walletEgp)); } catch {}
    renderLobby();
  }

  function setPhase(phase) {
    document.body.dataset.state = phase;
    el('title-overlay').classList.toggle('hidden', phase !== 'title');
    el('game-hud').classList.toggle('hidden', phase !== 'playing');
    el('pause-modal').classList.toggle('hidden', phase !== 'paused');
    el('gameover-modal').classList.toggle('hidden', phase !== 'gameover');
  }

  function renderLobby() {
    el('wallet-balance').textContent = `${formatEgp(walletEgp)} EGP`;
    el('best-length-display').textContent = String(engine.bestLength);
    el('btn-open-cashout').disabled = walletEgp <= 0;
    el('selected-skin-label').textContent = `${selectedSkin.name} · ${selectedSkin.pattern}`;

    const roomGrid = el('room-grid');
    roomGrid.innerHTML = '';
    for (const stake of ROOM_STAKES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `room-btn${selectedRoom === stake ? ' active' : ''}`;
      const ok = canAffordRoom(walletEgp, stake);
      btn.innerHTML = `<div class="room-btn-stake mono">${stake} EGP</div><div class="room-btn-sub${ok ? '' : ' low'}">${ok ? `+${stake} EGP base` : 'Low balance'}</div>`;
      btn.onclick = () => { selectedRoom = stake; renderLobby(); };
      roomGrid.appendChild(btn);
    }

    const skins = customSkin ? [customSkin, ...PRESET_SKINS] : PRESET_SKINS;
    const skinGrid = el('skin-grid');
    skinGrid.innerHTML = '';
    for (const skin of skins) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `skin-btn${selectedSkin.id === skin.id ? ' active' : ''}`;
      const dots = Array.from({ length: 8 }, (_, idx) => `<span class="skin-dot" style="background:${getSegmentColor(skin, idx, 8)}"></span>`).join('');
      btn.innerHTML = `<div><div class="skin-name">${skin.name}</div><div class="skin-trait">${skin.trait || skin.pattern}</div></div><span class="skin-strip">${dots}</span>`;
      btn.onclick = () => { selectedSkin = skin; renderLobby(); };
      skinGrid.appendChild(btn);
    }

    const affordable = canAffordRoom(walletEgp, selectedRoom);
    el('btn-play').disabled = !affordable;
    el('btn-play').textContent = `▶ Play (${selectedRoom} EGP)`;
    el('entry-status').innerHTML = affordable
      ? `Entry: <strong class="mono accent-lime">${selectedRoom} EGP</strong> · ${selectedSkin.name}`
      : `<span class="accent-danger">Need ${selectedRoom} EGP — use xPay Cash In</span>`;
  }

  function renderHud(hud) {
    el('hud-length').textContent = String(hud.length);
    el('hud-rank').textContent = `#${hud.rank}`;
    el('hud-total').textContent = `/${hud.totalSnakes}`;
    el('hud-pot').textContent = `${formatEgp(hud.potEgp)} EGP`;
    el('hud-kills').textContent = String(hud.kills);
    el('hud-room-stake').textContent = `${hud.roomStake} EGP`;
    el('cashout-pot').textContent = `${formatEgp(hud.potEgp)} EGP`;
    el('hud-boost-bar').style.transform = `scaleX(${Math.max(0.05, hud.boostCharge / 100)})`;
    el('hud-boost-bar').style.background = hud.canBoost ? '#A3E635' : '#475569';

    const notice = el('hud-kill-notice');
    if (hud.killNotice) { notice.textContent = hud.killNotice; notice.classList.remove('hidden'); }
    else { notice.classList.add('hidden'); }

    el('hud-leaderboard').innerHTML = hud.leaderboard.map((entry) => `
      <li class="leaderboard-item${entry.isPlayer ? ' me' : ''}">
        <span class="leaderboard-left">
          <span class="mono muted-xs">${entry.rank}.</span>
          <span class="leaderboard-dot" style="background:${entry.accentColor}"></span>
          <span class="leaderboard-name">${entry.name}</span>
        </span>
        <span class="mono">${entry.length}</span>
      </li>`).join('');
  }

  function showGameOver(summary) {
    setPhase('gameover');
    const title = el('gameover-modal-title');
    title.textContent = summary.cashedOut ? 'CASHED OUT!' : 'DAMN BRUH!';
    title.style.color = summary.cashedOut ? '#A3E635' : '#F43F5E';
    el('gameover-best-badge').classList.toggle('hidden', !summary.isNewBest);
    el('gameover-subtitle').innerHTML = summary.cashedOut
      ? `Secured <strong class="mono accent-lime">+${formatEgp(summary.payoutEgp)} EGP</strong> to xPay Preview Wallet · ${summary.survivedSeconds}s`
      : `Eliminated by <strong>${summary.defeatedBy}</strong> · Lost ${summary.roomStake} EGP stake`;
    el('go-length').textContent = String(summary.finalLength);
    el('go-rank').textContent = `#${summary.peakRank}`;
    el('go-kills').textContent = String(summary.kills);
    el('go-peak').textContent = String(summary.peakLength);
    el('go-best').textContent = String(summary.bestLength);
    renderLobby();
  }

  function startRun() {
    if (!canAffordRoom(walletEgp, selectedRoom)) { openXPay('cashin'); return; }
    setWallet(walletEgp - selectedRoom);
    setPhase('playing');
    engine.startNewRun(el('player-name-input').value, selectedSkin, selectedRoom);
    el('arena-canvas').focus();
  }

  // Hold 3s Cash Out button
  let holdTimer = null, holdStart = 0;
  const stopHold = () => {
    if (holdTimer !== null) { clearInterval(holdTimer); holdTimer = null; }
    el('cashout-progress').style.transform = 'scaleX(0)';
    el('cashout-label').textContent = 'Hold 3s to Cash Out';
  };
  el('btn-cashout-hold').addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (holdTimer !== null) return;
    holdStart = performance.now();
    holdTimer = setInterval(() => {
      const elapsed = performance.now() - holdStart;
      const pct = Math.min(1, elapsed / CASH_OUT_HOLD_MS);
      el('cashout-progress').style.transform = `scaleX(${pct})`;
      el('cashout-label').textContent = `Cashing Out (${((1 - pct) * 3).toFixed(1)}s)`;
      if (elapsed >= CASH_OUT_HOLD_MS) {
        stopHold();
        const summary = engine.cashOutRun();
        if (summary) { setWallet(walletEgp + summary.payoutEgp); showGameOver(summary); }
      }
    }, 40);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => el('btn-cashout-hold').addEventListener(ev, stopHold));

  // xPay Preview Modal
  function openXPay(mode) {
    xpayMode = mode;
    el('xpay-modal').classList.remove('hidden');
    el('xpay-receipt-wrap').classList.add('hidden');
    el('xpay-form').classList.remove('hidden');
    el('xpay-error').classList.add('hidden');
    el('xpay-balance').textContent = `${formatEgp(walletEgp)} EGP`;
    el('xpay-modal-title').textContent = mode === 'cashin' ? 'Cash In to Arena Wallet' : 'Cash Out from Arena Wallet';
    el('btn-xpay-submit').textContent = mode === 'cashin' ? 'Confirm Cash In (Preview)' : 'Confirm Cash Out (Preview)';
    el('xpay-presets').classList.toggle('hidden', mode !== 'cashin');
    el('xpay-amount-input').value = mode === 'cashin' ? '100' : formatEgp(Math.min(100, Math.max(1, walletEgp)));
  }

  el('btn-open-cashin').onclick = () => openXPay('cashin');
  el('btn-open-cashout').onclick = () => openXPay('cashout');
  el('btn-close-xpay').onclick = () => el('xpay-modal').classList.add('hidden');
  el('btn-xpay-done').onclick = () => el('xpay-modal').classList.add('hidden');
  el('xpay-presets').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { el('xpay-amount-input').value = b.dataset.preset; };
  });
  el('xpay-form').onsubmit = (e) => {
    e.preventDefault();
    const amt = roundEgp(Number(el('xpay-amount-input').value));
    const err = el('xpay-error');
    if (!Number.isFinite(amt) || amt <= 0) { err.textContent = 'Enter a valid amount in EGP.'; err.classList.remove('hidden'); return; }
    if (xpayMode === 'cashout' && amt > walletEgp) { err.textContent = `Insufficient balance. Available: ${formatEgp(walletEgp)} EGP.`; err.classList.remove('hidden'); return; }
    setWallet(xpayMode === 'cashin' ? walletEgp + amt : walletEgp - amt);
    el('xpay-balance').textContent = `${formatEgp(walletEgp)} EGP`;
    el('xpay-receipt-text').textContent = xpayMode === 'cashin'
      ? `Preview deposit of +${formatEgp(amt)} EGP completed.`
      : `Preview payout of ${formatEgp(amt)} EGP scheduled.`;
    el('xpay-form').classList.add('hidden');
    el('xpay-receipt-wrap').classList.remove('hidden');
  };

  // Photo Skin Studio
  el('photo-upload-input').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    el('photo-error').classList.add('hidden');
    try {
      uploadedPhoto = await loadAndDownscaleImage(file);
      el('photo-preview-img').src = uploadedPhoto.dataUrl;
      el('photo-dropzone').classList.add('hidden');
      el('photo-preview-wrap').classList.remove('hidden');
      el('btn-clear-photo').classList.remove('hidden');
      el('btn-analyze-photo').disabled = false;
    } catch (err) {
      el('photo-error').textContent = err.message;
      el('photo-error').classList.remove('hidden');
    }
  };

  el('btn-clear-photo').onclick = () => {
    uploadedPhoto = null;
    el('photo-upload-input').value = '';
    el('photo-dropzone').classList.remove('hidden');
    el('photo-preview-wrap').classList.add('hidden');
    el('btn-clear-photo').classList.add('hidden');
    el('btn-analyze-photo').disabled = true;
  };

  el('btn-analyze-photo').onclick = () => {
    if (!uploadedPhoto) return;
    const res = extractLocalPaletteFromCanvas(uploadedPhoto.canvas, el('photo-focus-input').value.trim());
    customSkin = { id: 'custom-photo-skin', name: res.title, colors: res.palette, pattern: res.pattern, eyeStyle: res.eyeStyle, trait: res.trait };
    selectedSkin = customSkin;
    el('photo-result-title').textContent = res.title;
    el('photo-result-desc').textContent = res.description;
    el('photo-result-meta').textContent = `${res.pattern} pattern · ${res.eyeStyle} eyes · ${res.trait}`;
    el('photo-result-palette').innerHTML = res.palette.map((hex) => `<span class="swatch" style="background:${hex}" title="${hex}"></span>`).join('');
    el('photo-result-card').classList.remove('hidden');
    renderLobby();
  };

  // Controls
  el('btn-play').onclick = startRun;
  el('btn-play-again').onclick = startRun;
  el('btn-restart-pause').onclick = startRun;
  el('btn-pause').onclick = () => { engine.pause(); setPhase('paused'); };
  el('btn-resume').onclick = () => { engine.resume(); setPhase('playing'); el('arena-canvas').focus(); };
  el('btn-lobby-pause').onclick = () => { engine.returnToTitle(); setPhase('title'); };
  el('btn-change-skin').onclick = () => { engine.returnToTitle(); setPhase('title'); };
  el('btn-mute').onclick = () => { el('btn-mute').textContent = sound.toggleMute() ? '🔇' : '🔊'; };

  window.addEventListener('keydown', (e) => {
    if (!el('xpay-modal').classList.contains('hidden')) {
      if (e.code === 'Escape') el('xpay-modal').classList.add('hidden');
      return;
    }
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (e.code === 'KeyM' && !isInput) el('btn-mute').click();
    if (engine.phase === 'playing' && (e.code === 'Escape' || e.code === 'KeyP')) {
      e.preventDefault(); engine.pause(); setPhase('paused');
    } else if (engine.phase === 'paused' && (e.code === 'Escape' || e.code === 'KeyP')) {
      e.preventDefault(); engine.resume(); setPhase('playing');
    } else if ((engine.phase === 'title' || engine.phase === 'gameover') && (e.code === 'Enter' || e.code === 'Space') && !isInput) {
      e.preventDefault(); startRun();
    }
  });

  renderLobby();
})();
