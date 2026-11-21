'use strict';

const AirCastRooms = (() => {
  const room = (value) => typeof value === 'string' && /^[A-Z0-9]{3,16}(?:-[A-Z2-9]{16})?$/i.test(value) ? value.toUpperCase() : '';
  const slot = (value) => typeof value === 'string' && /^CAM(?:[1-9]|1\d|2[0-4])$/i.test(value) ? value.toUpperCase() : '';

  function output(query) {
    const roomParam = query.get('room');
    const legacy = roomParam !== null && query.get('obs') === 'direct';
    const cameraNumber = query.get('c');
    const rawSlot = query.get('cam') || (cameraNumber !== null ? 'CAM' + cameraNumber : legacy ? 'CAM1' : '');
    const camera = slot(rawSlot);
    return { room: room(roomParam ?? query.get('obs')), slot: camera, invalidSlot: Boolean(rawSlot && !camera) };
  }

  function joinTarget(input, base, role, camera) {
    const code = room(input.trim());
    let url;
    if (code) {
      url = new URL(base);
      url.search = '';
      url.hash = '';
      if (role === 'contributor') {
        url.searchParams.set('mode', 'sender');
        url.searchParams.set('room', code);
        if (camera) url.searchParams.set('cam', camera);
        else url.searchParams.set('auto', '1');
      } else {
        url.searchParams.set('obs', code);
      }
      return url;
    }
    try { url = new URL(input.trim(), base); } catch { return null; }
    const current = new URL(base);
    const scope = new URL('.', current).pathname;
    if (url.origin !== current.origin || url.username || url.password || ![scope, scope + 'index.html'].includes(url.pathname)) return null;
    const query = url.searchParams;
    const sender = query.get('mode') === 'sender' && room(query.get('room'));
    const receiver = (query.has('obs') || query.get('clean') === 'true') && output(query).room && !output(query).invalidSlot;
    return sender || receiver ? url : null;
  }

  function endpoint(code, camera) {
    return camera ? 'AIRCAST-CAMERA-' + code + '-' + camera : 'AIRCAST-HUB3-' + code;
  }

  return { room, slot, output, joinTarget, endpoint };
})();

if (typeof module !== 'undefined') module.exports = AirCastRooms;
