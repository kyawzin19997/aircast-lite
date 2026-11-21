'use strict';

const AirCastDiagnostics = (() => {
  function sample(report, prior) {
    const rows = [...report.values()];
    const transport = rows.find((row) => row.type === 'transport' && row.selectedCandidatePairId);
    const pair = transport && report.get(transport.selectedCandidatePairId);
    const candidates = pair ? [report.get(pair.localCandidateId), report.get(pair.remoteCandidateId)] : [];
    const media = rows.find((row) => ['inbound-rtp','outbound-rtp'].includes(row.type) && (row.kind || row.mediaType) === 'video');
    if (!media) return { path: candidates.length ? candidates.some((item) => item?.candidateType === 'relay') ? 'Relayed' : 'Direct' : '—', rtt: pair?.currentRoundTripTime };
    const remote = media.remoteId && report.get(media.remoteId);
    const bytes = media.bytesReceived ?? media.bytesSent;
    const received = media.packetsReceived ?? media.packetsSent;
    const lost = media.packetsLost ?? remote?.packetsLost;
    const key = media.id + ':' + media.ssrc;
    const elapsed = prior?.key === key ? media.timestamp - prior.time : 0;
    const missed = lost - prior?.lost;
    const packets = received - prior?.received;
    return { width: media.frameWidth, height: media.frameHeight, fps: media.framesPerSecond,
      path: candidates.length ? candidates.some((item) => item?.candidateType === 'relay') ? 'Relayed' : 'Direct' : '—',
      rtt: pair?.currentRoundTripTime,
      kbps: elapsed > 0 && bytes >= prior.bytes ? Math.round((bytes - prior.bytes) * 8 / elapsed) : null,
      loss: elapsed > 0 && missed >= 0 && packets >= 0 && packets + missed ? 100 * missed / (packets + missed) : null,
      base: { key, time: media.timestamp, bytes, received, lost } };
  }

  function panel(read) {
    const target = document.createElement('aside');
    target.className = 'connection-card';
    target.setAttribute('aria-label', 'Connection diagnostics');
    target.hidden = true;
    const details = document.createElement('div');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn ghost tiny';
    close.textContent = 'Close diagnostics';
    close.onclick = () => toggle(false);
    target.append(details, close);
    document.body.append(target);
    let timer;
    let pc;
    let last;
    let generation = 0;
    async function refresh() {
      const turn = generation;
      const current = read();
      if (pc !== current.pc) { pc = current.pc; last = null; }
      let result;
      try { if (pc) result = sample(await pc.getStats(), last); } catch { /* Stats can disappear during reconnect. */ }
      if (turn !== generation) return;
      last = result?.base;
      const num = (value, unit) => Number.isFinite(value) ? value + unit : '—';
      const rounded = (value, factor) => Number.isFinite(value) ? Math.round(value * factor) : null;
      details.textContent = [current.route || 'No route', 'Signaling  ' + (current.signal || 'Starting'),
        'Media      ' + (pc?.connectionState || 'Waiting'), 'Retry      ' + (current.retry ?? 0),
        'Path       ' + (result?.path || '—'), 'Frame      ' + (result?.width && result?.height ? result.width + ' × ' + result.height : '—'),
        'FPS        ' + num(rounded(result?.fps, 1), ' fps'), 'Bitrate    ' + num(result?.kbps, ' kbps'),
        'Loss       ' + num(rounded(result?.loss, 100) === null ? null : rounded(result.loss, 100) / 100, '%'),
        'RTT        ' + num(rounded(result?.rtt, 1000), ' ms')].join('\n');
      if (!target.hidden) timer = setTimeout(refresh, 1500);
    }
    function toggle(force) {
      target.hidden = !(force ?? target.hidden);
      ++generation;
      clearTimeout(timer);
      last = null;
      if (!target.hidden) refresh();
    }
    document.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'd' && !event.repeat && !event.target.closest?.('input,select,textarea')) toggle();
    });
    window.addEventListener('pagehide', () => toggle(false));
    return { toggle };
  }

  return { sample, panel };
})();
if (typeof module !== 'undefined') module.exports = AirCastDiagnostics;
