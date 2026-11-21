'use strict';

hydrateIcons();
document.querySelectorAll('button[data-close]').forEach((button) => {
  button.onclick = () => button.closest('dialog').close();
});
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
if (view !== 'output') {
  fitKeyboardViewport();
  if (window.isSecureContext && /^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./aircast-sw.js').catch(() => {});
  }
}

const ownerKey = (room) => 'aircast-owner:' + room;
const aliasKey = (room) => 'aircast-custom-id:' + room;

function joinRoom() {
  const code = normalizeRoom(query.get('join'));
  if (code) $('joinValue').value = code;
  $('createRoom').onclick = () => {
    const form = $('createRoomForm');
    form.hidden = false;
    $('createRoom').hidden = true;
    $('createRoomId').focus();
  };
  $('createRoomForm').onsubmit = async (event) => {
    event.preventDefault();
    let password = $('createPassword').value;
    $('createPassword').value = '';
    const requested = normalizeRoom($('createRoomId').value.trim());
    const hours = Number($('roomExpiry').value);
    const destination = new URL(location.protocol === 'file:' ? './index.html' : './', location.href);
    const expires = hours ? Date.now() + hours * 3600000 : 0;
    const namespace = randomCode(16);
    let room = requested || randomCode(16);
    event.submitter.disabled = true;
    $('joinFeedback').textContent = '';
    try {
      const alias = requested && saved(aliasKey(requested));
      if (alias?.room && (!alias.expires || alias.expires > Date.now())) throw new Error('This Room ID is already in use. Choose another ID.');
      if (password) {
        let protectedSetup = await AirCastSealed.create(room, password, expires);
        const stored = await AirCastSealed.request('POST', room, protectedSetup.envelope);
        if (!stored) {
          room = (requested || 'ROOM') + '-' + namespace;
          protectedSetup = await AirCastSealed.create(room, password, expires);
        }
        password = '';
        const { envelope, recovery, access } = protectedSetup;
        roomManifest = { room, envelope, stored, expires };
        roomAccess = { ...access, role: 'host', slot: '' };
        store(AirCastSealed.recoveryKey(room), recovery);
      } else {
        const stored = await AirCastSealed.request('POST', room, '2.' + expires + '.' + namespace);
        if (!stored) room = (requested || 'ROOM') + '-' + namespace;
        roomManifest = { room, expires, openNamespace: namespace };
      }
      store(ownerKey(room), true);
      if (requested) store(aliasKey(requested), { room, expires });
      destination.searchParams.set('room', room);
      destination.searchParams.set('owner', '1');
      history.replaceState(null, '', roomLink(destination, room));
      query.set('room', room);
      showRoom('studio');
    } catch (error) {
      $('joinFeedback').textContent = error.message;
      event.submitter.disabled = false;
    }
  };
  $('joinForm').onsubmit = async (event) => {
    event.preventDefault();
    const text = $('joinValue').value;
    const url = AirCastRooms.joinTarget(text, location.href, $('joinRole').value);
    if (!url) { $('joinFeedback').textContent = 'Enter a room ID or paste an invitation from this AirCast site.'; return; }
    const code = normalizeRoom(text.trim());
    try {
      const manifest = await findRoom(code, url);
      location.assign(roomLink(url, code, manifest));
    } catch (error) { $('joinFeedback').textContent = error.message; return; }
  };
}

function showEntryError(error, retry) {
  document.documentElement.dataset.view = 'join';
  for (const id of ['createRoom','createRoomForm','roomDivider','joinHeading','joinForm']) $(id).hidden = true;
  $('roomHome').hidden = false;
  $('joinTitle').textContent = retry ? 'Enter room password' : 'Room unavailable';
  $('joinFeedback').textContent = error.message;
  $('roomPasswordForm').hidden = !retry;
  if (!retry) return;
  $('joinPassword').focus();
  $('roomPasswordForm').onsubmit = (event) => {
    event.preventDefault();
    const password = $('joinPassword').value;
    $('joinPassword').value = '';
    event.submitter.disabled = true;
    boot(password).finally(() => { event.submitter.disabled = false; });
  };
}

async function findRoom(room, address, required = false) {
  if (!room) return null;
  const envelope = new URLSearchParams(address.hash.slice(1)).get('room');
  if (envelope !== null) return { room, envelope, stored: false };
  const openNamespace = room.split('-')[1];
  const record = openNamespace || !navigator.onLine ? null : await AirCastSealed.request('GET', room);
  if (record?.startsWith('1.')) return { room, envelope: record, stored: true };
  if (record?.startsWith('0.')) return { room, expires: Number(record.slice(2)) };
  if (record?.startsWith('2.')) {
    const [, expires, namespace] = record.split('.');
    return { room, expires: Number(expires), openNamespace: namespace };
  }
  if (required) throw new Error('The encrypted room data is missing. Open the full room link or scan the QR again.');
  if (address.searchParams.get('open') === '1' && !openNamespace) throw new Error('This Room ID is unavailable.');
  const until = address.searchParams.get('until');
  const expires = /^[1-9]\d{12}$/.test(until) ? Number(until) : 0;
  if (expires || openNamespace) return { room, expires, openNamespace };
  return null;
}

function showCountdown(expires) {
  $('roomExpiryStatus').hidden = false;
  const update = () => {
    const remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
    const clock = [Math.floor(remaining / 3600), Math.floor(remaining / 60) % 60, remaining % 60];
    $('roomCountdown').textContent = clock.map((value) => String(value).padStart(2, '0')).join(':');
  };
  update();
  const timer = setInterval(update, 1000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}

function showRoom(route) {
  if (roomManifest?.expires) {
    AirCastSealed.checkExpiry(roomManifest.expires);
    if (route === 'studio') showCountdown(roomManifest.expires);
    setTimeout(() => location.reload(), Math.max(0, roomManifest.expires - Date.now() + 100));
  }
  document.documentElement.dataset.view = route;
  if (route === 'output') {
    if (roomAccess) window.aircastProgramRoom = (room) => room === roomManifest.room ? { manifest: roomManifest, access: roomAccess } : null;
    obsOutput();
  } else if (route === 'phone') phone();
  else if (route === 'join') joinRoom();
  else studio();
}

async function boot(password) {
  const target = view === 'output' ? AirCastRooms.output(query) : {
    room: normalizeRoom(query.get('room')), slot: query.get('auto') === '1' ? '' : normalizeSlot(query.get('cam')) || 'CAM1'
  };
  const sealed = query.get('sealed') === '1';
  try {
    if (view === 'join') { showRoom(view); return; }
    if (query.get('private') === '1' && !sealed) throw new Error('This link uses the previous private room format. Ask the host for a new encrypted room link.');
    let inherited;
    if (sealed && view === 'output' && window.parent !== window && query.get('studio') === '1') {
      try { inherited = window.parent.aircastProgramRoom?.(target.room); } catch { /* A cross-origin parent cannot unlock a room. */ }
    }
    if (inherited?.manifest.stored && !location.hash) roomManifest = inherited.manifest;
    if (sealed || view === 'studio' || query.has('open') || query.has('until') || target.room.includes('-')) {
      roomManifest ||= await findRoom(target.room, new URL(location.href), sealed);
    }
    if (view === 'studio' && !sealed && (roomManifest?.envelope ||
        ((roomManifest?.openNamespace || query.has('owner')) && saved(ownerKey(target.room)) !== true))) {
      throw new Error('Studio is available in the browser that created this room. Use a camera pairing link or the Program viewer link to join.');
    }
    if (sealed) {
      if (!roomManifest?.envelope) throw new Error('The encrypted room data is missing.');
      if (view === 'output') {
        const child = inherited?.manifest.envelope === roomManifest.envelope && inherited.access.scope === '';
        const ticket = new URLSearchParams(location.hash.slice(1)).get('watch');
        roomAccess = child ? { ...inherited.access, slot: target.slot }
          : await AirCastSealed.watch(target.room, ticket, roomManifest.envelope, target.slot);
        roomManifest.expires = roomAccess?.expires;
        showRoom(view);
        return;
      }
      const role = view === 'phone' ? 'contributor' : 'host';
      const recovery = role === 'host' ? saved(AirCastSealed.recoveryKey(target.room)) : '';
      if (role === 'host' && typeof recovery !== 'string') throw new Error('Open Studio in the browser that created this encrypted room.');
      const access = await AirCastSealed.unlock(target.room, roomManifest.envelope, password, recovery);
      roomAccess = { ...access, role, slot: target.slot };
      roomManifest.expires = access.expires;
    }
    showRoom(view);
  } catch (error) {
    if (error.code === 'ROOM_PASSWORD') { showEntryError(error, true); return; }
    if (view === 'output') {
      if (query.get('slate') === 'off') return;
      $('outputPair').hidden = false;
      $('outputPairLayout').dataset.manual = 'true';
      $('outputPairTitle').textContent = 'Room unavailable';
      $('outputPairHint').textContent = error.message;
      $('outputPairQR').hidden = true;
      $('outputPairRoom').textContent = AirCastRooms.output(query).room;
    } else {
      showEntryError(error, false);
    }
  }
}

boot();
