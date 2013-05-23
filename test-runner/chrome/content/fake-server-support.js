/**
 * Support for loading Thunderbird-derived IMAP and SMTP fake-servers as well
 * as our ActiveSync fake-server.  Thunderbird has NNTP and POP3 that we could
 * steal too.
 *
 * Thunderbird's fake-servers are primarily used to being executed in an
 * xpcshell "global soup" type of context.  load(path) loads things in the
 * current (global) context a la the subscript loader.  (They've also been used
 * in TB's mozmill tests a little somehow.)  To this end, we create a sandbox
 * to load them in.
 *
 * These servers are intended to be used in one of three primary modes:
 * - In unit tests in the same process, such as our GELAM tests.  In this case,
 *   the unit test is in complete control of what folders are created.  Note
 *   that our unit tests run from a worker thread, but the fake-servers run in
 *   the main thread (with chrome privileges.)
 *
 * - In integration tests where the e-mail app is running in a b2g-desktop
 *   instance or on a real device and is being controlled by marionette.  In
 *   this case, we are expecting to be running inside an xpcwindow xpcshell
 *   instance and the test is in control of what folders are created.  In this
 *   case, the unit test is running with chrome privileges in the main thread,
 *   just like the fake servers.
 *
 * - As standalone servers initiated by GELAM's Makefile.  Eventually we will
 *   automatically put some messages in to make the accounts more interesting,
 *   but not yet.  The fake servers are run using our GELAM unit test harness.
 *
 * === Communication and control ===
 *
 * If our unit tests are running against a real IMAP server, our manipulation
 * of the server must be asynchronous since we are reusing the e-mail app's
 * own implementation (like APPEND) and there's no way we could do any evil
 * tricks to make things seem synchronous.  This means that all of our test APIs
 * for manipulating servers are async.
 *
 * However, for our fake-servers, we can do things somewhat synchronously.
 *
 * For our unit tests, changes to the fake-servers are issued via synchronous
 * XHR requests to 'backdoor' JSON-over-HTTP servers from the worker thread
 * where the back-end and our unit tests run.  If run in the same thread, we
 * could bypass the HTTP thing.
 *
 *
 * === Overview of fake server files we use ===
 *
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

function loadInSandbox(base, relpath, sandbox) {
  relpath = base.concat(relpath);
  var nsfile = fu.FileUtils.getFile('CurWorkD', relpath);
  //console.log('loadInSandbox resolved', relpath, 'to', nsfile.path);
  var jsstr = synchronousReadFile(nsfile);
  // the moz idiom is that synchronous file loading is okay for unit test
  // situations like this.  xpcshell load or even normal Cu.import would sync
  // load.
  Cu.evalInSandbox(jsstr, sandbox, '1.8', nsfile.path);
}

var imapSandbox = null;
var baseFakeserver = ['test-runner', 'chrome', 'fakeserver'];
function createImapSandbox() {
  if (imapSandbox)
    return;

  imapSandbox = makeSandbox('imap-fakeserver');
  // all the fakeserver stuff
  loadInSandbox(baseFakeserver, ['subscript', 'maild.js'], imapSandbox);
  loadInSandbox(baseFakeserver, ['subscript', 'auth.js'], imapSandbox);
  loadInSandbox(baseFakeserver, ['subscript', 'imapd.js'], imapSandbox);
  loadInSandbox(baseFakeserver, ['subscript', 'smtpd.js'], imapSandbox);
}

var activesyncSandbox = null;
var baseActiveSync = ['deps', 'activesync'];
var codepages = ['AirSyncBase.js', 'AirSync.js', 'Calendar.js', 'Common.js',
                 'ComposeMail.js', 'Contacts2.js', 'Contacts.js',
                 'DocumentLibrary.js', 'Email2.js', 'Email.js',
                 'FolderHierarchy.js', 'GAL.js', 'ItemEstimate.js',
                 'ItemOperations.js', 'MeetingResponse.js', 'Move.js',
                 'Notes.js', 'Ping.js', 'Provision.js', 'ResolveRecipients.js',
                 'RightsManagement.js', 'Search.js', 'Settings.js', 'Tasks.js',
                 'ValidateCert.js'];
function createActiveSyncSandbox() {
  if (activesyncSandbox)
    return;

  activesyncSandbox = makeSandbox('activesync-fakeserver');

  // load wbxml and all the codepages.
  if (inGELAM) {
    loadInSandbox(baseActiveSync, ['wbxml', 'wbxml.js'], activesyncSandbox);

    for (var i = 0; i < codepages.length; i++) {
      loadInSandbox(baseActiveSync, ['codepages', codepages[i]],
                    activesyncSandbox);
    }
    loadInSandbox(baseActiveSync, ['codepages.js'], activesyncSandbox);
  }
  else {
    throw new Error("XXX implement using aggregate JS file!");
  }

  // the actual activesync server logic
  loadInSandbox(baseFakeserver, ['subscript', 'activesync_server.js'],
                activesyncSandbox);
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

function makeActiveSyncServer(creds, logToDump) {
  createActiveSyncSandbox();
  var server = new activesyncSandbox.ActiveSyncServer();
  server.start(0);

  var httpServer = server.server;
  var port = httpServer._socket.port;
  httpServer._port = port;
  // it had created the identity on port 0, which is not helpful to anyone
  httpServer._identity._initialize(port, httpServer._host, true);

  if (logToDump) {
    server.logRequest = function(request, body) {
      let path = request.path;
      if (request.queryString)
        path += '?' + request.queryString;
      dump('>>> ' + path + '\n');
      if (body) {
        if (body instanceof activesyncSandbox.WBXML.Reader) {
          dump(body.dump());
          body.rewind();
        }
        else {
          dump(JSON.stringify(body, null, 2) + '\n');
        }
      }
      dump('\n');
    };

    server.logResponse = function(request, response, body) {
      dump('<<<\n');
      if (body) {
        if (body instanceof activesyncSandbox.WBXML.Writer) {
          dump(new activesyncSandbox.WBXML.Reader(
                 body, activesyncSandbox.ActiveSyncCodepages).dump());
        }
        else {
          dump(JSON.stringify(body, null, 2) + '\n');
        }
      }
      dump('\n');
    };

    server.logResponseError = function(err) {
      dump("ERR " + err + '\n\n');
    };
  }

  return {
    server: server,
    port: port
  };
}

return {
  makeIMAPServer: makeIMAPServer,
  makeSMTPServer: makeSMTPServer,
  makeActiveSyncServer: makeActiveSyncServer
};
} catch (ex) {
  console.error('Problem initializing FakeServerSupport', ex, '\n',
                ex.stack);
}
})(window.xpcComponents || Components,
   window.xpcComponents ? false : true);
