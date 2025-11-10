(() => {
  const WIDTH = 1280; // 16:9 720p
  const HEIGHT = 720;
  const FPS = 60;
  const DURATION_SEC = 20; // total duration

  const state = {
    chunks: [],
    recorder: null,
    recording: false,
    startTime: 0,
  };

  const $ = sel => document.querySelector(sel);
  const canvas = $('#stageCanvas');
  const ctx = canvas.getContext('2d');
  const videoEl = $('#resultVideo');
  const overlay = $('#overlay');
  const statusLabel = $('#statusLabel');
  const progressBar = $('#progressBar').querySelector('span');
  const btnGenerate = $('#generateBtn');
  const linkDownload = $('#downloadLink');
  const btnReplay = $('#replayBtn');
  $('#year').textContent = new Date().getFullYear();

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOutCubic(t){ return t<0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }
  function easeOutCubic(t){ return 1 - Math.pow(1-t, 3); }
  function map(v, inMin, inMax, outMin, outMax){ return outMin + (outMax - outMin) * ((v - inMin)/(inMax - inMin)); }

  function hsl(h, s, l, a=1){ return `hsla(${h}, ${s}%, ${l}%, ${a})`; }

  // Audio: build a soft evolving pad with simple triads and gentle filter
  function buildAudio(durationSec) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const master = audioCtx.createGain();
    master.gain.value = 0.28;

    // Gentle lowpass filter to soften the pad
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    filter.Q.value = 0.6;

    const dest = audioCtx.createMediaStreamDestination();
    master.connect(filter);
    filter.connect(dest);

    // Chord progression: D minor ? Bb major ? F major ? C major (each 4s)
    const chords = [
      [293.66, 349.23, 440.00], // Dm: D F A
      [233.08, 311.13, 392.00], // Bb: Bb D G (sus2-ish for color)
      [174.61, 261.63, 349.23], // F: F C F (open fifth + octave)
      [261.63, 329.63, 392.00], // C: C E G
    ];

    const measure = 4.0;
    const numMeasures = Math.ceil(durationSec / measure);

    // Create three detuned oscillators for lushness
    function createVoice(detuneCents) {
      const voiceGain = audioCtx.createGain();
      voiceGain.gain.value = 0.0;
      voiceGain.connect(master);

      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const osc3 = audioCtx.createOscillator();
      [osc1, osc2, osc3].forEach(osc => {
        osc.type = 'sine';
        osc.detune.value = detuneCents;
        osc.connect(voiceGain);
        osc.start();
      });

      return { gain: voiceGain, osc1, osc2, osc3 };
    }

    const voices = [createVoice(-4), createVoice(0), createVoice(5)];

    const now = audioCtx.currentTime + 0.05;

    // Fade master in/out
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.28, now + 1.5);
    master.gain.exponentialRampToValueAtTime(0.0001, now + durationSec - 0.8);

    for (let m = 0; m < numMeasures; m++) {
      const start = now + m * measure;
      const chord = chords[m % chords.length];

      voices.forEach((v, idx) => {
        const [f1, f2, f3] = chord.map(f => f * (idx === 0 ? 0.5 : idx === 2 ? 2.0 : 1));
        v.osc1.frequency.setValueAtTime(f1, start);
        v.osc2.frequency.setValueAtTime(f2, start);
        v.osc3.frequency.setValueAtTime(f3, start);

        // Per-measure swell
        const g = v.gain.gain;
        g.cancelScheduledValues(start);
        g.setValueAtTime(0.0001, start);
        g.exponentialRampToValueAtTime(0.28, start + 1.0);
        g.exponentialRampToValueAtTime(0.08, start + 3.2);
        g.exponentialRampToValueAtTime(0.0001, start + measure);
      });
    }

    // Subtle breath noise using filtered noise for texture
    const noise = audioCtx.createBufferSource();
    const noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * durationSec, audioCtx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.03;
    noise.buffer = noiseBuf;
    const noiseGain = audioCtx.createGain();
    noiseGain.gain.value = 0.05;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 600;
    noiseFilter.Q.value = 1.0;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(now);
    noise.stop(now + durationSec);

    return { audioCtx, stream: dest.stream };
  }

  // Visuals: background, particles, and stylized Eye of Horus
  const particles = Array.from({ length: 80 }, () => ({
    x: Math.random() * WIDTH,
    y: Math.random() * HEIGHT,
    r: 0.8 + Math.random() * 2.2,
    a: Math.random() * Math.PI * 2,
    s: 0.2 + Math.random() * 0.9
  }));

  function drawBackground(t) {
    const hue = lerp(200, 260, 0.5 + 0.5 * Math.sin(t * 0.08));
    const grad = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    grad.addColorStop(0, hsl(hue, 60, 10));
    grad.addColorStop(1, hsl(hue + 60, 50, 8));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Stars/particles
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    particles.forEach(p => {
      p.x += Math.cos(p.a) * p.s * 0.4;
      p.y += Math.sin(p.a) * p.s * 0.4;
      if (p.x < -10) p.x = WIDTH + 10; if (p.x > WIDTH + 10) p.x = -10;
      if (p.y < -10) p.y = HEIGHT + 10; if (p.y > HEIGHT + 10) p.y = -10;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 18);
      g.addColorStop(0, hsl(hue + 80, 90, 70, 0.75));
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

    // Horizon glow
    const glow = ctx.createLinearGradient(0, HEIGHT * 0.6, 0, HEIGHT);
    glow.addColorStop(0, 'rgba(255,255,255,0)');
    glow.addColorStop(1, hsl(hue + 180, 60, 50, 0.13));
    ctx.fillStyle = glow;
    ctx.fillRect(0, HEIGHT * 0.6, WIDTH, HEIGHT * 0.4);
  }

  function drawEye(t) {
    ctx.save();
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2 - 20;
    const scaleBase = 1.0 + 0.06 * Math.sin(t * 0.9);
    ctx.translate(cx, cy);
    ctx.scale(scaleBase, scaleBase);

    // Eye outline
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(-360, 0);
    ctx.quadraticCurveTo(-80, -180, 220, -22);
    ctx.quadraticCurveTo(40, 140, -300, 20);
    ctx.quadraticCurveTo(-200, -40, -360, 0);
    ctx.stroke();

    // Pupil circle with rotating arc
    ctx.lineWidth = 5;
    const r = 60 + 6 * Math.sin(t * 1.3);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();

    const arcStart = (t * 0.9) % (Math.PI * 2);
    ctx.beginPath();
    ctx.strokeStyle = '#22c1c3';
    ctx.arc(0, 0, r + 14, arcStart, arcStart + Math.PI * 1.2);
    ctx.stroke();

    // Eye marking (Horus curl)
    ctx.beginPath();
    ctx.strokeStyle = '#fdbb2d';
    ctx.moveTo(60, 40);
    ctx.quadraticCurveTo(120, 80, 100, 120);
    ctx.quadraticCurveTo(70, 160, 20, 136);
    ctx.stroke();

    // Title text
    ctx.font = '800 64px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.fillText('HORUS MUSIC', 0, -240);

    // Subtitle appears later
    const subtitleAlpha = clamp(map(t, 3, 6, 0, 1), 0, 1);
    ctx.globalAlpha = easeInOutCubic(subtitleAlpha);
    ctx.font = '600 22px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(220,230,255,0.86)';
    ctx.fillText('A generative audiovisual tribute', 0, -200);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawTimeline(t) {
    // 0-5s: intro emphasis, 5-15s: motion and glow, 15-20s: outro fade with callout
    drawBackground(t);
    drawEye(t);

    // Glow bars synced subtly to time
    const bars = 24;
    ctx.save();
    ctx.translate(0, HEIGHT - 120);
    for (let i = 0; i < bars; i++) {
      const x = lerp(80, WIDTH - 80, i / (bars - 1));
      const phase = t * 1.6 + i * 0.35;
      const h = 20 + 60 * (0.5 + 0.5 * Math.sin(phase));
      const alpha = 0.22 + 0.25 * (0.5 + 0.5 * Math.cos(phase * 0.7));
      ctx.fillStyle = `rgba(80,200,220,${alpha})`;
      ctx.fillRect(x - 8, -h, 16, h);
    }
    ctx.restore();

    // Outro tag
    if (t > 14.2) {
      const a = easeOutCubic(clamp(map(t, 14.2, 16.5, 0, 1), 0, 1));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = '700 28px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(230,240,255,0.95)';
      ctx.fillText('Vision. Sky. Protection.', WIDTH / 2, HEIGHT * 0.2);
      ctx.font = '600 18px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(210,225,255,0.9)';
      ctx.fillText('Generated live with Canvas + WebAudio', WIDTH / 2, HEIGHT * 0.2 + 34);
      ctx.restore();
    }
  }

  async function generate() {
    if (state.recording) return;

    // Prepare audio and capture streams
    statusLabel.textContent = 'Initializing audio & video?';

    let audio;
    try {
      audio = buildAudio(DURATION_SEC);
    } catch (err) {
      console.error(err);
      statusLabel.textContent = 'Audio init failed, proceeding with silent video?';
    }

    const videoStream = canvas.captureStream(FPS);
    const mixed = new MediaStream();
    videoStream.getVideoTracks().forEach(tr => mixed.addTrack(tr));
    if (audio && audio.stream) {
      audio.stream.getAudioTracks().forEach(tr => mixed.addTrack(tr));
    }

    state.chunks = [];
    state.recorder = new MediaRecorder(mixed, { mimeType: 'video/webm;codecs=vp9,opus' });

    state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
    state.recorder.onstop = () => {
      const blob = new Blob(state.chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      videoEl.src = url;
      linkDownload.href = url;
      linkDownload.hidden = false;
      videoEl.hidden = false;
      overlay.style.display = 'none';
      btnReplay.hidden = false;
      canvas.style.visibility = 'hidden';
      videoEl.play().catch(()=>{});
      if (audio && audio.audioCtx && audio.audioCtx.state !== 'closed') {
        audio.audioCtx.close().catch(()=>{});
      }
    };

    // Start recording
    state.recorder.start();
    state.recording = true;

    // Render loop
    const start = performance.now();
    state.startTime = start;

    function frame(now) {
      const t = (now - start) / 1000;
      const p = clamp(t / DURATION_SEC, 0, 1);

      progressBar.style.width = `${(p * 100).toFixed(1)}%`;
      statusLabel.textContent = p < 1 ? `Rendering? ${(p*100).toFixed(0)}%` : 'Finalizing?';

      // Letterbox-safe clear at fixed resolution
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      drawTimeline(t);

      if (t < DURATION_SEC) {
        requestAnimationFrame(frame);
      } else {
        // Grace period to flush last frames
        setTimeout(() => {
          try { state.recorder.stop(); } catch (_) {}
          state.recording = false;
        }, 150);
      }
    }

    // Show overlay while rendering
    overlay.style.display = 'grid';
    canvas.style.visibility = 'visible';
    videoEl.hidden = true;
    linkDownload.hidden = true;
    btnReplay.hidden = true;

    requestAnimationFrame(frame);
  }

  function replay() {
    videoEl.currentTime = 0;
    videoEl.play().catch(()=>{});
  }

  btnGenerate.addEventListener('click', generate);
  btnReplay.addEventListener('click', replay);

  // Auto-generate on first load (user gesture may be needed for audio resume)
  window.addEventListener('load', async () => {
    // Try to start; if browser blocks audio context, user can press the button
    try { await generate(); } catch (_) { /* user can click */ }
  });
})();
