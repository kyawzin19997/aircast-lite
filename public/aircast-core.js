'use strict';

const $ = (id) => document.getElementById(id);
const view = document.documentElement.dataset.view;
const routeName = (slot) => String(slot).replace(/^CAM(?=\d)/, 'CAM ');
const KEY = 'aircast-lite-studio-v3';
const PHONE_KEY = 'aircast-lite-phone-v3';
const MULTIVIEW_LAYOUTS = ['auto', '2', '3', '4'];
const BASE_IMAGE = Object.freeze({ zoom: 1, brightness: 100, contrast: 100, rotation: 0, mirror: false, flip: false, fit: 'contain' });
const PROFILES = {
  '240': { width: 426, height: 240, bitrate: 300000 },
  '360': { width: 640, height: 360, bitrate: 650000 },
  '480': { width: 854, height: 480, bitrate: 1100000 },
  '540': { width: 960, height: 540, bitrate: 1600000 },
  '720': { width: 1280, height: 720, bitrate: 2400000 },
  '1080': { width: 1920, height: 1080, bitrate: 4400000 },
  '1440': { width: 2560, height: 1440, bitrate: 8000000 },
  '2160': { width: 3840, height: 2160, bitrate: 14500000 }
};
const PHONE_QUALITIES = ['360', '480', '720', '1080', '2160'];
const CAPTURE_RATES = ['auto', '15', '20', '24', '25', '30', '48', '50', '60', '90', '120'];
const MAX_VIDEO_BITRATE = 24000000;
const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
const PHONE_PAIR_TIMEOUT = 14000;
const PHONE_VIDEO_TIMEOUT = 18000;
let relayServers = [];
let relayRequest;

function turnServers(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((server) => {
    if (typeof server?.username !== 'string' || typeof server.credential !== 'string') return [];
    const urls = [server.urls].flat().filter((url) => typeof url === 'string' && /^turns?:[^\s/]+$/i.test(url));
    return urls.length ? [{ urls, username: server.username, credential: server.credential }] : [];
  });
}

function loadRelayServers() {
  const path = document.querySelector('meta[name="aircast-ice-endpoint"]')?.content.trim();
  if (!path && roomAccess) {
    if (relayRequest) return relayRequest;
    if (relayServers.length) return;
    relayRequest = roomAccess.request('turn').then((data) => { relayServers = turnServers(data.iceServers); }).catch(() => {}).finally(() => { relayRequest = null; });
    return relayRequest;
  }
  if (!path || !['http:', 'https:'].includes(location.protocol)) return;
  let url;
  try { url = new URL(path, location.href); } catch { return; }
  if (url.origin !== location.origin || url.username || url.password) return;
  if (relayRequest) return relayRequest;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 2000);
  relayRequest = fetch(url, { cache: 'no-store', redirect: 'error', signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      relayServers = turnServers(data?.iceServers);
    })
    .catch(() => {})
    .finally(() => { clearTimeout(deadline); relayRequest = null; });
  return relayRequest;
}

function rtcConfiguration() {
  const relays = relayServers.length ? relayServers : turnServers(window.peerjs?.util?.defaultConfig?.iceServers);
  return { iceServers: [...STUN_SERVERS, ...relays] };
}
const PROTOCOL = 'aircast-lite-v3';
const protectedRoom = query.get('private') === '1';
let roomAccess;
const CAMERA_SLOTS = Array.from({ length: 24 }, (_, index) => 'CAM' + (index + 1));
const DEFAULT_SLOTS = CAMERA_SLOTS.slice(0, 3);
const LIBS = {
  Peer: ['./aircast-peer.min.js'],
  QRCode: ['./aircast-qr.min.js']
};
const libraries = new Map();

function randomCode(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}

function saved(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; }
  catch { return {}; }
}

function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Private storage is optional. */ }
}

function legacyRoom() {
  try { return sessionStorage.getItem('aircast_studio_code'); }
  catch { return null; }
}

const normalizeRoom = AirCastRooms.room;
const normalizeSlot = AirCastRooms.slot;
const slotNumber = (slot) => Number(slot.slice(3));
const profile = (quality) => PROFILES[quality] || PROFILES['720'];

function makeUrl(room, view, slot, muted = false) {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  if (view === 'obs') {
    url.searchParams.set('obs', room);
    if (slot) url.searchParams.set('c', slotNumber(slot));
  } else {
    url.searchParams.set('room', room);
    url.searchParams.set('mode', 'sender');
    if (slot) url.searchParams.set('cam', slot);
  }
  if (muted) url.searchParams.set('mute', '1');
  return url.href;
}

function endpoint(room) {
  return AirCastRooms.endpoint(room, null, protectedRoom);
}

function cameraEndpoint(room, slot) {
  return AirCastRooms.endpoint(room, slot, protectedRoom);
}

const incomingCaps = new WeakMap();
const packetTypes = new Set(['leave','ping','pong','media','program','paired','occupied','unknown-slot','replaced','stop','torch','watch']);

function validControlPacket(value) {
  if (!value || typeof value !== 'object' || !packetTypes.has(value.type)) return false;
  if (value.type === 'watch') return typeof value.active === 'boolean';
  if (value.type !== 'media' && value.type !== 'program') return true;
  // Limits apply before allocating SDP, ICE or transition state.
  return JSON.stringify(value).length <= 131072;
}

function claimAdmission(signaler, connection) {
  const role = connection.metadata?.role;
  const cap = role === 'direct-viewer' ? 10 : 48;
  const counts = incomingCaps.get(signaler) || new Map();
  const used = counts.get(role) || 0;
  if (!['direct-viewer','phone','output'].includes(role) || used >= cap) { connection.close(); return false; }
  incomingCaps.set(signaler, counts);
  counts.set(role, used + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    counts.set(role, (counts.get(role) || 1) - 1);
  };
  const timer = setTimeout(() => { if (!connection.open) { release(); connection.close(); } }, 10000);
  connection.on('close', release);
  return true;
}

function acceptProtectedRole(connection, remote) {
  const { role, slot } = connection.metadata || {};
  const camera = normalizeSlot(slot);
  if (roomAccess.role === 'host' && role === 'phone') return remote.role === 'contributor' && remote.slot === camera;
  if (roomAccess.role === 'host' && role === 'output') return remote.role === 'viewer' && (!remote.slot || remote.slot === camera);
  return roomAccess.role === 'contributor' && role === 'direct-viewer' && remote.role === 'viewer' &&
    camera === roomAccess.slot && (!remote.slot || remote.slot === camera);
}

function protectedUrl(url, secret) {
  const address = new URL(url);
  address.searchParams.set('private', '1');
  if (secret) address.hash = new URLSearchParams({ ticket: secret }).toString();
  return address.href;
}

function httpURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function localPage() {
  return location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

function loadLibrary(name) {
  if (window[name]) return Promise.resolve(window[name]);
  if (libraries.has(name)) return libraries.get(name);

  const request = (async () => {
    for (const url of LIBS[name]) {
      const loaded = await new Promise((resolve) => {
        const script = document.createElement('script');
        const finish = (ok) => { clearTimeout(timer); if (!ok) script.remove(); resolve(ok); };
        const timer = setTimeout(() => finish(false), url.startsWith('./') ? 2200 : 4200);
        script.async = true;
        script.src = url;
        script.onload = () => finish(Boolean(window[name]));
        script.onerror = () => finish(false);
        document.head.append(script);
      });
      if (loaded) return window[name];
    }
    throw new Error(name === 'Peer' ? 'Could not load wireless signaling. Check your Internet connection.' : 'Could not load the QR code.');
  })();
  libraries.set(name, request);
  request.catch(() => libraries.delete(name));
  return request;
}

const icon = (name) => '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><use href="#i-' + name + '"></use></svg>';

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
}

function buttonState(button, active, label, glyph) {
  button.setAttribute('aria-pressed', String(active));
  if (label) {
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  if (glyph) button.innerHTML = icon(glyph);
}

function setSignal(element, text, tone = '') {
  element.lastElementChild.textContent = text;
  element.dataset.tone = tone;
  element.title = text;
}

let toastTimer;
function notify(text, bad = false) {
  const toast = $('toast');
  (document.querySelector('dialog[open]') || document.fullscreenElement || document.body).append(toast);
  toast.textContent = text;
  toast.dataset.bad = String(bad);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

async function copy(value, message) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); notify(message); return true; } catch { /* Try the legacy clipboard. */ }
  }
  const context = document.querySelector('dialog[open]') || document.fullscreenElement || document.body;
  const input = document.createElement('textarea');
  input.value = value;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;left:-999px;top:0';
  context.append(input);
  input.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* Offer a selectable field. */ }
  input.remove();
  if (copied) { notify(message); return true; }
  const fallback = document.createElement('dialog');
  fallback.innerHTML = '<div class="modal-body"><h3>Copy link</h3><p>Use your browser’s copy command.</p><input class="url-box mono" aria-label="Link" readonly><form method="dialog"><button class="btn">Done</button></form></div>';
  document.body.append(fallback);
  fallback.addEventListener('close', () => fallback.remove());
  fallback.showModal();
  const field = fallback.querySelector('input');
  field.value = value;
  field.select();
}

function fullscreen(element) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (element.requestFullscreen) element.requestFullscreen().catch(() => notify('Full screen is unavailable here.', true));
  else notify('Full screen is unavailable here.', true);
}

function bounded(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function imageSettings(value, inherited = false) {
  const s = value && typeof value === 'object' ? value : {};
  return {
    zoom: bounded(s.zoom, 1, 3, 1),
    brightness: bounded(s.brightness, 50, 150, 100),
    contrast: bounded(s.contrast, 50, 150, 100),
    rotation: [0, 90, 180, 270].includes(s.rotation) ? s.rotation : 0,
    mirror: s.mirror === true,
    flip: s.flip === true,
    fit: s.fit === 'cover' ? 'cover' : s.fit === 'contain' || !inherited ? 'contain' : 'inherit'
  };
}

function combineImages(base, adjustment) {
  return {
    zoom: base.zoom * adjustment.zoom,
    brightness: base.brightness * adjustment.brightness / 100,
    contrast: base.contrast * adjustment.contrast / 100,
    rotation: (360 + adjustment.rotation + (adjustment.mirror !== adjustment.flip ? -base.rotation : base.rotation)) % 360,
    mirror: base.mirror !== adjustment.mirror,
    flip: base.flip !== adjustment.flip,
    fit: adjustment.fit === 'inherit' ? base.fit : adjustment.fit
  };
}

function outputImage(value) {
  const settings = imageSettings(value);
  settings.zoom = bounded(value?.zoom, 1, 9, 1);
  settings.brightness = bounded(value?.brightness, 25, 225, 100);
  settings.contrast = bounded(value?.contrast, 25, 225, 100);
  return settings;
}

const liveTrack = (stream, kind) => stream?.getTracks().find((track) => track.kind === kind && track.readyState === 'live') || null;

function captureError(error) {
  if (!navigator.mediaDevices?.getUserMedia) return 'Camera access needs HTTPS or localhost.';
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError': return 'Camera or microphone permission was denied. Check your browser permissions and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError': return 'That camera or capture format is unavailable.';
    case 'NotReadableError':
    case 'AbortError': return 'The camera is busy or unavailable. Close apps using it and try again.';
    default: return 'Could not open the camera. Check the device and try again.';
  }
}

function videoConstraints(quality) {
  const { width, height } = profile(quality);
  return { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30, max: 30 } };
}

function audioConstraints() {
  return { channelCount: { ideal: 1 }, echoCancellation: true, autoGainControl: true, noiseSuppression: true };
}

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

class Monitor {
  constructor(root, { muted = true, change = () => {} } = {}) {
    this.root = root;
    this.change = change;
    this.layer = document.createElement('div');
    this.layer.className = 'media-layer';
    this.layer.innerHTML = '<div class="frame-turn"><video autoplay playsinline></video><img alt="" decoding="async"></div>';
    this.turn = this.layer.firstElementChild;
    this.video = this.turn.firstElementChild;
    this.video.muted = muted;
    this.img = this.turn.lastElementChild;
    this.root.prepend(this.layer);
    this.stream = null;
    this.url = '';
    this.current = BASE_IMAGE;
    this.visible = false;
    this.showing = false;
    this.img.hidden = true;
    this.video.hidden = true;
    this.video.addEventListener('loadeddata', () => this.present(Boolean(this.stream && this.showing)));
    this.video.addEventListener('playing', () => this.present(Boolean(this.stream && this.showing)));
    this.img.addEventListener('load', () => {
      if (this.url) this.present(this.showing);
      this.onImageState?.(true, this.url);
    });
    this.img.addEventListener('error', () => {
      this.present(false);
      if (this.url) this.onImageState?.(false, this.url);
    });
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.transform()) : null;
    this.observer?.observe(root);
  }

  display({ stream = null, url = '', image = BASE_IMAGE, show = true } = {}) {
    this.showing = show;
    this.current = image;
    this.transform();
    if (stream !== this.stream) {
      this.stream = stream;
      this.video.srcObject = stream;
      this.present(false);
      if (stream) this.play();
    }
    if (url !== this.url) {
      this.url = url;
      this.present(false);
      if (url) this.img.src = url;
      else this.img.removeAttribute('src');
    }
    this.present(show && (stream ? this.video.readyState >= 2 : Boolean(url && this.img.naturalWidth)));
  }

  play() {
    this.video.play().catch(() => {
      if (!this.video.muted) {
        this.video.muted = true;
        this.video.play().catch(() => {});
        this.onMutedFallback?.();
      }
    });
  }

  transform() {
    const s = this.current;
    const quarter = s.rotation % 180 !== 0;
    this.turn.style.width = quarter ? this.root.clientHeight + 'px' : '100%';
    this.turn.style.height = quarter ? this.root.clientWidth + 'px' : '100%';
    this.turn.style.setProperty('--rotate', s.rotation + 'deg');
    this.turn.style.setProperty('--scale-x', String(s.zoom * (s.mirror ? -1 : 1)));
    this.turn.style.setProperty('--scale-y', String(s.zoom * (s.flip ? -1 : 1)));
    this.turn.style.setProperty('--brightness', String(s.brightness / 100));
    this.turn.style.setProperty('--contrast', String(s.contrast / 100));
    this.turn.style.setProperty('--fit', s.fit === 'cover' ? 'cover' : 'contain');
  }

  present(visible) {
    this.video.hidden = !this.stream;
    this.video.style.opacity = visible && this.stream ? '1' : '0';
    this.img.hidden = !(visible && this.url);
    this.root.classList.toggle('has-media', visible);
    if (this.visible !== visible) {
      this.visible = visible;
      this.change(visible);
    }
  }

  destroy() {
    this.observer?.disconnect();
    this.video.srcObject = null;
    this.img.removeAttribute('src');
    this.layer.remove();
  }
}
// Only Program uses two surfaces. Camera tiles and the phone keep their single preview.
class DissolveMonitor {
  constructor(root, { change = () => {} } = {}) {
    this.root = root;
    this.change = change;
    this.visible = false;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.buffers = Array.from({ length: 2 }, () => {
      const layer = document.createElement('div');
      layer.className = 'dissolve-layer';
      layer.hidden = true;
      root.prepend(layer);
      const buffer = { layer };
      buffer.monitor = new Monitor(layer, { change: (visible) => this.onFrame(buffer, visible) });
      buffer.monitor.onMutedFallback = () => {
        if (this.front === buffer) this.onMutedFallback?.();
      };
      return buffer;
    });
    this.front = this.buffers[0];
    root.prepend(this.front.layer);
  }

  get video() { return this.front.monitor.video; }

  setMuted(muted) {
    this.video.muted = muted;
    if (this.pending) this.pending.muted = muted;
  }

  play() { this.front.monitor.play(); }

  display({ stream = null, url = '', image = BASE_IMAGE, show = true, muted = true, onReady } = {}) {
    if (!show || (!stream && !url)) {
      this.cancelPending();
      this.finishFade();
      this.hide(this.front);
      return;
    }

    const matches = (buffer) => buffer && buffer.monitor.stream === stream && buffer.monitor.url === url;
    let buffer;
    if (matches(this.front)) {
      this.cancelPending();
      buffer = this.front;
    } else if (matches(this.pending)) {
      buffer = this.pending;
    } else {
      this.cancelPending();
      this.finishFade();
      buffer = this.buffers.find((item) => item !== this.front);
      this.pending = buffer;
      buffer.layer.hidden = false;
      buffer.layer.style.opacity = '0';
      buffer.layer.style.zIndex = '0';
    }
    buffer.ready = onReady;
    buffer.muted = muted;
    buffer.monitor.video.muted = buffer !== this.front || muted;
    buffer.monitor.display({ stream, url, image });
    if (buffer === this.front && buffer.monitor.visible && !this.fade) this.confirm(buffer);
  }

  onFrame(buffer, visible) {
    if (visible && buffer === this.pending) {
      this.promote(buffer);
    } else if (buffer === this.front) {
      this.root.classList.toggle('has-media', visible);
      if (this.visible !== visible) {
        this.visible = visible;
        this.change(visible);
      }
    }
  }

  promote(incoming) {
    const previous = this.front;
    const dissolve = previous.monitor.visible && !this.reducedMotion.matches && typeof incoming.layer.animate === 'function';
    this.pending = null;
    this.front = incoming;
    this.root.prepend(incoming.layer);
    previous.layer.style.zIndex = '0';
    incoming.layer.style.zIndex = '1';
    incoming.layer.style.opacity = '1';
    previous.monitor.video.muted = true;
    incoming.monitor.video.muted = incoming.muted;
    if (!incoming.muted && incoming.monitor.stream) incoming.monitor.play();
    this.onFrame(incoming, true);
    if (!dissolve) {
      this.hide(previous);
      this.confirm(incoming);
      return;
    }
    const duration = 180;
    const animation = incoming.layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease-out' });
    const fade = { animation, previous };
    this.fade = fade;
    const finish = () => { if (this.fade === fade) this.finishFade(); };
    animation.onfinish = finish;
    // Hidden browser sources can suspend their animation timeline.
    fade.timer = setTimeout(finish, duration + 50);
  }

  confirm(buffer) {
    const ready = buffer.ready;
    buffer.ready = null;
    ready?.();
  }

  finishFade() {
    if (!this.fade) return;
    const { animation, previous, timer } = this.fade;
    this.fade = null;
    clearTimeout(timer);
    animation.onfinish = null;
    animation.cancel();
    this.hide(previous);
    this.confirm(this.front);
  }

  cancelPending() {
    if (!this.pending) return;
    const buffer = this.pending;
    this.pending = null;
    this.hide(buffer);
  }

  hide(buffer) {
    buffer.ready = null;
    buffer.layer.hidden = true;
    buffer.monitor.video.muted = true;
    buffer.monitor.display({ show: false });
  }
}

// Signaling reconnects independently of active peer-to-peer media.
class Signaler {
  constructor(id, status = () => {}) {
    this.id = id;
    this.status = status;
    this.peer = null;
    this.closed = false;
    this.retry = 0;
    this.ready = false;
    this.onOnline = () => this.retryNow?.();
    window.addEventListener('online', this.onOnline);
    this.start();
  }

  async start() {
    this.status('Connecting to signaling');
    try {
      const [Peer] = await Promise.all([loadLibrary('Peer'), loadRelayServers()]);
      if (this.closed) return;
      const options = { config: rtcConfiguration(), secure: true, debug: 0 };
      const peer = new Peer(this.id || (roomAccess ? roomAccess.peer + '-' + randomCode(12) : 'AIRCAST-CLIENT-' + randomCode(20)), options);
      this.peer = peer;
      let idTaken = false;
      peer.on('open', () => {
        if (this.closed || this.peer !== peer) return;
        clearTimeout(this.timer);
        this.retryNow = null;
        this.ready = true;
        this.retry = 0;
        this.status('Signaling ready', 'good');
        this.onReady?.();
      });
      peer.on('connection', (connection) => {
        if (this.closed || this.peer !== peer || connection.label !== PROTOCOL || !this.accept) connection.close();
        else if (roomAccess) {
          if (!claimAdmission(this, connection)) return;
          roomAccess.gate(connection, (remote) => acceptProtectedRole(connection, remote)).then((authorized) => {
            if (this.closed || this.peer !== peer || !authorized.open) { authorized.close(); return; }
            this.accept(authorized);
          }).catch(() => {});
        } else if (claimAdmission(this, connection)) this.accept(connection);
      });
      peer.on('disconnected', () => {
        if (this.peer === peer && !idTaken) this.recover('Signaling disconnected');
      });
      peer.on('close', () => {
        if (this.peer === peer && !idTaken) this.recover('Signaling disconnected', true);
      });
      peer.on('error', (error) => {
        if (this.closed || this.peer !== peer || error.type === 'webrtc') return;
        if (error.type === 'peer-unavailable') {
          this.onMissing?.();
          return;
        }
        if (error.type === 'unavailable-id') {
          idTaken = true;
          this.recover('Room already in use', true, 'bad');
          return;
        }
        if (['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable'].includes(error.type)) {
          this.ready = false;
          this.status('Signaling is unavailable in this browser', 'bad');
          return;
        }
        this.recover('Signaling connection interrupted');
      });
      this.recover('Connecting to signaling', false, '', 11000);
    } catch (error) {
      if (!this.closed) this.recover(error.message, true, 'bad');
    }
  }

  recover(message, rebuild = false, tone = 'warn', delay) {
    if (this.closed) return;
    this.ready = false;
    this.status(message, tone);
    clearTimeout(this.timer);
    const wait = delay ?? Math.min(12000, 1500 * 2 ** Math.min(this.retry++, 3));
    this.retryNow = () => {
      clearTimeout(this.timer);
      this.retryNow = null;
      if (this.closed) return;
      const peer = this.peer;
      if (!rebuild && peer && !peer.destroyed && peer.disconnected) {
        try {
          peer.reconnect();
          this.recover('Reconnecting signaling', false, 'warn', 11000);
          return;
        } catch { /* Recreate the signaling peer. */ }
      }
      this.peer = null;
      peer?.destroy();
      this.start();
    };
    this.timer = setTimeout(this.retryNow, wait);
  }

  dial(id, metadata) {
    if (!this.ready || !this.peer?.open) return null;
    try { return this.peer.connect(id, { label: PROTOCOL, metadata, serialization: 'json', reliable: true }); }
    catch { return null; }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.retryNow = null;
    window.removeEventListener('online', this.onOnline);
    this.peer?.destroy();
  }
}

class Link {
  constructor(connection, { open, receive, close }) {
    this.connection = connection;
    this.closed = false;
    this.open = false;
    this.lastHeard = Date.now();
    this.onClose = close;
    this.timer = setTimeout(() => this.close('Connection timed out'), 9000);
    const online = () => {
      if (this.closed || this.open) return;
      this.open = true;
      this.lastHeard = Date.now();
      clearTimeout(this.timer);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastHeard > 18000) this.close('Connection timed out');
        else this.send({ type: 'ping' });
      }, 4000);
      this.watchConnection();
      open(this);
    };
    connection.on('open', online);
    connection.on('data', (message) => {
      if (this.closed || !validControlPacket(message)) return;
      this.lastHeard = Date.now();
      if (message.type === 'leave') this.close();
      else if (message.type === 'ping') this.send({ type: 'pong' });
      else if (message.type !== 'pong') receive(message, this);
    });
    connection.on('close', () => this.close());
    connection.on('error', () => this.close('Connection interrupted'));
    if (connection.open) queueMicrotask(online);
  }

  watchConnection() {
    const pc = this.connection.peerConnection;
    if (!pc?.addEventListener) return;
    this.transport = pc;
    this.onTransportState = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'closed') {
        this.close('Connection interrupted');
      } else if (state === 'disconnected') {
        if (!this.disconnectTimer) this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (pc.connectionState === 'disconnected') this.close('Connection interrupted');
        }, 5000);
      } else if (state === 'connected') {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
    };
    pc.addEventListener('connectionstatechange', this.onTransportState);
  }

  leave() {
    this.send({ type: 'leave' });
    this.close();
  }

  send(message) {
    if (!this.open || this.closed) return false;
    try { this.connection.send(message); return true; }
    catch { this.close('Connection interrupted'); return false; }
  }

  close(reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    clearTimeout(this.timer);
    clearTimeout(this.disconnectTimer);
    clearInterval(this.heartbeat);
    this.transport?.removeEventListener('connectionstatechange', this.onTransportState);
    this.connection.close();
    this.onClose?.(this, reason);
  }
}

class ClientLink {
  constructor(target, metadata, handlers, localId) {
    this.target = target;
    this.metadata = metadata;
    this.handlers = handlers;
    this.retry = 0;
    this.closed = false;
    this.signaler = new Signaler(localId, handlers.status);
    this.signaler.onReady = () => {
      handlers.ready?.();
      this.connect();
    };
    this.signaler.onMissing = () => {
      if (this.link && !this.link.open) this.link.close('Waiting for destination');
    };
    this.onOnline = () => {
      this.retry = 0;
      this.connect();
    };
    window.addEventListener('online', this.onOnline);
  }

  connect() {
    if (this.closed || this.link || this.pending || !this.signaler.ready || navigator.onLine === false) return;
    clearTimeout(this.timer);
    const connection = this.signaler.dial(this.target, this.metadata);
    if (!connection) { this.schedule(); return; }
    this.handlers.status?.('Connecting to destination');
    if (roomAccess) {
      this.pending = connection;
      const remote = this.target.startsWith('AIRCAST-PRIVATE-CAM-') ? 'contributor' : 'host';
      roomAccess.gate(connection, (peer) => peer.role === remote && (remote !== 'contributor' || peer.slot === this.metadata.slot),
        (error) => { if (!this.closed) this.handlers.status?.(error.message, 'bad'); }).then((authorized) => {
        if (this.closed || this.pending !== connection || !authorized.open) { authorized.close(); return; }
        this.pending = null;
        this.attach(authorized);
      }).catch(() => {
        if (this.pending === connection) { this.pending = null; if (!this.closed) this.schedule(); }
      });
      return;
    }
    this.attach(connection);
  }

  attach(connection) {
    this.link = new Link(connection, {
      open: (link) => {
        this.retry = 0;
        this.handlers.open(link);
      },
      receive: (message, link) => this.handlers.receive(message, link),
      close: (link, reason) => {
        if (this.link !== link) return;
        this.link = null;
        this.handlers.close(link);
        if (this.closed) return;
        this.handlers.status?.(reason || 'Reconnecting', 'warn');
        this.schedule();
      }
    });
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), Math.min(5000, 900 * 2 ** Math.min(this.retry++, 3) * (0.85 + Math.random() * 0.3)));
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    window.removeEventListener('online', this.onOnline);
    this.pending?.close();
    this.pending = null;
    this.link?.leave();
    this.signaler.close();
  }
}

// A transport keeps one video and one audio sender across cuts, including silent cameras.
class MediaPipe {
  constructor(link, send, callbacks = {}) {
    this.link = link;
    this.sender = send;
    this.callbacks = callbacks;
    this.signals = Promise.resolve();
    this.current = { kind: 'standby' };
    this.incoming = null;
    this.pc = null;
  }

  send(message) {
    this.link.send({ type: 'media', ...message });
  }

  configure(epoch) {
    this.release();
    const pc = new RTCPeerConnection(rtcConfiguration());
    this.pc = pc;
    this.epoch = epoch;
    this.outboundIce = [];
    this.announced = false;
    this.inboundIce = [];
    this.incoming = new MediaStream();
    this.snapshot = '';
    pc.onicecandidate = ({ candidate }) => {
      if (this.pc !== pc || !candidate) return;
      const data = { epoch, candidate: candidate.toJSON() };
      if (this.announced) this.send(data);
      else this.outboundIce.push(data);
    };
    pc.ontrack = ({ track }) => {
      if (this.pc !== pc) return;
      this.incoming.addTrack(track);
      track.onunmute = track.onmute = track.onended = () => {
        if (this.pc === pc) this.callbacks.stream?.(this.incoming);
      };
      this.callbacks.stream?.(this.incoming);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const state = pc.connectionState;
      this.callbacks.state?.(state);
      if (state === 'connected') {
        clearTimeout(this.failureTimer);
        this.tune();
      } else if (state === 'failed') {
        this.failed(pc);
      } else if (state === 'disconnected') {
        clearTimeout(this.failureTimer);
        this.failureTimer = setTimeout(() => this.failed(pc), 6500);
      }
    };
    this.failureTimer = setTimeout(() => {
      if (pc.connectionState !== 'connected') this.failed(pc);
    }, 15000);
    return pc;
  }

  async announce(pc, description) {
    if (this.pc !== pc) return;
    await pc.setLocalDescription(description);
    if (this.pc !== pc) return;
    const local = pc.localDescription;
    this.send({ epoch: this.epoch, description: { type: local.type, sdp: local.sdp } });
    this.announced = true;
    this.outboundIce.splice(0).forEach((candidate) => this.send(candidate));
  }

  accept(message) {
    if (this.closed) return;
    this.signals = this.signals.then(() => this.handle(message)).catch(() => {
      if (this.pc && (!message.epoch || message.epoch === this.epoch)) this.failed(this.pc);
    });
  }

  async handle(message) {
    if (this.closed) return;
    if (message.reset) {
      if (this.sender) this.rebuild();
      return;
    }
    if (message.snapshot && !this.sender) {
      this.callbacks.snapshot?.(message.snapshot);
      return;
    }
    if (typeof message.epoch !== 'string') return;
    if (!this.sender && message.description?.type === 'offer') {
      const pc = this.configure(message.epoch);
      this.callbacks.stream?.(null);
      await pc.setRemoteDescription(message.description);
      await this.announce(pc, await pc.createAnswer());
      return;
    }
    const pc = this.pc;
    if (!pc || this.epoch !== message.epoch) return;
    if (this.sender && message.description?.type === 'answer') {
      await pc.setRemoteDescription(message.description);
      const pending = this.inboundIce.splice(0);
      for (const candidate of pending) await pc.addIceCandidate(candidate).catch(() => {});
    } else if (message.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(message.candidate).catch(() => {});
      else this.inboundIce.push(message.candidate);
    }
  }

  update(source, snapshot) {
    if (this.closed) return;
    this.current = { ...snapshot, source };
    this.pending = true;
    this.pump();
  }

  async pump() {
    if (this.pumping || this.closed || this.recoverTimer) return;
    this.pumping = true;
    let pc;
    try {
      while (this.pending && !this.closed && !this.recoverTimer) {
        this.pending = false;
        pc = this.pc;
        const { source, bitrate, scale, adaptive, ...snapshot } = this.current;
        const video = snapshot.kind === 'video' ? liveTrack(source, 'video') : null;
        const audio = video && snapshot.audio !== false ? liveTrack(source, 'audio') : null;
        const outbound = JSON.stringify(snapshot);
        if (this.snapshot !== outbound) {
          this.snapshot = outbound;
          this.send({ snapshot });
        }
        if (!pc && video) {
          pc = this.configure(randomCode(12));
          this.snapshot = outbound;
          this.videoSender = pc.addTransceiver(video, {
            direction: 'sendonly', streams: [this.incoming],
            sendEncodings: bitrate ? [{ maxBitrate: bitrate, scaleResolutionDownBy: scale ?? 1 }] : []
          }).sender;
          this.audioSender = pc.addTransceiver(audio || 'audio', { direction: 'sendonly', streams: [this.incoming] }).sender;
          await this.announce(pc, await pc.createOffer());
        } else if (this.pc) {
          const replace = [];
          if (this.videoSender.track !== video) replace.push(this.videoSender.replaceTrack(video));
          if (this.audioSender.track !== audio) replace.push(this.audioSender.replaceTrack(audio));
          await Promise.all(replace);
        }
        this.tune();
      }
    } catch {
      if (pc && this.pc === pc) this.failed(pc);
    } finally {
      this.pumping = false;
    }
  }

  async tune() {
    const sender = this.videoSender;
    if (!sender?.track || this.tuningSender === sender || this.pc?.connectionState !== 'connected') return;
    this.tuningSender = sender;
    try {
      while (this.videoSender === sender && sender.track && this.pc?.connectionState === 'connected') {
        const { bitrate, scale = 1, adaptive = false } = this.current;
        if (!bitrate || (this.lastEncoding?.bitrate === bitrate && this.lastEncoding.scale === scale && this.lastEncoding.adaptive === adaptive)) return;
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) return;
        parameters.encodings[0].maxBitrate = bitrate;
        parameters.encodings[0].scaleResolutionDownBy = scale;
        parameters.degradationPreference = adaptive ? 'balanced' : 'maintain-resolution';
        await sender.setParameters(parameters);
        if (this.videoSender === sender) this.lastEncoding = { bitrate, scale, adaptive };
      }
    } catch { /* Leave the current encoding in place until the next update. */ }
    finally { if (this.tuningSender === sender) this.tuningSender = null; }
  }

  failed(pc) {
    if (this.pc !== pc || this.closed) return;
    this.callbacks.state?.('failed');
    if (this.sender) this.rebuild();
    else {
      this.release();
      this.callbacks.stream?.(null);
      this.send({ reset: true });
    }
  }

  rebuild() {
    if (this.recoverTimer || this.closed) return;
    this.release();
    this.snapshot = '';
    this.pending = true;
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null;
      this.pump();
    }, 850);
  }

  release() {
    clearTimeout(this.failureTimer);
    const pc = this.pc;
    this.pc = null;
    this.videoSender = null;
    this.audioSender = null;
    this.lastEncoding = null;
    this.incoming = null;
    pc?.close();
  }

  close() {
    this.closed = true;
    clearTimeout(this.recoverTimer);
    this.release();
  }
}
// A Program cut stages a second transport briefly and retires the old one after presentation.
class ProgramSender {
  constructor(link) {
    this.link = link;
    this.sequence = 0;
  }

  update(stream, snapshot, force = false) {
    if (snapshot.kind === 'standby') {
      const signature = JSON.stringify(snapshot);
      if (this.standby !== signature) {
        this.standby = signature;
        this.link.send({ type: 'program', standby: snapshot });
      }
      this.close();
      return;
    }
    this.standby = null;
    if (!force && this.current && this.current !== this.active && this.current.slot !== snapshot.pairSlot) {
      this.queued = { stream, snapshot };
      if (!this.queueTimer) this.queueTimer = setTimeout(() => this.flush(), 1000);
      return;
    }
    this.clearQueue();
    if (this.current?.slot !== snapshot.pairSlot) {
      if (this.current !== this.active) this.current?.pipe.close();
      this.current = this.active?.slot === snapshot.pairSlot ? this.active : this.create(snapshot.pairSlot);
      this.link.send({ type: 'program', stage: this.current.id });
    }
    this.current.pipe.update(stream, snapshot);
  }

  create(slot) {
    const id = ++this.sequence;
    const pipe = new MediaPipe({ send: (packet) => this.link.send({ ...packet, programId: id }) }, true);
    return { slot, id, pipe };
  }

  accept(message) {
    if (message.type === 'program' && message.shown === this.current?.id && this.active !== this.current) {
      this.active?.pipe.close();
      this.active = this.current;
      this.flush();
    } else if (message.type === 'media') {
      const route = this.current?.id === message.programId ? this.current : this.active;
      if (route && route.id === message.programId) route.pipe.accept(message);
    }
  }

  flush() {
    const queued = this.queued;
    this.clearQueue();
    if (queued) this.update(queued.stream, queued.snapshot, true);
  }

  clearQueue() {
    clearTimeout(this.queueTimer);
    this.queueTimer = null;
    this.queued = null;
  }

  close() {
    this.clearQueue();
    if (this.active !== this.current) this.active?.pipe.close();
    this.current?.pipe.close();
    this.current = this.active = null;
  }
}

class ProgramReceiver {
  constructor(link, { parse, show, cancel }) {
    this.link = link;
    this.parse = parse;
    this.show = show;
    this.cancel = cancel;
  }

  accept(message) {
    if (message.type === 'program' && message.standby) {
      this.close();
      this.show({ snapshot: this.parse(message.standby), stream: null });
    } else if (message.type === 'program' && Number.isSafeInteger(message.stage) && message.stage > 0) {
      this.stage(message.stage);
    } else if (message.type === 'media') {
      const route = this.current?.id === message.programId ? this.current : this.active;
      if (route && route.id === message.programId) route.pipe.accept(message);
    }
  }

  stage(id) {
    if (this.current?.id === id) return;
    this.cancel();
    if (this.current !== this.active) this.current?.pipe.close();
    if (this.active?.id === id) {
      this.current = this.active;
      this.present(this.active);
      return;
    }
    const route = { id, snapshot: null, stream: null };
    this.current = route;
    clearTimeout(this.stageTimer);
    this.stageTimer = setTimeout(() => {
      if (this.current === route && this.active !== route) this.link.close('Program frame timed out');
    }, 12000);
    route.pipe = new MediaPipe({ send: (packet) => this.link.send({ ...packet, programId: id }) }, false, {
      snapshot: (value) => { route.snapshot = this.parse(value); this.present(route); },
      stream: (value) => { route.stream = value; this.present(route); }
    });
  }

  present(route) {
    if (this.current !== route || !route.snapshot) return;
    const video = liveTrack(route.stream, 'video');
    if (route.snapshot.kind === 'video' && (!video || video.muted)) {
      if (this.active === route && !this.staleTimer) this.staleTimer = setTimeout(() => {
        if (this.current === route) this.link.close('Program video stalled');
      }, 12000);
      return;
    }
    clearTimeout(this.staleTimer);
    this.staleTimer = null;
    this.show(route, () => {
      if (this.current !== route || this.active === route) return;
      clearTimeout(this.stageTimer);
      this.active?.pipe.close();
      this.active = route;
      this.link.send({ type: 'program', shown: route.id });
    });
  }

  close() {
    clearTimeout(this.stageTimer);
    clearTimeout(this.staleTimer);
    this.cancel();
    if (this.active !== this.current) this.active?.pipe.close();
    this.current?.pipe.close();
    this.current = this.active = null;
  }
}

function createInspector(container, get, change, allowInherit, showRotation = true, rangeHost = container, onRefresh) {
  const ranges = [
    { key: 'zoom', label: 'Zoom', min: 1, max: 3, step: 0.05, format: (value) => Number(value.toFixed(2)) + '×' },
    { key: 'brightness', label: 'Brightness', min: 50, max: 150, step: 1, format: (value) => value + '%' },
    { key: 'contrast', label: 'Contrast', min: 50, max: 150, step: 1, format: (value) => value + '%' }
  ];
  const prefix = container.id;
  rangeHost.innerHTML = ranges.map(({ key, label, min, max, step }) =>
    '<div class="adjustment"><label for="' + prefix + '-' + key + '">' + label + '</label><output for="' + prefix + '-' + key + '"></output><input id="' + prefix + '-' + key + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '"></div>'
  ).join('');
  container.insertAdjacentHTML('beforeend',
    '<div class="control-row"><button class="btn ghost tiny" data-turn>' + icon('rotate') + '<span></span></button><button class="btn ghost tiny" data-mirror>' + icon('mirror') + 'Mirror</button><button class="btn ghost tiny" data-flip>Flip</button></div>' +
    '<details class="control-details"><summary>More controls</summary><label class="field" style="margin-top:8px">' + (allowInherit ? 'Framing' : 'OBS framing') + '<select>' +
    (allowInherit ? '<option value="inherit">Follow source</option>' : '') +
    '<option value="contain">Fit entire frame</option><option value="cover">Fill frame</option></select></label><div class="control-row" data-extras hidden></div></details>');

  const turn = container.querySelector('[data-turn]');
  turn.hidden = !showRotation;
  const mirror = container.querySelector('[data-mirror]');
  const flip = container.querySelector('[data-flip]');
  const fit = container.querySelector('select');
  const fields = ranges.map((range) => ({
    ...range,
    input: $(prefix + '-' + range.key),
    output: $(prefix + '-' + range.key).previousElementSibling
  }));
  const refresh = () => {
    const s = get();
    fields.forEach(({ key, input, output, format }) => {
      input.value = s[key];
      output.textContent = format(s[key]);
    });
    turn.lastElementChild.textContent = 'Rotate ' + s.rotation + '°';
    turn.setAttribute('aria-label', 'Rotate clockwise 90 degrees. Current rotation ' + s.rotation + ' degrees.');
    buttonState(mirror, s.mirror, 'Mirror horizontally');
    buttonState(flip, s.flip, 'Flip vertically');
    fit.value = s.fit;
    onRefresh?.();
  };
  const update = (key, value, commit = true) => { change(key, value, commit); refresh(); };
  fields.forEach(({ key, input }) => {
    input.addEventListener('input', () => update(key, Number(input.value), false));
    input.addEventListener('change', () => update(key, Number(input.value)));
  });
  turn.onclick = () => update('rotation', (get().rotation + 90) % 360);
  mirror.onclick = () => update('mirror', !get().mirror);
  flip.onclick = () => update('flip', !get().flip);
  fit.onchange = () => update('fit', fit.value);
  refresh();
  return refresh;
}
