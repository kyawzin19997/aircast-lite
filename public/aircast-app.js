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
  $('joinForm').onsubmit = (event) => {
    event.preventDefault();
    const url = AirCastRooms.joinTarget($('joinValue').value, location.href, $('joinRole').value, $('joinSlot').value);
    if (url) location.assign(url.href);
    else $('joinFeedback').textContent = 'Enter a room ID or paste an invitation from this AirCast site.';
  };
}

async function boot() {
  try {
    if (protectedRoom && view !== 'join') {
      const target = view === 'output' ? AirCastRooms.output(query) : { room: normalizeRoom(query.get('room')), slot: normalizeSlot(query.get('cam')) };
      const role = view === 'output' ? 'viewer' : view === 'phone' ? 'contributor' : 'host';
      roomAccess = await AirCastRooms.enter(target.room, role, target.slot);
    }
    if (view === 'output') obsOutput();
    else if (view === 'phone') phone();
    else if (view === 'join') joinRoom();
    else studio();
  } catch (error) {
    if (!protectedRoom) throw error;
    if (view === 'output') {
      if (query.get('slate') === 'off') return;
      $('outputPair').hidden = false;
      $('outputPairLayout').dataset.manual = 'true';
      $('outputPairTitle').textContent = 'Private output unavailable';
      $('outputPairHint').textContent = error.message;
      $('outputPairQR').hidden = true;
      $('outputPairRoom').textContent = AirCastRooms.output(query).room;
    } else {
      document.documentElement.dataset.view = 'join';
      $('joinTitle').textContent = 'Private room unavailable';
      $('joinFeedback').textContent = error.message;
      joinRoom();
    }
  }
}

boot();
