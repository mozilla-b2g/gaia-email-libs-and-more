/**
 * Fairly simple test cases covering the various successful autoconfig
 * permutations and a few failures.
 */

define(function(require) {

var $fakexhr = require('./resources/fake_xhr');
var $accountcommon = require('accountcommon');
var $th_main = require('./resources/th_main');
var LegacyGelamTest = require('./resources/legacy_gelamtest');

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
  oauth2Settings: null
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
  oauth2Settings: null
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
  oauth2Settings: null
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
  oauth2Settings: null
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
  oauth2Settings: null
};


var goodActivesyncAutodiscoverSubdirConfig = {
  type: 'activesync',
  incoming: {
    autodiscoverEndpoint: AUTODISCOVER_SUBDIR_URL,
  },
};
var goodActivesyncAutodiscoverDomainConfig = {
  type: 'activesync',
  incoming: {
    autodiscoverEndpoint: AUTODISCOVER_DOMAIN_URL,
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
    lazy.log('xhr', args);
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

    lazy.expect(
      'xhr', {
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
    };
    eCheck.expect('result',  results.result);
    eCheck.expect('source',  results.source);
    eCheck.expect('configInfo',  results.configInfo);
    configurator.learnAboutAccount(userDetails)
      .then(function(actualResults) {
        eCheck.log('result', actualResults.result);
        eCheck.log('source', actualResults.source);
        eCheck.log('configInfo', actualResults.configInfo);
      })
      .catch(function(err) {
        eCheck.error('err', err);
      });
  });
};

var allTests = [];

/**
 * local XML config file tells us activesync.
 */
allTests.push(new LegacyGelamTest('successful local activesync', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodActivesyncXML },
    ],
    {
      result: 'need-password',
      source: 'local',
      configInfo: goodActivesyncConfig,
    });
}));

/**
 * local XML config file tells us IMAP using password.
 */
allTests.push(new LegacyGelamTest('successful local IMAP w/password', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapPasswordXML },
    ],
    {
      result: 'need-password',
      source: 'local',
      configInfo: goodImapPasswordConfig,
    });
}));

/**
 * local XML config file tells us IMAP using xoauth2.
 */
allTests.push(new LegacyGelamTest('successful local IMAP w/xoauth2', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapOauthXML },
    ],
    {
      result: 'need-oauth2',
      source: 'local',
      configInfo: goodImapOauthConfig,
    });
}));


/**
 * local XML config file tells us IMAP AND POP3 and for the love of
 * god we choose IMAP.
 */
allTests.push(new LegacyGelamTest('successful local IMAP+POP3 chooses IMAP', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapAndPop3XML },
    ],
    {
      result: 'need-password',
      source: 'local',
      configInfo: goodImapPasswordConfig,
    });
}));

/**
 * local XML config file tells us POP3.
 */
allTests.push(new LegacyGelamTest('successful local POP3', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodPop3XML },
    ],
    {
      result: 'need-password',
      source: 'local',
      configInfo: goodPop3Config,
    });
}));

/**
 * local XML config file tells us IMAP with STARTTLS.
 */
allTests.push(new LegacyGelamTest('successful local IMAP with STARTTLS', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapStarttlsXML },
    ],
    {
      result: 'need-password',
      source: 'local',
      configInfo: goodImapStarttlsConfig,
    });
}));

/**
 * local XML config file tells us IMAP with STARTTLS and SMTP with SSL.
 */
allTests.push(new LegacyGelamTest('successful IMAP with STARTTLS, SMTP with SSL', function(T, RT) {
  cannedTest(T, RT,
    [
      { url: LOCAL_AUTOCONFIG_URL, data: goodImapMixedXML },
    ],
    {
      result: 'need-password',
      source: 'local',
      configInfo: goodImapMixedConfig,
    });
}));


/**
 * The domain self-hosts an XML config at autoconfig.domain and we use that in
 * the absence of ISPDB and we don't care about the MX lookup.
 */
allTests.push(new LegacyGelamTest('successful IMAP autoconfig.domain', function(T, RT) {
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
      source: 'autoconfig-subdomain',
      configInfo: goodImapPasswordConfig,
    });
}));

/**
 * The domain self-hosts an XML config at domain/.well-known/ and we use that
 * in the absence of ISPDB and we don't care about the MX lookup.
 */
allTests.push(new LegacyGelamTest('successful IMAP domain/.well-known/', function(T, RT) {
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
      source: 'autoconfig-wellknown',
      configInfo: goodImapPasswordConfig,
    });
}));

/**
 * The domain self-hosts an XML config at autoconfig.domain and we use that in
 * preference over the ISPDB entry.
 */
allTests.push(new LegacyGelamTest('successful IMAP autoconfig.domain ignoring ISPDB',
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
      source: 'autoconfig-subdomain',
      configInfo: goodImapPasswordConfig,
    });
}));

/**
 * The domain self-hosts an XML config at domain/.well-known/ and we use that
 * in preference over the ISPDB entry.
 */
allTests.push(new LegacyGelamTest('successful IMAP domain/.well-known/ ignoring ISPDB',
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
      source: 'autoconfig-wellknown',
      configInfo: goodImapPasswordConfig,
    });
}));

/**
 * ISPDB lookup found the domain and told us IMAP w/Password.
 */
allTests.push(new LegacyGelamTest('successful ISPDB IMAP w/Password', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, data: goodImapPasswordXML },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
    ],
    {
      result: 'need-password',
      source: 'ispdb',
      configInfo: goodImapPasswordConfig,
    });
}));

/**
 * ISPDB lookup found the domain and told us IMAP w/xoauth2.  We currently don't
 * expect or really support this mode of operation (everything should be local
 * autoconfig), but it's good to make sure it's an option open to us.
 */
allTests.push(new LegacyGelamTest('successful ISPDB IMAP w/xoauth2', function(T, RT) {
  cannedTest(T, RT,
    [
      // group 1:
      { url: LOCAL_AUTOCONFIG_URL, status: 404 },
      // group 2:
      { url: AUTOCONFIG_DOMAIN_URL, status: 404 },
      { url: AUTOCONFIG_WELLKNOWN_URL, status: 404 },
      { url: ISPDB_ENTRY_URL, data: goodImapOauthXML },
      { url: ISPDB_MX_LOOKUP_URL, data: MXtext },
    ],
    {
      result: 'need-oauth2',
      source: 'ispdb',
      configInfo: goodImapOauthConfig,
    });
}));

/**
 * local XML config file tells us IMAP w/password after checking MX.
 */
allTests.push(new LegacyGelamTest('successful MX local IMAP w/password', function(T, RT) {
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
      { url: LOCAL_MX_AUTOCONFIG_URL, data: goodImapPasswordXML },
    ],
    {
      result: 'need-password',
      source: 'mx local',
      configInfo: goodImapPasswordConfig,
    });
}));

/**
 * local XML config file tells us IMAP w/password after checking MX.
 */
allTests.push(new LegacyGelamTest('successful MX local IMAP w/oauth2', function(T, RT) {
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
      { url: LOCAL_MX_AUTOCONFIG_URL, data: goodImapOauthXML },
    ],
    {
      result: 'need-oauth2',
      source: 'mx local',
      configInfo: goodImapOauthConfig,
    });
}));

/**
 * local XML config file tells us activesync after checking MX.
 */
allTests.push(new LegacyGelamTest('successful MX local activesync', function(T, RT) {
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
      source: 'mx local',
      configInfo: goodActivesyncConfig,
    });
}));

allTests.push(new LegacyGelamTest('successful MX ISPDB IMAP w/password', function(T, RT) {
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
      result: 'need-password',
      source: 'mx ispdb',
      configInfo: goodImapPasswordConfig,
    });
}));

allTests.push(new LegacyGelamTest('successful MX ISPDB IMAP w/oauth2', function(T, RT) {
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
      { url: ISPDB_MX_ENTRY_URL, data: goodImapOauthXML },
    ],
    {
      result: 'need-oauth2',
      source: 'mx ispdb',
      configInfo: goodImapOauthConfig,
    });
}));

allTests.push(new LegacyGelamTest('everything fails, get no-config-info', function(T, RT) {
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
      result: 'no-config-info',
      source: null,
      configInfo: null,
    });
}));

/**
 * If the MX lookup told us the same domain we already knew, we skip the group 3
 * local autoconfig and ISPDB re-lookups.
 */
allTests.push(new LegacyGelamTest('everything fails, same MX, get no-config-info', function(T, RT) {
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
      result: 'no-config-info',
      source: null,
      configInfo: null,
    });
}));

/**
 * If the ISPDB tells us something but it's unsafe, ignore it like it's not a
 * thing.  We currently don't have a level of confidence in the ISPDB's accuracy
 * to be able to authoritatively state that this means there is no secure way to
 * contact the server, so all we can say is no-config-info.
 */
allTests.push(new LegacyGelamTest('non-SSL ISPDB turns into no-config-info', function(T, RT) {
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
      source: null,
      configInfo: null
    });
}));

/**
 * Unsafe case same as before but with the MX ISPDB lookup happening too
 */
allTests.push(new LegacyGelamTest('non-SSL ISPDB w/MX turns into no-config-info', function(T, RT) {
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
      source: null,
      configInfo: null
    });
}));

/**
 * We end up probing for autodiscover and finding the subdir point.
 */
allTests.push(new LegacyGelamTest('successful activesync domain/autodiscover/ autodiscovery',
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
      // 401 is success for us since it wants us to auth
      { url: AUTODISCOVER_SUBDIR_URL, method: 'POST', status: 401 },
      { url: AUTODISCOVER_DOMAIN_URL, method: 'POST', status: 404 },
    ],
    {
      result: 'need-password',
      source: 'autodiscover',
      configInfo: goodActivesyncAutodiscoverSubdirConfig
    });
}));

/**
 * We end up probing for autodiscover and finding the autodiscover domain point.
 */
allTests.push(new LegacyGelamTest('successful activesync autodiscover.domain autodiscovery',
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
      // 401 is success for us since it wants us to auth
      { url: AUTODISCOVER_DOMAIN_URL, method: 'POST', status: 401 },
    ],
    {
      result: 'need-password',
      source: 'autodiscover',
      configInfo: goodActivesyncAutodiscoverDomainConfig
    });
}));

return allTests;

}); // end define
