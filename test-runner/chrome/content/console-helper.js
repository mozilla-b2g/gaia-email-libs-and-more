Components.utils.import("resource://gre/modules/Services.jsm");

Services.prefs.setBoolPref('browser.dom.window.dump.enabled', true);

function makeConsoleFunc(prefix) {
  return function() {
    if (!this._enabled)
      return;
    var msg = prefix + ':';
    for (var i = 0; i < arguments.length; i++) {
      msg += ' ' + arguments[i];
    }
    msg += '\x1b[0m\n';
    dump(msg);
  };
}

window.console = {
  _enabled: false,
  log: makeConsoleFunc('\x1b[32mLOG'),
  error: makeConsoleFunc('\x1b[31mERR'),
  info: makeConsoleFunc('\x1b[36mINF'),
  warn: makeConsoleFunc('\x1b[33mWAR'),
  harness: makeConsoleFunc('\x1b[36mRUN')
};
