define(
  [
    'tcp-socket',
    'exports'
  ],
  function(
    tcpSocket,
    exports
  ) {

var realTcpSocketOpen = tcpSocket.open.bind(tcpSocket);

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
  console.log('FawltySocket constructor for:', host, port);
  this._sock = null;
  this._mockId = lastMockId++;

  this._receiveWatches = [];
  this._sendWatches = [];
  if (cmdDict && cmdDict.callOnOpen) {
    cmdDict.callOnOpen();
  }
  this._callOnWrite = (cmdDict && cmdDict.callOnWrite) || null;
  if (cmdDict && cmdDict.onSend)
    this.doOnSendText(cmdDict.onSend);
  if (cmdDict && cmdDict.pre) {
    var precmd = cmdDict.pre;
    console.log('FawltySocket: processing pre-command:', precmd.cmd || precmd);
    switch (precmd.cmd || precmd) {
      case 'no-dns-entry':
        // This currently manifests as a Connection refused error.  Test by using
        // the nonesuch@nonesuch.nonesuch domain mapping...
        this._queueEvent('error', 'Connection refused');
        return;

      case 'unresponsive-server':
        // we won't generate any event for this whatsoever.  It's on a higher
        // level to alter the IMAP timeout to be very short.  Necko may be
        // capable of generating the timeout itself, but TCPSocket doesn't use it
        // or at least allow changing the defaults right now.
        return;

      case 'bad-security':
        this._queueEvent('error', { name: 'SecurityUntrustedIssuerError' });
        return;

      case 'close-on-send':
        setTimeout(function() {
          this.doOnSendText([{ match: precmd.match || true,
                               actions: ['instant-close'] }]);
        }.bind(this));
        break;

      case 'fake':
        // We are only going to send fake data, so don't bother establishing
        // a connection.
        this._queueEvent('open');
        if (precmd.data) {
          console.log('Fake-receiving:', precmd.data);
          this._queueEvent('data',
                           new TextEncoder('utf-8').encode(precmd.data));
        }
        else {
          console.log('No fake-receive data!');
        }
        return;

      case 'fake-no-connect':
        // just be fake, but don't even send a fake connect event yet.  owner
        // should call _queueEvent('open') when ready to connect.
        return;

      case 'port-not-listening':
        this._queueEvent('error', 'Connection refused');
        return;
      case 'bad-security':
        // This comes through as a Connection refused.
        this._queueEvent('error', 'Connection refused');
        return;

      default:
        break;
    }
  }

  // anything we send over the wire will be utf-8
  this._utf8Decoder = new TextDecoder('UTF-8');

  console.log('Creating real socket for:', host, port);
  this._sock = realTcpSocketOpen(host, port, {
    useSecureTransport: options.useSecureTransport
  });
  this._sock.onopen = this._reEmit.bind(this, 'open');
  this._sock.ondrain = this._reEmit.bind(this, 'drain');
  this._sock.onerror = this._reEmit.bind(this, 'error');
  this._sock.ondata = this._reEmit.bind(this, 'data');
  this._sock.onclose = this._reEmit.bind(this, 'close');
}


FawltySocket.prototype = {
  setTimeout: function() {},
  setKeepAlive: function() {},

  get readyState() {
    if (this._sock) {
      return this._sock.readyState;
    } else {
      return this._readyState;
    }
  },

  _reEmit: function(name, data) {
    if (name === 'error' || name === 'close') {
      FawltySocketFactory.__deadSocket(this);
    }

    var handler = 'on' + name;
    if (this[handler]) {
      this[handler].call(this, data);
    }
  },

  // XXX This is currently a hack and just operates based on the number of
  // times send() has been called.  I'm not sure it's worth actually finishing
  // this out; the IMAP fake-server might be better for most of this.
  /**
   * @args[
   *   @param[triggerDescs @listof[
   *     @dict[
   *       @key[match @oneof[true RegExp]]{
   *         The send pattern to look for.  If 'true', that means just match on the
   *         basis of the function call.  If it's a regexp, we wait for the regexp
   *         to match, then fire.  Note that a regexp effectively consumes the
   *         entire buffer for the given write/send call; we don't just consume
   *         half the buffer.
   *       }
   *       @key[actions @listof[FawltyAction]]
   *     ]
   *   ]]
   * ]
   */
  doOnSendText: function(triggerDescs) {
    // concat detects arrays/single values
    this._sendWatches = this._sendWatches.concat(triggerDescs);
  },

  _queueEvent: function(type, data) {
    window.setZeroTimeout(this.emit.bind(this, type, data));
  },

  /**
   *
   * @typedef[FawltyActionCommand @oneof[
   *   @case['instant-close']{
   *     Enqueue close/end events and 'detach' the socket.
   *   }
   *   @case['detach']{
   *     Stop all events from the real socket from reaching us, then close the
   *     real socket.  This action will not generate close/end events, allowing
   *     you to then use 'fake-receive' or whatever you want.
   *   }
   *   @case['fake-receive']{
   *     Pretend to receive the data from the 'data' attribute of the action def
   *     (which we automatically encode into utf-8 for you).
   *   }
   * ]]
   * @typedef[FawltyAction @oneof[
   *   @case[FawltyActionCommand]{
   *     For actions that don't have a payload, you can just provide the name as
   *     a string.
   *   }
   *   @case[@dict[
   *     @key[cmd FawltyActionCommand]
   *     @key[data #:optional]
   *   ]]{
   *     For more complex actions, provide a `cmd` and anything else needed,
   *     usually `data`.
   *   }
   * ]
   *
   * @args[
   *   @param[actions @listof[FawltyAction]]
   * ]
   */
  doNow: function(actions) {
    if (!Array.isArray(actions))
      actions = [actions];
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      if (typeof(action) === 'string')
        action = { cmd: action };
      console.log('FawltySocket.doNow:', action.cmd);
      switch (action.cmd) {
        case 'instant-close':
          // Emit a close event locally in the next turn of the event loop, and
          // detach the real socket so that we don't generate any more events
          // from it.
          this._queueEvent('close');
          if (this._sock) {
            this._sock.close();
            this._sock = null;
          }
          FawltySocketFactory.__deadSocket(this);
          break;
        case 'detach':
          // stop being connected to the real socket
          var sock = this._sock;
          this._sock = null;
          sock.close();
          FawltySocketFactory.__deadSocket(this);
          break;
        case 'fake-receive':
          console.log('Fake-receiving:', action.data);
          var encoder = new TextEncoder('utf-8');
          this._queueEvent('data', encoder.encode(action.data));
          break;

      }
    }
  },

  emit: function(name, data) {
    var handler = 'on' + name;
    var evt = { name: name, data: data };

    if (name === 'open') {
      this._readyState = 'open';
    } else if (name === 'close') {
      this._readyState = 'closed';
    };

    if (this._sock && this._sock[handler]) {
      this._sock[handler].call(this._sock, evt);
    }
    if (this[handler]) {
      this[handler].call(this, evt);
    }
  },

  close: function() {
    if (!this._sock) {
      return;
    }
    console.log('FawltySocket: close() called by user code');
    this.emit('close');
    var sock = this._sock;
    this._sock = null;
    sock.close();
    FawltySocketFactory.__deadSocket(this);
  },

  send: function(data) {
    if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    } else if (typeof data === 'string') {
      data = new TextEncoder('utf-8').encode(data);
    }
    var sendText;
    if (this._sendWatches.length) {
      sendText = new TextDecoder('utf-8').decode(data);
      var firstWatch = this._sendWatches[0];

      if (firstWatch.match === true ||
          firstWatch.match.test(sendText)) {
        this._sendWatches.shift();
        console.log('In response to send of: ', sendText);
        this.doNow(firstWatch.actions);
        return true;
      }
    }

    if (this._callOnWrite) {
      sendText = new TextDecoder('utf-8').decode(data);
      this._callOnWrite(sendText);
    }

    if (!this._sock) {
      sendText = new TextDecoder('utf-8').decode(data);
      console.log('Ignoring send because no sock or watch:', sendText);
      return null;
    }

    return this._sock.send(data);
  },
};


var FawltySocketFactory = exports.FawltySocketFactory = {
  // 'live' means looks open to code using the fake socket; this has nothing to
  // do with actually having a real socket connection backing the fake sock.
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
  precommand: function(host, port, command, onSend, otherOpts) {
    var cmdDict = {
      pre: command, onSend: onSend,
      callOnOpen: (otherOpts && otherOpts.callOnOpen) || undefined,
      callOnWrite: (otherOpts && otherOpts.callOnWrite) || undefined
    };
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


tcpSocket.open = function(host, port, options) {
  return FawltySocketFactory.open(host, port, options);
};

window.navigator.realMozTCPSocket = window.navigator.mozTCPSocket;
window.navigator.mozTCPSocket = FawltySocketFactory;

}); // end define
