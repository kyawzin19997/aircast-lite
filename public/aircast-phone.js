'use strict';

function cameraFormat(track, fallback) {
  return videoFormat(track.getSettings(), fallback);
}

function videoFormat({ width, height, frameRate }, fallback) {
  if (!width || !height) return fallback;
  return width + ' × ' + height + (frameRate ? ' · ' + Math.round(frameRate) + ' fps' : '');
}

function reportedCapabilities(track) {
  try { return track?.getCapabilities?.() || {}; } catch { return {}; }
}

function captureRate(value) {
  return value === 'auto' ? 30 : Number(value);
}

function phoneVideoConstraints(frameRate) {
  const nativeResize = navigator.mediaDevices?.getSupportedConstraints?.().resizeMode;
  const constraints = { width: { ideal: profile('2160').width }, frameRate: { ideal: captureRate(frameRate) } };
  if (nativeResize) constraints.resizeMode = { exact: 'none' };
  return constraints;
}

function supportedPhoneQuality(quality, { width, height }) {
  if (!width || !height || quality === PHONE_QUALITIES[0]) return true;
  return Math.min(width, height) >= profile(quality).height && (quality !== '2160' || Math.max(width, height) >= profile(quality).width);
}

function phoneStreamFormat(preset, active) {
  const { width, height, frameRate } = active;
  if (!width || !height) return { frameRate, scale: 1 };
  const scale = Math.max(1, Math.max(width, height) / preset.width, Math.min(width, height) / preset.height);
  return { width: Math.floor(width / scale), height: Math.floor(height / scale), frameRate, scale };
}

function captureBitrate(preset, frameRate, active = {}) {
  const { width, height, frameRate: actualRate } = active;
  const pixels = width && height ? Math.min(1, width * height / (preset.width * preset.height)) : 1;
  const frames = Math.max(0.65, Math.pow((actualRate || captureRate(frameRate)) / 30, 0.65));
  return Math.round(Math.min(MAX_VIDEO_BITRATE, Math.max(250000, preset.bitrate * pixels * frames)));
}

const qualityLabel = (quality) => quality === '2160' ? '4K' : quality + 'p';

const quarterAngle = (angle) => ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
const isQuarterTurn = (angle) => angle % 180 !== 0;

function screenPose() {
  const orientation = screen.orientation;
  if (Number.isFinite(orientation?.angle) && /^(portrait|landscape)-/.test(orientation.type)) {
    return { angle: quarterAngle(-orientation.angle), portrait: orientation.type.startsWith('portrait') };
  }
  if (Number.isFinite(window.orientation)) {
    const angle = quarterAngle(-window.orientation);
    return { angle, portrait: !isQuarterTurn(angle) };
  }
  return null;
}

function motionQuarter(beta, gamma) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const radians = Math.PI / 180;
  const x = -Math.sin(gamma * radians) * Math.cos(beta * radians);
  const y = Math.sin(beta * radians);
  if (Math.hypot(x, y) < 0.55 || Math.min(Math.abs(x), Math.abs(y)) > 0.72 * Math.max(Math.abs(x), Math.abs(y))) return null;
  return quarterAngle(-Math.atan2(x, y) / radians);
}

function fitKeyboardViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  let pending = 0;

  function update() {
    pending = 0;
    const field = document.activeElement;
    const editing = field?.matches('textarea, input:not([type]), input:is([type="text"],[type="search"],[type="url"],[type="email"],[type="tel"],[type="password"],[type="number"])');
    const sheet = field?.closest('#phoneDialog[open]');
    const edge = viewport.offsetTop + viewport.height;
    const bottom = Math.round(Math.max(0, innerHeight - edge));
    const shown = Boolean(editing && Math.abs(viewport.scale - 1) < 0.03 && bottom > 70);

    if (shown) {
      root.style.setProperty('--keyboard-bottom', bottom + 'px');
      root.style.setProperty('--keyboard-viewport', Math.round(viewport.height) + 'px');
      if (sheet) root.style.setProperty('--phone-keyboard-offset', Math.round(viewport.offsetTop) + 'px');
    }
    root.toggleAttribute('data-keyboard', shown);
    if (shown && sheet) {
      const dialogBounds = sheet.getBoundingClientRect();
      const fieldBottom = field.getBoundingClientRect().bottom;
      if (fieldBottom > dialogBounds.bottom - 12) sheet.scrollTop += fieldBottom - dialogBounds.bottom + 12;
    }
  }
  const schedule = () => { if (!pending) pending = requestAnimationFrame(update); };
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
}


function phone() {
  const preferences = saved(PHONE_KEY);
  const linkRoom = normalizeRoom(query.get('room'));
  if (roomAccess) $('phoneRoom').readOnly = $('phoneSlot').disabled = true;
  const storedConnection = preferences.connection || {};
  let destination = {
    room: linkRoom || normalizeRoom(storedConnection.room),
    slot: normalizeSlot(linkRoom ? query.get('cam') : storedConnection.slot) || 'CAM1'
  };
  let autoPair = Boolean(destination.room && (linkRoom ? query.get('join') !== '0' : storedConnection.auto === true));
  const identity = normalizeRoom(preferences.identity) || randomCode(16);
  const preferredQuality = { '240': '360', '540': '480', '1440': '1080' }[preferences.quality] || preferences.quality;
  let quality = PHONE_QUALITIES.includes(preferredQuality) ? preferredQuality : '720';
  let frameRate = CAPTURE_RATES.includes(preferences.frameRate) ? preferences.frameRate : 'auto';
  let adaptive = preferences.adaptive !== false;
  let settings = imageSettings(preferences.image);
  let autoRotate = typeof preferences.autoRotate === 'boolean' ? preferences.autoRotate : settings.rotation === 0;
  let automaticAngle = 0;
  let framePose = null;
  let screenReference = screenPose();
  let orientationTimer;
  let motionCandidate = null;
  let motionAngle = null;
  let motionTimer;
  let motionGranted = false;
  const canRequestMotion = typeof window.DeviceOrientationEvent?.requestPermission === 'function';
  let capabilities = {};
  let captureProblem = '';
  let grid = preferences.grid === true;
  let facing = 'environment';
  let video = null;
  let deviceStream = null;
  let microphone = null;
  let busy = false;
  let micRequest = null;
  let torchBusy = false;
  let torchOn = false;
  let session = null;
  let pairingToken = null;
  let confirmTimer;
  let pairDeadline;
  let videoDeadline;
  let hostedBefore = false;
  let studioLink = null;
  let studioPipe = null;
  let studioState = '';
  const viewers = new Map();
  let sending = false;
  let cameraHidden = false;
  let hasSentVideo = false;
  let copyObsTimer;
  let linkMessage = '';
  let linkTone = '';
  let wakeLock = null;
  let wakePending = false;
  let recoverTimer;
  let recoverStep = 0;
  let openCamera = false;
  let publishedVideo = null;
  let publishedAudio = null;
  let publishedStream = null;
  let imageTimer = 0;

  const monitor = new Monitor($('phoneView'), { change: (visible) => { $('phoneEmpty').hidden = visible; } });
  const adjustmentButtons = [...$('phoneAdjustments').querySelectorAll('[data-adjust]')];
  const refreshInspector = createInspector($('phoneImageControls'), () => settings, adjustImage, false, false, $('phoneAdjustRanges'), updateAdjustmentValues);
  let shownAdjustment = '';
  let toolsOpen = false;
  for (const button of adjustmentButtons) {
    const key = button.dataset.adjust;
    const range = $('phoneImageControls-' + key);
    range.labels[0].textContent = 'OBS ' + button.dataset.label;
    button.onclick = () => showAdjustment(shownAdjustment === key ? '' : key, true);
  }
  showAdjustment('');
  savePhone();

  function showTools(open) {
    toolsOpen = open;
    $('phoneAdjustments').hidden = !open;
    $('phoneTools').setAttribute('aria-expanded', String(open));
    buttonState($('phoneTools'), open);
    if (!open) showAdjustment('');
  }

  function showAdjustment(key, focus = false) {
    shownAdjustment = key;
    $('phoneAdjustPanel').hidden = !key;
    for (const button of adjustmentButtons) {
      const active = button.dataset.adjust === key;
      button.setAttribute('aria-expanded', String(active));
      buttonState(button, active);
      $('phoneImageControls-' + button.dataset.adjust).closest('.adjustment').hidden = !active;
    }
    if (key && focus) $('phoneImageControls-' + key).focus({ preventScroll: true });
  }

  function updateAdjustmentValues() {
    for (const button of adjustmentButtons) {
      const value = $('phoneImageControls-' + button.dataset.adjust).previousElementSibling.textContent;
      button.title = button.dataset.label + ' · ' + value;
      button.setAttribute('aria-label', button.title);
    }
  }

  function adjustImage(key, value, commit = true) {
    settings[key] = value;
    if (commit) savePhone();
    if (!imageTimer) imageTimer = setTimeout(() => {
      imageTimer = 0;
      publish();
    }, 32);
  }

  function savePhone() {
    store(PHONE_KEY, { identity, quality, frameRate, adaptive, image: settings, grid, autoRotate, connection: { ...destination, auto: autoPair } });
  }

  function refreshPreview() {
    const rotation = activeRotation();
    monitor.display({ stream: deviceStream });
    $('phoneGrid').hidden = !grid || !deviceStream;

    const { videoWidth: width, videoHeight: height } = monitor.video;
    const orientation = deviceStream && width && height && width !== height
      ? ((height > width) !== isQuarterTurn(rotation) ? 'Vertical' : 'Horizontal') : '';
    const status = ['OBS', orientation, autoRotate ? 'Auto' : 'Locked', rotation + '°'].filter(Boolean).join(' · ');
    if ($('phoneAngle').textContent !== status) {
      $('phoneAngle').textContent = status;
      const ratio = orientation === 'Vertical' ? '9:16' : orientation === 'Horizontal' ? '16:9' : '';
      $('phoneAngleLabel').textContent = [ratio, autoRotate ? 'Auto' : rotation + '°'].filter(Boolean).join(' · ');
      $('phoneRotate').setAttribute('aria-label', status + '. Rotate OBS feed 90 degrees and lock rotation.');
    }
    $('phoneRotate').title = 'Rotate OBS feed 90° and lock rotation';
    $('phoneAutoRotate').checked = autoRotate;
    $('phoneMotion').hidden = !autoRotate || !canRequestMotion || motionGranted;
    $('phoneMotionStatus').hidden = !autoRotate || !$('phoneMotionStatus').textContent;
  }

  function activeRotation() {
    return autoRotate ? automaticAngle : settings.rotation;
  }

  function scheduleOrientation() {
    clearTimeout(orientationTimer);
    orientationTimer = setTimeout(syncOrientation, 260);
  }

  function readCurrentScreen() {
    const pose = screenPose();
    if (pose && (screenReference?.angle !== pose.angle || screenReference?.portrait !== pose.portrait)) {
      motionAngle = motionCandidate = null;
      clearTimeout(motionTimer);
    }
    screenReference = pose;
    return pose;
  }

  function syncOrientation() {
    const pose = readCurrentScreen();
    const width = monitor.video.videoWidth;
    const height = monitor.video.videoHeight;
    if (!pose || !video || !width || !height || width === height) return;

    const naturalPortrait = pose.portrait !== isQuarterTurn(pose.angle);
    const target = motionAngle === null ? pose : {
      angle: motionAngle, portrait: naturalPortrait !== isQuarterTurn(motionAngle)
    };
    const portrait = height > width;
    if (portrait === pose.portrait) {
      framePose = pose;
    } else if (framePose?.portrait !== portrait) {
      // A browser may update the camera before it rotates the page.
      const matchesMotion = motionAngle !== null && target.portrait === portrait;
      framePose = matchesMotion ? target : { angle: portrait === naturalPortrait ? 0 : 90, portrait };
    }
    const next = quarterAngle(target.angle - framePose.angle);
    if (next === automaticAngle) return;
    automaticAngle = next;
    if (autoRotate) {
      refreshPreview();
      publish();
    }
  }

  function motionChanged(event) {
    if (!autoRotate || !video) return;
    readCurrentScreen();
    const angle = motionQuarter(event.beta, event.gamma);
    if (angle === null || angle === motionCandidate) return;
    clearTimeout(motionTimer);
    motionCandidate = angle;
    motionTimer = setTimeout(() => {
      motionAngle = angle;
      syncOrientation();
    }, 200);
  }

  function setAutoRotate(value) {
    autoRotate = value;
    motionAngle = motionCandidate = null;
    clearTimeout(motionTimer);
    syncOrientation();
    savePhone();
    refreshPreview();
    publish();
  }

  async function enableMotion() {
    const button = $('phoneMotion');
    button.disabled = true;
    try {
      const result = await window.DeviceOrientationEvent.requestPermission();
      motionGranted = result === 'granted';
      $('phoneMotionStatus').textContent = motionGranted ? 'Motion access is on.' : 'Allow motion in browser settings or turn off your phone’s rotation lock.';
    } catch {
      $('phoneMotionStatus').textContent = 'Motion access is unavailable. Turn off your phone’s rotation lock or use Rotate.';
    } finally {
      $('phoneMotionStatus').hidden = false;
      button.disabled = false;
      refreshPreview();
    }
  }


  function supportsTorch() {
    return capabilities.torch === true;
  }

  function captureSettings() {
    if (!video) return {};
    const active = video.getSettings();
    if ((!active.width || !active.height) && monitor.video.srcObject === deviceStream) {
      return { ...active, width: monitor.video.videoWidth, height: monitor.video.videoHeight };
    }
    return active;
  }

  function activeQuality(active) {
    return PHONE_QUALITIES.findLast((value) => Number(value) <= Number(quality) && supportedPhoneQuality(value, active));
  }

  function syncCaptureOptions() {
    const active = captureSettings();
    for (const option of $('phoneQuality').options) {
      option.disabled = !supportedPhoneQuality(option.value, active);
      option.textContent = qualityLabel(option.value) + (option.disabled ? ' (unavailable)' : '');
    }
    const { min = 0, max = Infinity } = capabilities.frameRate || {};
    for (const option of $('phoneFrameRate').options) {
      const rate = Number(option.value);
      option.disabled = option.value !== 'auto' && (rate > max + 0.5 || rate < min - 0.5);
      option.textContent = option.value === 'auto' ? 'Auto (prefer 30 fps)' : rate + ' fps' + (option.disabled ? ' (unavailable)' : '');
    }
    $('phoneQuality').value = activeQuality(active);
    $('phoneFrameRate').value = frameRate;
  }

  function updateCaptureDisplay() {
    const active = captureSettings();
    const fps = active.frameRate;
    const selected = activeQuality(active);
    $('phoneFormat').textContent = video ? qualityLabel(selected) + (fps ? ' · ' + Math.round(fps) + ' fps' : '') : 'Capture';
    $('phoneCaptureButton').setAttribute('aria-label', 'Capture settings' + (video ? '. Stream ' + $('phoneFormat').textContent : ''));
    const output = phoneStreamFormat(profile(selected), active);
    const note = video
      ? 'Preview ' + videoFormat({ ...active, frameRate: undefined }, 'full frame') + ' · Stream up to ' + videoFormat(output, qualityLabel(selected))
      : 'Enable the camera to see available resolutions.';
    $('phoneCaptureSummary').textContent = captureProblem || note;
  }

  function updatePhone() {
    const available = Boolean(video && video.readyState === 'live');
    $('phoneTools').hidden = !available;
    if (!available && toolsOpen) showTools(false);
    const routes = [...viewers.values()].filter((viewer) => viewer.watching);
    const paired = Boolean(studioPipe || viewers.size);
    const ready = session?.signaler.ready;
    if (session && !ready && !paired) startPairDeadline();
    const states = [studioState, ...routes.map((viewer) => viewer.state)];
    const transmitting = sending && !cameraHidden && available && states.includes('connected');
    const waitingForVideo = sending && !cameraHidden && available && !transmitting && Boolean(studioPipe || routes.length);
    if (transmitting) hasSentVideo = true;
    trackVideoStart(waitingForVideo);
    const failed = !session && linkTone === 'bad';
    let status = failed ? 'Connection failed' : 'Unpaired';
    let tone = failed ? 'bad' : '';
    if (session) {
      status = ready ? 'Waiting for OBS' : hostedBefore ? 'Reconnecting' : 'Pairing';
      tone = linkTone || 'warn';
    }
    if (paired) {
      status = 'Paired';
      tone = 'good';
    }
    if (waitingForVideo) {
      status = states.some((state) => ['failed', 'disconnected'].includes(state)) ? 'Reconnecting video' : 'Starting video';
      tone = 'warn';
    }
    if (transmitting) {
      status = 'Live';
      tone = 'bad';
    }
    const form = formDestination();
    const same = sameDestination(form);
    const changesPending = Boolean(session && !same);
    const target = destination.room
      ? routeName(destination.slot) + ' · Room ' + destination.room
      : 'Camera preview';
    setSignal($('phoneStatus'), status, tone);
    setSignal($('phoneConnectionStatus'), changesPending ? 'Changes pending' : status, changesPending ? 'warn' : tone);
    $('phoneDestination').textContent = destination.room ? routeName(destination.slot) : 'Preview';
    $('phoneDestination').title = target;
    const standbyHint = available ? 'Tap Go live to send video.' : 'Enable the camera, then tap Go live.';
    const waitingHint = ready && !paired ? 'Open this camera’s URL in OBS to pair.' : '';
    const hint = changesPending ? status + ' · ' + target : linkMessage || (paired && !sending ? standbyHint : waitingHint);
    $('phoneConnectionHint').textContent = hint;
    $('phoneConnectionHint').hidden = !hint;
    $('phoneConnect').disabled = same && Boolean(session);
    $('phoneConnect').textContent = same && session ? (paired ? 'Connected' : ready ? 'Ready' : status + '…') : same && failed ? 'Retry' : 'Connect';
    $('phoneCopyObs').disabled = !form.room;
    $('phoneDisconnect').hidden = !session;
    $('phoneRetry').hidden = !failed;
    if (sending && cameraHidden) setSignal($('phoneStatus'), 'Camera hidden', 'warn');
    $('phoneHideCamera').hidden = !sending;
    buttonState($('phoneHideCamera'), cameraHidden, cameraHidden ? 'Show camera on the output' : 'Hide camera from the output');
    $('phoneLive').disabled = !sending && (!available || busy);
    $('phoneLiveLabel').textContent = sending ? 'Stop sending' : 'Go live';
    $('phoneLive').classList.toggle('transmitting', sending);
    $('enableCamera').disabled = busy;
    $('enableCamera').textContent = busy ? 'Opening…' : 'Enable camera';
    $('swapLens').disabled = !available || busy || torchBusy;
    $('phoneQuality').disabled = busy || torchBusy;
    $('phoneFrameRate').disabled = busy || torchBusy;
    $('phoneMic').disabled = Boolean(micRequest);
    $('phoneTorch').disabled = busy || torchBusy || !supportsTorch();
    updateCaptureDisplay();
    $('turnOffCamera').disabled = !openCamera && !microphone;
    buttonState($('phoneMic'), Boolean(microphone), microphone ? 'Mute microphone' : 'Enable microphone', microphone ? 'mic' : 'mic-off');
    buttonState($('phoneTorch'), torchOn, supportsTorch() ? (torchOn ? 'Turn torch off' : 'Turn torch on') : 'Torch unavailable', 'bolt');
  }

  function setHint(message) {
    $('phoneHint').textContent = message || '';
    $('phoneHint').hidden = !message;
  }

  function publish() {
    const routes = [...viewers.values()].filter((viewer) => viewer.pipe);
    if (!studioPipe && !routes.length) return;
    const nextVideo = sending && !cameraHidden && video?.readyState === 'live' ? video : null;
    const nextAudio = nextVideo && microphone?.readyState === 'live' ? microphone : null;
    if (publishedVideo !== nextVideo || publishedAudio !== nextAudio) {
      publishedVideo = nextVideo;
      publishedAudio = nextAudio;
      publishedStream = nextVideo ? new MediaStream([nextVideo, nextAudio].filter(Boolean)) : null;
    }
    const active = captureSettings();
    const preset = profile(activeQuality(active));
    const output = phoneStreamFormat(preset, active);
    const rate = captureBitrate(preset, frameRate, output);
    const snapshot = {
      kind: nextVideo ? 'video' : 'standby', image: { ...settings, rotation: activeRotation() }, audio: Boolean(nextAudio),
      paused: !sending || cameraHidden, format: nextVideo ? videoFormat(output, 'Camera active') : '',
      torchSupported: supportsTorch(), torchOn, rate, bitrate: rate, scale: output.scale, adaptive
    };
    studioPipe?.update(publishedStream, snapshot);
    const idleCamera = (!sending || cameraHidden) && hasSentVideo ? routeName(destination.slot) : '';
    for (const viewer of routes) {
      if (viewer.watching) viewer.pipe.update(publishedStream, { ...snapshot, paired: true, idleCamera });
      else viewer.pipe.update(null, { kind: 'standby', paired: true });
    }
  }

  function adopt(stream, requested) {
    const previous = video;
    const next = liveTrack(stream, 'video');
    if (!next) { stopTracks(stream); throw new Error('Missing video track'); }
    video = next;
    framePose = null;
    capabilities = reportedCapabilities(next);
    captureProblem = '';
    deviceStream = stream;
    syncCaptureOptions();
    facing = next.getSettings().facingMode || requested;
    torchOn = false;
    recoverStep = 0;
    next.contentHint = 'motion';
    next.addEventListener('ended', () => {
      if (video !== next || !openCamera) return;
      relinquishVideo();
      setHint('Camera disconnected. Trying to restore the feed.');
      updatePhone();
      scheduleRecovery();
    });
    refreshPreview();
    publish();
    if (previous && previous !== video) previous.stop();
    scheduleOrientation();
    requestWakeLock();
  }

  function relinquishVideo() {
    const old = video;
    deviceStream = null;
    video = null;
    capabilities = {};
    captureProblem = '';
    syncCaptureOptions();
    torchOn = false;
    refreshPreview();
    publish();
    old?.stop();
  }

  async function acquire(requested, exact, recovery = false) {
    if (busy || torchBusy) return false;
    busy = true;
    openCamera = true;
    updatePhone();
    const hadVideo = Boolean(video);
    const previousFacing = facing;
    const previousDevice = video?.getSettings().deviceId;
    const constraints = phoneVideoConstraints(frameRate);
    constraints.facingMode = { [exact ? 'exact' : 'ideal']: requested };
    const gum = async (video) => {
      try { return await navigator.mediaDevices.getUserMedia({ video, audio: false }); }
      catch (error) {
        if (!video.resizeMode || error.name !== 'OverconstrainedError' || error.constraint !== 'resizeMode') throw error;
        const { resizeMode, ...fallback } = video;
        return navigator.mediaDevices.getUserMedia({ video: fallback, audio: false });
      }
    };
    let acquired;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Secure context required');
      try {
        acquired = await gum(constraints);
      } catch (error) {
        if (!hadVideo || !['NotReadableError', 'AbortError'].includes(error.name)) throw error;
        relinquishVideo();
        acquired = await gum(constraints);
      }
      if (!openCamera) { stopTracks(acquired); return false; }
      const candidate = liveTrack(acquired, 'video');
      const actual = candidate?.getSettings();
      if (exact && hadVideo && ((actual?.facingMode && actual.facingMode !== requested) ||
          (!actual?.facingMode && previousDevice && actual?.deviceId === previousDevice))) {
        stopTracks(acquired);
        throw new DOMException('No alternate lens', 'NotFoundError');
      }
      adopt(acquired, requested);
      setHint('');
      return true;
    } catch (error) {
      if (exact && !video && openCamera && hadVideo) {
        try {
          const fallback = phoneVideoConstraints(frameRate);
          if (previousDevice) fallback.deviceId = { exact: previousDevice };
          else fallback.facingMode = { ideal: previousFacing };
          const recovered = await gum(fallback);
          if (openCamera) adopt(recovered, previousFacing);
          else stopTracks(recovered);
        } catch { scheduleRecovery(); }
      }
      if (openCamera && (!recovery || recoverStep >= 4)) {
        const message = exact && ['NotFoundError', 'OverconstrainedError'].includes(error.name)
          ? 'A second camera lens is unavailable.' : captureError(error);
        setHint(message);
        $('phoneEmptyTitle').textContent = 'Camera unavailable';
        $('phoneEmptyText').textContent = message;
      }
      return false;
    } finally {
      busy = false;
      updatePhone();
    }
  }

  function scheduleRecovery() {
    clearTimeout(recoverTimer);
    if (!openCamera || video || recoverStep >= 4) return;
    const delay = [650, 1400, 3200, 6500][recoverStep++];
    recoverTimer = setTimeout(async () => {
      if (openCamera && !video && !await acquire(facing, false, true)) scheduleRecovery();
    }, delay);
  }

  async function toggleMic() {
    if (micRequest) return;
    if (microphone) {
      const old = microphone;
      microphone = null;
      publish();
      old.stop();
      updatePhone();
      return;
    }
    const request = {};
    micRequest = request;
    updatePhone();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: audioConstraints() });
      const track = liveTrack(stream, 'audio');
      if (!track) throw new Error('No audio track');
      if (micRequest !== request) { stopTracks(stream); return; }
      microphone = track;
      track.addEventListener('ended', () => {
        if (microphone !== track) return;
        microphone = null;
        publish();
        updatePhone();
        setHint('The microphone disconnected.');
      });
      setHint('');
      publish();
    } catch (error) {
      if (micRequest === request) setHint(error?.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'The microphone is unavailable.');
    } finally {
      if (micRequest === request) micRequest = null;
      updatePhone();
    }
  }

  async function toggleTorch() {
    if (!supportsTorch() || torchBusy || busy) return;
    const track = video;
    torchBusy = true;
    updatePhone();
    try {
      await track.applyConstraints({ ...track.getConstraints(), advanced: [{ torch: !torchOn }] });
      if (video === track) {
        torchOn = !torchOn;
        publish();
      }
    } catch { setHint('This camera could not change its torch setting.'); }
    finally { torchBusy = false; updatePhone(); }
  }

  async function changeCapture(nextQuality, nextRate) {
    if (busy || torchBusy || !PHONE_QUALITIES.includes(nextQuality) || !CAPTURE_RATES.includes(nextRate) ||
        (nextQuality === quality && nextRate === frameRate)) return;
    const track = video;
    const active = captureSettings();
    if (nextQuality !== quality && !supportedPhoneQuality(nextQuality, active)) {
      syncCaptureOptions();
      return;
    }
    captureProblem = '';
    if (track && nextRate !== frameRate) {
      busy = true;
      updatePhone();
      try {
        const rate = captureRate(nextRate);
        const constraints = { ...track.getConstraints(), frameRate: { ideal: rate } };
        if (nextRate !== 'auto') {
          constraints.frameRate.min = rate - 0.5;
          constraints.frameRate.max = rate + 0.5;
        }
        if (active.width && active.height) {
          constraints.width = { exact: active.width };
          constraints.height = { exact: active.height };
        }
        try { await track.applyConstraints(constraints); }
        catch (error) {
          if (error.name !== 'OverconstrainedError' || !['width', 'height'].includes(error.constraint) || !active.width || !active.height) throw error;
          // Some phones report rotated settings but accept constraints in the sensor’s original orientation.
          await track.applyConstraints({ ...constraints, width: constraints.height, height: constraints.width });
        }
        if (track !== video) return;
        capabilities = reportedCapabilities(track);
      } catch {
        captureProblem = 'This frame rate is unavailable at the current camera format. The previous setting is still selected.';
        return;
      } finally {
        busy = false;
        syncCaptureOptions();
        updatePhone();
      }
    }
    quality = nextQuality;
    frameRate = nextRate;
    savePhone();
    syncCaptureOptions();
    updatePhone();
    publish();
  }

  async function requestWakeLock() {
    if (!openCamera || wakeLock || wakePending || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!openCamera) { await lock.release(); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch { /* Keep the camera usable when wake lock is unavailable. */ }
    finally { wakePending = false; }
  }

  function syncAddress() {
    const url = new URL(location.href);
    url.searchParams.set('room', destination.room);
    url.searchParams.set('cam', destination.slot);
    url.searchParams.delete('route');
    if (autoPair) url.searchParams.delete('join');
    else url.searchParams.set('join', '0');
    try { history.replaceState(null, '', url); } catch { /* The saved destination also works for local files. */ }
  }

  function formDestination() {
    return {
      room: normalizeRoom($('phoneRoom').value.trim()),
      slot: normalizeSlot($('phoneSlot').value) || 'CAM1'
    };
  }

  function sameDestination(value) {
    return value.room === destination.room && value.slot === destination.slot;
  }

  function openPhoneSettings(focus) {
    showTools(false);
    $('phoneRoom').value = destination.room;
    $('phoneSlot').value = destination.slot;
    $('phoneDialog').showModal();
    $('phoneDialog').scrollTop = 0;
    if (focus) $(focus).focus();
    updatePhone();
  }

  function trackVideoStart(waiting) {
    if (!waiting) {
      clearTimeout(videoDeadline);
      videoDeadline = null;
      return;
    }
    if (videoDeadline) return;
    videoDeadline = setTimeout(() => {
      videoDeadline = null;
      stopSending();
      linkMessage = 'Video couldn’t connect. Check your network and tap Go live to retry.';
      setHint(linkMessage);
      updatePhone();
    }, PHONE_VIDEO_TIMEOUT);
  }

  function clearPairDeadline() {
    clearTimeout(pairDeadline);
    pairDeadline = null;
  }

  function startPairDeadline() {
    if (pairDeadline) return;
    pairDeadline = setTimeout(() => {
      let message = linkTone === 'bad' && linkMessage
        ? linkMessage : 'AirCast couldn’t reach the signaling server. Check your internet connection and tap Retry.';
      if (navigator.onLine === false) message = 'Network offline. Reconnect to the internet and tap Retry.';
      disconnectPhone(message);
    }, PHONE_PAIR_TIMEOUT);
  }

  function detachPair() {
    const previous = session;
    pairingToken = session = null;
    clearPairDeadline();
    clearTimeout(confirmTimer);
    trackVideoStart(false);
    studioPipe?.close();
    studioPipe = studioLink = null;
    for (const [link, viewer] of viewers) {
      viewer.pipe?.close();
      link.leave();
    }
    viewers.clear();
    hostedBefore = hasSentVideo = false;
    publishedVideo = publishedAudio = publishedStream = null;
    studioState = linkMessage = linkTone = '';
    previous?.close();
  }

  function disconnectPhone(message = '') {
    detachPair();
    sending = autoPair = cameraHidden = false;
    if (destination.room) syncAddress();
    savePhone();
    linkMessage = message;
    linkTone = message ? 'bad' : '';
    setHint(message);
    updatePhone();
  }

  function acceptViewer(connection, token) {
    if (connection.metadata?.role !== 'direct-viewer' || normalizeSlot(connection.metadata?.slot) !== destination.slot) {
      connection.close();
      return;
    }
    const viewer = { watching: false, pipe: null, state: '' };
    new Link(connection, {
      open(link) {
        if (token !== pairingToken) { link.close(); return; }
        viewers.set(link, viewer);
        updatePhone();
      },
      receive(message, link) {
        if (viewers.get(link) !== viewer || token !== pairingToken) return;
        if (message.type === 'watch' && viewer.watching !== (message.active === true)) {
          viewer.watching = message.active === true;
          if (viewer.watching && !viewer.pipe) {
            viewer.pipe = new MediaPipe(link, true, {
              state(state) {
                if (viewers.get(link) !== viewer || token !== pairingToken) return;
                viewer.state = state;
                updatePhone();
              }
            });
          }
          publish();
          updatePhone();
        }
        if (message.type === 'media') viewer.pipe?.accept(message);
      },
      close(link) {
        viewer.pipe?.close();
        viewers.delete(link);
        if (token === pairingToken) updatePhone();
      }
    });
  }

  function connectPhone(next) {
    if (roomAccess && (next.room !== linkRoom || next.slot !== roomAccess.slot)) return;
    if (!next.room || (session && sameDestination(next))) return;
    detachPair();
    destination = next;
    autoPair = true;
    syncAddress();
    savePhone();
    setHint('');
    const token = {};
    let slotInUse = false;
    pairingToken = token;
    startPairDeadline();

    session = new ClientLink(endpoint(next.room), { role: 'phone', slot: next.slot, identity }, {
      status(message, tone) {
        if (pairingToken !== token || session?.signaler.ready) return;
        if (message === 'Room already in use') slotInUse = true;
        linkTone = slotInUse ? 'bad' : tone;
        if (navigator.onLine === false) linkMessage = 'Network offline. AirCast will retry when it returns.';
        else if (slotInUse) linkMessage = 'This camera slot is already in use. Close the other camera or choose another slot.';
        else linkMessage = tone === 'bad' ? message : 'Contacting the signaling server…';
        if (!studioPipe && !viewers.size) startPairDeadline();
        updatePhone();
      },
      ready() {
        if (pairingToken !== token) return;
        clearPairDeadline();
        slotInUse = false;
        hostedBefore = true;
        linkMessage = linkTone = '';
        updatePhone();
      },
      open(active) {
        if (pairingToken !== token) return;
        studioLink = active;
        confirmTimer = setTimeout(() => {
          if (studioLink === active && !studioPipe) active.close();
        }, 4500);
      },
      receive(message, active) {
        if (studioLink !== active) return;
        if (message.type === 'paired' && !studioPipe) {
          clearTimeout(confirmTimer);
          studioPipe = new MediaPipe(active, true, {
            state(state) {
              if (studioLink !== active) return;
              studioState = state;
              updatePhone();
            }
          });
          publish();
          updatePhone();
        }
        if (message.type === 'media') studioPipe?.accept(message);
        if (message.type === 'torch' && studioPipe) toggleTorch();
        if (message.type === 'occupied' || message.type === 'unknown-slot') session.retry = 3;
        if (message.type === 'replaced') disconnectPhone('This slot was paired from another AirCast tab.');
        if (message.type === 'stop') disconnectPhone('Camera Studio disconnected this camera.');
      },
      close(active) {
        if (studioLink !== active) return;
        clearTimeout(confirmTimer);
        studioPipe?.close();
        studioPipe = studioLink = null;
        studioState = '';
        updatePhone();
      }
    }, cameraEndpoint(next.room, next.slot));
    session.signaler.accept = (connection) => acceptViewer(connection, token);
    updatePhone();
  }

  function stopSending() {
    sending = cameraHidden = false;
    publish();
    if (session?.signaler.ready) linkMessage = '';
    setHint('');
    updatePhone();
  }

  function startSending() {
    if (!video || sending) return;
    if (!destination.room) { openPhoneSettings('phoneRoom'); return; }
    sending = true;
    if (!session) connectPhone(destination);
    if (session?.signaler.ready) linkMessage = '';
    setHint('');
    publish();
    updatePhone();
  }

  function leaveCamera(message = '') {
    if (!session && !openCamera && !microphone && !micRequest) return;
    disconnectPhone();
    openCamera = false;
    clearTimeout(recoverTimer);
    clearTimeout(orientationTimer);
    clearTimeout(motionTimer);
    micRequest = null;
    microphone?.stop();
    microphone = null;
    relinquishVideo();
    wakeLock?.release().catch(() => {});
    $('phoneEmptyTitle').textContent = 'Camera is off';
    $('phoneEmptyText').textContent = 'Enable your camera to check the shot.';
    setHint(message);
    updatePhone();
  }

  for (const slot of CAMERA_SLOTS) $('phoneSlot').add(new Option(routeName(slot), slot));
  $('phoneRoom').value = destination.room;
  $('phoneSlot').value = destination.slot;
  $('phoneConnectionForm').oninput = updatePhone;
  $('phoneConnectionForm').onsubmit = async (event) => {
    event.preventDefault();
    $('phoneRoom').blur();
    const target = formDestination();
    event.submitter.disabled = true;
    try {
      const address = new URL(makeUrl(target.room, 'phone', target.slot));
      const manifest = roomAccess ? null : await findRoom(target.room, address);
      if (manifest) {
        location.assign(roomLink(address, target.room, manifest));
        return;
      }
      connectPhone(target);
    } catch (error) { setHint(error.message); }
    finally { updatePhone(); }
  };
  $('phoneCopyObs').onclick = async () => {
    const { room, slot } = formDestination();
    if (!room) return;
    let url;
    try { url = await obsLink(new URL(makeUrl(room, 'obs', slot)), slot); }
    catch (error) { setHint(error.message); return; }
    if (await copy(url, routeName(slot) + ' OBS URL copied')) {
      const label = $('phoneCopyObs').lastElementChild;
      label.textContent = 'Copied';
      clearTimeout(copyObsTimer);
      copyObsTimer = setTimeout(() => { label.textContent = 'Copy OBS URL'; }, 2000);
    }
  };
  $('phoneRetry').onclick = () => connectPhone(destination);
  $('phoneDisconnect').onclick = () => disconnectPhone();
  if (!destination.room) setHint('Open Camera settings to connect.');
  $('enableCamera').onclick = () => { recoverStep = 0; acquire(facing, false); };
  $('swapLens').onclick = () => acquire(facing === 'environment' ? 'user' : 'environment', true);
  $('phoneHideCamera').onclick = () => {
    if (!sending) return;
    cameraHidden = !cameraHidden;
    publish();
    updatePhone();
  };
  $('phoneLive').onclick = () => sending ? stopSending() : startSending();
  $('phoneMic').onclick = toggleMic;
  $('phoneTorch').onclick = toggleTorch;
  $('phoneTools').onclick = () => showTools(!toolsOpen);
  $('phoneView').onclick = () => { if (toolsOpen) showTools(false); };
  $('phoneSettings').onclick = () => openPhoneSettings();
  $('phoneCaptureButton').onclick = () => openPhoneSettings('phoneQuality');
  $('phoneRotate').onclick = () => {
    settings.rotation = quarterAngle(activeRotation() + 90);
    autoRotate = false;
    savePhone();
    refreshPreview();
    publish();
  };
  $('phoneAutoRotate').onchange = () => setAutoRotate($('phoneAutoRotate').checked);
  $('phoneMotion').onclick = enableMotion;
  for (const value of PHONE_QUALITIES) $('phoneQuality').add(new Option(qualityLabel(value), value));
  for (const value of CAPTURE_RATES) $('phoneFrameRate').add(new Option('', value));
  $('phoneQuality').onchange = () => changeCapture($('phoneQuality').value, frameRate);
  $('phoneAdaptive').checked = adaptive;
  $('phoneAdaptive').onchange = () => { adaptive = $('phoneAdaptive').checked; savePhone(); publish(); };
  $('phoneLowBandwidth').onclick = () => changeCapture('360', frameRate);
  $('phoneFrameRate').onchange = () => changeCapture(quality, $('phoneFrameRate').value);
  syncCaptureOptions();
  refreshPreview();
  $('showGrid').checked = grid;
  $('showGrid').onchange = () => { grid = $('showGrid').checked; savePhone(); refreshPreview(); };
  $('phoneImageReset').onclick = () => { settings = imageSettings(null); savePhone(); refreshInspector(); refreshPreview(); publish(); };
  $('turnOffCamera').onclick = () => { leaveCamera(); $('phoneDialog').close(); };
  monitor.video.addEventListener('resize', () => { refreshPreview(); syncCaptureOptions(); updatePhone(); scheduleOrientation(); publish(); });
  screen.orientation?.addEventListener?.('change', scheduleOrientation);
  window.addEventListener('orientationchange', scheduleOrientation);
  window.addEventListener('resize', () => {
    const pose = screenPose();
    if (pose && (pose.angle !== screenReference?.angle || pose.portrait !== screenReference?.portrait)) scheduleOrientation();
  });
  window.addEventListener('deviceorientation', motionChanged, { passive: true });
  window.addEventListener('pagehide', () => leaveCamera());
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (openCamera && !video && !busy) { recoverStep = 0; scheduleRecovery(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      leaveCamera('Camera disconnected when you left this view.');
      return;
    }
    if (autoPair && !session) connectPhone(destination);
    requestWakeLock();
  });
  updatePhone();
  const diagnostics = AirCastDiagnostics.panel(() => {
    const direct = [...viewers.values()].find((viewer) => viewer.watching && viewer.pipe?.pc);
    return { route: studioPipe?.pc ? 'Studio uplink' : direct ? 'Direct camera uplink' : 'No upload',
      pc: studioPipe?.pc || direct?.pipe?.pc, signal: session?.signaler.ready ? 'Ready' : 'Waiting', retry: session?.retry };
  });
  $('phoneDiagnostics').onclick = () => { $('phoneDialog').close(); diagnostics.toggle(true); };
  if (autoPair && !document.hidden) connectPhone(destination);
  else loadLibrary('Peer').catch(() => {});
}
