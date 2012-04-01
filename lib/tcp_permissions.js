/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Provides the UI and persistence for WebAPI TCP connections.
 *
 * While we currently hard-code our string bundle for prototyping, we do,
 * however depend on a chrome.manifest-driven overlay (xul, css) to include our
 * icon in the address bar for our door-hanger.
 **/

"use strict";
const {Cc,Ci,Cu} = require("chrome");

Cu.import("resource://gre/modules/Services.jsm");

const nsIPermissionManager = Ci.nsIPermissionManager;


const TCP_NO_SSL_PERM_PREFIX = 'webtcp:',
      TCP_SSL_PERM_PREFIX = 'webtcps:';

// The strings are in the JS source only for prototyping simplicity.
const stringPool = {
  "webapi.permission.tcp.prompt": 
    "This website (%1$S) is asking to initiate an unencrypted network" +
    " connection to %2$S:%3$S.",
  "webapi.permission.tcps.prompt":
    "This website (%1$S) is asking to initiate an encrypted network" +
    " connection to %2$S:%3$S.",

  "webapi.permission.allow": "Allow",
  "webapi.permission.allowAccessKey": "A",
  "webapi.permission.neverThis":
    "Never allow this site to connect to %1$S:%2$S",
  "webapi.permission.neverThisAccessKey": "e",
  "webapi.permission.neverAny":
    "Never allow this site to connect to any server in this fashion",
  "webapi.permission.neverAnyAccessKey": "v",
  "webapi.permission.notNow": "Not Now",
  "webapi.permission.notNowAccessKey": "N",

  // about:certerror is Firefox's UI for this.  It uses strings from
  // netError.dtd and aboutCertError.dtd.
  "webapi.security.certException.prompt":
    "We are trying to connect securely to the serverr at %1$S:%2$S, but we" +
    " can't confirm that the connection is secure.",
  "webapi.security.certException.promptExtraExistingException":
    " You had previously made an exception for this server, but its identity" +
    " has changed since then.",

  "webapi.security.seeCertificate": "See certificate and possibly add exception",
  "webapi.security.seeCertificateAccessKey": "S",
  "webapi.security.notNow": "Do not connect, hide this message",
  "webapi.security.notNowAccessKey": "D",
};
const gStringBundle = {
  getString: function(name) {
    return stringPool[name];
  },
  getFormattedString: function(name, args) {
    let s = stringPool[name];
    for (let i = 0; i < args.length; i++) {
      s = s.replace("%" + i + "$S", args[i]);
    }
    return s;
  }
};

exports.PermissionChecker = {
  checkTCPConnectionAllowed: function(ownerInfo, host, port, useSSL,
                                      allowedCallback) {
    // - Check existing permissions
    let permType =
      (useSSL ? TCP_SSL_PERM_PREFIX : TCP_NO_SSL_PERM_PREFIX) +
      host + ':' + port,
    perm = Services.perms.testExactPermission(ownerInfo.uri, permType);

    // If allowed, indicate this immediately.
    if (perm === nsIPermissionManager.ALLOW_ACTION) {
      allowedCallback();
      return;
    }
    // If forbidden, never generate the callback.
    if (perm === nsIPermissionManager.DENY_ACTION)
      return;

    // Check if all connections are forbidden to this app.
    let allPermType =
      (useSSL ? TCP_SSL_PERM_PREFIX : TCP_NO_SSL_PERM_PREFIX) + '*';
    if (Services.perms.testExactPermission(originURI, allPermType) ===
        nsIPermissionManager.DENY_ACTION)
      return;

    // - Ask for Permission
    let browserNode = ownerInfo.browserWin.gBrowser.getBrowserForDocument(
                        ownerInfo.contentWin),
        PopupNotifications = ownerInfo.browserWin.PopupNotifications;

    let allowAction = {
      label: gStringBundle.getString("webapi.permission.allow"),
      accessKey: gStringBundle.getString("webapi.permission.allowAccessKey"),
      callback: function allowCallback() {
        Services.perms.add(ownerInfo.uri, permType,
                           nsIPermissionManager.ALLOW_ACTION);
        allowedCallback();
      },
    };
    let neverThisAction = {
      label: gStringBundle.getFormattedString("webapi.permission.neverThis",
                                              [host, port]),
      accessKey: gStringBundle.getString("webapi.permission.neverThisAccessKey"),
      callback: function neverThisCallback() {
        Services.perm.add(ownerInfo.uri, permType,
                          nsIPermissionManager.DENY_ACTION);
        // do not trigger any callback notification
      },
    };
    let neverAnyAction = {
      label: gStringBundle.getString("webapi.permission.neverAny"),
      accessKey: gStringBundle.getString("webapi.permission.neverAnyAccessKey"),
      callback: function neverAnyCallback() {
        Services.perm.add(ownerInfo.uri, allPermType,
                          nsIPermissionManager.DENY_ACTION);
        // do not trigger any callback notification
      },
    };
    let notNowAction = {
      label: gStringBundle.getString("webapi.permission.notNow"),
      accessKey: gStringBundle.getString("webapi.permission.notNowAccessKey"),
      callback: function notNowCallback() {
        // This UI choice is a no-op.
      },
    };
    
    PopupNotifications.show(
      browserNode,
      "webapi-tcp-permission-prompt",
      gStringBundle.getFormattedString(
        "webapi.permission." + useSSL ? "tcps" : "tcp" + ".prompt",
        // contentWin is an xray wrapper, so the access is safe
        [ownerInfo.contentWin.location.host, host, port])
      "webapi-tcp-notification-icon",
      allowAction,
      [neverThisAction, neverAnyAction, notNowAction],
      {});
  },

  /**
   * Display UI for dealing with a bad certificate with the goal of potentially
   * adding an exception.  This should only be called when certificate
   * exceptions are frequently required for the protocol in question (ex: IMAP).
   * That decision is left to the webpage requesting the connection.
   */
  handleBadCertificate: function(ownerInfo, host, port, targetSite,
                                 retryCallback) {
    let browserNode = ownerInfo.browserWin.gBrowser.getBrowserForDocument(
                        ownerInfo.contentWin),
        PopupNotifications = ownerInfo.browserWin.PopupNotifications;

    let overrideService = Cc["@mozilla.org/security/certoverride;1"]
                            .getService(Ci.nsICertOverrideService),
        existingBits = {},
        hasExistingOverride = overrideService.getValidityOverride(
                                host, port, {}, {}, existingBits, {});

    let promptString = gStringBundle.getFormattedString(
                         "webapi.security.certException.prompt", [host, port]);
    if (hasExistingOverride) {
      promptString += gStringBundle.getString(
        "webapi.security.certException.promptExtraExistingException");
    }
    
    let seeAction = {
      label: gStringBundle.getString("webapi.security.seeCertificate"),
      accessKey: gStringBundle.getString(
                   "webapi.security.seeCertificateAccessKey"),
      callback: function allowCallback() {
        // Bring up the exception dialog which also provides the ability to see
        // all the details of the certificate and explains the problems with
        // the certificate.  But do this in a timeout so the popup has a chance
        // to hide.
        setTimeout(function() {
            let params = {
              exceptionAdded: false,
              prefetechCert: true,
              location: targetSite,
            };
            ownerInfo.browserWin.openDialog(
              "chrome://pippki/content/exceptionDialog.xul", "", 
              "chrome,centerscreen,modal",
              params);
            // (the modal dialog spins a nested event loop, so we have a result)
            if (params.exceptionAdded && retryCallback)
              retryCallback();
          }, 0);
      },
    };
    let notNowAction = {
      label: gStringBundle.getString("webapi.security.notNow"),
      accessKey: gStringBundle.getString("webapi.security.notNowAccessKey"),
      callback: function notNowCallback() {
        // This UI choice is a no-op.
      },
    };

    PopupNotifications.show(
      browserNode,
      "webapi-tcp-exception-prompt",
      promptString,
      "webapi-tcp-notification-icon",
      seeAction,
      [notNowAction],
      {});
  },
};
