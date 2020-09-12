/* eslint-disable no-prototype-builtins */
var listeners = {};

export function receiveMessage(evt) {
  var data = evt.data;
//dump('\x1b[37mw <= M: recv: '+data.type+' '+data.uid+' '+data.cmd +'\x1b[0m\n');
  var listener = listeners[data.type];
  if (listener) {
    listener(data);
  }
}

globalThis.addEventListener('message', receiveMessage);


export function unregister(type) {
  delete listeners[type];
}

export function registerSimple(type, callback) {
  listeners[type] = callback;

  return function sendSimpleMessage(cmd, args) {
    //dump('\x1b[34mw => M: send: ' + type + ' null ' + cmd + '\x1b[0m\n');
    globalThis.postMessage({ type: type, uid: null, cmd: cmd, args: args });
  };
}

var callbackSenders = {};

/**
 * Register a message type that allows sending messages that expect a return
 * message which should resolve the returned Promise.
 */
export function registerCallbackType(type) {
  if (callbackSenders.hasOwnProperty(type)) {
    return callbackSenders[type];
  }
  var callbacks = {};
  var uid = 0;
  listeners[type] = function receiveCallbackMessage(data) {
    var callback = callbacks[data.uid];
    if (!callback) {
      return;
    }
    delete callbacks[data.uid];

    callback(data.args);
  };

  var sender = function sendCallbackMessage(cmd, args) {
    return new Promise((resolve) => {
      callbacks[uid] = resolve;

      //dump('\x1b[34mw => M: send: ' + type + ' ' + uid + ' ' + cmd + '\x1b[0m\n');
      globalThis.postMessage({ type: type, uid: uid++, cmd: cmd, args: args });
    });
  };
  callbackSenders[type] = sender;
  return sender;
}

/**
 * Register a message type that gets associated with a specific set of callbacks
 * keyed by 'cmd' for received messages.
 */
export function registerInstanceType(type) {
  var uid = 0;
  var instanceMap = {};
  listeners[type] = function receiveInstanceMessage(data) {
    var instanceListener = instanceMap[data.uid];
    if (!instanceListener) {
      return;
    }

    instanceListener(data);
  };

  return {
    register: function(instanceListener) {
      var thisUid = uid++;
      instanceMap[thisUid] = instanceListener;

      return {
        sendMessage: function sendInstanceMessage(cmd, args, transferArgs) {
//dump('\x1b[34mw => M: send: ' + type + ' ' + thisUid + ' ' + cmd + '\x1b[0m\n');
          globalThis.postMessage({ type: type, uid: thisUid,
                               cmd: cmd, args: args },
                             transferArgs);
        },
        unregister: function unregisterInstance() {
          delete instanceMap[thisUid];
        }
      };
    },
  };
}

export function shutdown() {
  globalThis.removeEventListener('message', receiveMessage);
  listeners = {};
  callbackSenders = {};
}
