// XXX see below about us not having tcp-socket and the moot-ish feature.
//import tcpSocket from 'tcp-socket';

import { AUTOCONFIG_TIMEOUT_MS } from '../../syncbase';

import { Connection, HttpError } from 'activesync/protocol';

function checkServerCertificate(url) {
  return new Promise((resolve) => {
    // XXX We used to use mozTCPSocket to try and figure out certificate errors
    // after the fact, but now we don't have TCPSocket and don't really care.
    resolve(null);
    return;
/*
    var match = /^https:\/\/([^:/]+)(?::(\d+))?/.exec(url);
    // probably unit test http case?
    if (!match) {
      resolve(null);
      return;
    }
    var port = match[2] ? parseInt(match[2], 10) : 443,
        host = match[1];

    console.log('checking', host, port, 'for security problem');

    var sock = tcpSocket.open(host, port);
    function reportAndClose(err) {
      if (sock) {
        var wasSock = sock;
        sock = null;
        try {
          wasSock.close();
        }
        catch (ex) {
          // nothing to do
        }
        resolve(err);
      }
    }
    // this is a little dumb, but since we don't actually get an event right now
    // that tells us when our secure connection is established, and connect always
    // happens, we write data when we connect to help trigger an error or have us
    // receive data to indicate we successfully connected.
    // so, the deal is that connect is going to happen.
    sock.onopen = function() {
      sock.send(
        new TextEncoder('utf-8').encode('GET /images/logo.png HTTP/1.1\n\n'));
    };
    sock.onerror = function(err) {
      var reportErr = null;
      if (err && typeof(err) === 'object' &&
          /^Security/.test(err.name)) {
        reportErr = 'bad-security';
      }
      reportAndClose(reportErr);
    };
    sock.ondata = function(_data) {
      reportAndClose(null);
    };
*/
  });
}

export default function probe({ connInfo, credentials }) {
  return new Promise((resolve) => {
    var conn = new Connection(connInfo.deviceId);
    conn.open(connInfo.server, credentials.username,
              credentials.password);
    conn.timeout = AUTOCONFIG_TIMEOUT_MS;

    conn.connect((error/*, options*/) => {
      if (error) {
        // This error is basically an indication of whether we were able to
        // call getOptions or not.  If the XHR request completed, we get an
        // HttpError.  If we timed out or an XHR error occurred, we get a
        // general Error.
        var failureType,
            failureDetails = { server: connInfo.server };

        if (error instanceof HttpError) {
          if (error.status === 401) {
            failureType = 'bad-user-or-pass';
          }
          else if (error.status === 403) {
            failureType = 'not-authorized';
          }
          // Treat any other errors where we talked to the server as a problem
          // with the server.
          else {
            failureType = 'server-problem';
            failureDetails.status = error.status;
          }
        }
        else {
          // We didn't talk to the server, so it's either an unresponsive
          // server or a server with a bad certificate.  (We require https
          // outside of unit tests so there's no need to branch here.)
          resolve(checkServerCertificate(connInfo.server)
            .then((securityError) => {
              return {
                error: securityError ? 'bad-security' : 'unresponsive-server',
                errorDetails: failureDetails
              };
            }));
          return;
        }

        resolve({
          error: failureType,
          errorDetails: failureDetails
        });
        return;
      }

      resolve({ conn, error: null, errorDetails: null });
    });
  });
}
