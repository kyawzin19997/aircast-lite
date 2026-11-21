'use strict';

function studio() {
  const legacy = saved(KEY);
  const room = normalizeRoom(query.get('room'));
  const roomKey = 'aircast-room:' + (roomAccess ? 'sealed:' : 'public:') + room;
  const existing = saved(roomKey);
  const stored = existing.room ? existing : !roomAccess && normalizeRoom(legacy.room) === room ? legacy : {};
  let multiviewColumns = MULTIVIEW_LAYOUTS.includes(stored.multiviewColumns) ? stored.multiviewColumns : 'auto';
  let programLayout = stored.programLayout === 'grid' ? 'grid' : 'program';
  let signaler;
  let selected = '';
  let dialogSlot = '';
  let sourceView = 'phone';
  let qrToken = 0;
  let monitoring = false;
  let recording = null;
  let program = stored.program === '' ? '' : normalizeSlot(stored.program) || null;
  let programImage = imageSettings(stored.programImage, true);
  const cameras = new Map();
  const subscriptions = new Set();
  const programTiles = new Map();
  const attempts = new Map();
  const receiverLinks = new Set();
  const cards = new Map();
  const restored = new Map((Array.isArray(stored.slots) ? stored.slots : []).filter((entry) =>
    normalizeSlot(entry?.slot) && typeof entry.name === 'string').map((entry) => [entry.slot, entry]));
  const initial = restored.size ? [...restored.keys()] : DEFAULT_SLOTS;

  function add(slot, entry = {}) {
    const camera = {
      slot, name: entry.name?.trim().slice(0, 36) || routeName(slot),
      image: imageSettings(entry.image, true), mjpeg: httpURL(entry.mjpeg),
      phoneImage: BASE_IMAGE, link: null, kind: '', stream: null, ready: false
    };
    cameras.set(slot, camera);
    return camera;
  }

  initial.forEach((slot) => add(slot, restored.get(slot)));
  const ordered = () => [...cameras.values()].sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot));
  selected = cameras.has(stored.selected) ? stored.selected : ordered()[0].slot;
  if (program && !cameras.has(program)) program = null;

  function persist() {
    store(roomKey, { room, program, programImage, selected, programLayout, multiviewColumns, slots: ordered().map(({ slot, name, image, mjpeg }) => ({ slot, name, image, mjpeg })) });
  }

  async function obsUrl(slot = '', muted = false, options = {}) {
    const url = new URL(makeUrl(room, 'obs', slot, muted));
    if (options.clean) url.searchParams.set('slate', 'off');
    if (typeof options.black === 'boolean') url.searchParams.set('bg', options.black ? 'black' : 'transparent');
    if (options.frame) url.searchParams.set('frame', options.frame);
    return url.href;
  }

  async function copyObsOutput(slot, options, field) {
    try {
      const url = await obsUrl(slot, options?.muted, options);
      if (field) { field.value = url; $('outputUrlRow').hidden = false; }
      const name = cameras.get(slot)?.name || 'Program';
      await copy(url, name + ' OBS URL copied');
    } catch (error) { notify(error.message, true); }
  }

  async function previewObsOutput(slot, muted, options) {
    const preview = window.open('about:blank', '_blank');
    if (!preview) { notify('Allow pop-ups to open the preview.', true); return; }
    preview.opener = null;
    try {
      const url = new URL(await obsUrl(slot, muted, options));
      url.searchParams.set('debug','1');
      preview.location.replace(url.href);
    } catch (error) { preview.close(); notify(error.message, true); }
  }

  const managerOptions = () => ({ clean: $('outputClean').checked, black: $('outputBlack').checked,
    frame: $('outputCanvas').value, muted: !$('outputAudio').checked });
  function updateManager() {
    const sizes = { '720': [1280,720], '1080': [1920,1080], '2160': [3840,2160] };
    const dimensions = sizes[$('outputSize').value].slice();
    if ($('outputCanvas').value === 'vertical') dimensions.reverse();
    $('outputDimensions').textContent = 'Set OBS Browser Source Width and Height to ' + dimensions.join(' × ') + '.';
    $('outputScope').textContent = 'Browser Source size sets the OBS canvas. Capture quality is set at the camera.';
    $('outputUrlRow').hidden = true;
  }
  $('openOutputManager').onclick = () => {
    $('outputChoice').replaceChildren(new Option('Program output', ''), ...ordered().map((camera) => new Option(camera.name, camera.slot)));
    updateManager();
    $('outputManager').showModal();
  };
  $('outputForm').onchange = updateManager;
  $('outputForm').onsubmit = (event) => {
    event.preventDefault();
    copyObsOutput($('outputChoice').value, managerOptions(), $('outputUrl'));
  };
  $('previewOutput').onclick = () => previewObsOutput($('outputChoice').value, true, managerOptions());

  const monitor = new DissolveMonitor($('programView'), { change: (visible) => { $('programEmpty').hidden = visible; } });
  monitor.onMutedFallback = () => {
    monitoring = false;
    buttonState($('audioMonitor'), false, 'Monitor Program audio', 'mute');
    notify('Click the audio monitor button to enable playback.', true);
  };
  const usbMonitor = new Monitor($('usbPreview'), { change: (visible) => { $('usbPreviewEmpty').hidden = visible; } });
  let imageTimer;
  let programImagePending = false;
  const pendingImage = new Set();
  const refreshImage = createInspector($('imageControls'), () => cameras.get(selected).image,
    (key, value, commit) => changeSourceImage(cameras.get(selected), key, value, commit), true);
  const refreshUsbImage = createInspector($('usbImageControls'), () => cameras.get(dialogSlot)?.image || imageSettings(null, true),
    (key, value, commit) => changeSourceImage(cameras.get(dialogSlot), key, value, commit), true);
  const refreshProgramImage = createInspector($('programImageControls'), () => programImage, (key, value, commit) => {
    programImage[key] = value;
    if (commit) persist();
    programImagePending = true;
    scheduleImageUpdate();
  }, true);

  function changeSourceImage(camera, key, value, commit) {
    if (!camera) return;
    camera.image[key] = value;
    if (commit) persist();
    pendingImage.add(camera);
    scheduleImageUpdate();
  }

  function scheduleImageUpdate() {
    if (imageTimer) return;
    imageTimer = setTimeout(() => {
      imageTimer = null;
      const updateProgramImage = programImagePending;
      programImagePending = false;
      const programSource = cameras.get(program);
      for (const camera of pendingImage) if (cameras.get(camera.slot) === camera) refreshCamera(camera);
      if (updateProgramImage && !pendingImage.has(programSource)) updateProgram();
      pendingImage.clear();
      refreshImage();
      if ($('sourceDialog').open && sourceView === 'usb') refreshUsbImage();
    }, 24);
  }

  function resetSourceImage(camera) {
    if (!camera) return;
    camera.image = imageSettings(null, true);
    persist();
    refreshImage();
    refreshUsbImage();
    refreshCamera(camera);
  }

  function updateUsbPreview() {
    const camera = cameras.get(dialogSlot);
    const live = camera?.kind === 'usb' && camera.ready;
    usbMonitor.display({ stream: live ? camera.stream : null, image: cameraImage(camera), show: live });
    $('usbPreviewStatus').textContent = live ? camera.format : 'Disconnected';
    $('usbBody').querySelector('[type=submit]').textContent = live ? 'Apply capture settings' : 'Connect camera';
  }

  const extras = $('imageControls').querySelector('[data-extras]');
  extras.hidden = false;
  extras.innerHTML = '<button class="btn ghost tiny" id="remoteTorch">' + icon('bolt') + 'Torch</button><button class="btn ghost tiny" id="recordClip">Record raw clip</button>';
  $('remoteTorch').onclick = () => cameras.get(selected).link?.send({ type: 'torch' });
  $('recordClip').onclick = () => toggleRecording();

  function sourceStatus(camera) {
    if (camera.kind === 'phone') return camera.ready && camera.format ? 'Live · ' + camera.format : camera.ready ? 'Live' : 'Paired';
    if (camera.kind === 'usb') return camera.ready ? (camera.format || 'USB connected') : 'USB camera disconnected';
    if (camera.kind === 'mjpeg') return camera.ready ? 'Network camera' : (camera.failed ? 'Stream unavailable' : 'Opening network stream');
    return 'Unpaired';
  }

  function makeCard(camera) {
    const row = document.createElement('div');
    row.className = 'source-row';
    row.innerHTML = '<button class="source-select" type="button" aria-pressed="false"><span class="source-id mono"></span><span class="source-label"><strong class="truncate"></strong><small class="truncate"></small></span></button><div class="group source-actions"><button class="btn ghost tiny source-obs" type="button" data-copy>' + icon('copy') + '<span>OBS</span></button><button class="btn ghost square" type="button" data-pair>' + icon('phone') + '</button><button class="btn ghost square" type="button" data-options>' + icon('gear') + '</button></div>';
    row.querySelector('.source-id').textContent = String(slotNumber(camera.slot)).padStart(2, '0');
    const select = row.querySelector('.source-select');
    select.onclick = () => {
      selected = camera.slot;
      persist();
      refreshSelection();
    };
    row.querySelector('[data-copy]').onclick = () => copyObsOutput(camera.slot);
    row.querySelector('[data-pair]').onclick = () => openSource(camera.slot, 'phone');
    row.querySelector('[data-options]').onclick = () => openSource(camera.slot, camera.kind === 'phone' ? 'phone' : camera.kind || 'phone');

    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = '<button class="tile-select" type="button"><div class="viewport tile-stage">' + icon('camera') + '</div></button><div class="spread tile-info tile-footer"><span class="group truncate"><span class="dot"></span><span class="truncate" data-name></span></span><kbd class="keycap"></kbd><button class="btn ghost square tile-copy" type="button" data-copy>' + icon('copy') + '</button></div>';
    tile.querySelector('kbd').textContent = slotNumber(camera.slot);
    tile.onclick = () => camera.ready ? cut(camera.slot) : openSource(camera.slot, camera.kind === 'mjpeg' ? 'mjpeg' : camera.kind === 'usb' ? 'usb' : 'phone');
    tile.querySelector('[data-copy]').onclick = (event) => {
      event.stopPropagation();
      copyObsOutput(camera.slot);
    };
    const tileMonitor = new Monitor(tile.querySelector('.tile-stage'));
    tileMonitor.onImageState = (ready, url) => {
      if (camera.kind !== 'mjpeg' || camera.url !== url || (camera.ready === ready && camera.failed === !ready)) return;
      camera.ready = ready;
      camera.failed = !ready;
      useFirstProgram(camera);
      refreshCamera(camera);
    };

    cards.set(camera.slot, { row, tile, tileMonitor });
  }

  function syncCards() {
    const sourceList = $('sourceList');
    const tiles = $('tiles');
    for (const [index, camera] of ordered().entries()) {
      if (!cards.has(camera.slot)) makeCard(camera);
      const { row, tile } = cards.get(camera.slot);
      if (sourceList.children[index] !== row) sourceList.insertBefore(row, sourceList.children[index] || null);
      if (tiles.children[index] !== tile) tiles.insertBefore(tile, tiles.children[index] || null);
      refreshCamera(camera, false);
    }
    document.querySelectorAll('[data-add-slot]').forEach((button) => {
      button.disabled = cameras.size >= CAMERA_SLOTS.length;
      button.title = button.disabled ? 'All camera slots are in use' : '';
    });
    refreshSelection();
  }

  function refreshSelection() {
    for (const [slot, { row, tile }] of cards) {
      row.classList.toggle('is-selected', slot === selected);
      row.querySelector('.source-select').setAttribute('aria-pressed', String(slot === selected));
      tile.setAttribute('aria-current', String(slot === program));
    }
    $('inspectorName').textContent = cameras.get(selected).name;
    refreshImage();
    refreshExtras();
    updateProgram();
  }

  function refreshExtras() {
    const source = cameras.get(selected);
    $('remoteTorch').disabled = !source.torchSupported;
    $('remoteTorch').hidden = !source.torchSupported;
    buttonState($('remoteTorch'), source.torchOn === true);
    $('recordClip').disabled = !recording && (!source.ready || !source.stream || !window.MediaRecorder);
    $('recordClip').textContent = recording ? 'Stop clip' : 'Record raw clip';
    buttonState($('recordClip'), Boolean(recording));
  }

  function refreshCamera(camera, output = true) {
    const card = cards.get(camera.slot);
    if (!card) return;
    const { row, tile, tileMonitor } = card;
    row.querySelector('strong').textContent = camera.name;
    const status = row.querySelector('small');
    status.textContent = sourceStatus(camera);
    status.dataset.pairState = camera.kind === 'phone' ? (camera.ready ? 'live' : 'paired') : '';
    row.querySelector('[data-pair]').title = row.querySelector('[data-pair]').ariaLabel = 'Pair phone with ' + camera.name;
    row.querySelector('[data-options]').title = row.querySelector('[data-options]').ariaLabel = 'Configure ' + camera.name;
    const copyLabel = 'Copy OBS URL for ' + camera.name;
    for (const control of [row, tile]) {
      const button = control.querySelector('[data-copy]');
      button.title = button.ariaLabel = copyLabel;
    }
    tile.querySelector('[data-name]').textContent = camera.name;
    const dot = tile.querySelector('.dot');
    dot.className = 'dot' + (camera.ready ? (camera.slot === program ? ' live' : ' active') : camera.kind === 'phone' ? ' active' : camera.kind ? ' warn' : '');
    const selectTile = tile.querySelector('.tile-select');
    selectTile.title = selectTile.ariaLabel = camera.ready ? 'Cut to ' + camera.name : 'Set up ' + camera.name;
    tileMonitor.display({ stream: camera.ready ? camera.stream : null, url: camera.kind === 'mjpeg' ? camera.url : '', image: cameraImage(camera) });
    if (programTiles.has(camera.slot)) displayProgramTile(camera, programTiles.get(camera.slot));
    $('cameraCount').textContent = [...cameras.values()].filter((source) => source.ready || (source.kind === 'phone' && source.link?.open)).length + ' connected';
    if ($('sourceDialog').open && sourceView === 'usb' && camera.slot === dialogSlot) updateUsbPreview();
    if (output) {
      if (camera.slot === selected) refreshExtras();
      if (camera.slot === program) updateProgram();
      else {
        if (programLayout === 'grid') updateProgramBadge();
        syncOutputs(camera.slot);
      }
    }
  }

  function cameraImage(camera) {
    return combineImages(camera?.phoneImage || BASE_IMAGE, camera?.image || imageSettings(null, true));
  }

  function programFraming(camera) {
    return outputImage(combineImages(cameraImage(camera), programImage));
  }

  function displayProgramTile(camera, tile) {
    tile.display({ stream: camera.ready ? camera.stream : null, url: camera.ready ? camera.url : '', image: outputImage(cameraImage(camera)) });
  }

  function updateProgramGrid() {
    const grid = $('programGrid');
    const enabled = programLayout === 'grid';
    $('programView').dataset.programLayout = programLayout;
    grid.hidden = !enabled;
    for (const [slot, tile] of programTiles) {
      if (enabled && cameras.has(slot)) continue;
      tile.destroy();
      tile.root.remove();
      programTiles.delete(slot);
    }
    if (!enabled) return;
    sizeProgramGrid(grid, cameras.size, multiviewColumns);
    for (const [index, camera] of ordered().entries()) {
      let tile = programTiles.get(camera.slot);
      if (!tile) {
        const cell = document.createElement('div');
        cell.className = 'viewport program-cell';
        cell.dataset.slot = camera.slot;
        tile = new Monitor(cell);
        programTiles.set(camera.slot, tile);
      }
      if (grid.children[index] !== tile.root) grid.insertBefore(tile.root, grid.children[index] || null);
      displayProgramTile(camera, tile);
    }
  }

  function updateProgramBadge() {
    const grid = programLayout === 'grid';
    const active = grid ? [...cameras.values()].some((camera) => camera.ready) : Boolean(cameras.get(program)?.ready);
    $('programBadge').dataset.live = String(active);
    $('programBadge').lastElementChild.textContent = grid ? 'Multiview' : active ? 'On program' : 'Standby';
  }

  function updateProgram() {
    const camera = cameras.get(program);
    const active = Boolean(camera?.ready);
    updateProgramBadge();
    $('programStandby').hidden = !program;
    $('programName').hidden = !camera;
    $('programName').textContent = camera?.name || '';
    $('emptyTitle').textContent = camera ? (camera.ready ? 'Connecting video' : 'Waiting for ' + camera.name) : 'No camera on program';
    $('emptyText').textContent = camera ? (camera.ready ? 'Opening the selected feed.' : 'Program will resume when this camera returns.') : 'Pair a phone or connect a camera to get started.';
    $('quickPair').hidden = Boolean(camera?.ready);
    $('quickUSB').hidden = Boolean(camera?.ready);
    $('audioMonitor').disabled = !cameraAudio(camera);
    monitor.display({
      stream: active ? camera.stream : null, url: active ? camera.url : '',
      image: programFraming(camera), show: active, muted: !monitoring
    });
    updateProgramGrid();
    syncOutputs();
  }

  function cameraAudio(camera) {
    return Boolean(camera?.ready && (camera.kind !== 'phone' || camera.audio) && liveTrack(camera.stream, 'audio'));
  }

  function syncOutputs(changedSlot) {
    let programs = 0;
    for (const output of subscriptions) {
      if (!output.slot) {
        programs++;
        if (output.link.connection.metadata?.programLayout === true) {
          const layout = { mode: programLayout, slots: ordered().map((item) => item.slot), columns: multiviewColumns };
          const signature = JSON.stringify(layout);
          if (output.layout !== signature) { output.layout = signature; output.link.send({ type: 'layout', ...layout }); }
        }
      }
      if (changedSlot && output.slot !== changedSlot) continue;
      const camera = cameras.get(output.slot || program);
      const pairSlot = output.slot || program || selected;
      const image = output.slot ? cameraImage(camera) : programFraming(camera);
      if (!camera?.ready) {
        const paired = camera?.kind === 'phone' && Boolean(camera.link?.open);
        const idleCamera = paired && camera.phonePaused && camera.phoneAired ? camera.name : '';
        output.pipe.update(null, { kind: 'standby', idleCamera, pairSlot, paired });
      } else if (camera.kind === 'mjpeg') {
        output.pipe.update(null, { kind: 'mjpeg', url: camera.url, image, pairSlot });
      } else {
        output.pipe.update(camera.stream, { kind: 'video', image, audio: cameraAudio(camera), bitrate: camera.bitrate || 3500000, pairSlot });
      }
    }
    setSignal($('outputStatus'), programs ? programs + (programs === 1 ? ' output connected' : ' outputs connected') : 'Waiting for OBS', programs ? 'good' : '');
  }

  function cut(slot) {
    if (slot && !cameras.get(slot)?.ready) return;
    const prior = program;
    program = slot;
    if (slot) selected = slot;
    persist();
    if (prior && cameras.has(prior)) refreshCamera(cameras.get(prior), false);
    if (slot) refreshCamera(cameras.get(slot), false);
    refreshSelection();
  }

  function useFirstProgram(camera) {
    if (program !== null || !camera.ready) return;
    program = camera.slot;
    cards.get(camera.slot)?.tile.setAttribute('aria-current', 'true');
    persist();
  }

  function disconnect(camera, cancelAttempt = true) {
    if (cancelAttempt) attempts.delete(camera.slot);
    const link = camera.link;
    camera.link = null;
    link?.close();
    if (camera.kind === 'usb') stopTracks(camera.stream);
    camera.kind = '';
    camera.stream = null;
    camera.url = '';
    camera.ready = false;
    camera.failed = false;
    camera.format = '';
    camera.torchSupported = false;
    camera.torchOn = false;
    camera.phoneImage = BASE_IMAGE;
    camera.audio = false;
    camera.bitrate = 0;
    camera.phoneVideo = false;
    camera.phonePaused = false;
    camera.phoneAired = false;
    camera.mjpeg = '';
    camera.usb = null;
  }

  function startRoom() {
    $('roomCode').textContent = room;
    $('roomButton').title = roomAccess ? 'Encrypted room' : 'Public room';
    signaler = new Signaler(endpoint(room), (message, tone) => {
      setSignal($('studioSignal'), message, tone);
    });
    signaler.accept = accept;
  }

  function rejectPair(link, type) {
    link.send({ type });
    setTimeout(() => link.close(), 250);
  }

  function accept(connection) {
    const metadata = connection.metadata || {};
    const slot = normalizeSlot(metadata.slot);
    if (metadata.role === 'output' && (!metadata.slot || slot)) {
      let output;
      const link = new Link(connection, {
        open: (active) => {
          const pipe = !slot && metadata.smoothProgram === true ? new ProgramSender(active) : new MediaPipe(active, true);
          output = { slot, pipe, link: active };
          subscriptions.add(output);
          syncOutputs();
        },
        receive: (message) => {
          if (message.type === 'media' || message.type === 'program') output?.pipe.accept(message);
        },
        close: (active) => {
          receiverLinks.delete(active);
          if (!output) return;
          output.pipe.close();
          subscriptions.delete(output);
          syncOutputs();
        }
      });
      receiverLinks.add(link);
    } else if (metadata.role === 'phone' && slot) {
      const camera = cameras.get(slot);
      let pipe;
      const phone = new Link(connection, {
        open: (link) => {
          if (!camera || cameras.get(slot) !== camera) { rejectPair(link, 'unknown-slot'); return; }
          const prior = camera.link;
          const occupied = camera.kind && camera.kind !== 'phone';
          if (occupied || (prior && prior.connection.metadata?.identity !== metadata.identity)) {
            rejectPair(link, 'occupied');
            return;
          }
          // Reclaim a slot after a reload, but leave any other camera slots alone.
          camera.link = link;
          if (prior) rejectPair(prior, 'replaced');
          camera.kind = 'phone';
          camera.stream = null;
          camera.ready = false;
          camera.format = '';
          camera.phoneImage = BASE_IMAGE;
          camera.torchSupported = false;
          camera.torchOn = false;
          camera.audio = false;
          camera.phoneVideo = false;
          camera.phonePaused = false;
          camera.phoneAired = false;
          const updatePhoneReadiness = () => {
            const video = liveTrack(camera.stream, 'video');
            camera.ready = Boolean(camera.phoneVideo && video && !video.muted);
            camera.phoneAired ||= camera.ready;
            useFirstProgram(camera);
            refreshCamera(camera);
          };
          pipe = new MediaPipe(link, false, {
            stream: (stream) => {
              if (camera.link !== link) return;
              camera.stream = stream;
              updatePhoneReadiness();
            },
            snapshot: (snapshot) => {
              if (camera.link !== link) return;
              camera.format = typeof snapshot.format === 'string' ? snapshot.format.slice(0, 28) : '';
              camera.phoneVideo = snapshot.kind === 'video';
              camera.phonePaused = !camera.phoneVideo && snapshot.paused === true;
              camera.audio = snapshot.audio === true;
              camera.bitrate = bounded(snapshot.rate, 250000, MAX_VIDEO_BITRATE, 2400000);
              camera.phoneImage = imageSettings(snapshot.image);
              camera.torchSupported = snapshot.torchSupported === true;
              camera.torchOn = snapshot.torchOn === true;
              updatePhoneReadiness();
            }
          });
          link.send({ type: 'paired' });
          refreshCamera(camera);
        },
        receive: (message, link) => { if (camera?.link === link && message.type === 'media') pipe?.accept(message); },
        close: (link) => {
          receiverLinks.delete(link);
          pipe?.close();
          if (camera?.link !== link) return;
          disconnect(camera, false);
          refreshCamera(camera);
        }
      });
      receiverLinks.add(phone);
    } else {
      connection.close();
    }
  }
  function formError(message) {
    $('sourceError').textContent = message;
    $('sourceError').hidden = !message;
  }

  async function renderPair(camera) {
    const token = ++qrToken;
    const url = makeUrl(room, 'phone', camera.slot);
    $('pairURL').value = url;
    $('pairRoute').textContent = 'Scan with your phone to pair this camera. Tap Go live when you’re ready.';
    const offline = localPage() || location.protocol !== 'https:';
    $('pairNotice').hidden = !offline;
    $('pairNotice').textContent = 'For phone pairing across devices, open AirCast from a shared HTTPS address first.';
    const box = $('pairQR');
    box.hidden = offline;
    box.textContent = offline ? '' : 'Loading QR code…';
    if (offline) return;
    try {
      const QRCode = await loadLibrary('QRCode');
      if (token !== qrToken) return;
      box.textContent = '';
      new QRCode(box, { text: url, width: 156, height: 156, correctLevel: QRCode.CorrectLevel.M });
    } catch {
      if (token === qrToken) box.textContent = 'QR code unavailable. Copy the pairing link below.';
    }
  }

  function showSourceType(type) {
    sourceView = type;
    const camera = cameras.get(dialogSlot);
    ++qrToken;
    formError('');
    $('pairBody').hidden = type !== 'phone';
    $('sourceDialog').dataset.source = type;
    $('usbBody').hidden = type !== 'usb';
    $('usbFraming').hidden = type !== 'usb';
    if (type !== 'usb') usbMonitor.display({ show: false });
    $('mjpegBody').hidden = type !== 'mjpeg';
    $('disconnectSource').hidden = !camera.kind;
    $('disconnectSource').textContent = camera.kind === 'phone' ? 'Disconnect phone' : 'Disconnect source';
    $('removeSlot').disabled = cameras.size < 2;
    document.querySelectorAll('[data-source-type]').forEach((button) => buttonState(button, button.dataset.sourceType === type));
    if (type === 'phone') renderPair(camera);
    if (type === 'usb') {
      $('usbQuality').value = camera.usb?.quality || '720';
      $('usbMic').checked = camera.usb?.mic || false;
      listDevices(camera.usb?.deviceId);
      refreshUsbImage();
      updateUsbPreview();
    }
    if (type === 'mjpeg') $('mjpegURL').value = camera.mjpeg;
  }

  function openSource(slot, type = 'phone') {
    if (!cameras.has(slot)) return;
    dialogSlot = slot;
    const camera = cameras.get(slot);
    $('sourceDialogTitle').textContent = camera.name + ' setup';
    $('slotName').value = camera.name;
    showSourceType(type);
    $('sourceDialog').showModal();
  }

  async function listDevices(preferred) {
    let devices;
    try { devices = await navigator.mediaDevices?.enumerateDevices(); }
    catch { return; }
    if (sourceView !== 'usb') return;
    const field = $('usbDevice');
    const current = preferred || field.value;
    while (field.options.length > 1) field.remove(1);
    for (const [index, item] of (devices || []).filter((device) => device.kind === 'videoinput' && device.deviceId).entries()) {
      field.add(new Option(item.label || 'Camera ' + (index + 1), item.deviceId));
    }
    field.value = [...field.options].some((option) => option.value === current) ? current : '';
  }

  async function connectUSB(camera, config, recovery = false) {
    const token = {};
    attempts.set(camera.slot, token);
    let stream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs HTTPS or localhost.');
      const video = videoConstraints(config.quality);
      if (config.deviceId) video.deviceId = { exact: config.deviceId };
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      let micFailed = false;
      if (config.mic) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ video: false, audio: audioConstraints() });
          mic.getAudioTracks().forEach((track) => stream.addTrack(track));
        } catch { micFailed = true; }
      }
      if (attempts.get(camera.slot) !== token || cameras.get(camera.slot) !== camera) { stopTracks(stream); return false; }
      const activeTrack = liveTrack(stream, 'video');
      if (!activeTrack) throw new Error('No video track was returned.');
      disconnect(camera);
      camera.kind = 'usb';
      camera.ready = true;
      camera.usb = { ...config, deviceId: activeTrack.getSettings().deviceId || config.deviceId };
      camera.stream = stream;
      camera.format = cameraFormat(activeTrack, 'USB camera');
      camera.bitrate = profile(config.quality).bitrate;
      activeTrack.addEventListener('ended', () => {
        if (camera.stream !== stream) return;
        stopTracks(stream);
        camera.ready = false;
        camera.stream = null;
        refreshCamera(camera);
        retryUSB(camera, 0);
      });
      for (const audio of stream.getAudioTracks()) {
        audio.addEventListener('ended', () => {
          if (camera.stream === stream) refreshCamera(camera);
        });
      }
      useFirstProgram(camera);
      refreshCamera(camera);
      persist();
      if (micFailed) notify('Camera connected. The microphone was unavailable.', true);
      return true;
    } catch (error) {
      stopTracks(stream);
      if (!recovery && attempts.get(camera.slot) === token) formError(captureError(error));
      return false;
    } finally {
      if (attempts.get(camera.slot) === token) attempts.delete(camera.slot);
    }
  }

  function retryUSB(camera, retry) {
    if (retry > 3 || !camera.usb) return;
    setTimeout(async () => {
      if (cameras.get(camera.slot) !== camera || camera.kind !== 'usb' || camera.ready || attempts.has(camera.slot)) return;
      if (!await connectUSB(camera, camera.usb, true)) retryUSB(camera, retry + 1);
    }, [800, 1800, 3800, 7500][retry]);
  }

  function setMjpeg(camera, url) {
    disconnect(camera);
    camera.kind = 'mjpeg';
    camera.url = url;
    camera.mjpeg = url;
    refreshCamera(camera);
  }

  function toggleRecording() {
    if (recording) {
      if (recording.state !== 'inactive') recording.stop();
      return;
    }
    const camera = cameras.get(selected);
    if (!camera?.ready || !camera.stream || !window.MediaRecorder) return;
    try {
      const tracks = ['video', 'audio'].map((kind) => liveTrack(camera.stream, kind)).filter(Boolean);
      const recorder = new MediaRecorder(new MediaStream(tracks));
      const chunks = [];
      const name = camera.name.replace(/[^\p{L}\p{N}_ -]/gu, '').trim() || camera.slot;
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        recording = null;
        refreshExtras();
        if (!chunks.length) return;
        const type = recorder.mimeType || chunks[0].type || 'video/webm';
        const url = URL.createObjectURL(new Blob(chunks, { type }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name + '-' + new Date().toISOString().replace(/[:.]/g, '-') + (type.startsWith('video/mp4') ? '.mp4' : '.webm');
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      };
      recorder.onerror = () => notify('Clip recording was interrupted.', true);
      recorder.start(1000);
      recording = recorder;
      refreshExtras();
    } catch { notify('This camera could not be recorded by the browser.', true); }
  }

  $('quickPair').onclick = () => openSource(program || selected);
  $('quickUSB').onclick = () => openSource(program || selected, 'usb');
  $('programStandby').onclick = () => cut('');
  $('programFull').onclick = () => fullscreen($('programView'));
  $('programFraming').onclick = () => {
    const panel = $('programFramingPanel');
    panel.hidden = !panel.hidden;
    const open = !panel.hidden;
    $('programFraming').setAttribute('aria-expanded', String(open));
    buttonState($('programFraming'), open);
  };
  $('programImageReset').onclick = () => {
    programImage = imageSettings(null, true);
    persist();
    refreshProgramImage();
    updateProgram();
  };
  $('multiFull').onclick = () => fullscreen($('tiles'));
  $('multiviewColumns').value = multiviewColumns;
  $('tiles').dataset.columns = multiviewColumns;
  $('multiviewColumns').onchange = () => {
    multiviewColumns = MULTIVIEW_LAYOUTS.includes($('multiviewColumns').value) ? $('multiviewColumns').value : 'auto';
    $('tiles').dataset.columns = multiviewColumns;
    persist();
    updateProgramGrid();
    syncOutputs();
  };
  $('audioMonitor').onclick = () => {
    monitoring = !monitoring;
    monitor.setMuted(!monitoring);
    if (monitoring) monitor.play();
    buttonState($('audioMonitor'), monitoring, monitoring ? 'Mute local monitoring' : 'Monitor Program audio', monitoring ? 'speaker' : 'mute');
  };
  $('copyProgram').onclick = () => copyObsOutput();
  $('openProgram').onclick = () => previewObsOutput('', true);
  document.querySelectorAll('[data-add-slot]').forEach((button) => {
    button.onclick = () => {
      const slot = CAMERA_SLOTS.find((id) => !cameras.has(id));
      if (!slot) return;
      add(slot);
      selected = slot;
      syncCards();
      persist();
      openSource(slot, 'phone');
    };
  });
  $('imageReset').onclick = () => resetSourceImage(cameras.get(selected));
  $('usbImageReset').onclick = () => resetSourceImage(cameras.get(dialogSlot));
  $('copyPair').onclick = () => copy($('pairURL').value, 'Pairing link copied');
  $('pairURL').onclick = () => $('pairURL').select();
  function clearSourcePreview() {
    ++qrToken;
    usbMonitor.display({ show: false });
  }

  function closeSource() {
    clearSourcePreview();
    $('sourceDialog').close();
  }

  $('sourceDialog').querySelector('[data-close]').onclick = closeSource;
  $('sourceDialog').addEventListener('cancel', clearSourcePreview);
  document.querySelectorAll('[data-source-type]').forEach((button) => {
    button.onclick = () => showSourceType(button.dataset.sourceType);
  });

  $('renameForm').onsubmit = (event) => {
    event.preventDefault();
    const camera = cameras.get(dialogSlot);
    const name = $('slotName').value.trim().slice(0, 36);
    if (!name) { formError('Enter a display name.'); return; }
    camera.name = name;
    $('sourceDialogTitle').textContent = name + ' setup';
    formError('');
    refreshCamera(camera);
    refreshSelection();
    persist();
  };

  $('removeSlot').onclick = () => {
    if (cameras.size < 2) return;
    const camera = cameras.get(dialogSlot);
    disconnect(camera);
    const card = cards.get(dialogSlot);
    card.tileMonitor.destroy();
    card.row.remove();
    card.tile.remove();
    cards.delete(dialogSlot);
    cameras.delete(dialogSlot);
    if (program === dialogSlot) program = '';
    if (selected === dialogSlot) selected = ordered()[0].slot;
    closeSource();
    syncCards();
    persist();
  };

  $('disconnectSource').onclick = () => {
    const camera = cameras.get(dialogSlot);
    if (camera.link) {
      const link = camera.link;
      link.send({ type: 'stop' });
      setTimeout(() => { if (camera.link === link) link.close(); }, 350);
    } else {
      disconnect(camera);
      refreshCamera(camera);
    }
    $('disconnectSource').hidden = true;
    persist();
  };

  $('usbBody').onsubmit = async (event) => {
    event.preventDefault();
    const camera = cameras.get(dialogSlot);
    const button = event.submitter;
    button.disabled = true;
    formError('');
    const connected = await connectUSB(camera, { deviceId: $('usbDevice').value, quality: $('usbQuality').value, mic: $('usbMic').checked });
    button.disabled = false;
    if (connected && dialogSlot === camera.slot && sourceView === 'usb' && $('sourceDialog').open) {
      $('disconnectSource').hidden = false;
      $('disconnectSource').textContent = 'Disconnect source';
      updateUsbPreview();
    }
  };

  $('usbDiscover').onclick = async () => {
    const button = $('usbDiscover');
    const slot = dialogSlot;
    button.disabled = true;
    formError('');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
      await listDevices();
    } catch (error) {
      if (slot === dialogSlot && sourceView === 'usb') formError(captureError(error));
    } finally {
      stopTracks(stream);
      button.disabled = false;
    }
  };

  $('mjpegBody').onsubmit = (event) => {
    event.preventDefault();
    const url = httpURL($('mjpegURL').value.trim());
    if (!url) { formError('Enter a full HTTP or HTTPS URL without embedded credentials.'); return; }
    const camera = cameras.get(dialogSlot);
    setMjpeg(camera, url);
    persist();
    closeSource();
  };

  $('setupButton').onclick = () => {
    $('setupNotice').hidden = !localPage() && location.protocol === 'https:';
    $('setupNotice').textContent = 'For wireless cameras, serve this page over HTTPS and open that address before copying URLs.';
    $('setupDialog').showModal();
  };
  $('setupCopy').onclick = () => $('copyProgram').click();
  $('openPhoneSetup').onclick = () => {
    $('setupDialog').close();
    openSource(selected, 'phone');
  };

  function updateProgramLayout() {
    const grid = programLayout === 'grid';
    buttonState($('programMultiview'), grid, grid ? 'Switch OBS output to Program' : 'Switch OBS output to Multiview');
    $('programMultiview').lastElementChild.textContent = grid ? 'Back to Program' : 'Multiview';
  }
  $('programMultiview').onclick = () => {
    programLayout = programLayout === 'grid' ? 'program' : 'grid';
    persist();
    updateProgramLayout();
    updateProgram();
  };
  updateProgramLayout();

  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat ||
        document.querySelector('dialog[open]') || event.target.closest?.('input, select, textarea, [contenteditable=true]')) return;
    if (/^[1-9]$/.test(event.key) && cameras.get('CAM' + event.key)?.ready) cut('CAM' + event.key);
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if ($('sourceDialog').open && sourceView === 'usb') listDevices();
    for (const camera of cameras.values()) if (camera.kind === 'usb' && !camera.ready) retryUSB(camera, 0);
  });
  addEventListener('pagehide', () => {
    if (recording?.state === 'recording') recording.stop();
    [...receiverLinks].forEach((link) => link.leave());
    signaler.close();
    for (const camera of cameras.values()) if (camera.kind === 'usb') stopTracks(camera.stream);
  });
  syncCards();
  for (const camera of cameras.values()) if (camera.mjpeg) setMjpeg(camera, camera.mjpeg);
  persist();
  startRoom();
}
