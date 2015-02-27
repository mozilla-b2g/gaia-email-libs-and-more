define(['./th_main',
        './fault_injecting_socket', 'imap/probe',
        'syncbase',
        'pop3/probe', 'pop3/pop3', 'smtp/probe',
        'imap/client'],
function($th_main, $fawlty, $imapProbe,
         syncbase, $pop3Probe, $pop3, $smtpProbe, imapclient) {
var FawltySocketFactory = $fawlty.FawltySocketFactory;


function thunkTimeouts(lazyLogger) {
  var timeouts = [];
  function thunkedSetTimeout(func, delay) {
    lazyLogger.log('incoming:setTimeout', delay);
    return timeouts.push(func);
  }
  function thunkedClearTimeout() {
    lazyLogger.log('incoming:clearTimeout');
  }

  imapclient.setTimeoutFunctions(thunkedSetTimeout, thunkedClearTimeout);
  $pop3.setTimeoutFunctions(thunkedSetTimeout, thunkedClearTimeout);

  return function fireThunkedTimeout(index) {
    timeouts[index]();
    timeouts[index] = null;
  };
}

// Utility function for properly raising errors in promises.
function thrower(err) {
  console.error(err);
  throw err;
}

function proberTimeout(RT) {
  return syncbase.CONNECT_TIMEOUT_MS;
}
function constructProber(RT, cci) {
  var probeAccount = (RT.envOptions.type === "imap") ?
        $imapProbe.probeAccount : $pop3Probe.probeAccount;
  return probeAccount(cci.credentials, cci.connInfo);
}

function openResponse(RT) {
  if (RT.envOptions.type === "imap") {
    return '* OK IMAP rules, POP3 drools\r\n';
  } else if (RT.envOptions.type === "pop3") {
    return '+OK POP3 READY\r\n';
  }
}

function badStarttlsResponse(RT) {
  if (RT.envOptions.type === "imap") {
    return 'W1 BAD STARTTLS Unsupported\r\n';
  } else if (RT.envOptions.type === "pop3") {
    return '-ERR no starttls\r\n';
  }
}

function capabilityResponse(RT) {
  if (RT.envOptions.type === "imap") {
    return [
      '* CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE' +
        ' STARTTLS AUTH=PLAIN',
      'W1 OK Pre-login capabilities listed, post-login capabilities have more.',
    ].join('\r\n') + '\r\n';
  } else if (RT.envOptions.type === "pop3") {
    return '+OK\r\n.\r\n';
  }
}

// Currently all the tests in here are completely fake; we never connect.
const HOST = 'localhost', PORT = 65535;

function makeCredsAndConnInfo() {
  return {
    credentials: {
      username: 'USERNAME',
      password: 'PASSWORD',
      outgoingPassword: 'SMTP-PASSWORD',
    },
    connInfo: {
      hostname: HOST,
      port: PORT,
      crypto: true,
    },
  };
}

var KEEP_ALIVE_TIMEOUT_MS = 10000;

function cannedLoginTest(T, RT, opts) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');

  var fireTimeout = thunkTimeouts(eCheck),
      cci = makeCredsAndConnInfo(),
      prober;

  if (opts.mutateConnInfo) {
    opts.mutateConnInfo(cci);
  }

  T.action('connect, get error, return', eCheck, function() {
    if (opts.expectFunc) {
      opts.expectFunc();
    }

    if (!opts.willNotMakeConnection) {
      eCheck.expect('incoming:setTimeout',  proberTimeout(RT));
      eCheck.expect('incoming:clearTimeout');
    }
    eCheck.expect('probe result',  opts.expectResult);

    // Even though we will fail to login, from the IMAP connection's
    // perspective we won't want the connection to die.
    // ...And now I've restored the original event functionality.
    //eCheck.expect('incoming:setTimeout',  KEEP_ALIVE_TIMEOUT_MS);
    var precommands = [];

    if (RT.envOptions.type === 'pop3') {
      // If SASL AUTH fails, POP3 just tries USER blindly.
      // So push a failing SASL auth here, and then we'll respond to
      // the login error after USER.
      precommands.push({
          match: true,
          actions: [
            {
              cmd: 'fake-receive',
              data: '-ERR\r\n',
            },
          ],
      });
    } else { // IMAP
      precommands.push({
          match: /CAPABILITY/,
          actions: [
            {
              cmd: 'fake-receive',
              data: opts.capabilityResponse || capabilityResponse(RT),
            },
          ],
      });
    }
    precommands.push({
      match: true,
      actions: [
        {
          cmd: 'fake-receive',
          data: (RT.envOptions.type === 'imap' ? 'W2 OK\r\nW3 ' : '-ERR ') +
            opts.loginErrorString + '\r\n',
        }
      ],
    });

    if (!opts.willNotMakeConnection) {
      FawltySocketFactory.precommand(
        HOST, PORT,
        {
          cmd: 'fake',
          data: opts.openResponse || openResponse(RT),
        },
        precommands);
    }

    constructProber(RT, cci).catch(function(err) {
      eCheck.log('probe result', err);
    });
  });
};

return {
  thunkTimeouts, thrower, proberTimeout, constructProber, openResponse,
  badStarttlsResponse, capabilityResponse, makeCredsAndConnInfo,
  HOST, PORT, KEEP_ALIVE_TIMEOUT_MS,
  cannedLoginTest
};

});
