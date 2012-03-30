/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;
const CC = Components.Constructor;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

let debug = false;
function LOG(msg) {
  if (debug)
    dump(msg);
}

/*
 * nsITCPSocketEvent object
 */
function TCPSocketEvent(type, data) {
  this.type = type;
  this.data = data;
}

TCPSocketEvent.prototype = {
  classID: Components.ID("{f29a577b-e831-431e-a540-1c4856721c82}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsITCPSocketEvent]),

  classInfo: XPCOMUtils.generateCI({
    classID: Components.ID("{f29a577b-e831-431e-a540-1c4856721c82}"),
    contractID: "@mozilla.org/tcp-socket-event;1",
    classDescription: "TCP Socket Event",
    interfaces: [Ci.nsITCPSocketEvent],
    flags: Ci.nsIClassInfo.DOM_OBJECT
  })
};


/*
 * nsITCPSocket object
 */
function createTransport(host, port, ssl) {
  let options = ssl ? ["ssl"] : [""];
  return Cc["@mozilla.org/network/socket-transport-service;1"]
           .getService(Ci.nsISocketTransportService)
           .createTransport(options, options.length, host, port, null);
}

let InputStreamPump = CC("@mozilla.org/network/input-stream-pump;1",
                         "nsIInputStreamPump",
                         "init");

let ScriptableInputStream = CC("@mozilla.org/scriptableinputstream;1",
                               "nsIScriptableInputStream");

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function TCPSocket() {
  this.readyState = CLOSED;

  this.onopen = null;
  this.onmessage = null;
  this.onerror = null;
  this.onclose = null;

  this.host = "";
  this.port = -1;
  this.ssl = false;
};

TCPSocket.prototype = {
  _transport: null,
  _outputStream: null,
  _inputStream: null,
  _scriptableInputStream: null,
  _request: null,

  dispatchEvent: function ts_dispatchEvent(type, data) {
    if (!this[type])
      return;

    this[type].handleEvent(new TCPSocketEvent(type, data || ""));
  },

  // nsITCPSocket
  open: function ts_open(host, port, ssl) {
    if (this.readyState != CLOSED) {
      this.dispatchEvent("onerror", "Socket is already opened");
      return;
    }

    LOG("startup called\n");
    LOG("Host info: " + host + ":" + port + "\n");

    this.readyState = CONNECTING;
    this.host = host;
    this.port = port;
    this.ssl = (ssl === true);

    let transport = this._transport = createTransport(host, port, this.ssl);
    transport.securityCallbacks = new SecurityCallbacks(this);
    
    this._inputStream = transport.openInputStream(0, 0, 0);
    this._outputStream = transport.openOutputStream(1, 65536, 0);

    let pump = new InputStreamPump(this._inputStream, -1, -1, 0, 0, false);
    pump.asyncRead(this, null);

    this._scriptableInputStream = new ScriptableInputStream();
  },
  
  close: function ts_close() {
    if (this.readyState === CLOSING || this.readyState === CLOSED)
      return;

    LOG("shutdown called\n"); 
    this.readyState = CLOSING;

    this._outputStream.close();
    this._inputStream.close();
    this._transport.close(Cr.NS_OK);
  },

  send: function ts_send(data) {
    if (this.readyState !== OPEN) {
      this.dispatchEvent("onerror", "Socket is not opened");
      return;
    }

    if (data === undefined)
      return;

    
    // TODO
    // Because data is a |jsval| this method use JS coercion rules but
    // Blob and ArrayBuffer are should be handled correctly.
    this._outputStream.write(data, data.length);
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
    this.readyState = OPEN;
    this._request = request;
    
    this.dispatchEvent("onopen");
  },

  onStopRequest: function ts_onStopRequest(request, context, status) {
    this.readyState = CLOSED;
    this._request = null;

    if (status) {
      this.dispatchEvent("onerror", "Error " + status);
    }

    this.dispatchEvent("onclose");
  },

  onDataAvailable: function ts_onDataAvailable(request, context, inputStream, offset, count) {
    this._scriptableInputStream.init(inputStream);
    this.dispatchEvent("onmessage", this._scriptableInputStream.read(count));
  },
 
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
}

function SecurityCallbacks(socket) {
  this._socket = socket;
}

SecurityCallbacks.prototype = {
  notifySSLError: function sc_notifySSLError(socketInfo, error, targetSite) {
    this._socket.dispatchEvent("onerror", "SSL Error: " + error);
  },

  notifyCertProblem: function sc_notifyCertProblem(socketInfo, status, targetSite) {
    let msg = "Certificat error: ";
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
    throw Cr.NS_ERROR_NO_INTERFACE;
  }
};
 
const NSGetFactory = XPCOMUtils.generateNSGetFactory([TCPSocket]);

