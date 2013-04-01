(function(window) {

/**
 * Creates a event handler wrapper which will either call socket.on[type]
 * or send the event to a FawltySocket consumer (see consumeEventHandler).
 */
function eventHandler(type, killSocket) {
  var method = 'on' + type;

  return function(event) {
    var consumer = this._eventConsumers[type];
    if (this._sock) {
      if (killSocket) {
        FawltySocketFactory.__deadSocket(this);
      }

      if (consumer && consumer(event)) {
        // event was consumed
        return;
      }

      // emit the event to the real listener
      this[method] && this[method](event);
    }
  };
}

/**
 * For debugging and easy identification of spy sockets.
 */
var lastMockId = 1;

/**
 * Wraps mozTCPSocket so that we can inject a fault.  We can use some combination
 * of injecting fake received data and fake or real closing a connection that is
 * either manually triggered (at a quiescent time), or based on when we observe
 * some data in the incoming or outgoing stream.
 *
 * Please see the inline switch() case comments for details / docs:
 */
function FawltySocket(host, port, options, cmdDict) {
  this._sock = null;
  this._mockId = lastMockId++;

  this.onopen = null;
  this.ondata = null;
  this.onerror = null;
  this.onclose = null;

  this._receiveWatches = [];
  this._sendWatches = [];
  if (cmdDict && cmdDict.onSend)
    this.doOnSendText(cmdDict.onSend);
  if (cmdDict && cmdDict.pre) {
    var precmd = cmdDict.pre;
    console.log('FawltySocket: processing pre-command:', precmd.cmd || precmd);
    switch (precmd.cmd || precmd) {
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

      case 'bad-security':
        // Fake an nsISSLStatus object, which is what bad crypto engenders
        var fakeSslError = {
          serverCert: {},
          cipherName: 'zob',
          keyLength: 2048,
          secretKeyLength: 2048,
          isDomainMismatch: false,
          isNotValidAtThisTime: false,
          isUntrusted: false,
          isExtendedValidation: false
        };
        this._queueEvent('onerror', fakeSslError);
        return;

      case 'fake':
        // We are only going to send fake data, so don't bother establishing
        // a connection.
        this._queueEvent('onopen');
        if (precmd.data) {
          console.log('Fake-receiving:', precmd.data);
          this._queueEvent('ondata',
                           new TextEncoder('utf-8').encode(precmd.data));
        }
        else {
          console.log('No fake-receive data!');
        }
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
  }

  // anything we send over the wire will be utf-8
  this._utf8Decoder = new TextDecoder('UTF-8');

  this._sock = window.navigator.realMozTCPSocket.open(host, port, options);
  this._sock.onopen = this._onopen.bind(this);
  this._sock.ondata = this._ondata.bind(this);
  this._sock.onerror = this._onerror.bind(this);
  this._sock.onclose = this._onclose.bind(this);

  this._eventConsumers = {};
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

  /**
   * Every event sent by this socket will clear the given function
   * prior to being passed off to the real event handler.
   *
   *
   *    socket.consumeEventHandler('data', function(event) {
   *      if (...) {
   *        // true indicates that this event should _not_ be sent
   *        // to the real .ondata handler...
   *        return true;
   *      }
   *    });
   *
   */
  consumeEventHandler: function(type, callback) {
    this._eventConsumers[type] = callback;
  },

  clearConsumeEventsHandler: function(type) {
    if (type) {
      return (delete this._eventConsumers[type]);
    }

    this._eventConsumers = {};
  },

  _onopen: eventHandler('open'),
  _ondata: eventHandler('data'),
  _onerror: eventHandler('error', true),
  _onclose: eventHandler('close', true),

  // XXX This is currently a hack and just operates based on the number of
  // times send() has been called.  I'm not sure it's worth actually finishing
  // this out; the IMAP fake-server might be better for most of this.
  doOnSendText: function(desc) {
    // concat detects arrays/single values
    this._sendWatches = this._sendWatches.concat(desc);
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
          // Emit a close event locally in the next turn of the event loop, and
          // detach the real socket so that we don't generate any more events
          // from it.  We will optionally generate an error event with the
          // provided string.
          this._queueEvent('onclose', '');
          this._sock.close();
          this._sock = null;
          break;
        case 'detach':
          // stop being connected to the real socket
          var sock = this._sock;
          this._sock = null;
          sock.close();
          break;
        case 'fake-receive':
          var encoder = new TextEncoder('utf-8');
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
    var sendText;
    if (this._sendWatches.length) {
      sendText = new TextDecoder('utf-8').decode(data);
      console.log('In response to send of: ', data);
      var responseText = this._sendWatches.shift();
      console.log('Fake-receiving:', responseText);
      var responseData = new TextEncoder('utf-8').encode(responseText);
      this._queueEvent('ondata', responseData);
      // it's okay to send more data
      return true;
    }

    if (!this._sock) {
      sendText = new TextDecoder('utf-8').decode(data);
      console.log('Ignoring send beacuse no sock or watch:', sendText);
      return null;
    }

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
   * port-not-listening, and bad-security, plus one bonus: fake.
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

  findImapSocket: function() {
    return this.findLiveSocketWith(function(socket) {
      // assuming quite a bit but probably fine for our initial tests.
      return socket.port === 143 || socket.port == 993;
    });
  },

  /**
   * Attempt to find a live socket with a filter function.
   *
   *
   *    // bad way of finding a IMAP socket
   *    var socket = FawltySocketFactory.findLiveSocketWith(function(sock) {
   *      return sock.port === 143
   *    });
   *
   */
  findLiveSocketWith: function(enumerator) {
    var len = this._liveSockets.length;
    for (var i = 0; i < len; i++) {
      if (enumerator(this._liveSockets[i])) {
        return this._liveSockets[i];
      }
    }

    return null;
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
window.FawltySocketFactory = FawltySocketFactory;

}(this));
