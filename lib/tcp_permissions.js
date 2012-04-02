/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Provides the UI and persistence for WebAPI TCP connections.
 **/

"use strict";
const {Cc,Ci,Cu} = require("chrome"),
      $unload = require("unload");

let importNS = {};
Cu.import("resource://gre/modules/Services.jsm", importNS);
const Services = importNS.Services;

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
    if (!stringPool.hasOwnProperty(name))
      throw new Error("String pool has no key: " + name);
    return stringPool[name];
  },
  getFormattedString: function(name, args) {
    if (!stringPool.hasOwnProperty(name))
      throw new Error("String pool has no key: " + name);
    let s = stringPool[name];
    for (let i = 0; i < args.length; i++) {
      s = s.replace("%" + (i + 1) + "$S", args[i]);
    }
    return s;
  }
};

let PERMISSION_ANCHOR_ID = "webapi-tcp-notification-icon",
    PERMISSION_ANCHOR_ICON_URL = "chrome://global/skin/icons/question-16.png",
    PERMISSION_POPUP_ICON_URL = "chrome://global/skin/icons/question-64.png",
    CERTIFICATE_ANCHOR_ID = "webapi-tcp-exception-icon",
    CERTIFICATE_ANCHOR_ICON_URL = "chrome://global/skin/icons/question-16.png",
    CERTIFICATE_POPUP_ICON_URL = "chrome://global/skin/icons/question-64.png";

// NB: We tried to dynamically create an anchor-id so that we could give it
// its own icon and have a persistent location for our notifications.  This
// unfortunately runs afoul of the means by which the icons are shown.  The
// iconbox sets an "anchorid" attribute and there exist specific CSS rules to
// set each element's display to -moz-box.  Because dynamically creating CSS
// rules in XUL tends to break everything, we hit a wall.  (And just manually
// updating the display style ourself is problematic without aggressive
// monkeypatching, as if we use the callback we are too late for the panel
// positioning.  We could probably fix-up the panel afterwards, but that's
// also ugly.

function showPopup(contentWin,
                   anchorId, anchorIconUrl, popupIconUrl,
                   message, primaryAction, secondaryActions) {
  let browserWin = contentWin.QueryInterface(Ci.nsIInterfaceRequestor)
                             .getInterface(Ci.nsIWebNavigation)
                             .QueryInterface(Ci.nsIDocShellTreeItem)
                             .rootTreeItem
                             .QueryInterface(Ci.nsIInterfaceRequestor)
                             .getInterface(Ci.nsIDOMWindow),
      browserNode = browserWin.gBrowser.getBrowserForDocument(
                      contentWin.document),
      PopupNotifications = browserWin.PopupNotifications;

  let unloadHelper = {
    unload: function() {
      if (notification) {
        PopupNotifications.remove(notification);
        notification = null;
      }
    },
  };

  let notification = PopupNotifications.show(
      browserNode, anchorId, message, "notification-popup-box",
      primaryAction, secondaryActions,
      {
        popupIconURL: popupIconUrl,
        eventCallback: function(state) {
          if (state === "removed") {
            notification = null;
            unloadHelper.unload();
          }
        }
      });
  $unload.ensure(unloadHelper);
}

/**
 * Permission checks.
 * - Is this webapp authorized to attempt to try establish TCP connections?
 *    This allows the user to blacklist use of the API by the extension and does
 *    not convey the ability to connect to anything.
 * - Is this webapp authorized to attempt to connect to the given hostname/IP?
 *    Eternal permission is granted if authorized.
 * 
 * SSL checks:
 * - In the event of a bad certificate and if the open call asked to allow for
 *    exceptions, then we ask the user if they want to add an exception for the
 *    certificate.  Before asking, we check if there already was an exception
 *    and are sure to mention that.
 */
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
    if (Services.perms.testExactPermission(ownerInfo.uri, allPermType) ===
        nsIPermissionManager.DENY_ACTION)
      return;

    // - Ask for Permission
    let allowAction = {
      label: gStringBundle.getString("webapi.permission.allow"),
      accessKey: gStringBundle.getString("webapi.permission.allowAccessKey"),
      callback: function allowCallback() {
console.log("Adding permission:",ownerInfo.uri.spec, "host:",ownerInfo.uri.host, permType, nsIPermissionManager.ALLOW_ACTION);
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
    
    showPopup(
      ownerInfo.contentWin,
      PERMISSION_ANCHOR_ID, PERMISSION_ANCHOR_ICON_URL,
      PERMISSION_POPUP_ICON_URL,
      gStringBundle.getFormattedString(
        "webapi.permission." + (useSSL ? "tcps" : "tcp") + ".prompt",
        [ownerInfo.host, host, port]),
      allowAction,
      [neverThisAction, neverAnyAction, notNowAction]);
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

    showPopup(
      ownerInfo.contentWin,
      CERTIFICATE_ANCHOR_ID, CERTIFICATE_ANCHOR_ICON_URL,
      CERTIFICATE_POPUP_ICON_URL,
      promptString,
      seeAction,
      [notNowAction]);
  },
};
