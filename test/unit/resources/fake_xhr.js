define(
  [
    'exports'
  ],
  function(
    exports
  ) {

window.gFakeXHRListener = null;

function FakeXHR() {
  this._args = {
    method: null,
    url: null,
    async: null,
    timeout: null
  };

  this.onload = null;
  this.ontimeout = null;

  this.timeout = null;

  this.upload = {
    onprogress: null,
    onload: null,
  };

  this.status = null;
  this.statusText = 'Meh';
}
FakeXHR.prototype = {
  open: function(method, url, async) {
    this._args.method = method;
    this._args.url = url;
    this._args.async = async;
  },

  // To prevent regressions related to <https://bugzil.la/949722> in
  // which XHRs treat .onerror like .addEventListener('error'), ensure
  // that we only assign to this property once for safety:

  get onerror() {
    return this._onerror;
  },

  set onerror(fn) {
    if (fn && this._onerror) {
      throw new Error("onerror already set on XHR! Don't. See bug 949722.");
    }
    this._onerror = fn;
  },

  send: function() {
    this._args.timeout = this.timeout;
    if (window.gFakeXHRListener) {
      window.gFakeXHRListener(this, this._args);
    }
  },

  setRequestHeader: function() {
    // ActiveSync uses this to set various headers that we don't care about.
  },
};

window.XMLHttpRequest = FakeXHR;

}); // end define
