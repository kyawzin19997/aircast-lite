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
    const password = $('createPassword').value;
    const hours = Number($('roomExpiry').value);
    const destination = new URL(location.protocol === 'file:' ? './index.html' : './', location.href);
    event.submitter.disabled = true;
    $('joinFeedback').textContent = '';
    try {
      const created = await AirCastRooms.request('create', { openJoin: true, password, hours });
      if (!normalizeRoom(created.room) || !created.secret) throw new Error('The room authority is unavailable.');
      AirCastRooms.remember(created.room, created.secret);
      destination.searchParams.set('room', created.room);
      destination.searchParams.set('private', '1');
    } catch (error) {
      if (password || hours || (error.status && ![404, 503].includes(error.status))) {
        $('joinFeedback').textContent = !error.status || [404, 503].includes(error.status)
          ? 'Passwords and expiration require the Cloudflare ROOMS binding.'
          : error.message;
        event.submitter.disabled = false;
        return;
      }
      destination.searchParams.set('room', randomCode(16));
    }
    location.assign(destination);
  };
  $('joinForm').onsubmit = async (event) => {
    event.preventDefault();
    const text = $('joinValue').value;
    const url = AirCastRooms.joinTarget(text, location.href, $('joinRole').value, $('joinSlot').value);
    if (!url) { $('joinFeedback').textContent = 'Enter a room ID or paste an invitation from this AirCast site.'; return; }
    const code = normalizeRoom(text.trim());
    try {
      if (await AirCastRooms.managed(code)) url.searchParams.set('private','1');
    } catch (error) { $('joinFeedback').textContent = error.message; return; }
    location.assign(url.href);
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

async function boot(password) {
  try {
    if (protectedRoom && view !== 'join') {
      const target = view === 'output' ? AirCastRooms.output(query) : { room: normalizeRoom(query.get('room')), slot: normalizeSlot(query.get('cam')) };
      const role = view === 'output' ? 'viewer' : view === 'phone' ? 'contributor' : 'host';
      roomAccess = await AirCastRooms.enter(target.room, role, target.slot, password);
      if (roomAccess.expires) setTimeout(() => location.reload(), Math.max(0, roomAccess.expires - Date.now() + 100));
    }
    document.documentElement.dataset.view = view;
    if (view === 'output') obsOutput();
    else if (view === 'phone') phone();
    else if (view === 'join') joinRoom();
    else studio();
  } catch (error) {
    if (!protectedRoom) throw error;
    if (error.code === 'ROOM_PASSWORD') { showEntryError(error, true); return; }
    if (view === 'output') {
      if (query.get('slate') === 'off') return;
      $('outputPair').hidden = false;
      $('outputPairLayout').dataset.manual = 'true';
      $('outputPairTitle').textContent = 'Private output unavailable';
      $('outputPairHint').textContent = error.message;
      $('outputPairQR').hidden = true;
      $('outputPairRoom').textContent = AirCastRooms.output(query).room;
    } else {
      showEntryError(error, false);
    }
  }
}

boot();
