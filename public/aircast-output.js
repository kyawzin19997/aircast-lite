'use strict';

function multiviewOutput(room) {
  if (roomAccess?.slot) return;
  const slots = [...new Set((query.get('slots') || '1,2,3').split(',').map((n) => normalizeSlot('CAM' + n)).filter(Boolean))].slice(0, 24);
  const grid = document.createElement('div');
  grid.className = 'output-grid';
  grid.setAttribute('aria-label', 'Studio Multiview');
  const columns = Number(query.get('columns'));
  const count = [2, 3, 4].includes(columns) ? columns : Math.max(1, Math.ceil(Math.sqrt(slots.length)));
  grid.style.setProperty('--columns', count);
  grid.style.setProperty('--rows', Math.max(1, Math.ceil(slots.length / count)));
  grid.dataset.background = query.get('bg') === 'black' ? 'black' : 'transparent';
  for (const slot of slots) {
    const url = new URL(makeUrl(room, 'obs', slot, true));
    url.searchParams.set('studio', '1');
    url.searchParams.set('slate', 'off');
    url.searchParams.set('bg', 'transparent');
    const tile = document.createElement('iframe');
    tile.title = routeName(slot);
    tile.allow = 'autoplay';
    tile.src = roomAccess ? protectedUrl(url) : url.href;
    grid.append(tile);
  }
  $('output').replaceChildren(grid);
}

function obsOutput() {
  const roomParam = query.get('room');
  const { room, slot, invalidSlot } = AirCastRooms.output(query);
  const mutedPreview = query.get('mute') === '1';
  if (!room || invalidSlot) return;
  const fixedPairSlot = slot || normalizeSlot(query.get('pairCam'));
  let pairSlot = fixedPairSlot || (roomParam === null || query.get('obs') === '1' ? '' : 'CAM1');
  let renderedPairSlot;
  const cleanFeed = query.get('slate') === 'off';
  const showPairing = !cleanFeed && query.get('pair') !== '0';
  const background = query.get('bg');
  if (background === 'black' || background === 'transparent') $('output').dataset.background = background;
  // Keep the sizing chosen by previously copied OBS URLs.
  const legacyFormat = query.get('frame');
  if (['horizontal', 'vertical'].includes(legacyFormat)) $('output').dataset.format = legacyFormat;
  if (query.get('view') === 'multiview') { multiviewOutput(room); return; }
  const feeds = new Map();
  const standby = { kind: 'standby' };
  let active = null;
  let snapshot = standby;
  let stream = null;
  let onPresented;
  let firstFrameTimer;
  let waitingLink;
  let autoplayMuted = false;
  let hasAired = false;
  const monitor = new DissolveMonitor($('output'), { change: updateSlates });
  $('outputPairRoom').textContent = room;
  $('outputPairKind').textContent = slot ? 'Camera feed' : 'Program';
  updateSlates();

  function renderPairTarget() {
    const target = pairSlot;
    renderedPairSlot = target;
    $('outputPairCamera').textContent = target ? routeName(target) : 'Waiting for Studio';
    const qr = $('outputPairQR');
    const hint = $('outputPairHint');
    const showManual = (message) => {
      qr.hidden = true;
      $('outputPairLayout').dataset.manual = 'true';
      hint.textContent = message;
    };
    if (roomAccess) { showManual('The host can issue a contributor invitation from the private room menu.'); return; }
    if (!target) {
      showManual('Keep Camera Studio open to get the pairing code.');
      return;
    }
    if (location.protocol !== 'https:' || localPage()) {
      showManual('Open AirCast over HTTPS on your phone, enter these connection details, then tap Go live.');
      return;
    }
    const url = makeUrl(room, 'phone', target);
    qr.hidden = false;
    delete $('outputPairLayout').dataset.manual;
    hint.textContent = 'Scan the code, enable your camera, then tap Go live.';
    const loading = document.createElement('small');
    loading.textContent = 'Loading QR code…';
    qr.replaceChildren(loading);
    const currentTarget = () => pairSlot === target && renderedPairSlot === target;
    loadLibrary('QRCode').then((QRCode) => {
      if (!currentTarget()) return;
      qr.replaceChildren();
      new QRCode(qr, { text: url, width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
    }).catch(() => {
      if (currentTarget()) {
        renderedPairSlot = undefined;
        showManual('Open AirCast on your phone, enter these connection details, then tap Go live.');
      }
    });
  }

  function updateSlates() {
    const idle = $('outputIdle');
    const name = snapshot.idleCamera;
    const waitingToPair = snapshot.kind === 'standby' && !name && !snapshot.paired;
    if (monitor.visible) hasAired = true;
    else if (waitingToPair) hasAired = false;

    const paused = Boolean(name && (snapshot.paired || hasAired));
    const keepPaused = !idle.hidden && !waitingToPair;
    const showIdle = Boolean(active && !monitor.visible && (paused || keepPaused));
    if (showIdle && name) $('outputIdleStatus').textContent = name + ' · Paired';
    idle.hidden = cleanFeed || !showIdle;

    const pair = $('outputPair');
    pair.hidden = !showPairing || monitor.visible || showIdle;
    if (!pair.hidden && renderedPairSlot !== pairSlot) renderPairTarget();
  }

  monitor.onMutedFallback = () => { autoplayMuted = true; };
  document.addEventListener('pointerdown', () => {
    if (mutedPreview) return;
    autoplayMuted = false;
    paint();
    monitor.play();
  });

  function paint() {
    const video = liveTrack(stream, 'video');
    const muted = mutedPreview || autoplayMuted || snapshot.kind !== 'video' || !snapshot.audio;
    monitor.display({
      muted, onReady: onPresented,
      stream: snapshot.kind === 'video' ? stream : null,
      url: snapshot.kind === 'mjpeg' ? snapshot.url : '',
      image: snapshot.image || BASE_IMAGE,
      show: snapshot.kind === 'mjpeg' || (snapshot.kind === 'video' && Boolean(video && !video.muted))
    });
    updateSlates();
    const waiting = active && snapshot.kind === 'video' && (!monitor.visible || monitor.video.srcObject !== stream);
    if (waiting && waitingLink === active) return;
    clearTimeout(firstFrameTimer);
    waitingLink = waiting ? active : null;
    if (waiting) {
      const route = active;
      firstFrameTimer = setTimeout(() => {
        if (waitingLink !== route) return;
        waitingLink = null;
        if (!monitor.visible || monitor.video.srcObject !== stream) route.close('First video frame timed out');
      }, 12000);
    }
  }

  function selectFeed() {
    const studio = feeds.get('studio');
    const direct = feeds.get('direct');
    const video = liveTrack(studio?.stream, 'video');
    const studioReady = Boolean(studio && (studio.snapshot.kind === 'mjpeg' || studio.snapshot.idleCamera ||
      (studio.snapshot.kind === 'video' && video && !video.muted)));

    function watchDirect(watching) {
      if (!direct || direct.watching === watching) return;
      direct.watching = watching;
      if (!watching) direct.snapshot = standby;
      direct.link.send({ type: 'watch', active: watching });
    }

    if (!studioReady) watchDirect(true);
    const directReady = direct && direct.snapshot !== standby;
    const next = studioReady ? studio : directReady ? direct : studio || direct;
    if (active !== (next?.link || null)) autoplayMuted = false;
    active = next?.link || null;
    snapshot = next?.snapshot || standby;
    stream = next?.stream || null;
    onPresented = next === studio && studioReady && slot && direct?.watching ? () => {
      if (feeds.get('studio') !== studio || active !== studio.link) return;
      watchDirect(false);
    } : next?.onPresented;
    if (studioReady && studio?.snapshot.idleCamera) watchDirect(false);
    paint();
  }

  function parseSnapshot(value) {
    const url = value.kind === 'mjpeg' ? httpURL(value.url) : '';
    const kind = url ? 'mjpeg' : value.kind === 'video' ? 'video' : 'standby';
    const idleCamera = kind === 'standby' && typeof value.idleCamera === 'string' ? value.idleCamera.trim().slice(0, 48) : '';
    const availableSlot = normalizeSlot(value.pairSlot) || (kind === 'standby' && !pairSlot ? 'CAM1' : '');
    if (!fixedPairSlot && availableSlot) pairSlot = availableSlot;
    return { kind, url, audio: value.audio === true, image: outputImage(value.image), idleCamera, paired: value.paired === true };
  }

  function subscribe(route, target, role) {
    return new ClientLink(target, { role, slot, smoothProgram: !slot }, {
      open(link) {
        const feed = { link, snapshot: standby, stream: null, watching: null };
        feeds.set(route, feed);
        feed.pipe = new MediaPipe(link, false, {
          snapshot(value) {
            if (feeds.get(route) !== feed || (route === 'direct' && !feed.watching)) return;
            feed.snapshot = parseSnapshot(value);
            selectFeed();
          },
          stream(value) {
            if (feeds.get(route) !== feed) return;
            feed.stream = value;
            selectFeed();
          }
        });
        selectFeed();
      },
      receive(message, link) {
        const feed = feeds.get(route);
        if (feed?.link !== link) return;
        if (!slot && message.type === 'program') {
          feed.program ||= new ProgramReceiver(link, {
            parse: parseSnapshot,
            cancel: () => monitor.cancelPending(),
            show: ({ snapshot, stream }, onReady) => {
              feed.snapshot = snapshot;
              feed.stream = stream;
              feed.onPresented = onReady;
              selectFeed();
            }
          });
          feed.program.accept(message);
        } else if (message.type === 'media') {
          if (message.programId) feed.program?.accept(message);
          else feed.pipe.accept(message);
        }
      },
      close(link) {
        const feed = feeds.get(route);
        if (feed?.link !== link) return;
        feeds.delete(route);
        feed.program?.close();
        feed.pipe.close();
        selectFeed();
      }
    });
  }

  const sessions = [subscribe('studio', endpoint(room), 'output')];
  if (slot && query.get('studio') !== '1') sessions.push(subscribe('direct', cameraEndpoint(room, slot), 'direct-viewer'));
  const diagnostic = AirCastDiagnostics.panel(() => {
    const feed = [...feeds.values()].find((entry) => entry.link === active);
    const channel = feed?.program?.current?.pipe || feed?.pipe;
    return { route: !active ? 'No route' : active === feeds.get('direct')?.link ? 'Direct camera' : 'Studio output',
      pc: channel?.pc, signal: sessions.some((session) => session.signaler.ready) ? 'Ready' : 'Connecting',
      retry: Math.max(...sessions.map((session) => session.retry)) };
  });
  if (query.get('debug') === '1') diagnostic.toggle(true);
  window.addEventListener('pagehide', () => sessions.forEach((session) => session.close()));
}
