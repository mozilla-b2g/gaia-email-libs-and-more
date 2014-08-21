/**
 * Fairly simple test cases covering the various successful autoconfig
 * permutations and a few failures.
 */

define(['rdcommon/testcontext', './resources/th_main',
        './resources/fake_xhr', 'accountcommon',
        'exports'],
       function($tc, $th_main, $fakexhr, $accountcommon, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_autoconfig' }, null, [$th_main.TESTHELPER], ['app']);

var goodImapXML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<clientConfig version="1.1"><emailProvider id="blah">' +
    '<incomingServer type="imap">' +
      '<hostname>imap.xampl.tld</hostname>' +
      '<port>993</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</incomingServer>' +
    '<outgoingServer type="smtp">' +
      '<hostname>smtp.xampl.tld</hostname>' +
      '<port>465</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</outgoingServer>' +
      '</emailProvider></clientConfig>';

var goodPop3XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<clientConfig version="1.1"><emailProvider id="blah">' +
    '<incomingServer type="pop3">' +
      '<hostname>pop3.xampl.tld</hostname>' +
      '<port>993</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</incomingServer>' +
    '<outgoingServer type="smtp">' +
      '<hostname>smtp.xampl.tld</hostname>' +
      '<port>465</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</outgoingServer>' +
      '</emailProvider></clientConfig>';

var goodImapAndPop3XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<clientConfig version="1.1"><emailProvider id="blah">' +
    '<incomingServer type="imap">' +
      '<hostname>imap.xampl.tld</hostname>' +
      '<port>993</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</incomingServer>' +
    '<incomingServer type="pop3">' +
      '<hostname>pop3.xampl.tld</hostname>' +
      '<port>993</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</incomingServer>' +
    '<outgoingServer type="smtp">' +
      '<hostname>smtp.xampl.tld</hostname>' +
      '<port>465</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</outgoingServer>' +
      '</emailProvider></clientConfig>';

var goodImapStarttlsXML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<clientConfig version="1.1"><emailProvider id="blah">' +
    '<incomingServer type="imap">' +
      '<hostname>imap.xampl.tld</hostname>' +
      '<port>143</port>' +
      '<socketType>STARTTLS</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</incomingServer>' +
    '<outgoingServer type="smtp">' +
      '<hostname>smtp.xampl.tld</hostname>' +
      '<port>587</port>' +
      '<socketType>STARTTLS</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</outgoingServer>' +
  '</emailProvider></clientConfig>';

var goodImapMixedXML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<clientConfig version="1.1"><emailProvider id="blah">' +
    '<incomingServer type="imap">' +
      '<hostname>imap.xampl.tld</hostname>' +
      '<port>143</port>' +
      '<socketType>STARTTLS</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</incomingServer>' +
    '<outgoingServer type="smtp">' +
      '<hostname>smtp.xampl.tld</hostname>' +
      '<port>465</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</outgoingServer>' +
  '</emailProvider></clientConfig>';


var goodImapConfig = {
  type: 'imap+smtp',
  incoming: {
    hostname: 'imap.xampl.tld',
    port: '993',
    socketType: 'SSL',
    username: 'user@xampl.tld',
    authentication: 'password-cleartext',
  },
  outgoing: {
    hostname: 'smtp.xampl.tld',
    port: '465',
    socketType: 'SSL',
    username: 'user@xampl.tld',
    authentication: 'password-cleartext',
  },
};

var goodPop3Config = {
  type: 'pop3+smtp',
  incoming: {
    hostname: 'pop3.xampl.tld',
    port: '993',
    socketType: 'SSL',
    username: 'user@xampl.tld',
    authentication: 'password-cleartext',
  },
  outgoing: {
    hostname: 'smtp.xampl.tld',
    port: '465',
    socketType: 'SSL',
    username: 'user@xampl.tld',
    authentication: 'password-cleartext',
  },
};

var goodImapStarttlsConfig = {
  type: 'imap+smtp',
  incoming: {
    hostname: 'imap.xampl.tld',
    port: '143',
    socketType: 'STARTTLS',
    username: 'user@xampl.tld',
    authentication: 'password-cleartext',
  },
  outgoing: {
    hostname: 'smtp.xampl.tld',
    port: '587',
    socketType: 'STARTTLS',
    username: 'user@xampl.tld',
    authentication: 'password-cleartext',
  },
};

var goodImapMixedConfig = {
  type: 'imap+smtp',
  incoming: {
    hostname: 'imap.xampl.tld',
    port: '143',
    socketType: 'STARTTLS',
    username: 'user@xampl.tld',
    authentication: 'password-cleartext',
  },
  outgoing: {
    hostname: 'smtp.xampl.tld',
    port: '465',
    socketType: 'SSL',
    username: 'user@xampl.tld',
    authentication: 'password-cleartext',
  },
};

var unsafeImapXML = goodImapXML.replace('SSL', 'plain', 'g');

var goodActivesyncXML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<clientConfig version="1.1"><emailProvider id="blah">' +
    '<incomingServer type="activesync">' +
      '<server>https://m.xampl.tld/</server>' +
      '<username>%EMAILADDRESS%</username>' +
    '</incomingServer>' +
  '</emailProvider></clientConfig>';

var MXtext = 'mx-xampl.tld';

var goodActivesyncConfig = {
  type: 'activesync',
  incoming: {
    server: 'https://m.xampl.tld/',
    username: 'user@xampl.tld',
  },
  outgoing: {
  },
};

var goodActivesyncAutodiscoverConfig = {
  type: 'activesync',
  displayName: 'DISPLAYNAME',
  incoming: {
    server: 'https://m.xampl.tld/',
    username: 'EMAILADDRESS',
  },
};


var goodActivesyncAutodiscoverXML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<ad:Autodiscover ' +
    'xmlns:ad="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006" ' +
    'xmlns:ms="http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006" ' +
    'xmlns:rq="http://schemas.microsoft.com/exchange/autodiscover/mobilesync/requestschema/2006">' +
    '<ms:Response>' +
      '<ms:User>' +
        '<ms:DisplayName>DISPLAYNAME</ms:DisplayName>' +
        '<ms:EMailAddress>EMAILADDRESS</ms:EMailAddress>' +
      '</ms:User>' +
      '<ms:Culture>CULTURE</ms:Culture>' +
      '<ms:Action><ms:Settings><ms:Server>' +
        '<ms:Type>MobileSync</ms:Type>' +
        '<ms:Url>https://m.xampl.tld/</ms:Url>' +
        '<ms:Name>SERVERNAME</ms:Name>' +
        '<ms:ServerData>SERVERDATA</ms:ServerData>' +
      '</ms:Server></ms:Settings></ms:Action>' +
    '</ms:Response>' +
  '</ad:Autodiscover>';

var gibberishXML = '<xml>I NOT GOOD XML</xml>';

function expectXHRs(lazy, xhrs) {
  var iServiced = 0;
  window.gFakeXHRListener = function(req, args) {
    lazy.namedValue('xhr', args);
    if (iServiced >= xhrs.length)
      return;
    var def = xhrs[iServiced++];
    window.setZeroTimeout(function() {
      if (def.data) {
        req.status = 200;
        req.responseText = def.data;
        req.onload();
      }
      else if (typeof(def.status) === 'number') {
        req.status = def.status;
        req.onload();
      }
      else if (typeof(def.status) === 'string') {
        if (def.status === 'timeout')
          req.ontimeout();
        else if (def.status === 'error')
          req.onerror();
      }
    });
  };
  for (var i = 0; i < xhrs.length; i++) {
    var def = xhrs[i];

    lazy.expect_namedValue(
      'xhr',
      {
        method: def.method || 'GET',
        url: def.url,
        async: true,
        timeout: 30000
      });
  }
}

function cannedTest(T, RT, xhrs, results) {
  $th_main.thunkConsoleForNonTestUniverse();
  var eCheck = T.lazyLogger('check');
  T.action(eCheck, 'autoconfig', function() {
    expectXHRs(eCheck, xhrs);
    var configurator = new $accountcommon.Autoconfigurator();
    var userDetails = {
      emailAddress: 'user@xampl.tld',
      password: 'PASSWORD',
    };
    eCheck.expect_namedValue('error', results.error);
    eCheck.expect_namedValue('config', results.config);
    eCheck.expect_namedValue('errorDetails', results.errorDetails);
    configurator.getConfig(userDetails, function(error, config, errorDetails) {
      eCheck.namedValue('error', error);
      eCheck.namedValue('config', config);
      eCheck.namedValue('errorDetails', errorDetails);
    });
  });
};

/**
 * local XML config file tells us activesync.
 */
TD.commonCase('successful local activesync', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        data: goodActivesyncXML },
    ],
    {
      error: null,
      config: goodActivesyncConfig,
      errorDetails: null,
    });
});

/**
 * local XML config file tells us IMAP.
 */
TD.commonCase('successful local IMAP', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        data: goodImapXML },
    ],
    {
      error: null,
      config: goodImapConfig,
      errorDetails: null,
    });
});

/**
 * local XML config file tells us IMAP AND POP3 and for the love of
 * god we choose IMAP.
 */
TD.commonCase('successful local IMAP+POP3 chooses IMAP', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        data: goodImapAndPop3XML },
    ],
    {
      error: null,
      config: goodImapConfig,
      errorDetails: null,
    });
});

/**
 * local XML config file tells us POP3.
 */
TD.commonCase('successful local POP3', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        data: goodPop3XML },
    ],
    {
      error: null,
      config: goodPop3Config,
      errorDetails: null,
    });
});

/**
 * local XML config file tells us IMAP with STARTTLS.
 */
TD.commonCase('successful local IMAP with STARTTLS', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        data: goodImapStarttlsXML },
    ],
    {
      error: null,
      config: goodImapStarttlsConfig,
      errorDetails: null,
    });
});

/**
 * local XML config file tells us IMAP with STARTTLS and SMTP with SSL.
 */
TD.commonCase('successful IMAP with STARTTLS, SMTP with SSL', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        data: goodImapMixedXML },
    ],
    {
      error: null,
      config: goodImapMixedConfig,
      errorDetails: null,
    });
});

/**
 * The domain self-hosts an XML config at autoconfig.domain.
 */
TD.commonCase('successful IMAP autoconfig.domain', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        data: goodImapXML },
    ],
    {
      error: null,
      config: goodImapConfig,
      errorDetails: null,
    });
});

/**
 * The domain self-hosts an XML config at domain/.well-known/
 */
TD.commonCase('successful IMAP domain/.well-known/', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        data: goodImapXML },
    ],
    {
      error: null,
      config: goodImapConfig,
      errorDetails: null,
    });
});

/**
 * ActiveSync autodiscovery worked for the domain via /autodiscover/.
 */
TD.commonCase('successful activesync domain/autodiscover/ autodiscovery',
              function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', data: goodActivesyncAutodiscoverXML },
    ],
    {
      error: null,
      config: goodActivesyncAutodiscoverConfig,
      errorDetails: null,
    });
});

/**
 * ActiveSync autodiscovery worked for the domain via autodiscover.domain.
 */
TD.commonCase('successful activesync autodiscover.domain autodiscovery',
              function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', data: gibberishXML },
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', data: goodActivesyncAutodiscoverXML },
    ],
    {
      error: null,
      config: goodActivesyncAutodiscoverConfig,
      errorDetails: null,
    });
});

/**
 * Auth failure (401: bad-user-or-pass) in autodiscover process ends the
 * autoconfig process.  Note that this is different from the 403 case (see
 * below) where we keep going because 403 has been used to indicate that the
 * user needs to pay money to use ActiveSync but can use IMAP for free.
 */
TD.commonCase('ActiveSync autodiscover 401 tries ISPDB but fails',
              function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      // here's the autodiscover failure!
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 401 },
    ],
    {
      error: 'bad-user-or-pass',
      config: null,
      errorDetails: {},
    });
});

/**
 * ISPDB lookup found the domain and told us IMAP.
 */
TD.commonCase('successful ISPDB IMAP', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/xampl.tld',
        data: goodImapXML },
    ],
    {
      error: null,
      config: goodImapConfig,
      errorDetails: null,
    });
});

/**
 * Verify that even if there is an ActiveSync autodiscover mechanism that fails
 * to auth us that we keep going to perform a successful ISPDB IMAP lookup.
 * This is the case for t-online.de right now where ActiveSync is provided as
 * a premium service but free IMAP is available.  (Note that we are also
 * going to address the t-online.de case by using a local config XML since we
 * prefer to use IMAP over ActiveSync.)
 */
TD.commonCase('ActiveSync auth failure followed by successful ISPDB IMAP',
              function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      // for t-online.de, there is no server at the base domain
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 'error' },
      // 403 is 'not-authorized'
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 403 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/xampl.tld',
        data: goodImapXML },
    ],
    {
      error: null,
      config: goodImapConfig,
      errorDetails: null,
    });
});

/**
 * local XML config file tells us activesync after checking MX.
 */
TD.commonCase('successful MX local activesync', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/dns/mx/xampl.tld',
        data: MXtext },
      { url: '/autoconfig/mx-xampl.tld',
        data: goodActivesyncXML },
    ],
    {
      error: null,
      config: goodActivesyncConfig,
      errorDetails: null,
    });
});

/**
 * local XML config file tells us IMAP after checking MX.
 */
TD.commonCase('successful MX local IMAP', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/dns/mx/xampl.tld',
        data: MXtext },
      { url: '/autoconfig/mx-xampl.tld',
        data: goodImapXML },
    ],
    {
      error: null,
      config: goodImapConfig,
      errorDetails: null,
    });
});

/**
 * ISPDB lookup found the MX-resolved domain
 */
TD.commonCase('successful MX ISPDB IMAP', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/dns/mx/xampl.tld',
        data: MXtext },
      { url: '/autoconfig/mx-xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/mx-xampl.tld',
        data: goodImapXML },
    ],
    {
      error: null,
      config: goodImapConfig,
      errorDetails: null,
    });
});

TD.commonCase('everything fails, get no-config-info', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/dns/mx/xampl.tld',
        data: MXtext },
      { url: '/autoconfig/mx-xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/mx-xampl.tld',
        status: 404 },
    ],
    {
      error: 'no-config-info',
      config: null,
      errorDetails: { status: 404 },
    });
});

TD.commonCase('non-SSL ISPDB turns into no-config-info', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/dns/mx/xampl.tld',
        data: MXtext },
      { url: '/autoconfig/mx-xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/mx-xampl.tld',
        data: unsafeImapXML },
    ],
    {
      error: 'no-config-info',
      config: null,
      errorDetails: { status: 'unsafe' },
    });
});

/**
 * See the t-online.de notes above.  Basically, if ActiveSync autodiscover
 * doesn't work, we want to try all other setup options but then report the
 * original autodiscover error as our error.
 *
 * This case is for a 403 which we map to not-authorized.  This is what a
 * well behaved server will do and there's very little ambiguity here.
 */
TD.commonCase('ActiveSync autodiscover 403 tries ISPDB but fails',
              function(T, RT) {
  cannedTest(T, RT,
    [
      { url: '/autoconfig/xampl.tld',
        status: 404 },
      { url: 'http://autoconfig.xampl.tld/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'http://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40xampl.tld',
        status: 404 },
      { url: 'https://xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 404 },
      // here's the autodiscover failure!
      { url: 'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml',
        method: 'POST', status: 403 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/dns/mx/xampl.tld',
        data: MXtext },
      { url: '/autoconfig/mx-xampl.tld',
        status: 404 },
      { url: 'https://live.mozillamessaging.com/autoconfig/v1.1/mx-xampl.tld',
        status: 404 },
    ],
    {
      error: 'not-authorized',
      config: null,
      errorDetails: {},
    });
});

}); // end define
