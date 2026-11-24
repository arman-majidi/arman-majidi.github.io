(() => {
  'use strict';

  /* =========================================================================
     1. BLIND SPEECH SEPARATION ENGINE
        - Real 16 kHz male & female counting speech ("One, two, three") loaded
          from assets/voice1.wav & assets/voice2.wav (with clean synthetic
          fallback if opened offline/file://)
        - PCA Whitening + Exact 4th-order-moment Max-Kurtosis 2D ICA
        - Dynamic Radix-2 FFT STFT Spectrogram + Web Audio synced playback
     ========================================================================= */
  let fs = 16000;
  let N = 38400; // 2.40 seconds at 16 kHz
  let duration = N / fs;
  let usingRealSpeech = false;

  const sum = v => {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i];
    return s;
  };

  const norm = v => {
    const n = v.length;
    let m = 0;
    for (let i = 0; i < n; i++) m += v[i];
    m /= n;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const d = v[i] - m;
      sq += d * d;
    }
    const sd = Math.sqrt(sq / n) || 1;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = (v[i] - m) / sd;
    return out;
  };

  function syllableEnv(t, bursts) {
    let e = 0;
    for (let i = 0; i < bursts.length; i++) {
      const [c, w, a] = bursts[i];
      const u = (t - c) / w;
      if (Math.abs(u) < 2.2) e += a * Math.exp(-(u * u * u * u));
    }
    return e;
  }

  function synthFallbackVoice(cfg, len, sr) {
    const out = new Float64Array(len);
    let phase = cfg.phase0;
    for (let n = 0; n < len; n++) {
      const t = n / sr;
      const env = syllableEnv(t, cfg.bursts);
      const f0 = cfg.f0 * (1 + cfg.vibA * Math.sin(2 * Math.PI * cfg.vibF * t + cfg.vibP));
      phase += (2 * Math.PI * f0) / sr;
      if (env < 1e-4) continue;
      let s = 0;
      for (let k = 1; k <= cfg.harmonics; k++) {
        const fk = k * f0;
        if (fk > sr * 0.44) break;
        const g1 = Math.exp(-0.5 * Math.pow((fk - cfg.F1) / cfg.B1, 2));
        const g2 = Math.exp(-0.5 * Math.pow((fk - cfg.F2) / cfg.B2, 2));
        const amp = (0.14 + 1.0 * g1 + 0.65 * g2) / Math.pow(k, 0.55);
        s += amp * Math.sin(k * phase + k * 0.25);
      }
      out[n] = env * s;
    }
    return norm(out);
  }

  function makeNoise(seed, len) {
    const out = new Float64Array(len);
    for (let n = 0; n < len; n++) {
      const u1 = ((Math.sin((n + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) % 1 || 1e-6;
      const u2 = ((Math.sin((n + 1) * 93.9898 + seed * 67.345) * 24634.6345) % 1 + 1) % 1;
      out[n] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    return out;
  }

  // Parse uncompressed 16-bit mono PCM WAV directly (no AudioContext needed before click)
  function parseWavPCM(buf) {
    const view = new DataView(buf);
    if (buf.byteLength < 44) return null;
    const sr = view.getUint32(24, true);
    let off = 12;
    while (off + 8 <= buf.byteLength) {
      const id = String.fromCharCode(
        view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3)
      );
      const chunkSize = view.getUint32(off + 4, true);
      if (id === 'data') {
        const count = Math.floor(chunkSize / 2);
        const samples = new Float64Array(count);
        const start = off + 8;
        for (let i = 0; i < count; i++) {
          samples[i] = view.getInt16(start + i * 2, true) / 32768;
        }
        return { sr, samples };
      }
      off += 8 + chunkSize + (chunkSize & 1);
    }
    return null;
  }

  let S = [
    synthFallbackVoice({
      f0: 128, vibA: 0.08, vibF: 0.85, vibP: 0.3, phase0: 0.2, harmonics: 14,
      F1: 420, B1: 130, F2: 1080, B2: 220,
      bursts: [[0.28, 0.16, 1.0], [1.02, 0.17, 0.95], [1.78, 0.17, 1.0]]
    }, N, fs),
    synthFallbackVoice({
      f0: 235, vibA: 0.09, vibF: 1.15, vibP: 1.8, phase0: 1.5, harmonics: 12,
      F1: 680, B1: 170, F2: 1920, B2: 300,
      bursts: [[0.52, 0.15, 0.95], [1.26, 0.16, 1.04], [2.02, 0.16, 0.92]]
    }, N, fs)
  ];
  let N1 = makeNoise(1, N);
  let N2 = makeNoise(2, N);
  const sigma = 0.055;

  function setSources(s0, s1, sampleRate, realFlag) {
    const len = Math.min(s0.length, s1.length);
    fs = sampleRate;
    N = len;
    duration = N / fs;
    S = [norm(s0.subarray(0, len)), norm(s1.subarray(0, len))];
    N1 = makeNoise(1, N);
    N2 = makeNoise(2, N);
    usingRealSpeech = !!realFlag;
  }

  function mix(a, b) {
    const x0 = new Float64Array(N);
    const x1 = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      x0[n] = S[0][n] + a * S[1][n] + sigma * N1[n];
      x1[n] = b * S[0][n] + S[1][n] + sigma * N2[n];
    }
    return [x0, x1];
  }

  function corr(u, v) {
    let s = 0;
    for (let i = 0; i < N; i++) s += u[i] * v[i];
    return s / N;
  }

  function matrixStats(a, b) {
    const det = 1 - a * b;
    const tr = 2 + a * a + b * b;
    const disc = Math.sqrt(Math.max(0, tr * tr - 4 * det * det));
    const lMax = (tr + disc) / 2;
    const lMin = Math.max(1e-9, (tr - disc) / 2);
    return { det, cond: Math.sqrt(lMax / lMin) };
  }

  // PCA Whitening + Exact 4th-order-moment Max-Kurtosis 2D ICA
  function unmix(x) {
    const m0 = sum(x[0]) / N;
    const m1 = sum(x[1]) / N;
    const c0 = new Float64Array(N);
    const c1 = new Float64Array(N);
    let cxx = 0, cyy = 0, cxy = 0;
    for (let n = 0; n < N; n++) {
      const a0 = x[0][n] - m0;
      const a1 = x[1][n] - m1;
      c0[n] = a0;
      c1[n] = a1;
      cxx += a0 * a0;
      cyy += a1 * a1;
      cxy += a0 * a1;
    }
    cxx /= N; cyy /= N; cxy /= N;

    let th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    let co = Math.cos(th), si = Math.sin(th);
    let l1 = cxx * co * co + 2 * cxy * co * si + cyy * si * si;
    let l2 = cxx * si * si - 2 * cxy * co * si + cyy * co * co;
    if (l2 > l1) {
      [l1, l2] = [l2, l1];
      th += Math.PI / 2;
      co = Math.cos(th); si = Math.sin(th);
    }
    if (co < 0) { co = -co; si = -si; }
    if (Math.min(l1, l2) < 1e-3 * Math.max(l1, l2)) return null;

    const inv1 = 1 / Math.sqrt(l1);
    const inv2 = 1 / Math.sqrt(l2);
    const v00 = co * inv1, v01 = si * inv1;
    const v10 = -si * inv2, v11 = co * inv2;

    const z0 = new Float64Array(N);
    const z1 = new Float64Array(N);
    let m40 = 0, m31 = 0, m22 = 0, m13 = 0, m04 = 0;
    for (let n = 0; n < N; n++) {
      const u = v00 * c0[n] + v01 * c1[n];
      const v = v10 * c0[n] + v11 * c1[n];
      z0[n] = u;
      z1[n] = v;
      const u2 = u * u, v2 = v * v;
      m40 += u2 * u2;
      m31 += u2 * u * v;
      m22 += u2 * v2;
      m13 += u * v2 * v;
      m04 += v2 * v2;
    }
    m40 /= N; m31 /= N; m22 /= N; m13 /= N; m04 /= N;

    let bestPhi = 0;
    let bestScore = -1;
    const steps = 360;
    for (let k = 0; k < steps; k++) {
      const phi = (k * Math.PI) / (2 * steps);
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const c2 = cp * cp, s2 = sp * sp;
      const c4 = c2 * c2, s4 = s2 * s2, c3s = c2 * cp * sp, cs3 = cp * s2 * sp, c2s2 = c2 * s2;
      const ey14 = c4 * m40 + 4 * c3s * m31 + 6 * c2s2 * m22 + 4 * cs3 * m13 + s4 * m04;
      const ey24 = s4 * m40 - 4 * cs3 * m31 + 6 * c2s2 * m22 - 4 * c3s * m13 + c4 * m04;
      const sc = Math.abs(ey14 - 3) + Math.abs(ey24 - 3);
      if (sc > bestScore) { bestScore = sc; bestPhi = phi; }
    }

    const cp = Math.cos(bestPhi), sp = Math.sin(bestPhi);
    const ry0 = new Float64Array(N);
    const ry1 = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      ry0[n] = cp * z0[n] + sp * z1[n];
      ry1[n] = -sp * z0[n] + cp * z1[n];
    }

    const r00 = corr(S[0], ry0), r01 = corr(S[0], ry1);
    const r10 = corr(S[1], ry0), r11 = corr(S[1], ry1);
    const straight = Math.abs(r00 * r11) >= Math.abs(r01 * r10);
    const pick = straight ? [0, 1] : [1, 0];
    const rMat = [[r00, r01], [r10, r11]];
    const sgn0 = Math.sign(rMat[0][pick[0]] || 1);
    const sgn1 = Math.sign(rMat[1][pick[1]] || 1);

    const raw = [ry0, ry1];
    const y0 = new Float64Array(N);
    const y1 = new Float64Array(N);
    const src0 = raw[pick[0]];
    const src1 = raw[pick[1]];
    for (let n = 0; n < N; n++) {
      y0[n] = sgn0 * src0[n];
      y1[n] = sgn1 * src1[n];
    }

    const baseR = [[cp, sp], [-sp, cp]];
    const Q = [
      [sgn0 * baseR[pick[0]][0], sgn0 * baseR[pick[0]][1]],
      [sgn1 * baseR[pick[1]][0], sgn1 * baseR[pick[1]][1]]
    ];
    const rotAngle = Math.atan2(Q[1][0], Q[0][0]);
    const detQ = Q[0][0] * Q[1][1] - Q[0][1] * Q[1][0];
    const quality = (Math.abs(rMat[0][pick[0]]) + Math.abs(rMat[1][pick[1]])) / 2;

    return { y: [y0, y1], z: [z0, z1], V: [[v00, v01], [v10, v11]], Q, rotAngle, detQ, quality };
  }

  // Iterative Radix-2 FFT (512-pt for 16 kHz wideband human speech spectrograms)
  const FFT_SIZE = 512;
  const HOP_SIZE = 256;
  const SPEC_BINS = 144; // 0 .. 4500 Hz at 16 kHz
  const hann = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  const bitRev = new Uint16Array(FFT_SIZE);
  {
    const bits = Math.log2(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      bitRev[i] = r;
    }
  }
  const twCos = new Float64Array(FFT_SIZE / 2);
  const twSin = new Float64Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    const ang = (-2 * Math.PI * i) / FFT_SIZE;
    twCos[i] = Math.cos(ang);
    twSin[i] = Math.sin(ang);
  }
  const fftRe = new Float64Array(FFT_SIZE);
  const fftIm = new Float64Array(FFT_SIZE);

  function computeSpectrogram(sig) {
    const frames = Math.max(1, Math.floor((sig.length - FFT_SIZE) / HOP_SIZE) + 1);
    const mag = new Float32Array(frames * SPEC_BINS);
    let peak = 1e-6;
    for (let f = 0; f < frames; f++) {
      const start = f * HOP_SIZE;
      for (let i = 0; i < FFT_SIZE; i++) {
        const rev = bitRev[i];
        fftRe[rev] = sig[start + i] * hann[i];
        fftIm[rev] = 0;
      }
      for (let size = 2; size <= FFT_SIZE; size <<= 1) {
        const half = size >> 1;
        const step = FFT_SIZE / size;
        for (let i = 0; i < FFT_SIZE; i += size) {
          for (let j = 0, tw = 0; j < half; j++, tw += step) {
            const k = i + j, l = k + half;
            const wr = twCos[tw], wi = twSin[tw];
            const tr = wr * fftRe[l] - wi * fftIm[l];
            const ti = wr * fftIm[l] + wi * fftRe[l];
            fftRe[l] = fftRe[k] - tr;
            fftIm[l] = fftIm[k] - ti;
            fftRe[k] += tr;
            fftIm[k] += ti;
          }
        }
      }
      const base = f * SPEC_BINS;
      for (let b = 0; b < SPEC_BINS; b++) {
        const m = Math.hypot(fftRe[b], fftIm[b]);
        mag[base + b] = m;
        if (m > peak) peak = m;
      }
    }
    return { frames, bins: SPEC_BINS, mag, peak };
  }

  if (typeof module !== 'undefined') {
    module.exports = { get fs() { return fs; }, get N() { return N; }, get S() { return S; }, setSources, parseWavPCM, mix, unmix, matrixStats, computeSpectrogram };
  }
  if (typeof document === 'undefined') return;

  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* =========================================================================
     2. HERO INTERACTIVE TWO-VOICE INTERFERENCE CANVAS
     ========================================================================= */
  (() => {
    const canvas = document.querySelector('#hero-wave');
    if (!canvas) return;
    const wrap = canvas.closest('.hero-wave-wrap');
    const ctx = canvas.getContext('2d');
    let sep = prefersReducedMotion() ? 0.65 : 0.0;
    let targetSep = sep;
    let pointerX = 0.5;
    let t = 0;
    let rafId = null;
    let visible = true;
    let pal = {};

    function loadPal() {
      pal = {
        accent: cssVar('--accent'),
        s1: cssVar('--source-1'),
        s2: cssVar('--source-2'),
        muted: cssVar('--muted'),
        line: cssVar('--line')
      };
    }

    function resize() {
      const r = Math.min(devicePixelRatio || 1, 2);
      const b = canvas.getBoundingClientRect();
      if (!b.width || !b.height) return;
      canvas.width = Math.round(b.width * r);
      canvas.height = Math.round(b.height * r);
      draw();
    }

    function draw() {
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      const r = Math.min(devicePixelRatio || 1, 2);
      ctx.clearRect(0, 0, w, h);

      const mid = h * 0.5;
      const amp = h * 0.28;
      const offset = sep * (h * 0.24);
      const steps = Math.max(120, Math.round(w / 2));

      ctx.strokeStyle = pal.line;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = r * 0.7;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();

      const w1 = x => {
        const env = Math.pow(Math.sin(Math.PI * x), 1.5);
        return env * (0.68 * Math.sin(14 * x - t * 1.4) + 0.32 * Math.sin(28 * x - t * 2.1 + 0.6));
      };
      const w2 = x => {
        const env = Math.pow(Math.sin(Math.PI * x), 1.4);
        return env * (0.62 * Math.sin(23 * x + t * 1.9 + 1.4) + 0.38 * Math.sin(39 * x + t * 1.2));
      };

      ctx.strokeStyle = pal.s1;
      ctx.lineWidth = r * (1.25 + sep * 0.4);
      ctx.globalAlpha = 0.28 + sep * 0.65;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const localSep = offset * (0.45 + 0.55 * Math.exp(-Math.pow((u - pointerX) * 2.1, 2)));
        const y = mid - localSep - w1(u) * amp * (0.62 + 0.32 * sep);
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(u * w, y);
      }
      ctx.stroke();

      ctx.strokeStyle = pal.s2;
      ctx.lineWidth = r * (1.25 + sep * 0.4);
      ctx.globalAlpha = 0.28 + sep * 0.65;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const localSep = offset * (0.45 + 0.55 * Math.exp(-Math.pow((u - pointerX) * 2.1, 2)));
        const y = mid + localSep - w2(u) * amp * (0.62 + 0.32 * sep);
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(u * w, y);
      }
      ctx.stroke();

      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = r * 1.65;
      ctx.globalAlpha = Math.max(0.14, 0.92 - sep * 0.72);
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const y = mid - (0.58 * w1(u) + 0.52 * w2(u)) * amp;
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(u * w, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function tick() {
      if (!visible) { rafId = null; return; }
      t += 0.018;
      sep += (targetSep - sep) * 0.1;
      draw();
      rafId = requestAnimationFrame(tick);
    }

    function start() {
      if (prefersReducedMotion()) { draw(); return; }
      if (!rafId) rafId = requestAnimationFrame(tick);
    }

    if (wrap) {
      wrap.addEventListener('pointerenter', () => { targetSep = 1; wrap.classList.add('is-active'); });
      wrap.addEventListener('pointermove', e => {
        const b = canvas.getBoundingClientRect();
        pointerX = Math.max(0.05, Math.min(0.95, (e.clientX - b.left) / b.width));
        targetSep = 1;
        if (prefersReducedMotion()) { sep = 1; draw(); }
      });
      wrap.addEventListener('pointerleave', () => {
        targetSep = 0;
        wrap.classList.remove('is-active');
        if (prefersReducedMotion()) { sep = 0.65; draw(); }
      });
    }

    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) start();
    }, { threshold: 0.01 }).observe(canvas);
    new ResizeObserver(resize).observe(canvas);
    new MutationObserver(() => { loadPal(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    loadPal();
    resize();
    start();
  })();

  /* =========================================================================
     3. FIG. 01 — INTERACTIVE BLIND SPEECH SEPARATION STUDIO
     ========================================================================= */
  (() => {
    const lab = document.querySelector('#signal-lab');
    if (!lab) return;

    const state = {
      a: 0.60,
      b: 0.45,
      scatter: 'x',
      domain: 'wave',
      morphStage: 0,
      targetStage: 0
    };

    const stack = lab.querySelector('#wave-stack');
    const groups = [
      ['Original speakers (counting 1–3)', ['Male', 'Female'], 'source'],
      ['Recorded mixtures (microphones)', ['Mic 1', 'Mic 2'], 'mic'],
      ['Recovered blindly via ICA', ['Output 1', 'Output 2'], 'rec']
    ];
    const waves = [];
    groups.forEach(([title, names, kind]) => {
      const g = document.createElement('div');
      g.className = 'wave-group';
      g.innerHTML = `<div class="plot-column-label">${title}</div>`;
      names.forEach((name, i) => {
        const row = document.createElement('div');
        row.className = 'wave-row';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'play-track-btn';
        btn.setAttribute('aria-label', `Play ${name}`);
        btn.setAttribute('aria-pressed', 'false');
        btn.innerHTML = '<svg aria-hidden="true" class="icon"><use href="#i-play"></use></svg>';
        const label = document.createElement('span');
        label.className = 'track-name';
        label.textContent = name;
        const canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${name} signal visualization`);
        const trackObj = { id: `${kind}-${i}`, name, kind, i, canvas, btn };
        btn.addEventListener('click', () => toggleAudio(trackObj));
        row.append(btn, label, canvas);
        g.append(row);
        waves.push(trackObj);
      });
      stack.append(g);
    });

    const scatter = lab.querySelector('#scatter');
    const statusEl = lab.querySelector('#sep-status');
    const eqA = lab.querySelector('#eq-a');
    const eqB = lab.querySelector('#eq-b');
    const eqWrap = lab.querySelector('#mix-eq');
    const metricDet = lab.querySelector('#metric-det');
    const metricCond = lab.querySelector('#metric-cond');
    const metricCorr = lab.querySelector('#metric-corr');
    const qualityFill = lab.querySelector('#quality-fill');
    const scatterLabel = lab.querySelector('#scatter-label');
    const scatterHint = lab.querySelector('#scatter-hint');
    const leg1 = lab.querySelector('#leg-1');
    const leg2 = lab.querySelector('#leg-2');
    const animateBtn = lab.querySelector('#animate-ica');

    let colors = {};
    let currentData = null;
    let specCache = new WeakMap();
    const specOffscreen = document.createElement('canvas');
    let draggingHandle = null;
    let hoverHandle = null;
    let morphRaf = null;
    let autoSeqTimer = null;

    function updateColors() {
      const dark = document.documentElement.dataset.theme === 'dark';
      colors = {
        dark,
        s: [cssVar('--source-1'), cssVar('--source-2')],
        mic: dark ? '#a8b0cc' : '#4a4f63',
        bg: cssVar('--bg'),
        surface: cssVar('--surface'),
        text: cssVar('--text'),
        muted: cssVar('--muted'),
        line: cssVar('--line'),
        grid: cssVar('--grid'),
        accent: cssVar('--accent'),
        good: dark ? '#6ee7b7' : '#1b7a5c',
        warn: dark ? '#fbbf24' : '#b4690e',
        bad: dark ? '#f87171' : '#b83b3b'
      };
    }

    function sizeCanvas(c) {
      const r = Math.min(devicePixelRatio || 1, 2);
      const b = c.getBoundingClientRect();
      const nw = Math.max(1, Math.round(b.width * r));
      const nh = Math.max(1, Math.round(b.height * r));
      if (c.width !== nw || c.height !== nh) { c.width = nw; c.height = nh; }
      return r;
    }

    let cmapLUT = null;
    let cmapTheme = null;
    function getColormap() {
      const theme = colors.dark ? 'dark' : 'light';
      if (cmapLUT && cmapTheme === theme) return cmapLUT;
      cmapTheme = theme;
      const stops = colors.dark
        ? [[0, 30, 32, 41], [0.25, 48, 44, 88], [0.52, 114, 92, 198], [0.78, 120, 220, 232], [1, 245, 240, 224]]
        : [[0, 247, 246, 242], [0.25, 215, 211, 234], [0.55, 117, 102, 184], [0.80, 62, 48, 128], [1, 22, 18, 46]];
      const lut = new Uint8ClampedArray(256 * 4);
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let k = 0;
        while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
        const s0 = stops[k], s1 = stops[k + 1];
        const f = (t - s0[0]) / (s1[0] - s0[0] || 1);
        lut[i * 4] = Math.round(s0[1] + (s1[1] - s0[1]) * f);
        lut[i * 4 + 1] = Math.round(s0[2] + (s1[2] - s0[2]) * f);
        lut[i * 4 + 2] = Math.round(s0[3] + (s1[3] - s0[3]) * f);
        lut[i * 4 + 3] = 255;
      }
      cmapLUT = lut;
      return lut;
    }

    function getTrackSignal(track) {
      if (!currentData) return null;
      if (track.kind === 'source') return S[track.i];
      if (track.kind === 'mic') return currentData.x[track.i];
      return currentData.y ? currentData.y[track.i] : null;
    }

    function getTrackColor(track) {
      return track.kind === 'mic' ? colors.mic : colors.s[track.i];
    }

    // Robust scale (99.6th percentile) so real speech waveforms & scatter fill canvas cleanly
    function robustScale(arrs, quantile = 0.996) {
      const sample = [];
      for (const v of arrs) {
        if (!v) continue;
        const step = Math.max(1, Math.floor(v.length / 2000));
        for (let i = 0; i < v.length; i += step) sample.push(Math.abs(v[i]));
      }
      if (!sample.length) return 1;
      sample.sort((a, b) => a - b);
      const q = sample[Math.min(sample.length - 1, Math.floor(sample.length * quantile))];
      return Math.max(q * 1.12, 1e-3);
    }

    function drawWaveTrack(track, v, M, playFrac) {
      const c = track.canvas;
      const r = sizeCanvas(c);
      const ctx = c.getContext('2d');
      const w = c.width, h = c.height;
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = colors.line;
      ctx.lineWidth = r * 0.65;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      if (!v) {
        ctx.fillStyle = colors.muted;
        ctx.font = `${Math.round(10 * r)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('singular mixture', w / 2, h / 2);
        return;
      }

      const color = getTrackColor(track);
      const scale = (h / 2 - 2.5 * r) / M;
      const cols = Math.max(1, Math.floor(w / r));
      const hiPts = new Float32Array(cols);
      const loPts = new Float32Array(cols);
      for (let col = 0; col < cols; col++) {
        const start = Math.floor((col * N) / cols);
        const end = Math.max(start + 1, Math.floor(((col + 1) * N) / cols));
        let lo = Infinity, hi = -Infinity;
        for (let n = start; n < end; n++) {
          const val = v[n];
          if (val < lo) lo = val;
          if (val > hi) hi = val;
        }
        hiPts[col] = Math.max(1.5 * r, h / 2 - hi * scale);
        loPts[col] = Math.min(h - 1.5 * r, h / 2 - lo * scale);
      }

      ctx.fillStyle = color;
      ctx.globalAlpha = colors.dark ? 0.26 : 0.18;
      ctx.beginPath();
      for (let col = 0; col < cols; col++) {
        const x = (col + 0.5) * r;
        if (col === 0) ctx.moveTo(x, hiPts[col]);
        else ctx.lineTo(x, hiPts[col]);
      }
      for (let col = cols - 1; col >= 0; col--) ctx.lineTo((col + 0.5) * r, loPts[col]);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.92;
      ctx.lineWidth = r * 1.05;
      ctx.beginPath();
      for (let col = 0; col < cols; col++) {
        const x = (col + 0.5) * r;
        ctx.moveTo(x, hiPts[col]);
        ctx.lineTo(x, Math.max(loPts[col], hiPts[col] + r * 0.8));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (playFrac !== null) drawPlayhead(ctx, w, h, r, playFrac);
    }

    function drawSpecTrack(track, v, playFrac) {
      const c = track.canvas;
      const r = sizeCanvas(c);
      const ctx = c.getContext('2d');
      const w = c.width, h = c.height;
      ctx.clearRect(0, 0, w, h);

      if (!v) {
        ctx.fillStyle = colors.muted;
        ctx.font = `${Math.round(10 * r)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('singular mixture', w / 2, h / 2);
        return;
      }

      let sp = specCache.get(v);
      if (!sp) {
        sp = computeSpectrogram(v);
        specCache.set(v, sp);
      }
      const lut = getColormap();
      specOffscreen.width = sp.frames;
      specOffscreen.height = sp.bins;
      const octx = specOffscreen.getContext('2d');
      const img = octx.createImageData(sp.frames, sp.bins);
      const data = img.data;
      const dbFloor = -46;
      const invPeak = 1 / (sp.peak || 1);

      for (let f = 0; f < sp.frames; f++) {
        const base = f * sp.bins;
        for (let b = 0; b < sp.bins; b++) {
          const val = sp.mag[base + b] * invPeak;
          const db = 20 * Math.log10(val + 1e-6);
          const normDb = Math.max(0, Math.min(1, (db - dbFloor) / -dbFloor));
          const idx = Math.round(Math.pow(normDb, 1.1) * 255) * 4;
          const py = sp.bins - 1 - b;
          const p = (py * sp.frames + f) * 4;
          data[p] = lut[idx];
          data[p + 1] = lut[idx + 1];
          data[p + 2] = lut[idx + 2];
          data[p + 3] = 255;
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(specOffscreen, 0, 0, w, h);

      ctx.fillStyle = getTrackColor(track);
      ctx.fillRect(0, 0, 2.5 * r, h);

      if (playFrac !== null) drawPlayhead(ctx, w, h, r, playFrac);
    }

    function drawPlayhead(ctx, w, h, r, frac) {
      const px = frac * w;
      ctx.save();
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = r * 1.65;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.restore();
    }

    function scatterPointAt(n, s, d) {
      const x0 = d.x[0][n], x1 = d.x[1][n];
      if (!d.u || s <= 0.001) return [x0 / d.maxX, x1 / d.maxX];
      const z0 = d.u.z[0][n], z1 = d.u.z[1][n];
      if (s <= 1.0) {
        const e = s * s * (3 - 2 * s);
        return [
          (1 - e) * (x0 / d.maxX) + e * (z0 / d.maxZ),
          (1 - e) * (x1 / d.maxX) + e * (z1 / d.maxZ)
        ];
      }
      const u = s - 1.0;
      const e = u * u * (3 - 2 * u);
      if (d.u.detQ > 0) {
        const ang = e * d.u.rotAngle;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const rx = ca * z0 - sa * z1;
        const ry = sa * z0 + ca * z1;
        const sc = (1 - e) / d.maxZ + e / d.maxY;
        return [rx * sc, ry * sc];
      }
      return [
        (1 - e) * (z0 / d.maxZ) + e * (d.u.y[0][n] / d.maxY),
        (1 - e) * (z1 / d.maxZ) + e * (d.u.y[1][n] / d.maxY)
      ];
    }

    function getHandlePositions(w, h) {
      const radius = w * 0.41;
      return [[1, state.b], [state.a, 1]].map(([dx, dy]) => {
        const len = Math.hypot(dx, dy) || 1;
        const nx = dx / len, ny = dy / len;
        return { x: w / 2 + nx * radius, y: h / 2 - ny * radius, nx, ny, radius };
      });
    }

    function drawScatter(playFrac) {
      const r = sizeCanvas(scatter);
      const ctx = scatter.getContext('2d');
      const w = scatter.width, h = scatter.height;
      const pad = 16 * r;
      const scale = w / 2 - pad;
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = r * 0.65;
      ctx.beginPath();
      [0.25, 0.75].forEach(f => {
        ctx.moveTo(w * f, 0); ctx.lineTo(w * f, h);
        ctx.moveTo(0, h * f); ctx.lineTo(w, h * f);
      });
      ctx.stroke();

      const stage = currentData && currentData.u ? state.morphStage : 0;
      if (stage > 0.15) {
        const circleAlpha = Math.min(1, stage) * (stage > 1 ? Math.max(0.25, 2 - stage) : 1);
        ctx.save();
        ctx.strokeStyle = colors.line;
        ctx.globalAlpha = 0.7 * circleAlpha;
        ctx.setLineDash([3 * r, 3 * r]);
        ctx.lineWidth = r * 0.9;
        const unitR = (1 / (currentData ? currentData.maxZ : 3)) * scale;
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, unitR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      ctx.strokeStyle = colors.line;
      ctx.lineWidth = r * 1.0;
      ctx.beginPath();
      ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
      ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
      ctx.stroke();

      if (!currentData) return;

      if (stage < 0.05) {
        const handles = getHandlePositions(w, h);
        const ang1 = Math.atan2(state.b, 1);
        const ang2 = Math.atan2(1, state.a);
        const sepDeg = Math.round(((ang2 - ang1) * 180) / Math.PI);
        ctx.save();
        ctx.strokeStyle = colors.muted;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = r * 1.1;
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, w * 0.15, -ang2, -ang1);
        ctx.stroke();
        const midAng = (ang1 + ang2) / 2;
        ctx.fillStyle = colors.muted;
        ctx.globalAlpha = 0.85;
        ctx.font = `${Math.round(9.5 * r)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${sepDeg}°`, w / 2 + Math.cos(midAng) * w * 0.22, h / 2 - Math.sin(midAng) * w * 0.22);
        ctx.restore();

        handles.forEach((hd, i) => {
          const isHot = draggingHandle === i || hoverHandle === i;
          ctx.save();
          ctx.strokeStyle = colors.s[i];
          ctx.globalAlpha = 0.35;
          ctx.setLineDash([4 * r, 3 * r]);
          ctx.lineWidth = r * 1.1;
          ctx.beginPath();
          ctx.moveTo(w / 2 - hd.nx * scale * 0.92, h / 2 + hd.ny * scale * 0.92);
          ctx.lineTo(w / 2 + hd.nx * scale * 0.92, h / 2 - hd.ny * scale * 0.92);
          ctx.stroke();
          ctx.restore();

          ctx.strokeStyle = colors.s[i];
          ctx.lineWidth = r * (isHot ? 2.4 : 1.8);
          ctx.beginPath();
          ctx.moveTo(w / 2, h / 2);
          ctx.lineTo(hd.x, hd.y);
          ctx.stroke();

          ctx.fillStyle = isHot ? colors.s[i] : colors.surface;
          ctx.strokeStyle = colors.s[i];
          ctx.lineWidth = r * 2.0;
          ctx.beginPath();
          ctx.arc(hd.x, hd.y, (isHot ? 6.2 : 5.0) * r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = colors.s[i];
          ctx.font = `600 ${Math.round(10 * r)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
          ctx.textAlign = i === 0 ? 'left' : 'center';
          ctx.textBaseline = i === 0 ? 'middle' : 'bottom';
          ctx.fillText(i === 0 ? 'a₁' : 'a₂', hd.x + (i === 0 ? 9 * r : 0), hd.y + (i === 0 ? 0 : -9 * r));
        });
      } else if (currentData.u) {
        const u = Math.max(0, stage - 1);
        const e = u * u * (3 - 2 * u);
        const remAng = currentData.u.detQ > 0 ? -(1 - e) * currentData.u.rotAngle : 0;
        const cA = Math.cos(remAng), sA = Math.sin(remAng);
        [[cA, sA], [-sA, cA]].forEach(([dx, dy], i) => {
          ctx.save();
          ctx.strokeStyle = colors.s[i];
          ctx.globalAlpha = 0.72;
          ctx.setLineDash(stage > 1.85 ? [4 * r, 3 * r] : []);
          ctx.lineWidth = r * 1.5;
          ctx.beginPath();
          ctx.moveTo(w / 2 - dx * scale * 0.94, h / 2 + dy * scale * 0.94);
          ctx.lineTo(w / 2 + dx * scale * 0.94, h / 2 - dy * scale * 0.94);
          ctx.stroke();
          ctx.restore();
        });
      }

      const scatterStep = Math.max(1, Math.floor(N / 2200));
      const dotColor = stage < 0.5 ? colors.text : colors.accent;
      ctx.fillStyle = dotColor;
      ctx.globalAlpha = colors.dark ? 0.34 : 0.28;
      const dotR = 1.4 * r;
      for (let n = 0; n < N; n += scatterStep) {
        const [px, py] = scatterPointAt(n, stage, currentData);
        if (Math.abs(px) > 1.06 || Math.abs(py) > 1.06) continue;
        const cx = w / 2 + px * scale;
        const cy = h / 2 - py * scale;
        ctx.fillRect(cx - dotR, cy - dotR, dotR * 2, dotR * 2);
      }
      ctx.globalAlpha = 1;

      if (playFrac !== null && playFrac >= 0 && playFrac <= 1) {
        const idxNow = Math.min(N - 1, Math.floor(playFrac * N));
        const trailLen = 22;
        ctx.save();
        for (let k = trailLen; k >= 0; k--) {
          const idx = Math.max(0, idxNow - k * 14);
          const [px, py] = scatterPointAt(idx, stage, currentData);
          const cx = w / 2 + Math.max(-1.02, Math.min(1.02, px)) * scale;
          const cy = h / 2 - Math.max(-1.02, Math.min(1.02, py)) * scale;
          const alpha = 1 - k / (trailLen + 1);
          ctx.fillStyle = k === 0 ? colors.s[1] : colors.accent;
          ctx.globalAlpha = k === 0 ? 1 : alpha * 0.55;
          ctx.beginPath();
          ctx.arc(cx, cy, (k === 0 ? 4.4 : 2.1 * alpha + 0.8) * r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      const axLbl = stage < 0.5 ? ['x₁', 'x₂'] : stage < 1.5 ? ['z₁', 'z₂'] : ['y₁', 'y₂'];
      ctx.fillStyle = colors.muted;
      ctx.font = `${Math.round(10.5 * r)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(axLbl[0], w - 7 * r, h / 2 - 4 * r);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(axLbl[1], w / 2 + 6 * r, 6 * r);
    }

    function recompute() {
      const x = mix(state.a, state.b);
      const u = unmix(x);
      const y = u && u.y;
      const M = robustScale([...S, ...x, ...(y || [])], 0.997);
      currentData = {
        x,
        u,
        y,
        M,
        maxX: robustScale(x, 0.994),
        maxZ: u ? robustScale(u.z, 0.994) : 1,
        maxY: y ? robustScale(y, 0.994) : 1
      };
      updateReadouts();
      renderCanvases(getPlayFraction());
    }

    function updateReadouts() {
      const A = state.a.toFixed(2);
      const B = state.b.toFixed(2);
      eqA.textContent = A;
      eqB.textContent = B;
      eqWrap.setAttribute('aria-label', `Microphone 1 is male speaker plus ${A} times female speaker. Microphone 2 is ${B} times male speaker plus female speaker.`);

      const { det, cond } = matrixStats(state.a, state.b);
      metricDet.textContent = det.toFixed(2);
      metricCond.textContent = cond > 99 ? '>99' : cond.toFixed(1);

      const u = currentData && currentData.u;
      if (u) {
        const q = Math.min(1, Math.max(0, u.quality));
        metricCorr.textContent = q.toFixed(2);
        qualityFill.style.width = `${Math.round(q * 100)}%`;
        qualityFill.style.background = q > 0.92 ? colors.good : q > 0.78 ? colors.warn : colors.bad;
        statusEl.textContent = q > 0.94
          ? `Well-conditioned mixture — ICA separates both speakers with r = ${q.toFixed(2)}.`
          : `Higher crosstalk amplifies sensor noise — recovery drops to r = ${q.toFixed(2)}.`;
      } else {
        metricCorr.textContent = '—';
        qualityFill.style.width = '6%';
        qualityFill.style.background = colors.bad;
        statusEl.textContent = 'Near-singular mixture: both microphones hear almost the same sum, so blind recovery breaks down.';
      }

      lab.querySelectorAll('.preset-btn').forEach(btn => {
        const [pa, pb] = btn.dataset.preset.split(',').map(Number);
        btn.classList.toggle('is-active', Math.abs(pa - state.a) < 0.006 && Math.abs(pb - state.b) < 0.006);
      });
    }

    function renderCanvases(playFrac) {
      if (!currentData) return;
      waves.forEach(track => {
        const v = getTrackSignal(track);
        if (state.domain === 'wave') drawWaveTrack(track, v, currentData.M, playFrac);
        else drawSpecTrack(track, v, playFrac);
      });
      drawScatter(playFrac);
    }

    function setScatterStage(mode, animate = true) {
      state.scatter = mode;
      state.targetStage = mode === 'x' ? 0 : mode === 'z' ? 1 : 2;
      lab.querySelectorAll('[data-scatter]').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.scatter === mode));
      });
      if (mode === 'x') {
        scatterLabel.textContent = 'Mixed (x₁, x₂)';
        scatterHint.textContent = 'Drag vector tips';
        leg1.textContent = 'Column a₁';
        leg2.textContent = 'Column a₂';
      } else if (mode === 'z') {
        scatterLabel.textContent = 'Whitened (z₁, z₂)';
        scatterHint.textContent = 'Decorrelated, rotated';
        leg1.textContent = 'Latent axis 1';
        leg2.textContent = 'Latent axis 2';
      } else {
        scatterLabel.textContent = 'Recovered (y₁, y₂)';
        scatterHint.textContent = 'Aligned by kurtosis';
        leg1.textContent = 'Output 1 axis';
        leg2.textContent = 'Output 2 axis';
      }
      scatter.style.cursor = mode === 'x' ? 'grab' : 'default';

      if (!animate || prefersReducedMotion()) {
        state.morphStage = state.targetStage;
        drawScatter(getPlayFraction());
        return;
      }
      if (!morphRaf) {
        const step = () => {
          const diff = state.targetStage - state.morphStage;
          if (Math.abs(diff) < 0.004) {
            state.morphStage = state.targetStage;
            morphRaf = null;
            drawScatter(getPlayFraction());
            return;
          }
          state.morphStage += diff * 0.14;
          drawScatter(getPlayFraction());
          morphRaf = requestAnimationFrame(step);
        };
        morphRaf = requestAnimationFrame(step);
      }
    }

    if (animateBtn) {
      animateBtn.addEventListener('click', () => {
        clearTimeout(autoSeqTimer);
        setScatterStage('x', false);
        autoSeqTimer = setTimeout(() => {
          setScatterStage('z', true);
          autoSeqTimer = setTimeout(() => setScatterStage('y', true), 950);
        }, 250);
      });
    }

    function pointerToCanvas(e) {
      const b = scatter.getBoundingClientRect();
      const r = Math.min(devicePixelRatio || 1, 2);
      return { x: (e.clientX - b.left) * r, y: (e.clientY - b.top) * r, r };
    }

    function setMixingValues(a, b) {
      state.a = Math.round(Math.max(0, Math.min(0.95, a)) * 100) / 100;
      state.b = Math.round(Math.max(0, Math.min(0.95, b)) * 100) / 100;
      lab.querySelector('#mix-a').value = String(Math.round(state.a * 100));
      lab.querySelector('#mix-b').value = String(Math.round(state.b * 100));
      lab.querySelector('#mix-a-v').textContent = state.a.toFixed(2);
      lab.querySelector('#mix-b-v').textContent = state.b.toFixed(2);
      recompute();
    }

    scatter.addEventListener('pointerdown', e => {
      if (state.scatter !== 'x') return;
      const pt = pointerToCanvas(e);
      const handles = getHandlePositions(scatter.width, scatter.height);
      let hit = null, bestD = 22 * pt.r;
      handles.forEach((hd, i) => {
        const d = Math.hypot(pt.x - hd.x, pt.y - hd.y);
        if (d < bestD) { bestD = d; hit = i; }
      });
      if (hit !== null) {
        draggingHandle = hit;
        scatter.setPointerCapture(e.pointerId);
        scatter.style.cursor = 'grabbing';
        drawScatter(getPlayFraction());
      }
    });

    scatter.addEventListener('pointermove', e => {
      if (state.scatter !== 'x') return;
      const pt = pointerToCanvas(e);
      if (draggingHandle !== null) {
        const dx = Math.max(0.05, pt.x - scatter.width / 2);
        const dy = Math.max(0.05, scatter.height / 2 - pt.y);
        if (draggingHandle === 0) setMixingValues(state.a, dy / dx);
        else setMixingValues(dx / dy, state.b);
        return;
      }
      const handles = getHandlePositions(scatter.width, scatter.height);
      let near = null;
      handles.forEach((hd, i) => {
        if (Math.hypot(pt.x - hd.x, pt.y - hd.y) < 18 * pt.r) near = i;
      });
      if (near !== hoverHandle) {
        hoverHandle = near;
        scatter.style.cursor = near !== null ? 'grab' : 'default';
        drawScatter(getPlayFraction());
      }
    });

    const endDrag = () => {
      if (draggingHandle !== null) {
        draggingHandle = null;
        scatter.style.cursor = hoverHandle !== null ? 'grab' : 'default';
        drawScatter(getPlayFraction());
      }
    };
    scatter.addEventListener('pointerup', endDrag);
    scatter.addEventListener('pointercancel', endDrag);
    scatter.addEventListener('pointerleave', () => {
      if (draggingHandle === null && hoverHandle !== null) {
        hoverHandle = null;
        drawScatter(getPlayFraction());
      }
    });

    /* --- Web Audio Playback --- */
    let audioCtx = null;
    let activeSource = null;
    let activeTrack = null;
    let playStartTime = 0;
    let playRaf = null;

    function getPlayFraction() {
      if (!activeTrack || !audioCtx) return null;
      const elapsed = audioCtx.currentTime - playStartTime;
      if (elapsed < 0 || elapsed > duration) return null;
      return elapsed / duration;
    }

    function stopAudio() {
      if (activeSource) {
        try { activeSource.onended = null; activeSource.stop(); } catch (_) {}
        activeSource = null;
      }
      if (activeTrack) {
        activeTrack.btn.setAttribute('aria-pressed', 'false');
        activeTrack.btn.setAttribute('aria-label', `Play ${activeTrack.name}`);
        activeTrack.btn.innerHTML = '<svg aria-hidden="true" class="icon"><use href="#i-play"></use></svg>';
        activeTrack = null;
      }
      if (playRaf) { cancelAnimationFrame(playRaf); playRaf = null; }
      document.body.classList.remove('audio-playing');
      renderCanvases(null);
    }

    function toggleAudio(track) {
      if (activeTrack === track) { stopAudio(); return; }
      stopAudio();
      const sig = getTrackSignal(track);
      if (!sig) return;

      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      if (!audioCtx) audioCtx = new AudioCtor();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const buf = audioCtx.createBuffer(1, N, fs);
      const ch = buf.getChannelData(0);
      let pk = 1e-6, sq = 0;
      for (let i = 0; i < N; i++) {
        const a = Math.abs(sig[i]);
        if (a > pk) pk = a;
        sq += sig[i] * sig[i];
      }
      const rms = Math.sqrt(sq / N) || 1;
      const gain = Math.min(0.82 / pk, (usingRealSpeech ? 0.16 : 0.12) / rms);
      const fade = Math.min(260, Math.floor(N * 0.015));
      for (let i = 0; i < N; i++) {
        let env = 1;
        if (i < fade) env = 0.5 * (1 - Math.cos((Math.PI * i) / fade));
        else if (i > N - fade) env = 0.5 * (1 - Math.cos((Math.PI * (N - i)) / fade));
        ch[i] = Math.max(-0.98, Math.min(0.98, sig[i] * gain * env));
      }

      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      activeSource = src;
      activeTrack = track;
      playStartTime = audioCtx.currentTime;

      track.btn.setAttribute('aria-pressed', 'true');
      track.btn.setAttribute('aria-label', `Stop ${track.name}`);
      track.btn.innerHTML = '<svg aria-hidden="true" class="icon"><use href="#i-stop"></use></svg>';
      document.body.classList.add('audio-playing');

      src.onended = () => { if (activeSource === src) stopAudio(); };
      src.start();

      const tickPlay = () => {
        const frac = getPlayFraction();
        if (frac === null) { stopAudio(); return; }
        renderCanvases(frac);
        playRaf = requestAnimationFrame(tickPlay);
      };
      playRaf = requestAnimationFrame(tickPlay);
    }

    lab.querySelectorAll('input[type=range]').forEach(input => {
      input.addEventListener('input', () => {
        state[input.dataset.k] = Number(input.value) / 100;
        lab.querySelector(`#${input.id}-v`).textContent = state[input.dataset.k].toFixed(2);
        recompute();
      });
    });

    lab.querySelectorAll('[data-scatter]').forEach(btn => {
      btn.addEventListener('click', () => {
        clearTimeout(autoSeqTimer);
        setScatterStage(btn.dataset.scatter, true);
      });
    });

    lab.querySelectorAll('[data-domain]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.domain = btn.dataset.domain;
        lab.querySelectorAll('[data-domain]').forEach(o => o.setAttribute('aria-pressed', String(o === btn)));
        renderCanvases(getPlayFraction());
      });
    });

    lab.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const [a, b] = btn.dataset.preset.split(',').map(Number);
        setMixingValues(a, b);
      });
    });

    lab.querySelector('#reset-signals').addEventListener('click', () => {
      clearTimeout(autoSeqTimer);
      stopAudio();
      setMixingValues(0.60, 0.45);
      setScatterStage('x', true);
    });

    new ResizeObserver(() => renderCanvases(getPlayFraction())).observe(lab);
    new MutationObserver(() => {
      updateColors();
      updateReadouts();
      renderCanvases(getPlayFraction());
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    updateColors();
    recompute();
    setScatterStage('x', false);

    // Load real human male & female counting speech WAVs asynchronously
    Promise.all([
      fetch('assets/voice1.wav').then(r => (r.ok ? r.arrayBuffer() : null)),
      fetch('assets/voice2.wav').then(r => (r.ok ? r.arrayBuffer() : null))
    ]).then(([b1, b2]) => {
      if (!b1 || !b2) return;
      const w1 = parseWavPCM(b1);
      const w2 = parseWavPCM(b2);
      if (!w1 || !w2) return;
      stopAudio();
      specCache = new WeakMap();
      setSources(w1.samples, w2.samples, w1.sr, true);
      recompute();
    }).catch(() => { /* Keep synthetic fallback gracefully if opened via file:// */ });
  })();

  /* =========================================================================
     4. FIG. 02 — PHYSICS-DRIVEN INTERACTIVE 3D ACCELEROMETER + LIVE 2D TRACES
        - Dragging or shaking the 3D sensor tilts & accelerates the sensor
        - Real-time body-frame physics: a_body = R^T * (g_world + a_linear)
        - True 220-sample streaming ring buffer so fast shakes spike instantly!
        - Live window cues & cue-driven illustrative posture classification
     ========================================================================= */
  (() => {
    const fig = document.querySelector('#sensor-figure');
    if (!fig) return;

    const c3d = fig.querySelector('#sensor-3d');
    const cTrace = fig.querySelector('#sensor-traces');
    if (!c3d || !cTrace) return;

    const postures = {
      walking: {
        label: 'Walking',
        eval(t) {
          const step = 2 * Math.PI * 1.85 * t;
          return {
            pitch: 0.14 + 0.17 * Math.sin(step),
            roll: 0.13 * Math.cos(step * 0.5),
            pos: [0.06 * Math.sin(step), 0.04 * Math.cos(step * 0.5), 0.11 * Math.sin(2 * step - 0.3)],
            linAcc: [
              0.24 * Math.sin(step + 0.4) + 0.08 * Math.sin(19 * t),
              0.16 * Math.cos(step * 0.5) + 0.06 * Math.sin(2 * step + 1.1),
              0.44 * Math.sin(2 * step - 0.3) + 0.15 * Math.cos(4 * step)
            ]
          };
        }
      },
      sitting: {
        label: 'Sitting',
        eval(t) {
          return {
            pitch: 0.64 + 0.025 * Math.sin(2.1 * t),
            roll: 0.04 + 0.02 * Math.cos(1.7 * t),
            pos: [0, 0, 0],
            linAcc: [0.025 * Math.sin(11 * t), 0.02 * Math.cos(13 * t), 0.025 * Math.sin(9 * t)]
          };
        }
      },
      standing: {
        label: 'Standing',
        eval(t) {
          return {
            pitch: 0.07 + 0.02 * Math.sin(1.7 * t),
            roll: -0.02 + 0.018 * Math.cos(1.4 * t),
            pos: [0, 0, 0],
            linAcc: [0.02 * Math.sin(12 * t), 0.018 * Math.cos(15 * t), 0.022 * Math.sin(17 * t)]
          };
        }
      },
      lying: {
        label: 'Lying',
        eval(t) {
          return {
            pitch: 1.50 + 0.015 * Math.sin(1.4 * t),
            roll: 0.06 + 0.012 * Math.cos(1.2 * t),
            pos: [0, 0, 0],
            linAcc: [0.015 * Math.sin(10 * t), 0.014 * Math.cos(14 * t), 0.015 * Math.sin(12 * t)]
          };
        }
      }
    };

    // 3D rotations (X = forward, Y = left, Z = up; +pitch tilts +X upward so a_x = +sin(pitch)g)
    function rotX(p, a) {
      const c = Math.cos(a), s = Math.sin(a);
      return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
    }
    function rotY(p, a) {
      const c = Math.cos(a), s = Math.sin(a);
      return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
    }
    function rotZ(p, a) {
      const c = Math.cos(a), s = Math.sin(a);
      return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
    }
    function sensorToWorld(v, pitch, roll) {
      return rotY(rotX(v, roll), -pitch);
    }
    function worldToSensor(w, pitch, roll) {
      return rotX(rotY(w, pitch), -roll);
    }

    const BUF_LEN = 220;
    const histX = new Float32Array(BUF_LEN);
    const histY = new Float32Array(BUF_LEN);
    const histZ = new Float32Array(BUF_LEN);

    const sState = {
      mode: 'walking', // 'walking' | 'sitting' | 'standing' | 'lying' | 'freehand'
      axis: 'all',
      playing: !prefersReducedMotion(),
      t: 0,
      pitch: 0.14,
      roll: 0.0,
      targetPitch: 0.14,
      targetRoll: 0.0,
      // Physical 3D spring-mass offset for live dragging & shaking!
      pos: [0, 0, 0],
      vel: [0, 0, 0],
      dragOffset: [0, 0, 0],
      shakeAcc: [0, 0, 0], // world-frame linear shake acceleration (in g)
      isDragging: false,
      lastPtr: null,
      lastVel: [0, 0],
      camYaw: -0.58,
      camPitch: 0.34,
      winPos: 0.72,   // placed near right edge so live shakes register immediately!
      winWidth: 0.24,
      probs: { walking: 0.93, sitting: 0.03, standing: 0.03, lying: 0.01 },
      topClass: 'walking'
    };

    const valX = fig.querySelector('#val-x');
    const valY = fig.querySelector('#val-y');
    const valZ = fig.querySelector('#val-z');
    const traceCap = fig.querySelector('#trace-caption');
    const postureLbl = fig.querySelector('#posture-label');
    const axisNote = fig.querySelector('#axis-note');
    const playBtn = fig.querySelector('#sensor-play');
    const cueTilt = fig.querySelector('#cue-tilt');
    const cueTiltV = fig.querySelector('#cue-tilt-v');
    const cueEnergy = fig.querySelector('#cue-energy');
    const cueEnergyV = fig.querySelector('#cue-energy-v');
    const sensorBadge = fig.querySelector('#sensor-mode-badge');

    let pal = {};
    let visible = true;
    let rafId = null;

    function loadPal() {
      const dark = document.documentElement.dataset.theme === 'dark';
      pal = {
        dark,
        x: cssVar('--source-1'),
        y: cssVar('--source-2'),
        z: cssVar('--source-3'),
        accent: cssVar('--accent'),
        accentSoft: cssVar('--accent-soft'),
        bg: cssVar('--bg'),
        surface: cssVar('--surface'),
        soft: cssVar('--soft'),
        text: cssVar('--text'),
        muted: cssVar('--muted'),
        line: cssVar('--line'),
        grid: cssVar('--grid')
      };
    }

    function sizeCanvas(c) {
      const r = Math.min(devicePixelRatio || 1, 2);
      const b = c.getBoundingClientRect();
      const nw = Math.max(1, Math.round(b.width * r));
      const nh = Math.max(1, Math.round(b.height * r));
      if (c.width !== nw || c.height !== nh) { c.width = nw; c.height = nh; }
      return r;
    }

    function pushSample(ax, ay, az) {
      histX.copyWithin(0, 1);
      histY.copyWithin(0, 1);
      histZ.copyWithin(0, 1);
      histX[BUF_LEN - 1] = ax;
      histY[BUF_LEN - 1] = ay;
      histZ[BUF_LEN - 1] = az;
    }

    function prefillPreset(key) {
      const p = postures[key];
      if (!p) return;
      const dt = 0.018;
      for (let i = 0; i < BUF_LEN; i++) {
        const ts = sState.t - (BUF_LEN - 1 - i) * dt;
        const st = p.eval(ts);
        const aWorld = [st.linAcc[0], st.linAcc[1], 1.0 + st.linAcc[2]];
        const aBody = worldToSensor(aWorld, st.pitch, st.roll);
        histX[i] = aBody[0];
        histY[i] = aBody[1];
        histZ[i] = aBody[2];
      }
      const now = p.eval(sState.t);
      sState.pitch = now.pitch;
      sState.roll = now.roll;
      sState.targetPitch = now.pitch;
      sState.targetRoll = now.roll;
    }

    // Step rigid-body physics once per frame and emit true instantaneous (a_x, a_y, a_z)
    function stepPhysics() {
      let linWorld = [0, 0, 0];

      if (sState.mode !== 'freehand' && !sState.isDragging) {
        const st = postures[sState.mode].eval(sState.t);
        sState.pitch += (st.pitch - sState.pitch) * 0.16;
        sState.roll += (st.roll - sState.roll) * 0.16;
        for (let k = 0; k < 3; k++) {
          sState.pos[k] += (st.pos[k] - sState.pos[k]) * 0.22;
          sState.vel[k] *= 0.7;
          sState.shakeAcc[k] *= 0.72;
          linWorld[k] = st.linAcc[k] + sState.shakeAcc[k];
        }
      } else {
        // Freehand interactive accelerometer physics: smooth tilt + spring-damper 3D displacement + inertial shake
        sState.pitch += (sState.targetPitch - sState.pitch) * 0.28;
        sState.roll += (sState.targetRoll - sState.roll) * 0.28;

        const springK = sState.isDragging ? 0.30 : 0.14;
        const damp = sState.isDragging ? 0.68 : 0.78;
        for (let k = 0; k < 3; k++) {
          const target = sState.isDragging ? sState.dragOffset[k] : 0;
          const force = (target - sState.pos[k]) * springK;
          sState.vel[k] = (sState.vel[k] + force) * damp;
          sState.pos[k] += sState.vel[k];
          if (!sState.isDragging) sState.dragOffset[k] *= 0.82;
          // Decay explicit whip impulse smoothly; add spring recoil acceleration
          sState.shakeAcc[k] *= sState.isDragging ? 0.72 : 0.80;
          const recoil = force * 5.2;
          // Tiny realistic MEMS sensor thermal noise (~0.012g)
          const micro = 0.012 * Math.sin(sState.t * (17 + k * 7) + k * 2.1);
          linWorld[k] = Math.max(-2.6, Math.min(2.6, sState.shakeAcc[k] + recoil + micro));
        }
      }

      // Proper acceleration in sensor body frame: a_body = R^T * (g_up + a_linear)
      const aWorld = [linWorld[0], linWorld[1], 1.0 + linWorld[2]];
      const aBody = worldToSensor(aWorld, sState.pitch, sState.roll);
      pushSample(aBody[0], aBody[1], aBody[2]);
    }

    function project3D(pt, cx, cy, scale) {
      let p = rotZ(pt, sState.camYaw);
      p = rotX([p[0], p[2], -p[1]], sState.camPitch);
      const dist = 5.4;
      const persp = dist / (dist - p[2] * 0.45);
      return [cx + p[0] * scale * persp, cy - p[1] * scale * persp, p[2]];
    }

    function drawArrow3D(ctx, p0, p1, color, r, width, label, dashed = false, alpha = 1, labelOffset = null) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width * r;
      if (dashed) ctx.setLineDash([3.5 * r, 3 * r]);
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
      ctx.setLineDash([]);

      const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      const head = 6.2 * r;
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p1[0] - head * Math.cos(ang - 0.44), p1[1] - head * Math.sin(ang - 0.44));
      ctx.lineTo(p1[0] - head * Math.cos(ang + 0.44), p1[1] - head * Math.sin(ang + 0.44));
      ctx.closePath();
      ctx.fill();

      if (label) {
        ctx.font = `600 ${Math.round(10.5 * r)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lx = labelOffset ? p1[0] + labelOffset[0] * r : p1[0] + Math.cos(ang) * 10 * r;
        const ly = labelOffset ? p1[1] + labelOffset[1] * r : p1[1] + Math.sin(ang) * 10 * r;
        ctx.fillText(label, lx, ly);
      }
      ctx.restore();
    }

    function draw3DSensor() {
      const r = sizeCanvas(c3d);
      const ctx = c3d.getContext('2d');
      const w = c3d.width, h = c3d.height;
      ctx.clearRect(0, 0, w, h);

      const cx = w * 0.5;
      const cy = h * 0.52;
      const scale = Math.min(w, h) * 0.245;

      const toWorld = v => {
        const p = sensorToWorld(v, sState.pitch, sState.roll);
        return [p[0] + sState.pos[0], p[1] + sState.pos[1], p[2] + sState.pos[2]];
      };

      // World gravity direction (pointing downward -Z)
      const oW = toWorld([0, 0, 0]);
      const oP = project3D(oW, cx, cy, scale);
      const gEnd = project3D([oW[0], oW[1], oW[2] - 1.48], cx, cy, scale);
      drawArrow3D(ctx, oP, gEnd, pal.muted, r, 1.35, 'g', true, 0.72, [-11, -2]);

      // Dynamic shake vector indicator when moving fast!
      const shakeMag = Math.hypot(sState.shakeAcc[0], sState.shakeAcc[1], sState.shakeAcc[2]);
      if (shakeMag > 0.18) {
        const sc = Math.min(1.5, shakeMag * 0.85) / shakeMag;
        const aEnd = project3D([
          oW[0] + sState.shakeAcc[0] * sc,
          oW[1] + sState.shakeAcc[1] * sc,
          oW[2] + sState.shakeAcc[2] * sc
        ], cx, cy, scale);
        drawArrow3D(ctx, oP, aEnd, pal.accent, r, 2.0, 'a', false, Math.min(0.95, shakeMag * 0.65));
      }

      // 3D accelerometer housing
      const bx = 0.52, by = 0.38, bz = 0.14;
      const rawVerts = [
        [-bx, -by, -bz], [bx, -by, -bz], [bx, by, -bz], [-bx, by, -bz],
        [-bx, -by, bz], [bx, -by, bz], [bx, by, bz], [-bx, by, bz]
      ];
      const proj = rawVerts.map(v => project3D(toWorld(v), cx, cy, scale));
      const faces = [
        { idx: [0, 3, 2, 1] },
        { idx: [4, 5, 6, 7], top: true },
        { idx: [0, 1, 5, 4] },
        { idx: [2, 3, 7, 6] },
        { idx: [1, 2, 6, 5] },
        { idx: [3, 0, 4, 7] }
      ];
      faces.forEach(f => { f.depth = f.idx.reduce((acc, id) => acc + proj[id][2], 0) / 4; });
      faces.sort((a, b) => a.depth - b.depth);

      faces.forEach(f => {
        ctx.beginPath();
        f.idx.forEach((id, k) => (k === 0 ? ctx.moveTo(proj[id][0], proj[id][1]) : ctx.lineTo(proj[id][0], proj[id][1])));
        ctx.closePath();
        ctx.fillStyle = f.top ? pal.surface : pal.soft;
        ctx.globalAlpha = f.top ? 0.96 : 0.88;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = sState.isDragging ? pal.accent : pal.line;
        ctx.lineWidth = r * (sState.isDragging ? 1.45 : 1.15);
        ctx.stroke();

        if (f.top) {
          const ic = [[-0.22, -0.18, bz + 0.01], [0.22, -0.18, bz + 0.01], [0.22, 0.18, bz + 0.01], [-0.22, 0.18, bz + 0.01]]
            .map(v => project3D(toWorld(v), cx, cy, scale));
          ctx.beginPath();
          ic.forEach((p, k) => (k === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
          ctx.closePath();
          ctx.fillStyle = pal.accentSoft;
          ctx.fill();
          ctx.strokeStyle = pal.accent;
          ctx.globalAlpha = 0.6;
          ctx.lineWidth = r * 0.9;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });

      // Local body axes (x, y, z)
      [
        { key: 'x', vec: [1.34, 0, 0], color: pal.x },
        { key: 'y', vec: [0, 1.28, 0], color: pal.y },
        { key: 'z', vec: [0, 0, 1.28], color: pal.z }
      ].forEach(ax => {
        const end = project3D(toWorld(ax.vec), cx, cy, scale);
        const hi = sState.axis === 'all' || sState.axis === ax.key;
        drawArrow3D(ctx, oP, end, ax.color, r, hi ? 2.1 : 1.1, ax.key, false, hi ? 0.98 : 0.22);
      });

      ctx.fillStyle = pal.text;
      ctx.beginPath();
      ctx.arc(oP[0], oP[1], 3.2 * r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Unified cue-based illustrative classifier (reacts genuinely to user shaking & tilting!)
    function computeIllustrativeProbs(tiltDeg, acRms) {
      const motion = Math.max(0, Math.min(1, (acRms - 0.09) / 0.17));
      const still = 1 - motion;
      const gStand = Math.exp(-0.5 * Math.pow((tiltDeg - 6) / 14, 2));
      const gSit = Math.exp(-0.5 * Math.pow((tiltDeg - 38) / 16, 2));
      const gLie = Math.exp(-0.5 * Math.pow((Math.min(tiltDeg, 180 - tiltDeg) - 88) / 18, 2));

      const raw = {
        walking: 0.04 + 5.2 * motion,
        standing: 0.04 + 4.4 * still * gStand,
        sitting: 0.04 + 4.4 * still * gSit,
        lying: 0.04 + 4.8 * still * gLie
      };
      const total = raw.walking + raw.standing + raw.sitting + raw.lying;
      return {
        walking: raw.walking / total,
        sitting: raw.sitting / total,
        standing: raw.standing / total,
        lying: raw.lying / total
      };
    }

    function drawTracesAndCues() {
      const r = sizeCanvas(cTrace);
      const ctx = cTrace.getContext('2d');
      const w = cTrace.width, h = cTrace.height;
      ctx.clearRect(0, 0, w, h);

      const padL = 24 * r, padR = 8 * r, padT = 8 * r, padB = 8 * r;
      const plotW = w - padL - padR;
      const laneH = (h - padT - padB) / 3;

      const wx0 = padL + sState.winPos * plotW;
      const wxW = sState.winWidth * plotW;

      ctx.save();
      ctx.fillStyle = pal.accentSoft;
      ctx.globalAlpha = pal.dark ? 0.55 : 0.72;
      ctx.fillRect(wx0, padT - 2 * r, wxW, h - padT - padB + 4 * r);
      ctx.strokeStyle = pal.accent;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = r * 1.25;
      ctx.strokeRect(wx0, padT - 2 * r, wxW, h - padT - padB + 4 * r);
      ctx.fillStyle = pal.accent;
      ctx.globalAlpha = 0.95;
      ctx.font = `600 ${Math.round(8.5 * r)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('WINDOW', wx0 + wxW / 2, padT + 1 * r);
      ctx.restore();

      const series = [histX, histY, histZ];
      const axMeta = [
        { key: 'x', color: pal.x },
        { key: 'y', color: pal.y },
        { key: 'z', color: pal.z }
      ];

      axMeta.forEach((ax, idx) => {
        const top = padT + idx * laneH;
        const mid = top + laneH * 0.56;
        const amp = laneH * 0.36;
        const active = sState.axis === 'all' || sState.axis === ax.key;

        ctx.strokeStyle = pal.grid;
        ctx.lineWidth = r * 0.8;
        ctx.beginPath();
        ctx.moveTo(padL, mid);
        ctx.lineTo(w - padR, mid);
        ctx.stroke();

        ctx.fillStyle = ax.color;
        ctx.globalAlpha = active ? 1 : 0.28;
        ctx.font = `600 ${Math.round(11 * r)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(ax.key, 4 * r, mid);

        ctx.strokeStyle = ax.color;
        ctx.lineWidth = r * (active ? 1.85 : 1.15);
        ctx.globalAlpha = active ? 0.95 : 0.18;
        ctx.beginPath();
        const arr = series[idx];
        for (let i = 0; i < BUF_LEN; i++) {
          const px = padL + (i / (BUF_LEN - 1)) * plotW;
          const clamped = Math.max(-2.3, Math.min(2.3, arr[i]));
          const py = mid - clamped * (amp / 1.9);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      });

      const last = BUF_LEN - 1;
      const fmtG = v => (v >= 0 ? '+' : '') + v.toFixed(2);
      if (valX) valX.textContent = fmtG(histX[last]);
      if (valY) valY.textContent = fmtG(histY[last]);
      if (valZ) valZ.textContent = fmtG(histZ[last]);

      // Extract true stats from the samples currently inside WINDOW
      const i0 = Math.max(0, Math.floor(sState.winPos * (BUF_LEN - 1)));
      const i1 = Math.min(BUF_LEN - 1, Math.ceil((sState.winPos + sState.winWidth) * (BUF_LEN - 1)));
      const wn = Math.max(1, i1 - i0 + 1);
      let mx = 0, my = 0, mz = 0;
      for (let i = i0; i <= i1; i++) { mx += histX[i]; my += histY[i]; mz += histZ[i]; }
      mx /= wn; my /= wn; mz /= wn;

      const gMag = Math.hypot(mx, my, mz) || 1;
      const tiltDeg = Math.round((Math.acos(Math.max(-1, Math.min(1, mz / gMag))) * 180) / Math.PI);
      let acVar = 0;
      for (let i = i0; i <= i1; i++) {
        const dx = histX[i] - mx, dy = histY[i] - my, dz = histZ[i] - mz;
        acVar += dx * dx + dy * dy + dz * dz;
      }
      const acRms = Math.sqrt(acVar / (3 * wn));
      const energyPct = Math.min(100, Math.round((acRms / 0.42) * 100));

      if (cueTilt) cueTilt.style.width = `${Math.min(100, Math.round((tiltDeg / 110) * 100))}%`;
      if (cueTiltV) cueTiltV.textContent = `${tiltDeg}°`;
      if (cueEnergy) cueEnergy.style.width = `${Math.max(4, energyPct)}%`;
      if (cueEnergyV) cueEnergyV.textContent = energyPct > 48 ? 'High' : energyPct > 18 ? 'Mod' : 'Low';

      const targetProbs = computeIllustrativeProbs(tiltDeg, acRms);
      let topKey = 'walking', topVal = -1;
      Object.keys(sState.probs).forEach(key => {
        sState.probs[key] += (targetProbs[key] - sState.probs[key]) * 0.2;
        if (sState.probs[key] > topVal) { topVal = sState.probs[key]; topKey = key; }
      });
      sState.topClass = topKey;
      if (postureLbl) postureLbl.textContent = postures[topKey].label;

      Object.keys(sState.probs).forEach(key => {
        const item = fig.querySelector(`.prob-item[data-prob="${key}"]`);
        if (item) {
          const pct = Math.round(sState.probs[key] * 100);
          item.classList.toggle('is-top', key === topKey);
          item.querySelector('.prob-bar span').style.width = `${pct}%`;
          item.querySelector('output').textContent = `${pct}%`;
        }
      });
    }

    function tick() {
      if (!visible) { rafId = null; return; }
      if (sState.playing) {
        sState.t += 0.018;
        stepPhysics();
      }
      draw3DSensor();
      drawTracesAndCues();
      rafId = requestAnimationFrame(tick);
    }

    function ensureLoop() {
      if (!rafId && visible) rafId = requestAnimationFrame(tick);
    }

    function setMode(mode, resetBuffer = false) {
      sState.mode = mode;
      fig.querySelectorAll('[data-posture]').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.posture === mode));
      });
      if (sensorBadge) {
        sensorBadge.textContent = mode === 'freehand' ? 'Live hand control' : 'Drag & shake me';
        sensorBadge.classList.toggle('is-live', mode === 'freehand');
      }
      if (resetBuffer && mode !== 'freehand') {
        sState.shakeAcc = [0, 0, 0];
        sState.pos = [0, 0, 0];
        sState.vel = [0, 0, 0];
        prefillPreset(mode);
      }
      updateMeta();
      ensureLoop();
    }

    // Grab, tilt, and shake the actual 3D accelerometer!
    c3d.style.cursor = 'grab';
    c3d.addEventListener('pointerdown', e => {
      sState.isDragging = true;
      if (!sState.playing) {
        sState.playing = true;
        syncPlayBtn();
      }
      if (sState.mode !== 'freehand') {
        sState.targetPitch = sState.pitch;
        sState.targetRoll = sState.roll;
        setMode('freehand', false);
      }
      sState.lastPtr = { x: e.clientX, y: e.clientY, t: performance.now() };
      sState.lastVel = [0, 0];
      c3d.setPointerCapture(e.pointerId);
      c3d.style.cursor = 'grabbing';
      ensureLoop();
    });

    c3d.addEventListener('pointermove', e => {
      if (!sState.isDragging || !sState.lastPtr) return;
      const now = performance.now();
      const dt = Math.max(0.008, Math.min(0.06, (now - sState.lastPtr.t) / 1000));
      const dx = e.clientX - sState.lastPtr.x;
      const dy = e.clientY - sState.lastPtr.y;

      // Smoothly tilt sensor orientation with drag
      sState.targetPitch = Math.max(-Math.PI, Math.min(Math.PI, sState.targetPitch - dy * 0.014));
      sState.targetRoll = Math.max(-Math.PI, Math.min(Math.PI, sState.targetRoll + dx * 0.014));

      // Physical 3D translation tug (clamped smoothly inside viewport)
      sState.dragOffset[0] = Math.max(-0.46, Math.min(0.46, sState.dragOffset[0] + dx * 0.0065));
      sState.dragOffset[1] = Math.max(-0.46, Math.min(0.46, sState.dragOffset[1] - dx * 0.0045));
      sState.dragOffset[2] = Math.max(-0.46, Math.min(0.46, sState.dragOffset[2] - dy * 0.0075));

      // Compute instantaneous velocity & acceleration for rapid shake spikes!
      const vx = dx / dt; // px/s
      const vy = dy / dt;
      const axPx = (vx - sState.lastVel[0]) / dt;
      const ayPx = (vy - sState.lastVel[1]) / dt;

      // Map rapid screen movement & reversals into physically responsive world g-force spikes
      const spdScale = 0.00135;
      const accScale = 0.000055;
      const impX = vx * spdScale * 0.65 + axPx * accScale;
      const impY = -vx * spdScale * 0.45 - axPx * accScale * 0.6;
      const impZ = -vy * spdScale * 0.78 - ayPx * accScale;

      sState.shakeAcc[0] = Math.max(-2.6, Math.min(2.6, sState.shakeAcc[0] * 0.45 + impX));
      sState.shakeAcc[1] = Math.max(-2.6, Math.min(2.6, sState.shakeAcc[1] * 0.45 + impY));
      sState.shakeAcc[2] = Math.max(-2.6, Math.min(2.6, sState.shakeAcc[2] * 0.45 + impZ));

      sState.lastVel = [vx * 0.6 + sState.lastVel[0] * 0.4, vy * 0.6 + sState.lastVel[1] * 0.4];
      sState.lastPtr = { x: e.clientX, y: e.clientY, t: now };
    });

    const endSensorDrag = () => {
      if (!sState.isDragging) return;
      sState.isDragging = false;
      sState.lastPtr = null;
      c3d.style.cursor = 'grab';
    };
    c3d.addEventListener('pointerup', endSensorDrag);
    c3d.addEventListener('pointercancel', endSensorDrag);
    c3d.addEventListener('dblclick', () => setMode('walking', true));

    // Drag sliding window horizontally across traces
    let dragWin = false;
    cTrace.style.cursor = 'ew-resize';
    function moveWindowFromEvent(e) {
      const b = cTrace.getBoundingClientRect();
      const frac = (e.clientX - b.left - 24) / Math.max(1, b.width - 32);
      sState.winPos = Math.max(0.02, Math.min(1 - sState.winWidth - 0.02, frac - sState.winWidth / 2));
      drawTracesAndCues();
    }
    cTrace.addEventListener('pointerdown', e => {
      dragWin = true;
      cTrace.setPointerCapture(e.pointerId);
      moveWindowFromEvent(e);
    });
    cTrace.addEventListener('pointermove', e => { if (dragWin) moveWindowFromEvent(e); });
    cTrace.addEventListener('pointerup', () => { dragWin = false; });
    cTrace.addEventListener('pointercancel', () => { dragWin = false; });

    function updateMeta() {
      const name = sState.mode === 'freehand' ? 'Live manual motion' : postures[sState.mode].label;
      if (traceCap) traceCap.textContent = `Illustrative 3-axis stream · ${name} · sliding window`;
      if (axisNote) {
        if (sState.mode === 'freehand') {
          axisNote.textContent = 'Interactive hand control: tilt slowly to see gravity shift across x, y, z, or shake rapidly to trigger dynamic acceleration spikes in real time. Double-click the sensor or pick a preset to reset.';
        } else if (sState.axis === 'all') {
          axisNote.textContent = `Showing illustrative ${name.toLowerCase()} acceleration and gravity tilt. Grab and tilt or shake the 3D sensor to drive the graphs live. This sketch explains the pipeline; it does not show experimental thesis recordings.`;
        } else {
          axisNote.textContent = `Highlighting the ${sState.axis}-axis for ${name.toLowerCase()} across both the 3D sensor and live time series. The 1D-CNN uses all three axes together; these signals are illustrative.`;
        }
      }
    }

    function syncPlayBtn() {
      if (!playBtn) return;
      playBtn.setAttribute('aria-pressed', String(sState.playing));
      playBtn.setAttribute('aria-label', sState.playing ? 'Pause streaming sensor' : 'Resume streaming sensor');
      playBtn.innerHTML = sState.playing
        ? '<svg aria-hidden="true" class="icon"><use href="#i-pause"></use></svg>'
        : '<svg aria-hidden="true" class="icon"><use href="#i-play"></use></svg>';
    }

    if (playBtn) {
      playBtn.addEventListener('click', () => {
        sState.playing = !sState.playing;
        syncPlayBtn();
        ensureLoop();
      });
    }

    fig.querySelectorAll('[data-axis]').forEach(btn => {
      btn.addEventListener('click', () => {
        sState.axis = btn.dataset.axis;
        fig.querySelectorAll('[data-axis]').forEach(o => o.setAttribute('aria-pressed', String(o === btn)));
        updateMeta();
        draw3DSensor();
        drawTracesAndCues();
      });
    });

    fig.querySelectorAll('[data-posture]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.posture;
        if (target === 'freehand') {
          sState.targetPitch = sState.pitch;
          sState.targetRoll = sState.roll;
          setMode('freehand', false);
        } else {
          setMode(target, false);
        }
      });
    });

    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) ensureLoop();
    }, { threshold: 0.01 }).observe(fig);
    new ResizeObserver(() => { draw3DSensor(); drawTracesAndCues(); }).observe(fig);
    new MutationObserver(() => { loadPal(); draw3DSensor(); drawTracesAndCues(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    loadPal();
    prefillPreset('walking');
    syncPlayBtn();
    updateMeta();
    draw3DSensor();
    drawTracesAndCues();
    ensureLoop();
  })();
})();
