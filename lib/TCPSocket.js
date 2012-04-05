/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/*Jetpack*/
const {Cc,Ci,Cr,Cu,CC,components} = require("chrome"),
      PermissionChecker = require('./tcp_permissions').PermissionChecker;
let importNS = {};
Cu.import("resource://gre/modules/Services.jsm", importNS);
Cu.import("resource://gre/modules/XPCOMUtils.jsm", importNS);
const Services = importNS.Services;
const XPCOMUtils = importNS.XPCOMUtils;
/**/

/*B2G
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;
const CC = Components.Constructor;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm", importNS);
*/

let debug = false;
function LOG(msg) {
  if (debug)
    dump(msg);
}

const nsITransport = Ci.nsITransport,
      BinaryInputStream = CC("@mozilla.org/binaryinputstream;1",
                             "nsIBinaryInputStream", "setInputStream"),
      BinaryOutputStream = CC("@mozilla.org/binaryoutputstream;1",
                              "nsIBinaryOutputStream", "setOutputStream"),
      Pipe = CC("@mozilla.org/pipe;1", "nsIPipe", "init"),
      AsyncStreamCopier = CC("@mozilla.org/network/async-stream-copier;1",
                             "nsIAsyncStreamCopier", "init"),
      InputStreamPump = CC("@mozilla.org/network/input-stream-pump;1",
                           "nsIInputStreamPump",
                           "init");


/*
 * nsITCPSocketEvent object
 */
function TCPSocketEvent(type, data) {
  this.type = type;
  this.data = data;
}

TCPSocketEvent.prototype = {
/*B2G
  classID: Components.ID("{f29a577b-e831-431e-a540-1c4856721c82}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsITCPSocketEvent]),

  classInfo: XPCOMUtils.generateCI({
    classID: Components.ID("{f29a577b-e831-431e-a540-1c4856721c82}"),
    contractID: "@mozilla.org/tcp-socket-event;1",
    classDescription: "TCP Socket Event",
    interfaces: [Ci.nsITCPSocketEvent],
    flags: Ci.nsIClassInfo.DOM_OBJECT
  })
*/
};


function createTransport(host, port, sslMode) {
console.log("sslmode:", sslMode, sslMode.length);
  return Cc["@mozilla.org/network/socket-transport-service;1"]
           .getService(Ci.nsISocketTransportService)
           .createTransport(sslMode, sslMode.length, host, port, null);
}


/**
 * Maximum send buffer size (in 64KiB chunks) before we threaten to close the
 *  connection.
 */
const MAX_SEND_BUFFER_SIZE_64K_CHUNKS = 128 * 16;

/*
 * nsITCPSocket object
 */
function TCPSocket(ownerInfo) {
  /**
   * The state is always one of:
   * - closed: We are neither connected nor attempting to initiate a
   *    connection.
   * - authorizing: We are waiting on the user to authorize the connection.
   * - connecting: We are trying to establish the connection.
   * - connected: The connection is established.
   * - securing: The connection is upgrading to a TLS connection from a non-SSL
   *    cleartext connection.  Once secured, our state returns to connected.
   */
  this.readyState = 'closed'; // readOnly

  /**
   * This event is generated when the connection is established.
   */
  this.onopen = null;
  /**
   * This event is generated whenever data is received from the socket.  The
   * recipient should make no assumption about the amount of data received
   * with each event.
   */
  this.ondata = null;
  /**
   * This event is synchronously generated when an attempt to write to the
   * socket would overflow the send buffer.  No bytes are enqueued in that case.
   * If preventDefault is not invoked on the event then the connection will be
   * closed.  If preventDefault is invoked, the caller must take care to
   * observe the state of 
   */
  this.onsendoverflow = null;
  /**
   * This event is generated whenever any type of error is encountered involving
   * the connection.
   */
  this.onerror = null;
  this.onclose = null;
  /**
   * This event is generated when an SSL certificate exception is added by the
   * user and so it is reasonable to attempt to retry the connection.
   */
  this.oncertoverride = null;

  this._ownerInfo = ownerInfo;

  this.host = "";
  this.port = -1;
  this.ssl = false;
  this._sslSettings = null;
};

TCPSocket.prototype = {
  _transport: null,
  _rawOutputStream: null,
  _outputStreamPipe: null,
  _outputStreamCopier: null,
  _binaryOutputStream: null,
  _inputStream: null,
  _binaryInputStream: null,
  _request: null,

  dispatchEvent: function ts_dispatchEvent(type, data) {
    if (!this[type])
      return null;

    let event = new TCPSocketEvent(type, data || "");
    /*B2G
    this[type].handleEvent(event);
    */
    /*Jetpack*/
try {
    this[type](event);
}
catch (ex) {
  console.error("Exception in", type, ex, "\n", ex.stack);
}
    /**/
    return event;
  },

  // nsITCPSocket
  open: function ts_open(host, port, ssl, sslOptions) {
    if (this.readyState !== 'closed') {
      this.dispatchEvent("onerror", "Socket is already opened");
      return;
    }

    switch (ssl) {
      case 'ssl':
      case 'starttls':
        break;
      default:
        ssl = false;
    }

    this.readyState = 'authorizing';

    let self = this;
    PermissionChecker.checkTCPConnectionAllowed(
      this._ownerInfo, host, port, Boolean(ssl),
      function allowed() {
        self._open(host, port, ssl, sslOptions);
      });
  },

  startTLS: function() {
    this._transport.securityInfo.QueryInterface(Ci.nsISSLSocketControl)
                                .StartTLS();
  },

  _open: function(host, port, ssl, sslOptions) {
    LOG("startup called\n");
    LOG("Host info: " + host + ":" + port + "\n");

    this.readyState = 'connecting';
    this.host = host;
    this.port = port;
    this.ssl = ssl;
    let sslMode;
    if (ssl)
      sslMode = [ssl];
    else
      sslMode = [];
    if (ssl && sslOptions && typeof(sslOptions) === 'object')
      this._sslSettings = sslOptions;
    else
      this._sslSettings = {};

    let transport = this._transport = createTransport(host, port, sslMode);
/* debugging only stuff
    transport.setEventSink({
      onTransportStatus: function(aTransport, aStatus, aProgress, aProgressMax) {
        const nsITransportEventSinkStatus = {
          0x804b0003: "STATUS_RESOLVING",
          0x804b000b: "STATUS_RESOLVED",
          0x804b0007: "STATUS_CONNECTING_TO",
          0x804b0004: "STATUS_CONNECTED_TO",
          0x804b0005: "STATUS_SENDING_TO",
          0x804b000a: "STATUS_WAITING_FOR",
          0x804b0006: "STATUS_RECEIVING_FROM"
        };

        let status = nsITransportEventSinkStatus[aStatus];
        console.log("transportStatus: " + (status || ("0x" + aStatus.toString(16))));
      }
    }, Services.tm.currentThread);
*/
    transport.securityCallbacks = new SecurityCallbacks(this);

    // - Output Stream    
    // Open the socket as unbuffered and non-blocking so that the raw socket
    // output stream will be exposed and we can manually hook a pipe up to it.
    // By manually hooking up the pipe we are able to see both its input and
    // output streams.  If we had openOutputStream create the pipe for us,
    // we would not get to see the input stream, and so would be unable to
    // use its available() method to know how much data is buffered for our
    // `bufferedAmount` getter.
    this._outputStream = transport.openOutputStream(0, 0, 0);
    this._binaryOutputStream = new BinaryOutputStream(this._outputStream);

    // - Input Stream
    this._inputStream = transport.openInputStream(0, 0, 0);
    this._binaryInputStream = new BinaryInputStream(this._inputStream);

    // call onOutputStreamReady when connected
    this._outputStream.asyncWait(this, 0, 0, null);    
  },

  // nsIAsyncOutputStream
  onOutputStreamReady: function ts_onOutputStreamReady(stream) {
    if (this.readyState === 'connecting') {    
      this.readyState = 'open';
      this.dispatchEvent("onopen");
      new InputStreamPump(
        this._inputStream, -1, -1, 0, 0, false
      ).asyncRead(this, null);
    } else {
      this.dispatchEvent("ondrain");
    }
  },

  close: function ts_close() {
    if (this.readyState === 'closing' || this.readyState === 'closed')
      return;

    LOG("close called\n"); 
    this.readyState = 'closing';

    this._outputStream.close();
    this._inputStream.close();
    this._transport.close(Cr.NS_OK);
  },

  send: function ts_send(data) {
    if (this.readyState !== 'open') {
      this.dispatchEvent("onerror", "Socket is not opened");
      return;
    }

    if (data === undefined)
      return;

    if (typeof(data) === "string") {
      this._binaryOutputStream.writeBytes(data, data.length);
      return;
    }

    /*Jetpack*/
    // Until https://bugzilla.mozilla.org/show_bug.cgi?id=737245 is fixed,
    // cross-compartment typed arrays (aka those wrapped in a proxy) will fail
    // checks for being typed arrays, so we need to copy their contents to a
    // local typed array for now.
    let srcData = data;
    data = new Uint8Array(srcData);
    /**/

    try {
      this._binaryOutputStream.writeByteArray(data, data.length);
    }
    catch (ex) {
      if (ex.result === Cr.NS_BASE_STREAM_WOULD_BLOCK) {
        // Synchronously dispatch a notification about the send overflow
        // and close the connection if they don't prevent it.
        let event = this.dispatchEvent("onsendoverflow");
        if (!event || !event.defaultPrevented)
          this.close();
      }
      else {
        throw ex;
      }
    }
  },

  suspend: function ts_suspend() {
    if (this._request) {
      this._request.suspend();
    }
  },

  resume: function ts_resume() {
    if (this._request) {
      this._request.resume();
    }
  },

  // nsIStreamListener
  onStartRequest: function ts_onStartRequest(request, context) {
    this._request = request;
  },

  onStopRequest: function ts_onStopRequest(request, context, status) {
    this.readyState = 'closed';
    this._request = null;

    if (status) {
      this.dispatchEvent("onerror", "Error " + status);
    }

    this.dispatchEvent("onclose");
  },

  onDataAvailable: function ts_onDataAvailable(request, context, inputStream,
                                               offset, count) {
    // Although XPConnect can accept typed arrays, it cannot produce them, so
    // we need to create the typed array ourselves here and shuttle the bytes.
    let xpcArray = this._binaryInputStream.readByteArray(count),
        buffer = new ArrayBuffer(count),
        u8View = new Uint8Array(buffer);
    for (let i = 0; i < count; i++) {
      u8View[i] = xpcArray[i];
    }
    this.dispatchEvent("ondata", u8View);
  },

/*B2G
  classID: Components.ID("{cda91b22-6472-11e1-aa11-834fec09cd0a}"),
  
  classInfo: XPCOMUtils.generateCI({
    classID: Components.ID("{cda91b22-6472-11e1-aa11-834fec09cd0a}"),
    contractID: "@mozilla.org/tcp-socket;1",
    classDescription: "TCP Socket Helper",
    interfaces: [Ci.nsITCPSocket],
    flags: Ci.nsIClassInfo.DOM_OBJECT,
  }),

  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsITCPSocket
  ])
*/
}

function SecurityCallbacks(socket) {
  this._socket = socket;
}

SecurityCallbacks.prototype = {
  notifySSLError: function sc_notifySSLError(socketInfo, error, targetSite) {
    this._socket.dispatchEvent("onerror", "SSL Error: " + error);
  },

  /**
   * Translate error messages and potentially trigger UI for generating
   * certificate exceptions if the 
   */
  notifyCertProblem: function sc_notifyCertProblem(socketInfo, status,
                                                   targetSite) {
    if (this._socket._sslSettings.allowOverride) {
      let socket = this._socket;
      PermissionChecker.handleBadCertificate(
        socket._ownerInfo, socket.host, socket.port, targetSite,
        function exceptionAddedRetryConnection() {
          // The user added an exception.
          socket.dispatchEvent("oncertoverride");
        });
    }

    let msg = "Certificate error: ";
    if (status.isDomainMismatch) {
      msg = msg + "Domain Mismatch";
    } else if (status.isNotValidAtThisTime) {
      msg = msg + "Not valid at this time";
    } else {
      msg = msg + "Error";
    }
    this._socket.dispatchEvent("onerror", msg);
  },

  getInterface: function sc_getInterface(iid) {
    return this.QueryInterface(iid);
  },

  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsIBadCertListener2, Ci.nsISSLErrorListener
  ]),
};

/*B2G
const NSGetFactory = XPCOMUtils.generateNSGetFactory([TCPSocket]);
*/

/*Jetpack*/
exports.TCPSocket = TCPSocket;
/**/
