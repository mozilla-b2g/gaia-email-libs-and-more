/**
 * Test that we linkify both HTML and plaintext bodies correctly.  This logic is
 * provided by the back-end as a utility function, so we don't need to pass
 * messages through the server and can even do everything synchronously.
 */

define(['rdcommon/testcontext', 'mailapi/testhelper', 'exports'],
       function($tc, $th_imap, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_linkify' }, null, [$th_imap.TESTHELPER], ['app']);

/**
 * Standalone linkification test-cases to check our parsing logic and any
 * transformations we might do.
 */
var TEXT_CASES = [
  // HTML
  {
    name: 'non-SSL link, trailing /, no path',
    text: 'http://www.mozilla.org/',
    url: 'http://www.mozilla.org/',
  },
  {
    name: 'non-SSL link, no trailing /',
    text: 'http://www.mozilla.org',
    url: 'http://www.mozilla.org',
  },
  {
    name: 'SSL link, trailing /, no path',
    text: 'https://www.mozilla.org/',
    url: 'https://www.mozilla.org/',
  },
  {
    name: 'SSL link, no trailing /',
    text: 'https://www.mozilla.org',
    url: 'https://www.mozilla.org',
  },
  /*
  {
    name: 'naked domain name',
    text: 'www.mozilla.org',
    url: 'http://www.mozilla.org/',
  },
  */
  {
    name: 'link with path',
    text: 'http://www.mozilla.org/path/path/path.html',
    url: 'http://www.mozilla.org/path/path/path.html',
  },
  {
    name: 'link with query string',
    text: 'http://sub.mozilla.org/?foo=bar&baz#pong',
    url: 'http://sub.mozilla.org/?foo=bar&baz#pong',
  },
  {
    name: 'link with path, query string, hash',
    text: 'http://sub.mozilla.org/robo/hats?foo=bar&baz#pong',
    url: 'http://sub.mozilla.org/robo/hats?foo=bar&baz#pong',
  },
  /*
  {
    name: 'protocol-less domain with path, query string, hash',
    text: 'sub.mozilla.org/robo/hats?foo=bar&baz#pong',
    url: 'http://sub.mozilla.org/robo/hats?foo=bar&baz#pong',
  },
   */
  // e-mail
  {
    name: 'simple mailto link',
    text: 'mailto:foo@example.com',
    url: 'mailto:foo@example.com',
  },
  /*
  {
    name: 'mailto link with one argument',
    text: 'mailto:infobot@example.com?subject=current-issue',
    url: 'mailto:infobot@example.com?subject=current-issue',
  },
  {
    name: 'mailto link with two arguments',
    text: 'mailto:joe@example.com?cc=bob@example.com&body=hello',
    url: 'mailto:joe@example.com?cc=bob@example.com&body=hello',
  },
  */
  {
    name: 'plain e-mail address',
    text: 'foo@example.com',
    url: 'mailto:foo@example.com',
  },
];


function FakeText(text) {
  this.textContent = this.nodeValue = text;
}
FakeText.prototype = {
  nodeName: '#text',
};

function FakeNode(tagName) {
  this.nodeName = tagName.toUpperCase();
  this._attributes = {};
  this.className = '';
  this.children = this.childNodes = [];
}
FakeNode.prototype = {

  get textContent() {
    var s = '';
    for (var i = 0; i < this.children.length; i++) {
      s += this.children[i].textContent;
    }
    return s;
  },

  set textContent(val) {
    this.children.splice(this.children.length);
    var textNode = new FakeText(val);
    this.children.push(textNode);
  },

  hasAttribute: function hasAttribute(attrName) {
    return this._attributes.hasOwnProperty(attrName);
  },
  getAttribute: function getAttribute(attrName) {
    return this._attributes[attrName];
  },
  setAttribute: function setAttribute(attrName, attrVal) {
    this._attributes[attrName] = '' + attrVal;
  },
  removeAttribute: function removeAttribute(attrName) {
    delete this._attributes[attrName];
  },
  appendChild: function(child) {
    this.children.push(child);
  },
  insertBefore: function(child, before) {
    this.children.splice(this.children.indexOf(before), 0, child);
  },
  replaceChild: function(orig, replacement) {
    this.children.splice(this.children.indexOf(orig), 1, replacement);
  },
};

function FakeDoc() {
  this.body = new FakeNode('body');
}
FakeDoc.prototype = {
  createElement: function(tagName) {
    return new FakeNode(tagName);
  },
  createTextNode: function(text) {
    return new FakeText(text);
  }
};

TD.commonCase('linkify plaintext', function(T, RT) {
  // We need a universe to get a MailAPI
  var testUniverse = T.actor('testUniverse', 'U'),
      eLazy = T.lazyLogger('linkCheck');

  function expectUrl(tcase) {
    eLazy.expect_namedValue('text', tcase.text);
    eLazy.expect_namedValue('ext-href', tcase.url);
  }
  function expectText(str) {
    eLazy.expect_namedValue('non-link', str);
  }
  function reportUrls(nodes) {
    for (var iNode = 0; iNode < nodes.length; iNode++) {
      var node = nodes[iNode];
      if (node.nodeName === 'A') {
        eLazy.namedValue('text', node.textContent);
        eLazy.namedValue('ext-href', node.getAttribute('ext-href'));
      }
    }
  }
  function reportAll(nodes) {
    for (var iNode = 0; iNode < nodes.length; iNode++) {
      var node = nodes[iNode];
      if (node.nodeName === 'A') {
        eLazy.namedValue('text', node.textContent);
        eLazy.namedValue('ext-href', node.getAttribute('ext-href'));
      }
      else if (node.nodeName === '#text') {
        eLazy.namedValue('non-link', node.nodeValue);
      }
    }
  }

  T.group('no surrounding text');
  TEXT_CASES.forEach(function(tcase) {
    T.check(eLazy, tcase.name, function() {
      expectUrl(tcase);
      var nodes = testUniverse.MailAPI.utils.linkifyPlain(
                    tcase.raw || tcase.text, new FakeDoc());
      reportUrls(nodes);
    }).timeoutMS = 1; // (tests are synchronous)
  });

  T.group('text before and after');
  TEXT_CASES.forEach(function(tcase) {
    T.check(eLazy, tcase.name, function() {
      expectUrl(tcase);
      var nodes = testUniverse.MailAPI.utils.linkifyPlain(
        'fooooooooo ' + (tcase.raw || tcase.text) + ' barrrrrrrrrrrr',
        new FakeDoc());
      reportUrls(nodes);
    }).timeoutMS = 1; // (tests are synchronous)
  });

  T.group('multiple URLs');
  T.check(eLazy, 'multiple URLs', function() {
    var str = 'start http://foo.example.com/ space foo@example.com ' +
                'http://bar.example.com/ ace bar@example.com\n' +
                'http://baz.baz.baz/';

    expectText('start ');
    expectUrl({ text: 'http://foo.example.com/',
                url: 'http://foo.example.com/' });
    expectText(' space ');
    expectUrl({ text: 'foo@example.com',
                url: 'mailto:foo@example.com' });
    expectText(' ');
    expectUrl({ text: 'http://bar.example.com/',
                url: 'http://bar.example.com/' });
    expectText(' ace ');
    expectUrl({ text: 'bar@example.com',
                url: 'mailto:bar@example.com' });
    expectText('\n');
    expectUrl({ text: 'http://baz.baz.baz/',
                url: 'http://baz.baz.baz/' });

    var nodes = testUniverse.MailAPI.utils.linkifyPlain(str, new FakeDoc());
    reportAll(nodes);
  });
});

/**
 * We know that HTML linkification largely reuses the plaintext linkification,
 * so it's just up to us to make sure that we don't mess up existing 'A' tags.
 */
TD.commonCase('linkify HTML', function(T, RT) {
  // We need a universe to get a MailAPI
  var testUniverse = T.actor('testUniverse', 'U'),
      eLazy = T.lazyLogger('linkCheck');

  function traverseAndLogExpectations(enodes) {
    for (var i = 0; i < enodes.length; i++) {
      var enode = enodes[i];
      eLazy.namedValue('name', enode.name);
      if (enode.value)
        eLazy.namedValue('value', enode.value);
      if (enode.url)
        eLazy.namedValue('url', enode.url);
      if (enode.children)
        traverseAndLogExpectations(enode.children);
    }
  }

  function traverseAndLogNodes(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      eLazy.namedValue('name', node.nodeName);
      if (node.nodeValue)
        eLazy.namedValue('value', node.nodeValue);
      if (node.nodeName === '#text')
        continue;
      if (node.hasAttribute('ext-href'))
        eLazy.namedValue('url', node.getAttribute('ext-href'));
      if (node.childNodes)
        traverseAndLogNodes(node.childNodes);
    }
  }

  T.check(eLazy, 'HTML', function() {
    var doc = new FakeDoc(), body = doc.body;
    body.appendChild(
      doc.createTextNode('Lead-in http://bare.link/ gap1 '));

    var a = doc.createElement('a');
    a.setAttribute('ext-href', 'http://existing.link/');
    a.textContent = 'http://nested.plaintext.link/';
    body.appendChild(a);

    body.appendChild(
      doc.createTextNode(' gap2 and an http://intermediate.bare.link '));

    a = doc.createElement('a');
    a.setAttribute('ext-href', 'http://other.existing.link/');
    var span = doc.createElement('span');
    span.textContent = 'arbitrary http://nested.link/';
    a.appendChild(span);

    var expectedNodes = [
        { name: '#text', value: 'Lead-in ' },
        {
          name: 'A', url: 'http://bare.link/',
          children: [
            { name: '#text', value: 'http://bare.link/' },
          ]
        },
        { name: '#text', value: ' gap1 ' },
        {
          name: 'A', url: 'http://existing.link/',
          children: [
            { name: '#text', value: 'http://nested.plaintext.link/' },
          ]
        },
        { name: '#text', value: ' gap2 ' },
        {
          name: 'A', url: 'http://other.existing.link/',
          children: [
            {
              name: 'SPAN',
              children: [
                { name: '#text', value: 'arbitrary http://nested.link/ ' },
              ]
            },
          ]
        },
      ];
    traverseAndLogExpectations(expectedNodes);

    testUniverse.MailAPI.utils.linkifyHTML(doc);
    traverseAndLogNodes(doc.body.childNodes);
  });
});

}); // end define
