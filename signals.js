(() => {
  'use strict';
  const fs = 1600, N = 3200;
  const sum = v => v.reduce((a, b) => a + b, 0);
  const norm = v => { const m = sum(v) / N, c = v.map(e => e - m), s = Math.sqrt(sum(c.map(e => e * e)) / N); return c.map(e => e / s); };
  const gate = (t, rate, p) => Math.pow(Math.max(0, Math.sin(2 * Math.PI * rate * t + p)), 3);
  const voice = (f0, rate, p) => norm(Array.from({length: N}, (_, n) => {
    const t = n / fs; let s = 0;
    for (let k = 1; k <= 5; k++) s += Math.sin(2 * Math.PI * k * f0 * t * (1 + .04 * Math.sin(2 * Math.PI * .7 * t + p))) / k;
    return gate(t, rate, p) * s;
  }));
  const S = [voice(90, 1.1, .4), voice(150, 1.7, 2.1)];
  const noise = seed => Array.from({length: N}, (_, n) => {
    const u1 = ((Math.sin((n + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) % 1 || 1e-6;
    const u2 = ((Math.sin((n + 1) * 93.9898 + seed * 67.345) * 24634.6345) % 1 + 1) % 1;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  });
  const N1 = noise(1), N2 = noise(2), sigma = 0.07;
  const mix = (a, b) => [
    S[0].map((v, n) => v + a * S[1][n] + sigma * N1[n]),
    S[0].map((v, n) => b * v + S[1][n] + sigma * N2[n])
  ];
  const corr = (u, v) => sum(u.map((e, n) => e * v[n])) / N;

  // Whitening, then the rotation that makes both outputs as non-Gaussian (heavy-tailed) as possible.
  function unmix(x) {
    const c = x.map(v => { const m = sum(v) / N; return v.map(e => e - m); });
    const cxx = corr(c[0], c[0]), cyy = corr(c[1], c[1]), cxy = corr(c[0], c[1]);
    const th = .5 * Math.atan2(2 * cxy, cxx - cyy), co = Math.cos(th), si = Math.sin(th);
    const l1 = cxx * co * co + 2 * cxy * co * si + cyy * si * si, l2 = cxx * si * si - 2 * cxy * co * si + cyy * co * co;
    if (Math.min(l1, l2) < 1e-3 * Math.max(l1, l2)) return null;
    const z = [c[0].map((e, n) => (co * e + si * c[1][n]) / Math.sqrt(l1)), c[0].map((e, n) => (-si * e + co * c[1][n]) / Math.sqrt(l2))];
    const rot = p => [z[0].map((e, n) => Math.cos(p) * e + Math.sin(p) * z[1][n]), z[0].map((e, n) => -Math.sin(p) * e + Math.cos(p) * z[1][n])];
    const kurt = y => Math.abs(sum(y.map(e => e ** 4)) / N - 3);
    let best = 0, bestScore = -1;
    for (let k = 0; k < 90; k++) { const y = rot(k * Math.PI / 180); const sc = kurt(y[0]) + kurt(y[1]); if (sc > bestScore) { bestScore = sc; best = k; } }
    let y = rot(best * Math.PI / 180);
    const r = [[corr(S[0], y[0]), corr(S[0], y[1])], [corr(S[1], y[0]), corr(S[1], y[1])]];
    const straight = Math.abs(r[0][0] * r[1][1]) >= Math.abs(r[0][1] * r[1][0]);
    const pick = straight ? [0, 1] : [1, 0];
    y = [0, 1].map(i => y[pick[i]].map(e => e * Math.sign(r[i][pick[i]] || 1)));
    return {y, quality: (Math.abs(r[0][pick[0]]) + Math.abs(r[1][pick[1]])) / 2};
  }
  if (typeof module !== 'undefined') module.exports = {S, mix, unmix};

  const lab = typeof document === 'undefined' ? null : document.querySelector('#signal-lab');
  if (!lab) return;
  const state = {a: .6, b: .45, scatter: 'x'};
  const stack = lab.querySelector('#wave-stack');
  const groups = [['Sources', ['Voice 1', 'Voice 2'], 'source'], ['What the microphones record', ['Microphone 1', 'Microphone 2'], 'mic'], ['Recovered from the microphones alone', ['Output 1', 'Output 2'], 'rec']];
  const waves = [];
  groups.forEach(([title, names, kind]) => {
    const g = document.createElement('div'); g.className = 'wave-group';
    g.innerHTML = `<div class="plot-column-label">${title}</div>`;
    names.forEach((name, i) => {
      const row = document.createElement('div'); row.className = 'wave-row';
      const label = document.createElement('span'); label.textContent = name;
      const canvas = document.createElement('canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${name} waveform`);
      row.append(label, canvas); g.append(row); waves.push({canvas, kind, i});
    });
    stack.append(g);
  });
  const scatter = lab.querySelector('#scatter'), status = lab.querySelector('#sep-status');
  let colors = {};
  const css = () => getComputedStyle(document.documentElement);
  function updateColors() {
    const c = css(), v = n => c.getPropertyValue(n).trim();
    colors = {s: [v('--source-1'), v('--source-2')], text: v('--text'), muted: v('--muted'), line: v('--line'), grid: v('--grid'), accent: v('--accent')};
  }
  function size(c) { const r = Math.min(devicePixelRatio || 1, 2), b = c.getBoundingClientRect(); c.width = Math.max(1, Math.round(b.width * r)); c.height = Math.max(1, Math.round(b.height * r)); return r; }
  function drawWave(c, v, color, M) {
    const r = size(c), ctx = c.getContext('2d'), w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h); ctx.strokeStyle = colors.line; ctx.lineWidth = r * .6;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    if (!v) return;
    ctx.strokeStyle = color; ctx.lineWidth = r * 1.1; ctx.beginPath();
    const k = (h / 2 - 2 * r) / M;
    for (let x = 0; x < w; x++) {
      let lo = Infinity, hi = -Infinity;
      for (let n = Math.floor(x * N / w); n < Math.max(Math.floor((x + 1) * N / w), Math.floor(x * N / w) + 1); n++) { lo = Math.min(lo, v[n]); hi = Math.max(hi, v[n]); }
      ctx.moveTo(x + .5, h / 2 - hi * k); ctx.lineTo(x + .5, h / 2 - lo * k - 1);
    }
    ctx.stroke();
  }
  function drawScatter(pts, M) {
    const r = size(scatter), ctx = scatter.getContext('2d'), w = scatter.width, h = scatter.height, k = (w / 2 - 10 * r) / M;
    ctx.clearRect(0, 0, w, h);

    // Subtle background grid
    ctx.strokeStyle = colors.grid; ctx.lineWidth = r * .6;
    ctx.beginPath();
    [0.25, 0.75].forEach(f => {
      ctx.moveTo(w * f, 0); ctx.lineTo(w * f, h);
      ctx.moveTo(0, h * f); ctx.lineTo(w, h * f);
    });
    ctx.stroke();

    // Main zero axes
    ctx.strokeStyle = colors.line; ctx.lineWidth = r * .9;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();

    if (pts) {
      // Direction / target axis lines
      if (state.scatter === 'x') {
        [[1, state.b], [state.a, 1]].forEach((d, i) => {
          const L = M / Math.hypot(d[0], d[1]);
          ctx.strokeStyle = colors.s[i]; ctx.lineWidth = r * 1.6; ctx.globalAlpha = .75;
          ctx.beginPath(); ctx.moveTo(w / 2 - d[0] * L * k, h / 2 + d[1] * L * k); ctx.lineTo(w / 2 + d[0] * L * k, h / 2 - d[1] * L * k); ctx.stroke();
        });
      } else {
        ctx.save(); ctx.setLineDash([4 * r, 3 * r]); ctx.lineWidth = r * 1.4; ctx.globalAlpha = .75;
        ctx.strokeStyle = colors.s[0];
        ctx.beginPath(); ctx.moveTo(10 * r, h / 2); ctx.lineTo(w - 10 * r, h / 2); ctx.stroke();
        ctx.strokeStyle = colors.s[1];
        ctx.beginPath(); ctx.moveTo(w / 2, 10 * r); ctx.lineTo(w / 2, h - 10 * r); ctx.stroke();
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      // Scatter points
      ctx.fillStyle = state.scatter === 'x' ? colors.text : colors.accent; ctx.globalAlpha = .38;
      for (let n = 0; n < N; n += 2) {
        ctx.beginPath();
        ctx.arc(w / 2 + pts[0][n] * k, h / 2 - pts[1][n] * k, 1.45 * r, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Subtle axis labels
    ctx.fillStyle = colors.muted;
    ctx.font = `${Math.round(10.5 * r)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(state.scatter === 'x' ? 'x₁' : 'y₁', w - 7 * r, h / 2 - 4 * r);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(state.scatter === 'x' ? 'x₂' : 'y₂', w / 2 + 6 * r, 6 * r);
  }
  const max = arrs => Math.max(...arrs.map(v => v.reduce((m, e) => Math.max(m, Math.abs(e)), 0)));
  function render() {
    const x = mix(state.a, state.b), u = unmix(x), y = u && u.y;
    const M = max([...S, ...x, ...(y || [])]);
    waves.forEach(({canvas, kind, i}) => drawWave(canvas, kind === 'source' ? S[i] : kind === 'mic' ? x[i] : y && y[i], colors.s[i], M));
    const pts = state.scatter === 'x' ? x : y;
    drawScatter(pts, pts ? max(pts) : 1);
    const A = state.a.toFixed(2), B = state.b.toFixed(2);
    lab.querySelector('#eq-a').textContent = A; lab.querySelector('#eq-b').textContent = B;
    lab.querySelector('#mix-eq').setAttribute('aria-label', `Microphone 1 is voice 1 plus ${A} times voice 2. Microphone 2 is ${B} times voice 1 plus voice 2.`);
    status.textContent = u ? `Outputs match the voices with correlation ${u.quality.toFixed(2)} (1.00 is ideal).` : 'Both microphones record almost the same mixture, so the voices cannot be told apart.';
  }
  lab.querySelectorAll('input[type=range]').forEach(input => input.addEventListener('input', () => {
    state[input.dataset.k] = Number(input.value) / 100; lab.querySelector(`#${input.id}-v`).textContent = state[input.dataset.k].toFixed(2); render();
  }));
  lab.querySelectorAll('[data-scatter]').forEach(button => button.addEventListener('click', () => {
    state.scatter = button.dataset.scatter;
    lab.querySelectorAll('[data-scatter]').forEach(o => o.setAttribute('aria-pressed', String(o === button)));
    lab.querySelector('#scatter-label').textContent = state.scatter === 'x' ? 'Microphone 1 against microphone 2' : 'Output 1 against output 2'; render();
  }));
  lab.querySelector('#reset-signals').addEventListener('click', () => {
    Object.assign(state, {a: .6, b: .45});
    [['mix-a', 60], ['mix-b', 45]].forEach(([id, val]) => { lab.querySelector('#' + id).value = val; lab.querySelector(`#${id}-v`).textContent = (val / 100).toFixed(2); }); render();
  });
  new ResizeObserver(render).observe(lab);
  new MutationObserver(() => { updateColors(); render(); }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  updateColors(); render();
})();

(() => {
  'use strict';
  if (typeof document === 'undefined') return;
  const presets = {
    walking: {
      label: 'Walking',
      fn: (t, i) => {
        const env = .3 + .7 * Math.pow(Math.sin(Math.PI * t), 2);
        return env * (Math.sin((8 + i * 3) * Math.PI * t + i) + .28 * Math.sin(47 * Math.PI * t + i));
      }
    },
    sitting: {
      label: 'Sitting',
      fn: (t, i) => {
        const bias = [0.45, -0.15, 0.35][i];
        return bias + .12 * Math.sin(2.5 * Math.PI * t + i) + .05 * Math.sin(19 * Math.PI * t + i * 2);
      }
    },
    standing: {
      label: 'Standing',
      fn: (t, i) => {
        const bias = [-0.1, 0.05, 0.65][i];
        return bias + .08 * Math.sin(3 * Math.PI * t + i * 1.4) + .04 * Math.sin(29 * Math.PI * t);
      }
    }
  };
  let currentPosture = 'walking';
  let currentAxis = 'all';

  function drawTraces() {
    const p = presets[currentPosture];
    ['x', 'y', 'z'].forEach((axis, i) => {
      const path = Array.from({length: 181}, (_, n) => {
        const t = n / 180;
        const signal = p.fn(t, i);
        return `${n === 0 ? 'M' : 'L'}${(t * 360).toFixed(1)},${(22 - signal * 13).toFixed(1)}`;
      }).join(' ');
      const el = document.querySelector(`#accel-${axis}`);
      if (el) el.setAttribute('d', path);
    });
    const cap = document.querySelector('.trace-caption');
    if (cap) cap.textContent = `Illustrative time series · ${p.label}`;
    const lbl = document.querySelector('#posture-label');
    if (lbl) lbl.textContent = p.label;
  }

  function updateNote() {
    const note = document.querySelector('#axis-note');
    if (!note) return;
    note.textContent = currentAxis === 'all'
      ? `Showing illustrative ${presets[currentPosture].label.toLowerCase()} traces. This sketch explains the pipeline; it does not show experimental data or a model prediction.`
      : `The ${currentAxis}-axis trace is highlighted for ${presets[currentPosture].label.toLowerCase()}. The classifier uses all three axes together; these signals are illustrative.`;
  }

  document.querySelectorAll('[data-axis]').forEach(button => button.addEventListener('click', () => {
    currentAxis = button.dataset.axis;
    document.querySelectorAll('[data-axis]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    document.querySelectorAll('[data-sensor-axis]').forEach(trace => { trace.style.opacity = currentAxis === 'all' || trace.dataset.sensorAxis === currentAxis ? '1' : '.16'; });
    updateNote();
  }));

  document.querySelectorAll('[data-posture]').forEach(button => button.addEventListener('click', () => {
    currentPosture = button.dataset.posture;
    document.querySelectorAll('[data-posture]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    drawTraces();
    updateNote();
  }));

  drawTraces();
})();
