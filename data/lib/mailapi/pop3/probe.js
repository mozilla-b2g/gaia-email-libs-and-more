define(['pop3/pop3', 'exports'], function(pop3, exports) {

/**
 * How many milliseconds should we wait before giving up on the
 * connection? (see imap/probe.js for extended rationale on this
 * number)
 */
exports.CONNECT_TIMEOUT_MS = 30000;

/**
 * Validate connection information for an account and verify that the
 * server on the other end is something we are capable of sustaining
 * an account with.
 *
 * If we succeed at logging in, hand off the established connection to
 * our caller so they can reuse the connection.
 */
function Pop3Prober(credentials, connInfo, _LOG) {
  var opts = {
    host: connInfo.hostname,
    port: connInfo.port,
    crypto: connInfo.crypto,

    username: credentials.username,
    password: credentials.password,

    connTimeout: exports.CONNECT_TIMEOUT_MS,
  };
  if (_LOG) {
    opts._logParent = _LOG;
  }
  console.log("PROBE:POP3 attempting to connect to", connInfo.hostname);

  var bail = this.onError.bind(this);
  var succeed = this.onLoggedIn.bind(this);

  // We need the server to support UIDL and TOP. To test that it does,
  // first we assume that there's a message in the mailbox. If so, we
  // can just run `UIDL 1` and `TOP 1` to see if it works. If there
  // aren't any messages, we'll just run `UIDL` by itself to see if
  // that works. If so, great. If it errors out in any other path, the
  // server doesn't have the support we need and we must give up.
  var conn = this._conn = new pop3.Pop3Client(opts, function(err) {
    if (err) { bail(err); return; }
    conn.protocol.sendRequest('UIDL', ['1'], false, function(err, rsp) {
      if (rsp) {
        conn.protocol.sendRequest('TOP', ['1', '0'], true, function(err, rsp) {
          if (rsp) {
            // both UIDL and TOP work. Awesome!
            succeed();
          } else if (err.err) {
            // Uh, this server must not support TOP. That sucks.
            bail({
              name: 'pop-server-not-great',
              message: 'The server does not support TOP, which is required.'
            });
          } else {
            // if the error was socket-level or something, let it pass
            // through untouched
            bail(rsp.err);
          }
        });
      } else {
        // Either their inbox is empty or they don't support UIDL.
        conn.protocol.sendRequest('UIDL', [], true, function(err, rsp) {
          if (rsp) {
            // It looks like they support UIDL, so let's go for it.
            succeed();
          } else if (err.err) {
            // They must not support UIDL. Not good enough.
            bail({
              name: 'pop-server-not-great',
              message: 'The server does not support UIDL, which is required.'
            });
          } else {
            // if the error was socket-level or something, let it pass
            // through untouched
            bail(rsp.err);
          }
        });
      }
    });
  });

  this.onresult = null;
  this.error = null;
  this.errorDetails = { server: connInfo.hostname };
}

exports.Pop3Prober = Pop3Prober;

Pop3Prober.prototype = {
  onLoggedIn: function() {
    var conn = this._conn;
    this._conn = null;

    console.log('PROBE:POP3 happy');
    if (this.onresult) {
      this.onresult(this.error, conn);
      this.onresult = false;
    }
  },

  onError: function(err) {
    err = analyzeError(err);
    console.warn('PROBE:POP3 sad.', err && err.name, '|',
                 err && err.message, '|',
                 err && err.response && err.response.getStatusLine());

    this.error = err.name;

    // we really want to make sure we clean up after this dude.
    try {
      this._conn.die();
    } catch (ex) {
    }
    var conn = this._conn;
    this._conn = null;

    if (this.onresult) {
      this.onresult(this.error, null, this.errorDetails);
      this.onresult = false;
    }
  },
};


// These strings were taken verbatim from failed Gmail POP connection logs:
var GMAIL_POP_DISABLED_RE = /\[SYS\/PERM\] Your account is not enabled for POP/;
var GMAIL_APP_PASS_RE = /\[AUTH\] Application-specific password required/;
var GMAIL_DOMAIN_DISABLED_RE =
      /\[SYS\/PERM\] POP access is disabled for your domain\./;

/**
 * Given an error returned from Pop3Client, analyze it for more
 * context-specific information such as if we should report the
 * problem to the user, if we should retry, etc.
 *
 * Notes on transient failures:
 *
 * LOGIN-DELAY: RFC2449 defines the LOGIN-DELAY capability to tell the
 * client how often it should check and introduces it as a response
 * code if the client checks too frequently. See
 * http://tools.ietf.org/html/rfc2449#section-8.1.1
 *
 * SYS: RFC3206 provides disambiguation between system failures and
 * auth failures. SYS/TEMP is something that should go away on its
 * own. SYS/PERM is for errors that probably require a human involved.
 * We aren't planning on actually telling the user what the SYS/PERM
 * problem was so they can contact tech support, so we lump them in
 * the same bucket. See http://tools.ietf.org/html/rfc3206#section-4
 *
 * IN-USE: Someone else is already in the maildrop, probably another
 * POP3 client. If optimizing for multiple POP3-using devices was
 * something we wanted to optimize for we would indicate a desire to
 * retry here with a more extensive back-off strategy. See
 * http://tools.ietf.org/html/rfc2449#section-8.1.2
 */
var analyzeError = exports.analyzeError = function(err) {
  // If the root cause was invalid credentials, we must
  // report the problem so the user can correct it.
  err.reportProblem = (err.name === 'bad-user-or-pass');
  // If the problem was due to bad credentials or bad server
  // security, retrying won't help. Otherwise, we can retry later,
  // for connection problems or intermittent server issues, etc.
  err.retry = (err.name !== 'bad-user-or-pass' &&
               err.name !== 'bad-security');
  // As long as we didn't time out, the server was reachable.
  err.reachable = (err.name !== 'timeout');

  // If the server provides a specific extended status label like
  // LOGIN-DELAY, SYS/PERM, etc., pull it into the status field for
  // debugging.
  if (err.message) {
    var match = /\[(.*?)\]/.exec(err.message);
    if (match) {
      err.status = match[1];
    }
  }

  // Style note: The Gmail if-statements below are a bit repetitive,
  // but leaving each one as an independent check makes it clear which
  // path the code flows through.

  // If the server is Gmail, we might be able to extract more
  // specific errors in the case of a failed login. We leave
  // reportProblem and retry as set above, since the actions needed
  // remain the same as bad-user-or-pass errors.
  if (err.name === 'bad-user-or-pass' &&
      err.message && GMAIL_POP_DISABLED_RE.test(err.message)) {
    err.name = 'pop3-disabled';
  } else if (err.name === 'bad-user-or-pass' &&
             err.message && GMAIL_APP_PASS_RE.test(err.message)) {
    err.name = 'needs-app-pass';
  } else if (err.name === 'bad-user-or-pass' &&
             err.message && GMAIL_DOMAIN_DISABLED_RE.test(err.message)) {
    err.name = 'pop3-disabled';
  } else if (err.name === 'unresponsive-server' && err.exception &&
      err.exception.name && /security/i.test(err.exception.name)) {
    // If there was a socket exception and the exception looks like
    // a security exception, note that it was a security-related
    // problem rather than just a bad server connection.
    err.name = 'bad-security';
  } else if ((err.name === 'unresponsive-server' ||
              err.name === 'bad-user-or-pass') &&
             err.message && /\[(LOGIN-DELAY|SYS|IN-USE)/i.test(err.message)) {
    // In two cases (bad auth, and unresponsive server), we might get
    // a more detailed status message from the server that saysa that
    // our account (or the entire server) is temporarily unavailble.
    // Per RFC 3206, these statuses indicate that the server is
    // unavailable right now but will be later.
    err.name = 'server-maintenance';
    err.status = err.message.split(' ')[0]; // set it to the first word
  }

  return err;
};



}); // end define
