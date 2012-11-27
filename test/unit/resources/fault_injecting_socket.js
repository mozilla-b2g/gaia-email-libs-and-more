/**
 * Wraps mozTCPSocket so that we can inject a fault.  We can use some combination
 * of injecting fake received data and fake or real closing a connection that is
 * either manually triggered (at a quiescent time), or based on when we observe
 * some data in the incoming or outgoing stream.
 *
 * Actions currently supported:
 * - instant-close: Emit a close event locally in the next turn of the event
 *   loop, and detach the real socket so that we don't generate any more events
 *   from it.  We will optionally generate an error event with the provided
 *   string.
 *
 * Actions that it would be sweet to support:
 * - alter-data: Change the contents of the buffer that matched.
 *
 * - fake-receive: Pretend that we received some data via an ondata event in a
 *   future turn of the event loop.
 */
function FawltySocket(host, port, options, cmdDict) {
  this._sock = null;

  this.onopen = null;
  this.ondata = null;
  this.onerror = null;
  this.onclose = null;

  this._receiveWatches = [];
  this._sendWatches = [];
  if (cmdDict) {
    var precmd = cmdDict.pre;
    console.log('FawltySocket: processing pre-command:', precmd);
    switch (precmd) {
      case 'no-dns-entry':
        // This currently manifests as a Connection refused error.  Test by using
        // the nonesuch@nonesuch.nonesuch domain mapping...
        this._queueEvent('onerror', 'Connection refused');
        return;

      case 'unresponsive-server':
        // we won't generate any event for this whatsoever.  It's on a higher
        // level to alter the IMAP timeout to be very short.  Necko may be
        // capable of generating the timeout itself, but TCPSocket doesn't use it
        // or at least allow changing the defaults right now.
        return;

      case 'port-not-listening':
        this._queueEvent('onerror', 'Connection refused');
        return;
      case 'bad-security':
        // This comes through as a Connection refused.
        this._queueEvent('onerror', 'Connection refused');
        return;

      default:
        break;
    }
    if (cmdDict.onSend)
      this.doOnSendText(cmdDict.onSend);
  }

  // anything we send over the wire will be utf-8
  this._utf8Decoder = new TextDecoder('UTF-8');

  this._sock = window.navigator.realMozTCPSocket.open(host, port, options);
  this._sock.onopen = this._onopen.bind(this);
  this._sock.ondata = this._ondata.bind(this);
  this._sock.onerror = this._onerror.bind(this);
  this._sock.onclose = this._onclose.bind(this);
}
FawltySocket.prototype = {
  get readyState() {
    return this._sock.readyState;
  },
  get binaryType() {
    return this._sock.binaryType;
  },
  get host() {
    return this._sock.host;
  },
  get port() {
    return this._sock.port;
  },
  get ssl() {
    return this._sock.ssl;
  },
  get bufferedAmount() {
    return this._sock.bufferedAmount;
  },

  _onopen: function(event) {
    if (this._sock && this.onopen)
      this.onopen(event);
  },

  _ondata: function(event) {
    if (this._sock && this.ondata)
      this.ondata(event);
  },

  _onerror: function(event) {
    if (this._sock && this.onerror)
      this.onerror(event);
    // all errors are a death sentence; it's okay to remove slightly early.
    FawltySocketFactory.__deadSocket(this);
  },

  _onclose: function(event) {
    if (this._sock && this.onclose)
      this.onclose(event);
    FawltySocketFactory.__deadSocket(this);
  },

  doOnSendText: function(desc) {
    this._sendWatches.push(desc);
  },

  doOnReceiveText: function(match, actions) {
  },

  _queueEvent: function(type, data) {
    var event = { type: type, data: data },
        self = this;

    window.setZeroTimeout(function() {
      if (self[type])
        self[type](event);
      else
        console.warn('FawltySocket: event "' + type + '" not handled!');
    });
  },

  doNow: function(actions, payload) {
    if (!Array.isArray(actions))
      actions = [actions];
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      if (typeof(action) === 'string')
        action = { cmd: action };
      switch (action.cmd) {
        case 'instant-close':
          this._queueEvent('onclose', '');
          this._sock.close();
          this._sock = null;
          break;
        // stop being connected to the real socket
        case 'detach':
          var sock = this._sock;
          this._sock = null;
          sock.close();
          break;
        case 'fake-receive':
          var encoder = new TextEncoder(action.encoding || 'ASCII');
          this._queueEvent('ondata', encoder.encode(action.data));
          break;

      }
    }
  },

  close: function() {
    if (!this._sock)
      return;
    if (this._sock.readyState !== 'closed')
      this._sock.close();
    this._sock = null;
  },
  send: function(data) {
    if (!this._sock)
      return null;



    return this._sock.send(data);
  },
  suspend: function() {
    if (!this._sock)
      return null;
    return this._sock.suspend();
  },
  resume: function() {
    if (!this._sock)
      return;
    this._sock.resume();
  },
};

var FawltySocketFactory = {
  _liveSockets: [],
  _precommands: {},

  open: function(host, port, options) {
    var key = host + port, precmd = null;
    if (this._precommands.hasOwnProperty(key)) {
      var precmds = this._precommands[key];
      precmd = precmds.shift();
      if (!precmds.length)
        delete this._precommands[key];
    }
    var sock = new FawltySocket(host, port, options, precmd);
    this._liveSockets.push(sock);
    return sock;
  },

  /**
   * Allow us to create a failure state for the initial connection of a socket.
   *
   * Supported commands are a subset of the AccountCreationErrors documented in
   * `mailapi.js` right now.  Namely: no-dns-entry, unresponsive-server,
   * port-not-listening, and bad-security.
   *
   */
  precommand: function(host, port, command, onSend) {
    var cmdDict = { pre: command, onSend: onSend };
    var key = host + port;
    if (this._precommands.hasOwnProperty(key))
      this._precommands[key].push(cmdDict);
    else
      this._precommands[key] = [cmdDict];
  },

  __deadSocket: function(sock) {
    var idx = this._liveSockets.indexOf(sock);
    if (idx !== -1)
      this._liveSockets.splice(idx, 1);
  },

  getMostRecentLiveSocket: function() {
    if (!this._liveSockets.length)
      throw new Error('No live sockets!');
    return this._liveSockets[this._liveSockets.length - 1];
  },

  reset: function() {
    this._liveSockets = [];
    this._precommands = {};
  },

  assertNoPrecommands: function(host, port) {
    var key = host + port;
    if (this._precommands.hasOwnProperty(key))
      throw new Error('There are still ' + this._precommands[key].length +
                      'precommands pending for: ' + key);
  },
};
window.navigator.realMozTCPSocket = window.navigator.mozTCPSocket;
window.navigator.mozTCPSocket = FawltySocketFactory;
