define(function() {

var listeners = {};

function receiveMessage(evt) {
  var data = evt.data;
  var listener = listeners[data.type];
  if (listener)
    listener(data);
}

window.addEventListener('message', receiveMessage);

/**
 * Register a message type that allows sending messages that may expect a return
 * message that should trigger a callback.  Messages may not be received unless
 * they have an associated callback from a previous sendMessage.
 */
function registerCallbackType(type) {
  listeners[type] = function receiveCallbackMessage(data) {
    var callback = callbacks[data.uid];
    if (!callback)
      return;
    delete callbacks[data.uid];

    dump(type + ": receiveMessage fire callback\n");
    callback.apply(callback, data.args);
  };
  var callbacks = {};
  var uid = 0;

  return {
    sendMessage: function sendCallbackMessage(cmd, args, callback) {
      if (callback) {
        callbacks[uid] = callback;
      }

      if (!Array.isArray(args)) {
        args = args ? [args] : [];
      }

      dump(type + ": sendMessage " + cmd + "\n");
      window.postMessage({ type: type, uid: uid++, cmd: cmd, args: args });
    },
  };
}

/**
 * Register a message type that gets associated with a specific set of callbacks
 * keyed by 'cmd' for received messages.
 */
function registerInstanceType(type) {
  var uid = 0;
  var uidMapping = {};
  listeners[type] = function receiveInstanceMessage(data) {
    var cmdMapping = uidMapping[data.uid];
    if (!cmdMapping)
      return;
    var callback = cmdMapping[data.cmd];
    // The argument here is pretty specific to node-net's current structure...
    callback.call(callback, { data: data.args[0] });
  };

  return {
    register: function(cmdMapping) {
      var thisUid = uid++;
      uidMapping[thisUid] = cmdMapping;

      return {
        sendMessage: function sendInstanceMessage(cmd, args) {
          window.postMessage({ type: type, uid: thisUid,
                               cmd: cmd, args: args });
        },
        unregister: function unregisterInstance() {
          delete uidMapping[thisUid];
        }
      };
    },
  };
}

function shutdown() {
  window.removeEventListener('message', receiveMessage);
  listeners = {};
}

return {
  registerCallbackType: registerCallbackType,
  registerInstanceType: registerInstanceType,
  shutdown: shutdown
};

}); // end define
