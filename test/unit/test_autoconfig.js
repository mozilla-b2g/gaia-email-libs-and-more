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

var LOCAL_AUTOCONFIG_URL = '/autoconfig/xampl.tld';

var AUTOCONFIG_DOMAIN_URL =
  'https://autoconfig.xampl.tld/mail/config-v1.1.xml' +
    '?emailaddress=user%40xampl.tld';
var AUTOCONFIG_WELLKNOWN_URL =
  'https://xampl.tld/.well-known/autoconfig/mail/config-v1.1.xml' +
    '?emailaddress=user%40xampl.tld';
var ISPDB_ENTRY_URL =
  'https://live.mozillamessaging.com/autoconfig/v1.1/xampl.tld';
var ISPDB_MX_LOOKUP_URL = 'https://live.mozillamessaging.com/dns/mx/xampl.tld';
var ISPDB_MX_ENTRY_URL =
  'https://live.mozillamessaging.com/autoconfig/v1.1/mx-xampl.tld';

var LOCAL_MX_AUTOCONFIG_URL = '/autoconfig/mx-xampl.tld';

var AUTODISCOVER_SUBDIR_URL =
  'https://xampl.tld/autodiscover/autodiscover.xml';
var AUTODISCOVER_DOMAIN_URL =
  'https://autodiscover.xampl.tld/autodiscover/autodiscover.xml';

var goodImapPasswordXML =
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

// For the cases that should "lose" where we're performing parallel fetches.
// (AKA, we don't want this result, we want a different one.)
var conflictingImapPasswordXML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<clientConfig version="1.1"><emailProvider id="blah">' +
    '<incomingServer type="imap">' +
      '<hostname>imap.WRONG.tld</hostname>' +
      '<port>993</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</incomingServer>' +
    '<outgoingServer type="smtp">' +
      '<hostname>smtp.WRONG.tld</hostname>' +
      '<port>465</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>password-cleartext</authentication>' +
    '</outgoingServer>' +
  '</emailProvider></clientConfig>';

var goodImapOauthXML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<clientConfig version="1.1"><emailProvider id="blah">' +
    '<incomingServer type="imap">' +
      '<hostname>imap.xampl.tld</hostname>' +
      '<port>993</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>xoauth2</authentication>' +
    '</incomingServer>' +
    '<outgoingServer type="smtp">' +
      '<hostname>smtp.xampl.tld</hostname>' +
      '<port>465</port>' +
      '<socketType>SSL</socketType>' +
      '<username>%EMAILADDRESS%</username>' +
      '<authentication>xoauth2</authentication>' +
    '</outgoingServer>' +
    '<oauth2Settings>' +
      '<secretGroup>oauthy</secretGroup>' +
      '<authEndpoint>https://accounts.xampl.tld/o/oauth2/auth</authEndpoint>' +
      '<tokenEndpoint>https://accounts.xampl.tld/o/oauth2/token</tokenEndpoint>' +
      '<scope>https://mail.xampl.tld/</scope>' +
    '</oauth2Settings>' +
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


var goodImapPasswordConfig = {
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

var goodImapOauthConfig = {
  type: 'imap+smtp',
  incoming: {
    hostname: 'imap.xampl.tld',
    port: '993',
    socketType: 'SSL',
    username: 'user@xampl.tld',
    authentication: 'xoauth2',
  },
  outgoing: {
    hostname: 'smtp.xampl.tld',
    port: '465',
    socketType: 'SSL',
    username: 'user@xampl.tld',
    authentication: 'xoauth2',
  },
  oauth2Settings: {
    secretGroup: 'oauthy',
    authEndpoint: 'https://accounts.xampl.tld/o/oauth2/auth',
    tokenEndpoint: 'https://accounts.xampl.tld/o/oauth2/token',
    scope: 'https://mail.xampl.tld/'
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

var unsafeImapXML = goodImapPasswordXML.replace('SSL', 'plain', 'g');

var goodActivesyncXML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<clientConfig version="1.1"><emailProvider id="blah">' +
    '<incomingServer type="activesync">' +
      '<server>https://m.xampl.tld/</server>' +
      '<username>%EMAILADDRESS%</username>' +
    '</incomingServer>' +
  '</emailProvider></clientConfig>';

// Report a different MX domain
var MXtext = 'mx-xampl.tld';

// Report the same domain as the MX
var MXsame = 'xampl.tld';

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
      { url: LOCAL_AUTOCONFIG_URL, data: goodActivesyncXML },
    ],
    {
      result: 'need-password',
      configInfo: goodActivesyncConfig,
    });
});

/**
 * local XML config file tells us IMAP using password.
 */
TD.commonCase('successful local IMAP w/password', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapPasswordXML },
    ],
    {
      result: 'need-password',
      configInfo: goodImapPasswordConfig,
    });
});

/**
 * local XML config file tells us IMAP using xoauth2.
 */
TD.commonCase('successful local IMAP w/xoauth2', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapOauthXML },
    ],
    {
      result: 'need-password',
      configInfo: goodImapOauthConfig,
    });
});


/**
 * local XML config file tells us IMAP AND POP3 and for the love of
 * god we choose IMAP.
 */
TD.commonCase('successful local IMAP+POP3 chooses IMAP', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapAndPop3XML },
    ],
    {
      result: 'need-password',
      configInfo: goodImapPasswordConfig,
    });
});

/**
 * local XML config file tells us POP3.
 */
TD.commonCase('successful local POP3', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodPop3XML },
    ],
    {
      result: 'need-password',
      configInfo: goodPop3Config,
    });
});

/**
 * local XML config file tells us IMAP with STARTTLS.
 */
TD.commonCase('successful local IMAP with STARTTLS', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapStarttlsXML },
    ],
    {
      result: 'need-password',
      configInfo: goodImapStarttlsConfig,
    });
});

/**
 * local XML config file tells us IMAP with STARTTLS and SMTP with SSL.
 */
TD.commonCase('successful IMAP with STARTTLS, SMTP with SSL', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapMixedXML },
    ],
    {
      result: 'need-password',
      configInfo: goodImapMixedConfig,
    });
});


/**
 * The domain self-hosts an XML config at autoconfig.domain and we use that in
 * the absence of ISPDB and we don't care about the MX lookup.
 */
TD.commonCase('successful IMAP autoconfig.domain', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, data: goodImapPasswordXML },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: 404 },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext }
      // no group 3
    ],
    {
      result: 'need-password',
      configInfo: goodImapPasswordConfig,
    });
});

/**
 * The domain self-hosts an XML config at domain/.well-known/ and we use that
 * in the absence of ISPDB and we don't care about the MX lookup.
 */
TD.commonCase('successful IMAP domain/.well-known/', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, data: goodImapPasswordXML },
      { url: ISPDB_ENTRY_URL, status: 404 },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext }
      // no group 3
    ],
    {
      result: 'need-password',
      configInfo: goodImapPasswordConfig,
    });
});

/**
 * The domain self-hosts an XML config at autoconfig.domain and we use that in
 * preference over the ISPDB entry.
 */
TD.commonCase('successful IMAP autoconfig.domain ignoring ISPDB',
              function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, data: goodImapPasswordXML },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, data: conflictingImapPasswordXML },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext }
      // no group 3
    ],
    {
      result: 'need-password',
      configInfo: goodImapPasswordConfig,
    });
});

/**
 * The domain self-hosts an XML config at domain/.well-known/ and we use that
 * in preference over the ISPDB entry.
 */
TD.commonCase('successful IMAP domain/.well-known/ ignoring ISPDB',
              function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, data: goodImapPasswordXML },
      { url: ISPDB_ENTRY_URL, data: conflictingImapPasswordXML },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext }
      // no group 3
    ],
    {
      result: 'need-password',
      configInfo: goodImapPasswordConfig,
    });
});

/**
 * ISPDB lookup found the domain and told us IMAP w/Password.
 */
TD.commonCase('successful ISPDB IMAP w/Password', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: goodImapPasswordXML },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
    ],
    {
      reslult: 'need-password',
      config: goodImapPasswordConfig,
    });
});

/**
 * ISPDB lookup found the domain and told us IMAP w/xoauth2.  We currently don't
 * expect or really support this mode of operation (everything should be local
 * autoconfig), but it's good to make sure it's an option open to us.
 */
TD.commonCase('successful ISPDB IMAP w/xoauth2', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: goodImapOauthXML },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
    ],
    {
      reslult: 'need-password',
      config: goodImapOauthConfig,
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
        data: goodImapPasswordXML },
    ],
    {
      error: null,
      config: goodImapPasswordConfig,
      errorDetails: null,
    });
});

/**
 * local XML config file tells us activesync after checking MX.
 */
TD.commonCase('successful MX local activesync', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: 404 },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
      // group 3:
      { url: LOCAL_MX_AUTOCONFIG_URL, data: goodActivesyncXML },
    ],
    {
      result: 'need-password',
      configInfo: goodActivesyncConfig,
    });
});

/**
 * ISPDB lookup found the MX-resolved domain
 */
TD.commonCase('successful MX ISPDB IMAP', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: 404 },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
      // group 3:
      { url: LOCAL_MX_AUTOCONFIG_URL, status: 404 },
      { url: ISPDB_MX_ENTRY_URL, data: goodImapPasswordXML },
    ],
    {
      error: null,
      config: goodImapPasswordConfig,
      errorDetails: null,
    });
});

TD.commonCase('everything fails, get no-config-info', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: 404 },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
      // group 3:
      { url: LOCAL_MX_AUTOCONFIG_URL, status: 404 },
      { url: ISPDB_MX_ENTRY_URL, status: 404 },
      // group 4:
      { url: AUTODISCOVER_SUBDIR_URL, method: 'POST', status: 404 },
      { url: AUTODISCOVER_DOMAIN_URL, method: 'POST', status: 404 },
    ],
    {
      reslt: 'no-config-info',
      configInfo: null,
    });
});

/**
 * If the MX lookup told us the same domain we already knew, we skip the group 3
 * local autoconfig and ISPDB re-lookups.
 */
TD.commonCase('everything fails, same MX, get no-config-info', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: 404 },
      { url: ISPDB_MX_LOOKUP_URL, data: MXsame },
      // group 3 is skipped since it's redundant
      // group 4:
      { url: AUTODISCOVER_SUBDIR_URL, method: 'POST', status: 404 },
      { url: AUTODISCOVER_DOMAIN_URL, method: 'POST', status: 404 },
    ],
    {
      reslt: 'no-config-info',
      configInfo: null,
    });
});

/**
 * If the ISPDB tells us something but it's unsafe, ignore it like it's not a
 * thing.  We currently don't have a level of confidence in the ISPDB's accuracy
 * to be able to authoritatively state that this means there is no secure way to
 * contact the server, so all we can say is no-config-info.
 */
TD.commonCase('non-SSL ISPDB turns into no-config-info', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, data: unsafeImapXML },
      { url: ISPDB_MX_LOOKUP_URL, data: MXsame },
      // group 3 skipped since it's redundant
      // group 4:
      { url: AUTODISCOVER_SUBDIR_URL, method: 'POST', status: 404 },
      { url: AUTODISCOVER_DOMAIN_URL, method: 'POST', status: 404 },
    ],
    {
      result: 'no-config-info',
      configInfo: null
    });
});

/**
 * Unsafe case same as before but with the MX ISPDB lookup happening too
 */
TD.commonCase('non-SSL ISPDB turns into no-config-info', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, data: unsafeImapXML },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
      // group 3:
      { url: LOCAL_MX_AUTOCONFIG_URL, status: 404 },
      { url: ISPDB_MX_ENTRY_URL, data: unsafeImapXML },
      // group 4:
      { url: AUTODISCOVER_SUBDIR_URL, method: 'POST', status: 404 },
      { url: AUTODISCOVER_DOMAIN_URL, method: 'POST', status: 404 },
    ],
    {
      result: 'no-config-info',
      configInfo: null
    });
});

/**
 * ActiveSync autodiscovery works for the domain via /autodiscover/.
 */
TD.commonCase('successful activesync domain/autodiscover/ autodiscovery',
              function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: 404 },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
      // group 3:
      { url: LOCAL_MX_AUTOCONFIG_URL, status: 404 },
      { url: ISPDB_MX_ENTRY_URL, status: 404 },
      // group 4:
      { url: AUTODISCOVER_SUBDIR_URL,
        method: 'POST', data: goodActivesyncAutodiscoverXML },
      { url: AUTODISCOVER_DOMAIN_URL, method: 'POST', status: 404 },
    ],
    {
      result: 'need-password',
      configInfo: goodActivesyncAutodiscoverConfig,
    });
});

/**
 * ActiveSync autodiscovery worked for the domain via autodiscover.domain.
 */
TD.commonCase('successful activesync autodiscover.domain autodiscovery',
              function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: 404 },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
      // group 3:
      { url: LOCAL_MX_AUTOCONFIG_URL, status: 404 },
      { url: ISPDB_MX_ENTRY_URL, status: 404 },
      // group 4:
      { url: AUTODISCOVER_SUBDIR_URL, method: 'POST', status: 404 },
      { url: AUTODISCOVER_DOMAIN_URL,
        method: 'POST', data: goodActivesyncAutodiscoverXML },
    ],
    {
      result: 'need-password',
      configInfo: goodActivesyncAutodiscoverConfig,
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
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, status: 404 },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
      // group 3:
      { url: LOCAL_MX_AUTOCONFIG_URL, status: 404 },
      { url: ISPDB_MX_ENTRY_URL, status: 404 },
      // group 4:
      { url: AUTODISCOVER_SUBDIR_URL, method: 'POST', status: 404 },
      { url: AUTODISCOVER_DOMAIN_URL,
        method: 'POST', data: goodActivesyncAutodiscoverXML },

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
        data: goodImapPasswordXML },
    ],
    {
      error: null,
      config: goodImapPasswordConfig,
      errorDetails: null,
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
