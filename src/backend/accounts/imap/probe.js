/**
 * Validates connection information for an account and verifies that
 * the server on the other end is something we are capable of
 * sustaining an account with.
 */

import logic from 'logic';
import * as imapclient from './client';

  /**
   * Log in to test credentials and determine sync engine to use, passing the
   * established connection onward if successful for later reuse.
   *
   * The engines that may currently be returned:
   * - vanillaImap: vanilla IMAP.  so boring!  (We don't just call this IMAP
   *   because things quickly get ridiuclously confusing at that point.  And we
   *   don't just call it vanilla to avoid confusing would-be contributors.)
   * - gmailImap: gmail-specific IMAP.  (We suffix because someday we may have
   *   gmailJmap, or if things go more dystopian, gmailApi.)
   *
   * @param {object} credentials
   *   keys: hostname, port, crypto
   * @param {object} connInfo
   *   keys: username, password, xoauth2 (if OAUTH)
   * @return {Promise<{conn, engine>}}
   *   resolve => { conn, engine }
   *   reject => String (normalized)
   */
  export function probeAccount(credentials, connInfo) {
    var scope = logic.scope('ImapProber');
    logic(scope, 'connecting', { connInfo: connInfo });

    var conn;
    return imapclient.createImapConnection(
      credentials,
      connInfo,
      function onCredentialsUpdated() {
        // Normally we shouldn't see a request to update credentials
        // here, as the caller should have already passed a valid
        // accessToken during account setup. This might indicate a
        // problem with our OAUTH handling, so log it just in case.
        logic(scope, 'credentials-updated');
      }
    ).then(function(newConn) {
        conn = newConn;
        let engine = 'vanillaImap';
        if (conn.capability.indexOf('X-GM-EXT-1') !== -1) {
          engine = 'gmailImap';
        }
        logic(scope, 'success', { engine });
        return { conn, engine };
      })
      .catch(function(err) {
        // Normalize the error before passing it on.
        err = imapclient.normalizeImapError(conn, err);
        logic(scope, 'error', { error: err });
        if (conn) {
          conn.close();
        }
        throw err;
      });
  }
