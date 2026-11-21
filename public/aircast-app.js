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
function joinRoom() {
  const code = normalizeRoom(query.get('join'));
  if (code) $('joinValue').value = code;
  $('joinSlot').replaceChildren(...CAMERA_SLOTS.map((slot) => new Option(routeName(slot), slot)));
  $('joinRole').onchange = () => { $('joinSlotField').hidden = $('joinRole').value !== 'contributor'; };
  $('createRoom').onclick = () => {
    const form = $('createRoomForm');
    form.hidden = !form.hidden;
    $('createRoom').setAttribute('aria-expanded', String(!form.hidden));
  };
  $('createRoomForm').onsubmit = async (event) => {
    event.preventDefault();
    let password = $('createPassword').value;
    $('createPassword').value = '';
    const hours = Number($('roomExpiry').value);
    const destination = new URL(location.protocol === 'file:' ? './index.html' : './', location.href);
    const room = randomCode(16);
    const expires = hours ? Date.now() + hours * 3600000 : 0;
    destination.searchParams.set('room', room);
    event.submitter.disabled = true;
    $('joinFeedback').textContent = '';
    try {
      if (password) {
        const { envelope, recovery, access } = await AirCastSealed.create(room, password, expires);
        password = '';
        const stored = await AirCastSealed.request('POST', room, envelope);
        roomManifest = { room, envelope, stored, expires };
        roomAccess = { ...access, role: 'host', slot: '' };
        store(AirCastSealed.recoveryKey(room), recovery);
      } else if (expires) {
        await AirCastSealed.request('POST', room, '0.' + expires);
        roomManifest = { room, expires };
      }
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
    const url = AirCastRooms.joinTarget(text, location.href, $('joinRole').value, $('joinSlot').value);
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
  if (!/^[A-Z2-9]{16}$/.test(room)) return null;
  const envelope = new URLSearchParams(address.hash.slice(1)).get('room');
  if (envelope !== null) return { room, envelope, stored: false };
  if (address.searchParams.has('until') && !required) {
    const expires = Number(address.searchParams.get('until'));
    if (/^[1-9]\d{12}$/.test(String(expires))) return { room, expires };
  }
  const record = await AirCastSealed.request('GET', room);
  if (record?.startsWith('1.')) return { room, envelope: record, stored: true };
  if (record?.startsWith('0.')) return { room, expires: Number(record.slice(2)) };
  if (required) throw new Error('The encrypted room data is missing. Open the full room link or scan the QR again.');
  return null;
}

function showRoom(route) {
  if (roomManifest?.expires) {
    AirCastSealed.checkExpiry(roomManifest.expires);
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
    room: normalizeRoom(query.get('room')), slot: normalizeSlot(query.get('cam')) || 'CAM1'
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
    if (sealed || query.has('until')) roomManifest ||= await findRoom(target.room, new URL(location.href), sealed);
    if (sealed) {
      const role = view === 'output' ? 'viewer' : view === 'phone' ? 'contributor' : 'host';
      if (!roomManifest?.envelope) throw new Error('The encrypted room data is missing.');
      const recovery = role === 'host' ? saved(AirCastSealed.recoveryKey(target.room)) : '';
      if (role === 'host' && typeof recovery !== 'string') throw new Error('Open Studio in the browser that created this encrypted room.');
      const access = inherited?.manifest.envelope === roomManifest.envelope ? inherited.access
        : await AirCastSealed.unlock(target.room, roomManifest.envelope, password, recovery);
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
