  // ---------- Demo ao vivo: porta em JS da mesma lógica do projeto Python ----------
  // Landmarks usados (mesmos índices de detection/pose_landmarks.py)
  const IDX = {
    left_shoulder: 11, right_shoulder: 12,
    left_elbow: 13, right_elbow: 14,
    left_wrist: 15, right_wrist: 16,
    left_hip: 23, right_hip: 24,
  };
  const CONNECTIONS = [
    [11,12],[11,13],[13,15],[12,14],[14,16],
    [11,23],[12,24],[23,24],
    [23,25],[25,27],[24,26],[26,28],
  ];

  const MIN_CONF = 0.5;
  const WRIST_MARGIN = 0.035;
  const REQUIRED_FRAMES = 5;
  const MAX_DIST = 0.18;
  const MAX_MISSED = 8;
  const WINDOW_MS = 10000;

  function vis(landmarks, i){
    const p = landmarks[i];
    if (!p) return 0;
    const v = p.visibility ?? 1, pr = p.presence ?? 1;
    return Math.min(v, pr);
  }

  function isRaised(landmarks, side){
    const s = side === 'left' ? IDX.left_shoulder : IDX.right_shoulder;
    const e = side === 'left' ? IDX.left_elbow : IDX.right_elbow;
    const w = side === 'left' ? IDX.left_wrist : IDX.right_wrist;
    const h = side === 'left' ? IDX.left_hip : IDX.right_hip;
    const wristAboveShoulder = landmarks[w].y < landmarks[s].y - WRIST_MARGIN;
    const hipConf = vis(landmarks, h);
    if (hipConf < MIN_CONF) return wristAboveShoulder;
    const elbowAboveHip = landmarks[e].y < landmarks[h].y;
    return wristAboveShoulder && elbowAboveHip;
  }

  function evaluateArms(landmarks){
    const leftConf = Math.min(vis(landmarks, IDX.left_shoulder), vis(landmarks, IDX.left_elbow), vis(landmarks, IDX.left_wrist));
    const rightConf = Math.min(vis(landmarks, IDX.right_shoulder), vis(landmarks, IDX.right_elbow), vis(landmarks, IDX.right_wrist));
    const leftConfident = leftConf >= MIN_CONF, rightConfident = rightConf >= MIN_CONF;
    if (!leftConfident && !rightConfident) return null;
    return {
      leftRaised: leftConfident && isRaised(landmarks, 'left'),
      rightRaised: rightConfident && isRaised(landmarks, 'right'),
      leftConfident, rightConfident,
    };
  }

  function center(landmarks){
    const l = landmarks[IDX.left_shoulder], r = landmarks[IDX.right_shoulder];
    return [(l.x + r.x) / 2, (l.y + r.y) / 2];
  }

  function dist(a, b){ return Math.hypot(a[0]-b[0], a[1]-b[1]); }

  class Tracker{
    constructor(){ this.tracks = new Map(); this.nextId = 1; }
    update(posesLandmarks){
      const candidates = [];
      for (const [tid, t] of this.tracks){
        posesLandmarks.forEach((lm, pi) => candidates.push([dist(center(lm), t.center), tid, pi]));
      }
      candidates.sort((a,b) => a[0]-b[0]);
      const matchedTracks = new Set(), matchedPoses = new Set();
      const active = [];
      for (const [d, tid, pi] of candidates){
        if (d > MAX_DIST || matchedTracks.has(tid) || matchedPoses.has(pi)) continue;
        const t = this.tracks.get(tid);
        t.center = center(posesLandmarks[pi]);
        t.landmarks = posesLandmarks[pi];
        t.missed = 0;
        matchedTracks.add(tid); matchedPoses.add(pi);
        active.push(t);
      }
      posesLandmarks.forEach((lm, pi) => {
        if (matchedPoses.has(pi)) return;
        const id = 'track_' + (this.nextId++);
        const t = { id, center: center(lm), landmarks: lm, missed: 0,
          leftRaised:false, rightRaised:false, candidateState:null, candidateFrames:0, initialized:false };
        this.tracks.set(id, t);
        active.push(t);
      });
      for (const [tid, t] of Array.from(this.tracks)){
        if (matchedTracks.has(tid)) continue;
        t.missed++;
        if (t.missed > MAX_MISSED) this.tracks.delete(tid);
      }
      return active;
    }
  }

  class Aggregator{
    constructor(){ this.reset(); }
    reset(){ this.windowStart = performance.now(); this.peopleSamples = []; this.participants = new Set(); this.armEvents = 0; }
    ingest(peopleCount, newlyRaisedTrackIds){
      this.peopleSamples.push(peopleCount);
      newlyRaisedTrackIds.forEach(id => { this.participants.add(id); this.armEvents++; });
      const elapsed = performance.now() - this.windowStart;
      if (elapsed < WINDOW_MS) return { remainingMs: WINDOW_MS - elapsed, report: null };
      const avg = this.peopleSamples.length ? this.peopleSamples.reduce((a,b)=>a+b,0) / this.peopleSamples.length : 0;
      const report = {
        people_average: Math.round(avg * 100) / 100,
        people_max: this.peopleSamples.length ? Math.max(...this.peopleSamples) : 0,
        participating_people: this.participants.size,
        arm_raise_events: this.armEvents,
        participation_ratio: avg > 0 ? Math.round((this.participants.size / avg) * 1000) / 1000 : 0,
      };
      this.reset();
      return { remainingMs: WINDOW_MS, report };
    }
  }

  // ---------- DOM wiring ----------
  const btn = document.getElementById('liveToggle');
  const video = document.getElementById('liveVideo');
  const canvas = document.getElementById('liveCanvas');
  const overlayMsg = document.getElementById('liveOverlayMsg');
  const modelState = document.getElementById('liveModelState');
  const mPeople = document.getElementById('mPeople');
  const mArms = document.getElementById('mArms');
  const mRatio = document.getElementById('mRatio');
  const mWindow = document.getElementById('mWindow');
  const badgesEl = document.getElementById('liveBadges');
  const consoleEl = document.getElementById('liveConsole');

  let ctx = canvas.getContext('2d');
  let stream = null, poseLandmarker = null, running = false, rafId = null;
  const tracker = new Tracker();
  const aggregator = new Aggregator();

  function logLine(text){
    const div = document.createElement('div');
    div.className = 'live-console-line';
    div.textContent = text;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
    while (consoleEl.children.length > 12) consoleEl.removeChild(consoleEl.firstChild);
  }

  async function ensureModel(){
    if (poseLandmarker) return poseLandmarker;
    modelState.textContent = 'baixando modelo…';
    const { PoseLandmarker, FilesetResolver } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      },
      runningMode: 'VIDEO',
      numPoses: 4,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    modelState.textContent = 'modelo pronto';
    return poseLandmarker;
  }

  function drawFrame(tracks){
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    for (const t of tracks){
      const pts = t.landmarks.map(p => [p.x * w, p.y * h]);
      ctx.strokeStyle = '#FFB454'; ctx.lineWidth = 2;
      for (const [a,b] of CONNECTIONS){
        if (!pts[a] || !pts[b]) continue;
        ctx.beginPath(); ctx.moveTo(pts[a][0], pts[a][1]); ctx.lineTo(pts[b][0], pts[b][1]); ctx.stroke();
      }
      ctx.fillStyle = '#8CFF7A';
      for (const [x,y] of pts){ ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2); ctx.fill(); }
    }
  }

  function analyzeTrack(t){
    const evaluated = evaluateArms(t.landmarks);
    if (!evaluated) return { newlyRaised: false };
    const candidate = [
      evaluated.leftConfident ? evaluated.leftRaised : t.leftRaised,
      evaluated.rightConfident ? evaluated.rightRaised : t.rightRaised,
    ];
    const same = t.candidateState && t.candidateState[0] === candidate[0] && t.candidateState[1] === candidate[1];
    if (same) t.candidateFrames++; else { t.candidateState = candidate; t.candidateFrames = 1; }
    if (t.candidateFrames < REQUIRED_FRAMES) return { newlyRaised: false };

    const previous = [t.leftRaised, t.rightRaised];
    t.leftRaised = candidate[0]; t.rightRaised = candidate[1];
    t.initialized = true;
    const newlyRaised = (!previous[0] && candidate[0]) || (!previous[1] && candidate[1]);
    return { newlyRaised };
  }

  function tick(){
    if (!running) return;
    const now = performance.now();
    const result = poseLandmarker.detectForVideo(video, now);
    const posesLandmarks = result.landmarks || [];
    const tracks = tracker.update(posesLandmarks);

    let newlyRaisedIds = [];
    let armsUp = 0;
    for (const t of tracks){
      const { newlyRaised } = analyzeTrack(t);
      if (newlyRaised) newlyRaisedIds.push(t.id);
      if (t.leftRaised) armsUp++;
      if (t.rightRaised) armsUp++;
    }

    drawFrame(tracks);

    mPeople.textContent = tracks.length;
    mArms.textContent = armsUp;
    badgesEl.innerHTML = '';
    tracks.forEach(t => {
      const span = document.createElement('span');
      const on = t.leftRaised || t.rightRaised;
      span.className = 'badge' + (on ? ' on' : '');
      span.textContent = `${t.id}: ${t.leftRaised ? 'ESQ↑' : 'esq↓'} ${t.rightRaised ? 'DIR↑' : 'dir↓'}`;
      badgesEl.appendChild(span);
    });

    const { remainingMs, report } = aggregator.ingest(tracks.length, newlyRaisedIds);
    mWindow.textContent = Math.max(0, Math.round(remainingMs / 1000)) + 's';
    if (report){
      mRatio.textContent = report.participation_ratio;
      logLine('{ people_avg: ' + report.people_average + ', participating: ' + report.participating_people +
        ', ratio: ' + report.participation_ratio + ' }');
    }

    rafId = requestAnimationFrame(tick);
  }

  async function start(){
    btn.textContent = 'Ligando câmera…';
    btn.disabled = true;
    try{
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      video.srcObject = stream;
      await video.play();
      await new Promise(r => { if (video.readyState >= 2) r(); else video.onloadedmetadata = r; });
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
    } catch (err){
      overlayMsg.textContent = 'Não foi possível acessar a câmera (' + err.message + '). Verifique as permissões do navegador.';
      overlayMsg.style.display = 'flex';
      btn.textContent = 'Ligar câmera';
      btn.disabled = false;
      return;
    }
    try{
      await ensureModel();
    } catch (err){
      overlayMsg.textContent = 'Câmera ligada, mas não deu para baixar o modelo do MediaPipe (é preciso internet liberada para cdn.jsdelivr.net e storage.googleapis.com). Detalhe: ' + err.message;
      overlayMsg.style.display = 'flex';
      modelState.textContent = 'modelo indisponível';
      btn.textContent = 'Ligar câmera';
      btn.disabled = false;
      stream.getTracks().forEach(tr => tr.stop());
      stream = null;
      return;
    }
    overlayMsg.style.display = 'none';
    running = true;
    btn.textContent = 'Desligar câmera';
    btn.classList.add('stop');
    btn.disabled = false;
    logLine('// câmera ligada — detectando poses localmente');
    tick();
  }

  function stop(){
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach(tr => tr.stop());
    stream = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    overlayMsg.textContent = 'Clique em "Ligar câmera" para começar';
    overlayMsg.style.display = 'flex';
    btn.textContent = 'Ligar câmera';
    btn.classList.remove('stop');
    badgesEl.innerHTML = '';
    mPeople.textContent = '0'; mArms.textContent = '0'; mRatio.textContent = '–'; mWindow.textContent = '10s';
  }

  btn.addEventListener('click', () => { running ? stop() : start(); });
