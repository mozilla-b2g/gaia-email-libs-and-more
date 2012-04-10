/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at:
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Mozilla Raindrop Code.
 *
 * The Initial Developer of the Original Code is
 *   The Mozilla Foundation
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Andrew Sutherland <asutherland@asutherland.org>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/**
 *
 **/

define(
  [
    'wmsy/wmsy',
    './liveset-adapter',
    'text!./tab-signup.css',
    'exports'
  ],
  function(
    $wmsy,
    $liveset,
    $_css,
    exports
  ) {

// define our tab type in the tabs domain
var ty = exports.ty =
  new $wmsy.WmsyDomain({id: "tab-account", domain: "tabs", css: $_css});

var wy = exports.wy =
  new $wmsy.WmsyDomain({id: "tab-account", domain: "moda", css: $_css});

ty.defineWidget({
  name: 'account-tab',
  constraint: {
    type: 'tab',
    obj: { kind: 'account' },
  },
  focus: wy.focus.container.vertical('host', 'port', 'starttls',
                                     'username', 'password', 'btnSave'),
  structure: {
    errBlock: {
      errMsg: '',
    },
    serverBlock: {
      hostLine: wy.flow({
        hostLabel: 'Host: ',
        host: wy.text('host'),
      }),
      portLine: wy.flow({
        portLabel: 'Port: ',
        port: wy.text('port'),
      }),
      starttls: wy.checkbox(
                  'upgrade to encrypted rather than starting encrypted',
                  'starttls'),
    },
    userInfoBlock: {
      usernameLabel: 'Username: ',
      username: wy.text('username'),
      passwordLabel: 'Password: ',
      password: wy.password('password'),
    },
    buttonBar: {
      btnSave: wy.button('Use Server'),
    },
  },
  impl: {
  },
  events: {
    btnSave: {
      command: function() {
        var self = this, moda = this.__context.moda;

        // er, should we be using emit/receive on this?  having it transparently
        //  update something out of our context?
        this.obj.userAccount.updatePersonalInfo(
          this.userPoco_element.binding.gimmePoco());

        if (this.selectedServerBinding) {
          var serverInfo = this.accountServerInfo =
            this.selectedServerBinding.obj;
          this.obj.userAccount.accountWithServer(serverInfo, this);
        }
        else {
          var serverDomain = this.otherServer_element.value;
          if (serverDomain) {
            if (this.otherServerQuery)
              this.otherServerQuery.destroy();
            this.otherServerQuery =
              moda.insecurelyQueryServerUsingDomainName(serverDomain, {
                onSplice: function() {},
                onCompleted: function() {
                  var serverInfo = self.otherServerQuery.items ?
                                     self.otherServerQuery.items[0] : null;
                  if (!serverInfo) {
                    // XXX l10n
                    self.errMsg_element.textContent =
                      "No server info available for: '" + serverDomain + "'";
                    return;
                  }
                  self.accountServerInfo = serverInfo;
                  self.obj.userAccount.accountWithServer(serverInfo, self);
                },
              });
          }
          else {
            // XXX l10n
            this.errMsg_element.textContent = "No server selected / entered!";
          }
        }
      },
    }
  },
});

}); // end define
