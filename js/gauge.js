// Quadrante analogico a semicerchio con lancetta, in SVG.
import { MOODS, moodIndex } from './moods.js';

const CX = 120;
const CY = 124;
const R = 96;
const BAND = 24;

function point(deg, r) {
  const t = (deg * Math.PI) / 180;
  return [+(CX + r * Math.cos(t)).toFixed(2), +(CY - r * Math.sin(t)).toFixed(2)];
}

// value 0..100 -> angolo 180°(sinistra)..0°(destra)
const angleOf = (v) => 180 - v * 1.8;

function arc(a0, a1, r) {
  const [x0, y0] = point(a0, r);
  const [x1, y1] = point(a1, r);
  return `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`;
}

function buildSvg(id) {
  const step = 180 / MOODS.length;
  const segs = MOODS.map((m, i) => {
    const a0 = 180 - i * step - 0.8;
    const a1 = 180 - (i + 1) * step + 0.8;
    const mid = 180 - (i + 0.5) * step;
    const [ex, ey] = point(mid, R);
    return `<path class="g-seg" data-i="${i}" d="${arc(a0, a1, R)}" stroke="${m.color}" stroke-width="${BAND}" fill="none"/>
      <text class="g-emoji" data-i="${i}" x="${ex}" y="${ey}" text-anchor="middle" dominant-baseline="central">${m.emoji}</text>`;
  }).join('');

  let ticks = '';
  for (let v = 0; v <= 100; v += 5) {
    const major = v % 25 === 0;
    const [x0, y0] = point(angleOf(v), R - BAND / 2 - 4);
    const [x1, y1] = point(angleOf(v), R - BAND / 2 - (major ? 13 : 8));
    ticks += `<line class="g-tick${major ? ' major' : ''}" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`;
  }

  return `<svg class="gauge-svg" viewBox="0 0 240 136" aria-hidden="true" focusable="false">
    <defs>
      <filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <path class="g-track" d="${arc(180, 0, R)}" stroke-width="${BAND + 8}" fill="none"/>
    <g class="g-segs">${segs}</g>
    <g class="g-ticks">${ticks}</g>
    <g class="g-needle">
      <g class="g-needle-wobble">
        <polygon points="${CX - 4},${CY} ${CX},${CY - R + 4} ${CX + 4},${CY}" filter="url(#${id}-glow)"/>
      </g>
    </g>
    <circle class="g-hub" cx="${CX}" cy="${CY}" r="10"/>
    <circle class="g-hub-dot" cx="${CX}" cy="${CY}" r="3.5"/>
  </svg>`;
}

let uid = 0;

export function createGauge(container, { interactive = false, onInput } = {}) {
  container.innerHTML = buildSvg(`g${++uid}`);
  const svg = container.querySelector('svg');
  const needle = svg.querySelector('.g-needle');
  const segs = svg.querySelectorAll('.g-seg');
  const emojis = svg.querySelectorAll('.g-emoji');
  for (const g of [needle, svg.querySelector('.g-needle-wobble')]) {
    g.style.transformBox = 'view-box';
    g.style.transformOrigin = `${CX}px ${CY}px`;
  }
  let value = null;

  function set(v) {
    v = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const changedBucket = value === null || moodIndex(v) !== moodIndex(value);
    value = v;
    needle.style.transform = `rotate(${v * 1.8 - 90}deg)`;
    const active = moodIndex(v);
    if (changedBucket) {
      segs.forEach((s, i) => s.classList.toggle('active', i === active));
      emojis.forEach((s, i) => s.classList.toggle('active', i === active));
    }
    // Il colore della fascia attiva colora anche percentuale ed etichetta accanto.
    (container.closest('.mood-view') || container).style.setProperty('--mood-color', MOODS[active].color);
    return changedBucket;
  }

  if (interactive) {
    svg.classList.add('interactive');
    const fromEvent = (e) => {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      let deg = (Math.atan2(CY - p.y, p.x - CX) * 180) / Math.PI;
      if (deg < 0) deg = p.x < CX ? 180 : 0;
      return (180 - deg) / 1.8;
    };
    let dragging = false;
    const move = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const before = value;
      const bucketChanged = set(fromEvent(e));
      if (value !== before) onInput?.(value, bucketChanged);
    };
    svg.addEventListener('pointerdown', (e) => {
      dragging = true;
      svg.setPointerCapture(e.pointerId);
      container.classList.add('dragging');
      move(e);
    });
    svg.addEventListener('pointermove', move);
    const end = () => {
      dragging = false;
      container.classList.remove('dragging');
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  return { set, get: () => value };
}
