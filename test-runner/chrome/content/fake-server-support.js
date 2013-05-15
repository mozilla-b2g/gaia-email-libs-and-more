/**
 * Support for loading Thunderbird-derived IMAP and SMTP fake-servers.
 * ActiveSync's fake-server has nothing to do with this file right now.  Were we
 * ever to support NNTP (scope creep for now) or POP3 (boo, hiss!), Thunderbird
 * has those too.
 *
 * Thunderbird's fake-servers are primarily used to being executed in an
 * xpcshell "global soup" type of context.  load(path) loads things in the
 * current (global) context a la the subscript loader.  (They've also been used
 * in TB's mozmill tests a little somehow.)  To this end, we create a sandbox
 * to load them in.
 *
 * These servers are intended to be used in one of two primary modes:
 * - In unit tests in the same process.
 * - In integration tests where the e-mail app is running in a b2g-desktop
 *   instance or on a real device and is being controlled by marionette and
 *   the fake-server is in a different xulrunner-ish process
 *
 * ===
 *
 * Overview of fake server files we use:
 * - maild.js: nsMailServer does all the network stuff, takes a handle-creator
 *   to invoke when a connection is received and a daemon to pass to it.
 *
 * - imapd.js: Provides the IMAP_RFC3501_handler which has all the
 *   per-connection state as well as the parsing logic and some odd stuff
 *   like the username and password.  The imapDaemon really just represents
 *   the (single user) account state in terms of mailboxes and their messages.
 *
 * - smtpd.js: SMTP_RFC2821_handler does everything.  The daemon just
 *   accumulates a 'post' attribute when a message is sent.
 **/
var FakeServerSupport = (function(Components, inGELAM) {
try {
var Cc = Components.classes;
var Ci = Components.interfaces;
var Cu = Components.utils;

var fu = {};
Cu.import('resource://gre/modules/FileUtils.jsm', fu);

var baseFakeserver = '';

// -- create a sandbox
// We could use a scoped subscript load, but keeping the fake-servers in their
// own compartment makes it easier to track their memory usage and to kill
// them dead.  We could also use a JS module and subscript load into that.
var systemPrincipal = Cc["@mozilla.org/systemprincipal;1"]
                        .createInstance(Ci.nsIPrincipal);

function makeSandbox(name) {
  var sandbox = Cu.Sandbox(
    systemPrincipal,
    {
      sandboxName: name,
      // shouldn't matter because of the system principal?
      wantXrays: false,
      // yes, components!
      wantComponents: true,
      // don't care about XHR
      wantXHRConstructor: false
    });
  return sandbox;
}
// from:
// developer.mozilla.org/en-US/docs/Code_snippets/File_I_O#Synchronously
function synchronousReadFile(nsfile) {
  var data = '';
  var fstream = Components.classes["@mozilla.org/network/file-input-stream;1"].
    createInstance(Components.interfaces.nsIFileInputStream);
  var cstream = Components.classes["@mozilla.org/intl/converter-input-stream;1"].
    createInstance(Components.interfaces.nsIConverterInputStream);
  fstream.init(nsfile, -1, 0, 0);
  cstream.init(fstream, 'UTF-8', 0, 0);

  var str = {};
  var read = 0;
  do {
    read = cstream.readString(0xffffffff, str);
    data += str.value;
  } while (read != 0);
  cstream.close();

  return data;
}
function loadInSandbox(relpath, sandbox) {
  // XXX parameterize on inGELAM
  relpath = ['test-runner', 'chrome', 'fakeserver'].concat(relpath);
  var nsfile = fu.FileUtils.getFile('CurWorkD', relpath);
  console.log('loadInSandbox resolved', relpath, 'to', nsfile.path);
  var jsstr = synchronousReadFile(nsfile);
  // the moz idiom is that synchronous file loading is okay for unit test
  // situations like this.  xpcshell load or even normal Cu.import would sync
  // load.
  Cu.evalInSandbox(jsstr, sandbox, '1.8', nsfile.path);
}

var httpdSandbox = null;
function createHttpdSandbox() {
  if (httpdSandbox)
    return;

  httpdSandbox = makeSandbox('imap-backdoor');

  // for back-door control
  loadInSandbox(['subscript', 'httpd.js'], httpdSandbox);
}

var imapSandbox = null;
function createImapSandbox() {
  if (imapSandbox)
    return;

  imapSandbox = makeSandbox('imap-fakeserver');
  // all the fakeserver stuff
  loadInSandbox(['subscript', 'maild.js'], imapSandbox);
  loadInSandbox(['subscript', 'auth.js'], imapSandbox);
  loadInSandbox(['subscript', 'imapd.js'], imapSandbox);
  loadInSandbox(['subscript', 'smtpd.js'], imapSandbox);
}

var activesyncSandbox = null;
function createActiveSyncSandbox() {
  if (activesyncSandbox)
    return;

  activesyncSandbox = makeSandbox('activesync-fakeserver');

  // for the backdoor
  loadInSandbox('subscript/httpd.js', activesyncSandbox);

  // load wbxml and all the codepages.

  // the actual activesync server logic
  loadInSandbox('subscript/activesync_server.js', activesyncSandbox);
}

/**
 * Synchronously create a fake IMAP server operating on an available port.  The
 * IMAP server only services a single fake account.
 */
function makeIMAPServer(creds) {
  createImapSandbox();

  var infoString = 'RFC2195';

  var daemon = new imapSandbox.imapDaemon();

  function createHandler(d) {
    var handler = new imapSandbox.IMAP_RFC3501_handler(d);

    // hardcoded defaults are "username" and "password"
    handler.kUsername = creds.username;
    handler.kPassword = creds.password;

    var parts = infoString.split(/ *, */);
    for each (var part in parts) {
      if (part.startsWith("RFC"))
        imapSandbox.mixinExtension(handler,
                                   imapSandbox["IMAP_" + part + "_extension"]);
    }
    return handler;
  }
  var server = new imapSandbox.nsMailServer(createHandler, daemon);
  // take an available port
  server.start(0);
  return {
    daemon: daemon,
    server: server,
    port: server._socket.port
  };
}

function makeSMTPServer(creds) {
  createImapSandbox();

  var daemon = new imapSandbox.smtpDaemon();

  function createHandler(d) {
    var handler = new imapSandbox.SMTP_RFC2821_handler(d);

    handler.kUsername = creds.username;
    handler.kPassword = creds.password;

    return handler;
  }

  var server = new imapSandbox.nsMailServer(createHandler, daemon);
  // take an available port
  server.start(0);
  return {
    daemon: daemon,
    server: server,
    port: server._socket.port
  };
}

return {
  makeIMAPServer: makeIMAPServer,
  makeSMTPServer: makeSMTPServer
};
} catch (ex) {
  console.error('Problem initializing FakeServerSupport', ex, '\n',
                ex.stack);
}
})(window.xpcComponents || Components,
   window.xpcComponents ? false : true);
