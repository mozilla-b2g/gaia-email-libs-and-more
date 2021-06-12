var listeners = {};
var modules = [];
var worker = null;

export function register(module) {
  var action,
      name = module.name;

  modules.push(module);

  if (module.process) {
    action = function(msg) {
      module.process(msg.uid, msg.cmd, msg.args);
    };
  } else if (module.dispatch) {
    action = function(msg) {
      if (module.dispatch[msg.cmd]) {
        module.dispatch[msg.cmd].apply(module.dispatch, msg.args);
      }
    };
  }

  listeners[name] = action;

  module.sendMessage = function(uid, cmd, args, transferArgs) {
  //dump('\x1b[34mM => w: send: ' + name + ' ' + uid + ' ' + cmd + '\x1b[0m\n');
    //debug('onmessage: ' + name + ": " + uid + " - " + cmd);
    try {
      worker.postMessage({
        type: name,
        uid: uid,
        cmd: cmd,
        args: args
      }, transferArgs);
    } catch (ex) {
      console.error('Presumed DataCloneError on:', args, 'with transfer args',
                    transferArgs);
    }
  };
}

export function unregister(module) {
  delete listeners['on' + module.name];
}

export function shutdown() {
  modules.forEach(function(module) {
    if (module.shutdown) {
      module.shutdown();
    }
  });
}

export function useWorker(_worker) {
  worker = _worker;
  worker.onmessage = function dispatchToListener(evt) {
    var data = evt.data;
//dump('\x1b[37mM <= w: recv: '+data.type+' '+data.uid+' '+data.cmd+'\x1b[0m\n');
    var listener = listeners[data.type];
    if (listener) {
      listener(data);
    }
  };
}
