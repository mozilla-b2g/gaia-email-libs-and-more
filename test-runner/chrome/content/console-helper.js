Components.utils.import("resource://gre/modules/Services.jsm");

Services.prefs.setBoolPref('browser.dom.window.dump.enabled', true);

window.TEST_LOG_ENABLE = window.TEST_LOG_ENABLE | false;

function consoleHelper() {
  if (!this._enabled)
    return;
  var msg = arguments[0] + ':';
  for (var i = 1; i < arguments.length; i++) {
    msg += ' ' + arguments[i];
  }
  msg += '\x1b[0m\n';
  dump(msg);
}

window.console = {
  _enabled: window.TEST_LOG_ENABLE,
  log: consoleHelper.bind(null, '\x1b[32mLOG'),
  error: consoleHelper.bind(null, '\x1b[31mERR'),
  info: consoleHelper.bind(null, '\x1b[36mINF'),
  warn: consoleHelper.bind(null, '\x1b[33mWAR'),
  harness: consoleHelper.bind(null, '\x1b[36mRUN')
};
