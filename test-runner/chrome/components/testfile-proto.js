const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
const CC = Components.Constructor;

dump('sourcing testfile-proto.js\n');

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const IOService = CC('@mozilla.org/network/io-service;1', 'nsIIOService')();
const URIChannel = IOService.newChannel.bind(IOService);

const SecurityManager = CC('@mozilla.org/scriptsecuritymanager;1',
                     'nsIScriptSecurityManager')();
const URI = IOService.newURI.bind(IOService);
const Principal = SecurityManager.getCodebasePrincipal.bind(SecurityManager);

const URLParser = CC('@mozilla.org/network/url-parser;1?auth=maybe',
                     'nsIURLParser')();

function do_get_file(path, allowNonexistent) {
  try {
    let lf = Components.classes["@mozilla.org/file/directory_service;1"]
      .getService(Components.interfaces.nsIProperties)
      .get("CurWorkD", Components.interfaces.nsILocalFile);

    let bits = path.split("/");
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) {
        if (bits[i] == "..")
          lf = lf.parent;
        else
          lf.append(bits[i]);
      }
    }

    if (!allowNonexistent && !lf.exists()) {
      var stack = Components.stack.caller;
      dump("MISSING FILE | " + stack.filename + " | [" +
            stack.name + " : " + stack.lineNumber + "] " + lf.path +
            " does not exist\n");
    }

    return lf;
  }
  catch (ex) {
    dump(ex.toString() + "\n" + Components.stack.caller + "\n");
  }

  return null;
}


// from :gozala's protocol jetpack's uri.js:
function CustomURL(uriStr) {
  let uri = this;

  uri.spec = uriStr;

  let uriStrData = [ uriStr, uriStr.length, {}, {}, {}, {}, {}, {} ];
  URLParser.parseURL.apply(URLParser, uriStrData);
  let [ { value: schemePos }, { value: schemeLen },
        { value: authPos }, { value: authLen },
        { value: pathPos }, { value: pathLen } ] = uriStrData.slice(2);

  uri.scheme = uriStr.substr(schemePos, schemeLen);
  uri.prePath = uriStr.substring(schemePos, pathPos);


  let auth = uriStr.substr(authPos, authLen);
  let authData = [ auth, auth.length, {}, {}, {}, {}, {}, {}, {}, {} ];
  URLParser.parseAuthority.apply(URLParser, authData);
  let [ { value: usernamePos }, { value: usernameLen },
        { value: passwordPos }, { value: passwordLen },
        { value: hostnamePos }, { value: hostnameLen },
        { value: port } ] = authData.slice(2);

  // TODO: Make it more configurable.
  uri.host = auth.substr(hostnamePos, hostnameLen);
  uri.port = port;
  uri.username = auth.substr(usernamePos, usernameLen);
  uri.userPass = auth.substr(passwordPos, passwordLen);
  uri.path = uriStr.substr(pathPos, pathLen);


  let path = uri.path;
  let pathData = [ path, path.length, {}, {}, {}, {}, {}, {}, {}, {}, {}];
  URLParser.parsePath.apply(URLParser, pathData);
  let [ { value: filepathPos }, { value: filepathLen },
        { value: queryPos }, { value: queryLen },
        { value: refPos }, { value: refLen } ] = pathData.slice(2);

  uri.filePath = path.substr(filepathPos, filepathLen);
  uri.query = path.substr(queryPos, queryLen);
  uri.ref = path.substr(refPos, refLen);

  let filepath = uri.filePath;
  let fileData = [ filepath, filepath.length, {}, {}, {}, {}, {}, {} ];
  URLParser.parseFilePath.apply(URLParser, fileData);
  let [ { value: directoryPos }, { value: directoryLen },
        { value:  basenamePos }, { value: basenameLen },
        { value: extensionPos }, { value: extensionLen } ] = fileData.slice(2);

  uri.fileName = filepath.substr(basenamePos);
  uri.directory = filepath.substr(directoryPos, directoryLen);
  uri.fileBaseName = filepath.substr(basenamePos, basenameLen);
  uri.fileExtension = filepath.substr(extensionPos, extensionLen);

  return uri;
}
CustomURL.prototype = {
  QueryInterface: XPCOMUtils.generateQI(
    [ Ci.nsIURI, Ci.nsIURL, Ci.nsIStandardURL, Ci.nsIMutable ]),

  originCharset: 'UTF-8',
  get asciiHost() this.host,
  get asciiSpec() this.spec,
  get hostPort() this.port === -1 ? this.host : this.host + ':' + this.port,
  clone: function clone() { return new CustomURL(this.spec); },
  cloneIgnoringRef: function cloneIgnoringRef() this.clone(),
  equals: function equals(uri) this.spec === uri.spec,
  equalsExceptRef: function equalsExceptRef(uri) this.equals(uri),
  schemeIs: function schemeIs(scheme) this.scheme === scheme,
  resolve: function resolve(path) {
    let parts;

    if (path.length && path[0] === '/') {
      parts = [''];
    }
    else {
      parts = this.filePath.split('/');
    // pop off the filename part
      if (parts[parts.length - 1])
        parts.pop();
    }

    let bits = path.split("/");
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) {
        if (bits[i] == "..")
          parts.pop();
        else
          parts.push(bits[i]);
      }
    }

    return this.scheme + '://' + this.hostPort + parts.join('/');
  },

  mutable: true,
  classDescription: 'Custom URL',
  contractID: '@mozilla.org/network/custom-url;1',
  getCommonBaseSpec: function (uri) {
    dump('getCommonBaseSpec' + uri.spec + '\n');
  },
  getRelativeSpec: function (uri) {
    dump('getRelativeSpec' + uri.spec + '\n');
  }
};

var DEBUG = 0;

function TestfileProtocolHandler() {
//dump('instantiating protocol!\n');
}
TestfileProtocolHandler.prototype = {
  classDescription: 'testfile protocol handler',
  classID: Components.ID('{14f565f2-8886-4b9e-92f6-d52b53d87464}'),
  contractID: '@mozilla.org/network/protocol;1?name=testfile',

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIProtocolHandler]),

  scheme: 'testfile',
  defaultPort: 80,
  protocolFlags: Ci.nsIProtocolHandler.URI_LOADABLE_BY_ANYONE,
  allowPort: function() { return true; },

  newURI: function Proto_newURI(aSpec, aOriginCharset, aBaseURI) {
    if (DEBUG)
      dump('newURI! ' + aSpec + ' base? ' + (aBaseURI ? aBaseURI.spec : null) +
           '\n');
    if (aBaseURI) {
      let resolved = aBaseURI.resolve(aSpec);
      if (DEBUG)
        dump('resolved to: ' + resolved + '\n');
      return URI(resolved, null, null);
    }

    return new CustomURL(aSpec);
  },

  newChannel: function Proto_newChannel(aURI) {
    var relPath;
    if (aURI.QueryInterface(Ci.nsIURL))
      relPath = aURI.filePath;
    else
      relPath = aURI.path;
    if (DEBUG)
      dump('trying to create channel for: ' + relPath + '\n');
    var channel = URIChannel(IOService.newFileURI(do_get_file(relPath)).spec,
                             null, null);
    channel.originalURI = aURI;
    channel.owner = Principal(aURI, null, null);
    return channel;
  },
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([TestfileProtocolHandler]);
