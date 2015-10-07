/**
 * Test that we linkify both HTML and plaintext bodies correctly.  This logic is
 * provided by the back-end as a utility function, so we don't need to pass
 * messages through the server and can even do everything synchronously.
 */

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

/**
 * Standalone linkification test-cases to check our parsing logic and any
 * transformations we might do.
 *
 * The cases must include:
 * - name: The name of the test; this is used to create the test case name.
 * - text: What should be the textContent of the generated "a" link produced
 *   by the linkification logic.
 * - url: What should be the "href" of the generated "a" link produced by
 *   the linkification logic.
 *
 * Optional values and their defaults are:
 * - raw: The value to use in the source string that we run the linkification
 *   logic against.  If omitted, the value provided for "text" is used.  You
 *   would use this if you want to add surrounding characters/strings to the
 *   input that are not part of what gets linkified.  If you do this, you will
 *   probably need to also provide "extraPre" and "extraPost".
 * - extraPre: Non-linkified text that will precede the linkified "text".
 *   Probably any things you put in "raw" that you did not put in "text" that
 *   preceded the thing that gets linkified.
 * - extraPost: Non-linkified text that will follow the linkified "text".
 *   Probably any things you put in "raw" that you did not put in "text" that
 *   followed the think that gets linkified.
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
  {
    name: 'naked domain name',
    text: 'www.mozilla.org',
    url: 'http://www.mozilla.org',
  },
  {
    name: 'link with path',
    text: 'http://www.mozilla.org/path/path/path.html',
    url: 'http://www.mozilla.org/path/path/path.html',
  },
  {
    name: 'protocol-less link with path',
    text: 'www.mozilla.org/path/path/path.html',
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
  {
    name: 'protocol-less domain with path, query string, hash',
    text: 'sub.mozilla.org/robo/hats?foo=bar&baz#pong',
    url: 'http://sub.mozilla.org/robo/hats?foo=bar&baz#pong',
  },
  // -- e-mail
  // note: currently our mailto and plain variants are just copied and pasted
  // variants.  We should probably break this list out into its own separate
  // list that has 'mailto:' prefixed onto the front in a variation if it
  // doesn't already start with mailto.
  {
    name: 'simple mailto link',
    text: 'mailto:foo@example.com',
    url: 'mailto:foo@example.com',
  },
  {
    name: 'mailto sub-domain e-mail address',
    text: 'mailto:foo@bar.example.com',
    url: 'mailto:foo@bar.example.com',
  },
  {
    name: 'mailto deep sub-domain e-mail address',
    text: 'mailto:foo@bar.baz.bark.barzak.arrrr.arrrr.arrr.a.r.r.r.example.com',
    url: 'mailto:foo@bar.baz.bark.barzak.arrrr.arrrr.arrr.a.r.r.r.example.com',
  },
  {
    name: 'mailto UK domain e-mail address',
    text: 'mailto:foo@example.co.uk',
    url: 'mailto:foo@example.co.uk',
  },
  {
    name: 'mailto UK sub-domain e-mail address',
    text: 'mailto:foo@bar.example.co.uk',
    url: 'mailto:foo@bar.example.co.uk',
  },
  {
    name: 'mailto e-mail with digits',
    text: 'mailto:foo2@example2.com',
    url: 'mailto:foo2@example2.com',
  },
  {
    name: 'mailto sub-domain e-mail with digits',
    text: 'mailto:foo2@bar2.example2.com',
    url: 'mailto:foo2@bar2.example2.com',
  },
  // check lowercase, uppercase, digits, dashes, periods in e-mail addresses,
  // same for domains.
  {
    name: 'mailto e-mail character-set test',
    text: 'mailto:aAzZ09.a-z@aAzZ09-aZ.aZ0-9.co.uk',
    url: 'mailto:aAzZ09.a-z@aAzZ09-aZ.aZ0-9.co.uk',
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
  {
    name: 'plain sub-domain e-mail address',
    text: 'foo@bar.example.com',
    url: 'mailto:foo@bar.example.com',
  },
  {
    name: 'plain deep sub-domain e-mail address',
    text: 'foo@bar.baz.bark.barzak.arrrr.arrrr.arrr.a.r.r.r.example.com',
    url: 'mailto:foo@bar.baz.bark.barzak.arrrr.arrrr.arrr.a.r.r.r.example.com',
  },
  {
    name: 'plain UK domain e-mail address',
    text: 'foo@example.co.uk',
    url: 'mailto:foo@example.co.uk',
  },
  {
    name: 'plain UK sub-domain e-mail address',
    text: 'foo@bar.example.co.uk',
    url: 'mailto:foo@bar.example.co.uk',
  },
  {
    name: 'plain e-mail with digits',
    text: 'foo2@example2.com',
    url: 'mailto:foo2@example2.com',
  },
  {
    name: 'plain sub-domain e-mail with digits',
    text: 'foo2@bar2.example2.com',
    url: 'mailto:foo2@bar2.example2.com',
  },
  // email addresses with angle brackets adjacent to the address.  This
  // is primarily a problem for when email addresses are quoted in the text
  // and there was a display name present so the email address is enclosed
  // in angle brackets.
  {
    name: 'bare angle bracketed email address',
    raw: '<foo@example.com>',
    extraPre: '<',
    text: 'foo@example.com',
    extraPost: '>',
    url: 'mailto:foo@example.com'
  },
  {
    name: 'angle bracketed email address preceded by unquoted display name',
    raw: 'Foo Bar <foo@example.com>',
    extraPre: 'Foo Bar <',
    text: 'foo@example.com',
    extraPost: '>',
    url: 'mailto:foo@example.com'
  },
  {
    name: 'angle bracketed email address preceded by quoted display name',
    raw: '"Foo Bar" <foo@example.com>',
    extraPre: '"Foo Bar" <',
    text: 'foo@example.com',
    extraPost: '>',
    url: 'mailto:foo@example.com'
  },
  {
    name: 'left angle bracket before email address',
    raw: '<foo@example.com',
    extraPre: '<',
    text: 'foo@example.com',
    extraPost: '',
    url: 'mailto:foo@example.com'
  },
  {
    name: 'right angle bracket after email address',
    raw: 'foo@example.com>',
    extraPre: '',
    text: 'foo@example.com',
    extraPost: '>',
    url: 'mailto:foo@example.com'
  },
  {
    name: 'right angle bracket before email address',
    raw: '>foo@example.com',
    extraPre: '>',
    text: 'foo@example.com',
    extraPost: '',
    url: 'mailto:foo@example.com'
  },
  {
    name: 'left angle bracket after email address',
    raw: 'foo@example.com<',
    extraPre: '',
    text: 'foo@example.com',
    extraPost: '<',
    url: 'mailto:foo@example.com'
  },
  // IDN e-mail addresses from: http://idn.icann.org/E-mail_test
  // These are actually valid e-mail addresses that can respond.
  {
    name: 'plain IDN e-mail Greek',
    text: 'mailtest@xn--hxajbheg2az3al.xn--jxalpdlp',
    url: 'mailto:mailtest@xn--hxajbheg2az3al.xn--jxalpdlp',
  },
  {
    name: 'plain IDN e-mail Cyrillic',
    text: 'mailtest@xn--e1afmkfd.xn--80akhbyknj4f',
    url: 'mailto:mailtest@xn--e1afmkfd.xn--80akhbyknj4f',
  },
  // check lowercase, uppercase, digits, dashes, periods in e-mail addresses,
  // same for domains.
  {
    name: 'plain e-mail character-set test',
    text: 'aAzZ09.az@aAzZ09-aZ.aZ0-9.co.uk',
    url: 'mailto:aAzZ09.az@aAzZ09-aZ.aZ0-9.co.uk',
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

return [

new LegacyGelamTest('linkify plaintext', function(T, RT) {
  // We need a universe to get a MailAPI
  var testUniverse = T.actor('TestUniverse', 'U'),
      eLazy = T.lazyLogger('linkCheck');

  function expectUrl(tcase) {
    eLazy.expect('text',  tcase.text);
    eLazy.expect('ext-href',  tcase.url);
  }
  function expectText(str) {
    eLazy.expect('non-link',  str);
  }
  function reportUrls(nodes) {
    for (var iNode = 0; iNode < nodes.length; iNode++) {
      var node = nodes[iNode];
      if (node.nodeName === 'A') {
        eLazy.log('text', node.textContent);
        eLazy.log('ext-href', node.getAttribute('ext-href'));
      }
    }
  }
  function reportAll(nodes) {
    for (var iNode = 0; iNode < nodes.length; iNode++) {
      var node = nodes[iNode];
      if (node.nodeName === 'A') {
        eLazy.log('text', node.textContent);
        eLazy.log('ext-href', node.getAttribute('ext-href'));
      }
      else if (node.nodeName === '#text') {
        eLazy.log('non-link', node.nodeValue);
      }
    }
  }

  // -- TEXT_CASES with some permutations
  // The various permutations are to help pick up the obvious potential
  // edge cases that affect every regexp.  Probably only add more of these
  // if you would otherwise be duplicating all the existing TEXT_CASES with
  // some manual transforms.  If you are seeing specific cases that need
  // test coverage and/or benefit from being labeled/explicitly called out,
  // then just add the cases to TEXT_CASES directly.

  // - Test the regular expressions with no surrounding text.
  // This helps make sure we still linkify even if the linky thing was the only
  // thing in the message (covering 1 of the 2 basic boundary condition
  // permutations.)
  T.group('no surrounding text');
  TEXT_CASES.forEach(function(tcase) {
    T.check(eLazy, tcase.name, function() {
      expectUrl(tcase);
      var nodes = testUniverse.MailAPI.utils.linkifyPlain(
                    tcase.raw || tcase.text, new FakeDoc());
      reportUrls(nodes);
    }).timeoutMS = 1; // (tests are synchronous)
  });

  // - Test the regular expression with some surrounding text
  // This basically just covers the other basic boundary condition permutation;
  // it would be very embarassing if we couldn't find links in text!
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

  T.group('wrapped with punctuation');
  // - Test text reporting as well as url reporting; also some punctuation
  // We also wrap the patterns with some punctuation without whitespace, but
  // this is more about making sure that we properly report the stuff that is
  // not linkified.  (In the loops above, we only checked what got linkified,
  // not the text.)  If there are specific punctuation permutations to check
  // out, you may just want to add entries to TEXT_CASES and use raw, extraPre,
  // and extraPost appropriately.
  TEXT_CASES.forEach(function(tcase) {
    T.check(eLazy, tcase.name, function() {
      var extraPre = tcase.extraPre || '';
      var extraPost = tcase.extraPost || '';
      expectText('see the thing (' + extraPre);
      expectUrl(tcase);
      expectText(extraPost + ') or the other,' + extraPre);
      expectUrl(tcase);
      expectText(extraPost + ', or with a period ' + extraPre);
      expectUrl(tcase);
      expectText(extraPost + '. (Or with both: ' + extraPre);
      expectUrl(tcase);
      expectText(extraPost + '.)');
      var nodes = testUniverse.MailAPI.utils.linkifyPlain(
        'see the thing (' + (tcase.raw || tcase.text) + ') or the other,' +
        (tcase.raw || tcase.text) + ', or with a period ' +
        (tcase.raw || tcase.text) + '. (Or with both: ' +
        (tcase.raw || tcase.text) + '.)',
        new FakeDoc());
      reportAll(nodes);
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

  // Test our scaling by providing a string that is long enough and involves
  // enough new-lines that running the test cases should take a noticable time
  // in the event we our regex developes back-tracking issues.
  //
  // With these strings, on a Intel(R) Xeon(R) CPU E31225 @ 3.10GHz on
  // mozilla-b2g18 I was observing ~110.ms for the URL cases and ~940ms for
  // the e-mail cases.  I now get ~0.0.ms
  T.group('perf check');
  TEXT_CASES.forEach(function(tcase) {
    T.check(eLazy, tcase.name, function() {
      expectUrl(tcase);
      expectUrl(tcase);
      expectUrl(tcase);
      expectUrl(tcase);
      var nodes = testUniverse.MailAPI.utils.linkifyPlain(
        'fooooooooo foo foo foo foo foo FOO! ' + (tcase.raw || tcase.text) +
        ' dance pants. dance trance. dance plants. dance seance.\n ' +
        'dance chance. dance romance. dance enhance. dance valance.\n ' +
        'dance slants.  dance rants.  dance askance.\n ' +
        'dance pants. dance trance. dance plants. dance seance.\n ' +
        'dance chance. dance romance. dance enhance. dance valance.\n ' +
        'dance slants.  dance rants.  dance askance.\n \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. wwdance@ plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. @www. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        ' barrrrrrrrrrrr \n' + (tcase.raw || tcase.text) + ' moooooooooooo \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance @trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance@ trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. wwwwwwdance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. ww.dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance @trance. wwwdance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        (tcase.raw || tcase.text) + ' .... www. foo. bar. \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'foo bar foo bar foo bar foo bar foo bar foo bar foo bar foor \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance @trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance @trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance @trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance @trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance @trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww http http http httttttp. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance @trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance @trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. \n' +
        'dance chance. dance romance. dance enhance. dance valance. \n' +
        'dance slants.  dance rants.  dance askance. \n' +
        'dance pants. dance trance. dance plants. dance seance. ' +
        'dance chance. dance romance. dance enhance. dance valance. ' +
        'dance slants.  dance rants.  dance askance. ' +
        (tcase.raw || tcase.text) + ' dance-a-tron!',
        new FakeDoc());
      reportUrls(nodes);
    }).timeoutMS = 1; // (tests are synchronous)
  });
}),

/**
 * We know that HTML linkification largely reuses the plaintext linkification,
 * so it's just up to us to make sure that we don't mess up existing 'A' tags.
 */
new LegacyGelamTest('linkify HTML', function(T, RT) {
  // We need a universe to get a MailAPI
  var testUniverse = T.actor('TestUniverse', 'U', { restored: true }),
      eLazy = T.lazyLogger('linkCheck');

  function traverseAndLogExpectations(enodes) {
    for (var i = 0; i < enodes.length; i++) {
      var enode = enodes[i];
      eLazy.log('name', enode.name);
      if (enode.value)
        eLazy.log('value', enode.value);
      if (enode.url)
        eLazy.log('url', enode.url);
      if (enode.children)
        traverseAndLogExpectations(enode.children);
    }
  }

  function traverseAndLogNodes(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      eLazy.log('name', node.nodeName);
      if (node.nodeValue)
        eLazy.log('value', node.nodeValue);
      if (node.nodeName === '#text')
        continue;
      if (node.hasAttribute('ext-href'))
        eLazy.log('url', node.getAttribute('ext-href'));
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
})

];

}); // end define
