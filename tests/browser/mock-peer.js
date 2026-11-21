(() => {
  class Emitter {
    constructor() { this.events = {}; }
    on(name, fn) { (this.events[name] ||= []).push(fn); }
    emit(name, ...args) { (this.events[name] || []).forEach((fn) => fn(...args)); }
  }
  const channel = new BroadcastChannel('aircast-test-peer');
  let serial = 0;
  class Link extends Emitter {
    constructor(owner, to, id, options) {
      super();
      this.provider = owner; this.owner = owner;
      this.peerConnection = { localDescription: { sdp: 'a=fingerprint:fixture ' + owner.id }, remoteDescription: { sdp: 'a=fingerprint:fixture ' + to } };
      this.peer = to;
      this.id = id;
      this.label = options.label;
      this.metadata = options.metadata;
      this.open = false;
      this.closed = false;
    }
    post(type, data) { channel.postMessage({ type, data, to: this.peer, from: this.owner.id, link: this.id }); }
    send(data) { this.post('data', data); }
    close(remote = false) {
      if (this.closed) return;
      this.closed = true;
      this.open = false;
      if (!remote) this.post('close');
      this.emit('close');
    }
    connected() {
      if (this.open || this.closed) return;
      this.open = true;
      this.emit('open');
    }
  }
  window.Peer = class MockPeer extends Emitter {
    constructor(id) {
      super();
      this.id = typeof id === 'string' ? id : crypto.randomUUID();
      this.links = new Map();
      this.open = false;
      this.destroyed = false;
      this.disconnected = false;
      this.listener = ({ data }) => {
        if (data.to !== this.id || this.destroyed) return;
        if (data.type === 'request') {
          const link = new Link(this, data.from, data.link, data.data);
          this.links.set(link.id, link);
          this.emit('connection', link);
          queueMicrotask(() => {
            if (link.closed) return;
            link.post('ack');
            link.connected();
          });
          return;
        }
        const item = this.links.get(data.link);
        if (!item || item.closed) return;
        if (data.type === 'ack') item.connected();
        if (data.type === 'data') item.emit('data', data.data);
        if (data.type === 'close') item.close(true);
      };
      channel.addEventListener('message', this.listener);
      setTimeout(() => { if (!this.destroyed) { this.open = true; this.emit('open'); } }, 15);
    }
    connect(id, options) {
      const item = new Link(this, id, this.id + ++serial, options);
      this.links.set(item.id, item);
      item.post('request', options);
      setTimeout(() => { if (!item.open && !item.closed) this.emit('error', { type: 'peer-unavailable' }); }, 450);
      return item;
    }
    destroy() {
      this.destroyed = true;
      this.open = false;
      this.links.forEach((item) => item.close());
      channel.removeEventListener('message', this.listener);
    }
  };
})();
