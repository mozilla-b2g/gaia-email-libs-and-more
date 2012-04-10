/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Facilitate an in-Firefox demonstration of the proposed TCP WebAPI.  We
 *  define about URLs to provide human-readable names to the demo webpages/apps
 *  that we host in this module.
 *
 * We use an observer notification to know when content pages have their global
 *  created and at that instant (it's a synchronous API), we inject the TCP API
 *  if they match one of our URLs.
 *
 * Defines the following mappings:
 *
 * - about:imap-check, a simple webpage that will connect to an IMAP server
 *    and report its capability line.  This can be used to verify that the
 *    TCP API is operational and that certificates are being dealt with
 *    correctly is using SSL.
 *
 * - about:imap-client, our IMAP client/UI.  Although we are using the deuxdrop
 *    architecture which keeps the back-end and front-end logically partitioned,
 *    we are not putting them in separate frames/pages.
 *
 * Important notes:
 * - All our example webpages in here use the *same ORIGIN* which means the
 *    same localStorage universe, the same IndexedDB universe, etc.
 **/

const $protocol = require('./jetpack-protocol/index'),
      $unload = require('unload'),
      $tabBrowser = require('tab-browser'),
      $windowUtils = require('window/utils'),
      $self = require('self'),
      $observe = require('api-utils/observer-service'),
      $traits = require('traits'),
      $tcpsocket = require('./TCPSocket'),
      { Cc, Ci, Cu } = require('chrome');

let importNS = {};
Cu.import("resource://gre/modules/Services.jsm", importNS);
const Services = importNS.Services;

const CONTENT_GLOBAL_CREATED = 'content-document-global-created';

let PAGES = [
  {
    name: 'imap-check',
    url: $self.data.url('checkImap.html'),
  },
  {
    name: 'imap-raw',
    url: $self.data.url('rawImap.html'),
  },
  {
    name: 'imap-client',
    url: $self.data.url('imapClient.html'),
  }
];

let gTracker;

// XXX er, traits doesn't do the membrane thing we want either.
/*
let TCPSocket = $traits.Trait.compose(
  {
    constructor: $tcpsocket.TCPSocket,
  },
  $tcpsocket.TCPSocket.prototype);
*/
// XXX for now, just expose
let TCPSocket = $tcpsocket.TCPSocket;
    

exports.main = function(options, callbacks) {
  let pageUrls = {};
  PAGES.forEach(function(pageDef) {
    // - protocol
    pageDef.protocol = $protocol.about(pageDef.name, {
      onRequest: function(request, response) {
        response.uri = pageDef.url;
        // this may not be required
        response.principalURI = pageDef.url;
      }
    });
    pageDef.protocol.register();
    $unload.when(function() {
      pageDef.protocol.unregister();
    });

    pageUrls["about:" + pageDef.name] = true;
  });

  function contentGlobalCreated(domWindow) {
    if (!pageUrls.hasOwnProperty(domWindow.document.URL))
      return;

    let weakrefs = [];

    function cullDeadSockets() {
      for (let i = weakrefs.length - 1; i >= 0; i--) {
        if (!weakrefs[i].get())
          weakrefs.splice(i, 1);
      }
    }

    let useLocation;
    if (domWindow.location.protocol === 'about:') {
      useLocation = 'http://' + domWindow.location.href.substring(6) +
                      '.about.internal';
      console.log("adjusted location to", useLocation);
    }
    //else if (domWindow.location.protocol === 'resource')
    //  useLocation = 'resource:
    else 
      useLocation = domWindow.location;
    let ownerInfo = {
      // For aliased things like about: URLs, this will be the about: URL
      uri: Services.io.newURI(useLocation, null, null),
      // Favor the host:port if available, but in the case of about: URLs,
      // we net nothing, so fallback to the entire URL.
      host: domWindow.location.host || domWindow.location.toString(),
      contentWin: domWindow,
    };
    // We need the window ID to use inner-window-destroyed to know when the
    // window/document gets destroyed.  We are imitating jetpack's
    // api-utils/content/worker.js implementation which claims it does it this
    // way to avoid interfering with bfcache (which would happen if one added
    // an unload listener.)
    let windowID = domWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                            .getInterface(Ci.nsIDOMWindowUtils)
                            .currentInnerWindowID;
    console.log("injecting TCPSocket!", windowID);

    // Create a special constructor because we are not using XPConnect, but we
    //  want to look like it, including only surfacing public functions that
    //  would be on the interface.  So we:
    // - use Jetpack's "traits" to wrap the class so that things with
    //    underscores are hidden.
    // - capture the document's window in the process so we can use it for
    //    authentication
console.log("exposing TCPSocket constructor");
    domWindow.wrappedJSObject.TCPSocket = function() {
      // Cull any dead sockets so long-lived apps with high socket turnover
      // don't cause horrible problems.
try {
console.log("trying to create a socket!");
      cullDeadSockets();

      let socket = new TCPSocket(ownerInfo);
      weakrefs.push(Cu.getWeakReference(socket));
      return socket;
} catch (ex) {
  console.error("Problem creating socket:", ex);
  return null;
}
    };
console.log("Exposed!");

    let unloadHelper = {
      unload: function killSocketsForWindow() {
        if (!weakrefs)
          return;
        for (let i = 0; i < weakrefs.length; i++) {
          let socket = weakrefs[i].get();
          if (socket) {
            // kill off the socket and ignore any complaints.
            try {
              socket.close();
            }
            catch (ex) {
            }
          }
        }
        weakrefs = null;
        $observe.remove('inner-window-destroyed', observeWindowDeath);
      }
    };
    function observeWindowDeath(subject, topic, data) {
      let innerWindowID = subject.QueryInterface(Ci.nsISupportsPRUint64).data;
      if (innerWindowID === windowID)
        unloadHelper.unload();
    }
    $observe.add('inner-window-destroyed', observeWindowDeath);
    // Use ensure so that our unload helpers get removed when invoked so we
    // don't end up with an ever-growing list of moot unload closures.
    $unload.ensure(unloadHelper);
  }
  $observe.add(CONTENT_GLOBAL_CREATED, contentGlobalCreated);
  $unload.when(function() {
    $observe.remove(CONTENT_GLOBAL_CREATED, contentGlobalCreated);
  });

  // -- if we are being told to auto-sync-test, then do that.
  if (options.staticArgs.synctest)
    runSyncTest();
};

/**
 * Automatically run the sync test: blow away our existing IndexedDB
 *  database state, open about:imap-client, punch in our account details (from
 *  prefs where they are persisted), and initiate the sync process.
 */
function runSyncTest() {
  console.log("Running synchronization test logic...");

  var $prefs = require('preferences-service'),
      $timers = require('timers');

  // - Nuke the IndexedDB data FOR THIS ENTIRE EXTENSION (same origin)
  console.warn("NUKING INDEXEDDB DATABASE FOR", $self.data.url(''));
  let idbm = Cc["@mozilla.org/dom/indexeddb/manager;1"]
               .getService(Ci.nsIIndexedDatabaseManager);
  idbm.clearDatabasesForURI(Services.io.newURI($self.data.url(''), null, null));

  // - Open the tab
  if (!$prefs.has('labs.tcpimap.host')) {
    console.error("Unable to run sync logic without the labs.tcpimap.* prefs" +
                  " defined to tell us how to connect.");
  }

  // To avoid confusion/lots of tabs, close the current tab if it's of the same
  // type.
  let activeTab = $tabBrowser.activeTab,
      gBrowser = activeTab.ownerDocument.defaultView.gBrowser,
      browser = gBrowser.getBrowserForTab(activeTab);
  // (=== is no good here, we want coercion to string)
  if (browser.contentWindow.location == "about:imap-client") {
    console.log("Closing current tab");
    gBrowser.removeTab(activeTab, {animate: false, byMouse: false});
  }

  $tabBrowser.addTab("about:imap-client", {
    onLoad: function(event) {
      let doc = event.target, win = doc.defaultView;
      $timers.setTimeout(function quickhack() {
        var accountDef = {
          host: $prefs.get('labs.tcpimap.host'),
          port: $prefs.get('labs.tcpimap.port'),
          crypto: $prefs.get('labs.tcpimap.crypto'),
          username: $prefs.get('labs.tcpimap.username'),
          password: $prefs.get('labs.tcpimap.passwordTestOnly'),
        };
        win.goSync(accountDef);
      }, 100);
    }
  });
}
