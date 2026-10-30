(() => {
  'use strict';
  const lab = document.querySelector('#signal-lab');
  if (!lab) return;

  const sampleCount = 256;
  const components = [[[6, 1], [12, .35]], [[11, .75], [22, .25]], [[17, .8], [34, .2]]];
  const mixing = [[1, .65, .32], [.35, .85, 1]];
  const active = [true, true, true];
  const sourceCanvases = [0, 1, 2].map(i => document.querySelector(`#source-${i}`));
  const mixtureCanvases = [0, 1].map(i => document.querySelector(`#mixture-${i}`));
  const canvases = [...sourceCanvases, ...mixtureCanvases];
  const contexts = canvases.map(canvas => canvas.getContext('2d'));
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = motionQuery.matches;
  let view = 'time';
  let level = 1;
  let phase = 0;
  let visible = false;
  let lastTime = 0;
  let frameId = null;
  let sources, mixtures, spectra;
  let colors = {};
  const pauseButton = document.querySelector('#motion-toggle');

  function updateColors() {
    const css = getComputedStyle(document.documentElement);
    const value = name => css.getPropertyValue(name).trim();
    colors = {source: [1, 2, 3].map(i => value(`--source-${i}`)), text: value('--text'), muted: value('--muted'), line: value('--line')};
  }

  function sampleSources(offset) {
    return components.map((partials, source) => Array.from({length: sampleCount}, (_, n) => {
      if (!active[source]) return 0;
      const t = n / sampleCount + offset;
      const gain = source === 1 ? level : 1;
      return gain * partials.reduce((sum, [frequency, amplitude]) => sum + amplitude * Math.sin(2 * Math.PI * frequency * t), 0);
    }));
  }

  function getMixtures(input) {
    return mixing.map(row => Array.from({length: sampleCount}, (_, n) => row.reduce((sum, weight, i) => sum + weight * input[i][n], 0)));
  }

  function spectrum(samples) {
    return Array.from({length: 41}, (_, k) => {
      let real = 0, imaginary = 0;
      samples.forEach((v, n) => {
        const angle = 2 * Math.PI * k * n / sampleCount;
        real += v * Math.cos(angle);
        imaginary -= v * Math.sin(angle);
      });
      return (k === 0 ? 1 : 2) * Math.hypot(real, imaginary) / sampleCount;
    });
  }

  function updateData(withSpectrum = false) {
    sources = sampleSources(phase);
    mixtures = getMixtures(sources);
    if (withSpectrum) spectra = [...sources, ...mixtures].map(spectrum);
    mixtures.forEach((samples, i) => {
      const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / sampleCount);
      const output = document.querySelector(`#rms-${i}`);
      const label = `RMS ${rms.toFixed(2)}`;
      if (output.textContent !== label) output.textContent = label;
    });
  }

  function resizeCanvases() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvases.forEach(canvas => {
      const box = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(box.width * ratio));
      canvas.height = Math.max(1, Math.round(box.height * ratio));
    });
  }

  function plot(canvas, ctx, data, color) {
    if (!ctx) return;
    const width = canvas.width, height = canvas.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pad = 2 * ratio;
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = .65 * ratio;
    ctx.beginPath();
    const baseline = view === 'frequency' ? height - pad : height / 2;
    ctx.moveTo(0, baseline); ctx.lineTo(width, baseline); ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25 * ratio;
    if (view === 'frequency') {
      const scale = (height - 7 * ratio) / 1.5;
      data.forEach((amplitude, k) => {
        if (amplitude < .002) return;
        const x = pad + k / 40 * (width - 2 * pad);
        ctx.beginPath(); ctx.moveTo(x, baseline); ctx.lineTo(x, baseline - amplitude * scale); ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, baseline - amplitude * scale, 1.7 * ratio, 0, 2 * Math.PI); ctx.fill();
      });
    } else {
      const scale = (height - 8 * ratio) / 5;
      ctx.beginPath();
      data.forEach((v, n) => {
        const x = n / (sampleCount - 1) * width;
        const y = height / 2 - v * scale;
        if (!n) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  function draw() {
    const data = view === 'frequency' ? spectra : [...sources, ...mixtures];
    canvases.forEach((canvas, i) => plot(canvas, contexts[i], data[i], i < 3 ? colors.source[i] : colors.text));
  }

  function canAnimate() { return !paused && visible && !document.hidden && view === 'time'; }
  function frame(time) {
    frameId = null;
    if (!canAnimate()) { lastTime = 0; return; }
    if (lastTime && time - lastTime < 32) { frameId = requestAnimationFrame(frame); return; }
    const delta = lastTime ? Math.min((time - lastTime) / 1000, .1) : 0;
    lastTime = time;
    phase = (phase + delta * .08) % 60;
    updateData(); draw();
    frameId = requestAnimationFrame(frame);
  }
  function syncAnimation() {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null; lastTime = 0;
    if (canAnimate()) frameId = requestAnimationFrame(frame);
  }
  function updatePauseButton() {
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.setAttribute('aria-label', paused ? 'Resume waveform animation' : 'Pause waveform animation');
    pauseButton.querySelector('.motion-label').textContent = paused ? 'Play' : 'Pause';
    pauseButton.querySelector('.motion-symbol').textContent = paused ? '▷' : 'Ⅱ';
  }
  function updateSources() {
    document.querySelectorAll('[data-source]').forEach(button => {
      const i = Number(button.dataset.source);
      button.setAttribute('aria-pressed', String(active[i]));
      button.querySelector('.source-state').textContent = active[i] ? 'on' : 'off';
      document.querySelector(`[data-source-row='${i}']`).dataset.muted = String(!active[i]);
      document.querySelector(`[data-wire='${i}']`).style.opacity = active[i] ? '.4' : '.06';
    });
    const count = active.filter((value, i) => value && (i !== 1 || level > 0)).length;
    document.querySelector('#source-count').textContent = count === 0 ? 'All sources silent' : `${count} source${count === 1 ? '' : 's'} active`;
    updateData(true); draw();
  }

  document.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => {
    const i = Number(button.dataset.source); active[i] = !active[i]; updateSources();
  }));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    document.querySelector('#plot-axis-label').textContent = view === 'time' ? 'Time: 0–1 s · Shared amplitude scale' : 'Frequency: 0–40 Hz · One-sided magnitude';
    canvases.forEach((canvas, i) => canvas.setAttribute('aria-label', `${i < 3 ? 'Synthetic source ' + (i + 1) : 'Microphone mixture ' + (i - 2)} ${view === 'time' ? 'waveform' : 'magnitude spectrum'}`));
    updateData(true); draw(); syncAnimation();
  }));
  document.querySelector('#source-level').addEventListener('input', event => {
    level = Number(event.target.value) / 100;
    document.querySelector('#level-value').textContent = `${event.target.value}%`;
    updateSources();
  });
  document.querySelector('#reset-signals').addEventListener('click', () => {
    active.fill(true); level = 1; phase = 0;
    document.querySelector('#source-level').value = '100';
    document.querySelector('#level-value').textContent = '100%';
    updateSources();
  });
  pauseButton.addEventListener('click', () => { paused = !paused; updatePauseButton(); syncAnimation(); });
  motionQuery.addEventListener('change', event => { paused = event.matches; updatePauseButton(); syncAnimation(); });
  document.addEventListener('visibilitychange', syncAnimation);
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; syncAnimation(); }, {threshold: .1}).observe(lab);
  new ResizeObserver(() => { resizeCanvases(); draw(); }).observe(lab);
  new MutationObserver(() => { updateColors(); draw(); }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});

  updateColors(); updateData(true); resizeCanvases(); draw(); updatePauseButton();

  // Deterministic synthetic accelerometer traces, for illustration only.
  ['x', 'y', 'z'].forEach((axis, i) => {
    const path = Array.from({length: 181}, (_, n) => {
      const t = n / 180;
      const envelope = .3 + .7 * Math.pow(Math.sin(Math.PI * t), 2);
      const signal = envelope * (Math.sin((8 + i * 3) * Math.PI * t + i) + .28 * Math.sin(47 * Math.PI * t + i));
      return `${n === 0 ? 'M' : 'L'}${(t * 360).toFixed(1)},${(22 - signal * 13).toFixed(1)}`;
    }).join(' ');
    document.querySelector(`#accel-${axis}`).setAttribute('d', path);
  });
  document.querySelectorAll('[data-axis]').forEach(button => button.addEventListener('click', () => {
    const axis = button.dataset.axis;
    document.querySelectorAll('[data-axis]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    document.querySelectorAll('[data-sensor-axis]').forEach(trace => { trace.style.opacity = axis === 'all' || trace.dataset.sensorAxis === axis ? '1' : '.16'; });
    document.querySelector('#axis-note').textContent = axis === 'all'
      ? 'Highlight an axis to follow its trace. This sketch explains the pipeline; it does not show experimental data or a model prediction.'
      : `The ${axis}-axis trace is highlighted. The classifier uses the three axes together; these signals are illustrative.`;
  }));
})();
