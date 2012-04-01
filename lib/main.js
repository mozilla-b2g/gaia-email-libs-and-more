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
      { Cu, Ci } = require('chrome')

Cu.import("resource://gre/modules/Services.jsm");

const CONTENT_GLOBAL_CREATED = 'content-document-global-created';

let PAGES = [
  {
    name: 'imap-check',
    url: $self.data.url('checkImap.html'),
  },
  {
    name: 'imap-client',
    url: $self.data.url('imapClient.html'),
  }
];

let gTracker;

exports.main = function() {
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

    pageUrls[pageDef.url] = true;
  });

  function contentGlobalCreated(domWindow) {
    if (!pageUrls.hasOwnProperty(domWindow.document.URL))
      return;
    console.log("injecting TCPSocket!");

    let weakrefs = [];

    function cullDeadSockets() {
      for (let i = weakrefs.length - 1; i >= 0; i--) {
        if (!weakrefs[i].get())
          weakrefs.splice(i, 1);
      }
    }

    let ownerInfo = {
      // For aliased things like about: URLs, this will be the about: URL
      uri: Services.io.newURI(domWindow.location),
      contentWin: domWindow,
      browserWin: $windowUtils.getBaseWindow(domWindow),
    };
    // We need the window ID to use inner-window-destroyed to know when the
    // window/document gets destroyed.  We are imitating jetpack's
    // api-utils/content/worker.js implementation which claims it does it this
    // way to avoid interfering with bfcache (which would happen if one added
    // an unload listener.)
    let windowID = contentWin.QueryInterface(Ci.nsIInterfaceRequestor)
                             .getInterface(Ci.nsIDOMWindowUtils)
                             .currentInnerWindowID;

    // Create a special constructor because we are not using XPConnect, but we
    //  want to look like it, including only surfacing public functions that
    //  would be on the interface.  So we:
    // - use Jetpack's "cortex" to wrap the public methods and re-expose them
    //    on a public instance.
    // - capture the document's window in the process so we can use it for
    //    authentication
    domWindow.wrappedJSObject.TCPSocket = function() {
      // Cull any dead sockets so long-lived apps with high socket turnover
      // don't cause horrible problems.
      cullDeadSockets();

      let realSocket = new $tcpsocket.TCPSocket(ownerURI);
      weakrefs.push(Cu.getWeakReference(realSocket));

      return $cortex.Cortex(realSocket);
    };
    
    function killSocketsForWindow(subject, topic, data) {
      if (!weakrefs)
        return;
      let innerWindowID = subject.QueryInterface(Ci.nsISupportsPRUint64).data;
      if (innerWindowID === windowID)
        return;
      for (let i = 0; i < weakrefs.length; i++) {
        let socket = weakrefs[i].get();
        if (socket) {
          // kill off the socket and ignore any complaints.
          try {
            socket.close();
          }
          catch() {
          }
        }
      }
      weakrefs = null;
      $observe.remove('inner-window-destroyed', killSocketsForWindow);
    };
    $observe.add('inner-window-destroyed', killSocketsForWindow);
    $unload.when(killSocketsForWindow);
  }
  $observe.add(CONTENT_GLOBAL_CREATED, contentGlobalCreated);
  $unload.when(function() {
    $observe.remove(CONTENT_GLOBAL_CREATED, contentGlobalCreated);
  });
};
