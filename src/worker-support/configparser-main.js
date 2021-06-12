// XXX I tried to get rid of `Iterator` usages and otherwise clean up this file
// and it's conceivable I may have broken it a little bit.

function debug(str) {
  //dump('ConfigParser: ' + str + '\n');
}

var me = {
  name: 'configparser',
  sendMessage: null,
  process: function(uid, cmd, args) {
    debug('process ' + cmd);
    switch (cmd) {
      case 'accountcommon':
        parseAccountCommon(uid, cmd, args[0]);
        break;
      case 'accountactivesync':
        parseActiveSyncAccount(uid, cmd, args[0], args[1]);
        break;
      default:
        break;
    }
  }
};

function nsResolver(prefix) {
  var baseUrl = 'http://schemas.microsoft.com/exchange/autodiscover/';
  var ns = {
    rq: baseUrl + 'mobilesync/requestschema/2006',
    ad: baseUrl + 'responseschema/2006',
    ms: baseUrl + 'mobilesync/responseschema/2006',
  };
  return ns[prefix] || null;
}

function parseAccountCommon(uid, cmd, text) {
  var doc = new DOMParser().parseFromString(text, 'text/xml');
  var getNode = function(xpath, rel) {
    return doc.evaluate(xpath, rel || doc, null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE, null)
                          .singleNodeValue;
  };

  var dictifyChildNodes = function(node) {
    if (!node) {
      return null;
    }
    var dict = {};
    for (var kid = node.firstElementChild; kid;
          kid = kid.nextElementSibling) {
      dict[kid.tagName] = kid.textContent;
    }
    return dict;
  };

  var provider = getNode('/clientConfig/emailProvider');
  // Get the first incomingServer we can use (we assume first == best).
  var incoming = getNode('incomingServer[@type="imap"] | ' +
                          'incomingServer[@type="activesync"] | ' +
                          'incomingServer[@type="pop3"]', provider);
  var outgoing = getNode('outgoingServer[@type="smtp"]', provider);
  var oauth2Settings = dictifyChildNodes(getNode('oauth2Settings', provider));

  var config = null;
  var status = null;
  if (incoming) {
    config = {
      type: null,
      incoming: {},
      outgoing: {},
      oauth2Settings: oauth2Settings
    };
    for (const child of incoming.children) {
      config.incoming[child.tagName] = child.textContent;
    }

    if (incoming.getAttribute('type') === 'activesync') {
      config.type = 'activesync';
    } else if (outgoing) {
      var isImap = incoming.getAttribute('type') === 'imap';

      config.type = isImap ? 'imap+smtp' : 'pop3+smtp';
      for (const child of outgoing.children) {
        config.outgoing[child.tagName] = child.textContent;
      }

      var ALLOWED_SOCKET_TYPES = ['SSL', 'STARTTLS'];

      // We do not support unencrypted connections outside of unit tests.
      if (ALLOWED_SOCKET_TYPES.indexOf(config.incoming.socketType) === -1 ||
          ALLOWED_SOCKET_TYPES.indexOf(config.outgoing.socketType) === -1) {
        config = null;
        status = 'unsafe';
      }
    } else {
      config = null;
      status = 'no-outgoing';
    }
  } else {
    status = 'no-incoming';
  }

  me.sendMessage(uid, cmd, [config, status]);
}

function parseActiveSyncAccount(uid, cmd, text, aNoRedirect) {
  var doc = new DOMParser().parseFromString(text, 'text/xml');

  var getNode = function(xpath, rel) {
    return doc.evaluate(xpath, rel, nsResolver,
                        XPathResult.FIRST_ORDERED_NODE_TYPE, null)
                .singleNodeValue;
  };
  var getNodes = function(xpath, rel) {
    return doc.evaluate(xpath, rel, nsResolver,
                        XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
  };
  var getString = function(xpath, rel) {
    return doc.evaluate(xpath, rel, nsResolver, XPathResult.STRING_TYPE,
                        null).stringValue;
  };

  var postResponse = function(error, config, redirectedEmail) {
    me.sendMessage(uid, cmd, [config, error, redirectedEmail]);
  };

  let error = null;
  if (doc.documentElement.tagName === 'parsererror') {
    error = 'Error parsing autodiscover response';
    return postResponse(error);
  }

  // Note: specs seem to indicate the root should be ms:Autodiscover too.
  // It's not clear why we were using ad:Autodiscover or if it ever worked,
  // but there's no meaningful cost to leave that around.
  var responseNode = getNode('/ad:Autodiscover/ms:Response', doc) ||
                      getNode('/ms:Autodiscover/ms:Response', doc);
  if (!responseNode) {
    error = 'Missing Autodiscover Response node';
    return postResponse(error);
  }

  error = getNode('ms:Error', responseNode) ||
          getNode('ms:Action/ms:Error', responseNode);
  if (error) {
    error = getString('ms:Message/text()', error);
    return postResponse(error);
  }

  var redirect = getNode('ms:Action/ms:Redirect', responseNode);
  if (redirect) {
    if (aNoRedirect) {
      error = 'Multiple redirects occurred during autodiscovery';
      return postResponse(error);
    }

    var redirectedEmail = getString('text()', redirect);
    return postResponse(null, null, redirectedEmail);
  }

  var user = getNode('ms:User', responseNode);
  var config = {
    culture: getString('ms:Culture/text()', responseNode),
    user: {
      name:  getString('ms:DisplayName/text()',  user),
      email: getString('ms:EMailAddress/text()', user),
    },
    servers: [],
  };

  const servers = getNodes('ms:Action/ms:Settings/ms:Server', responseNode);
  let server;
  while ((server = servers.iterateNext())) {
    config.servers.push({
      type:       getString('ms:Type/text()',       server),
      url:        getString('ms:Url/text()',        server),
      name:       getString('ms:Name/text()',       server),
      serverData: getString('ms:ServerData/text()', server),
    });
  }

  // Try to find a MobileSync server from Autodiscovery.
  for (const mobileServer of config.servers) {
    if (mobileServer.type === 'MobileSync') {
      config.mobileSyncServer = mobileServer;
      break;
    }
  }

  if (!config.mobileSyncServer) {
    error = 'No MobileSync server found';
    return postResponse(error, config);
  }

  postResponse(null, config);
  return null;
}

export default me;

