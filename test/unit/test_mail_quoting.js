/**
 * Test our processing of MIME messages.  Because we leave most of this up to
 * the IMAP server, this ends up being a test of `imapchew.js`, the sync logic
 * in `mailslice.js`'s ability to cram things into mimeparser, and the
 * mimeparser lib itself.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        'quotechew', 'mailchew', 'exports'],
       function($tc, $th_imap, $quotechew, $mailchew, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_mail_quoting' }, null, [$th_imap.TESTHELPER], ['app']);

function j() {
  return Array.prototype.join.call(arguments, '\n');
}

const DESIRED_SNIPPET_LENGTH = 100;

TD.commonCase('Quoting', function(T) {
  var longBodyStr =
    'This is a very long message that wants to be snippeted to a ' +
    'reasonable length that is reasonable and not unreasonable.  It is ' +
    'neither too long nor too short.  Not too octogonal nor hexagonal. ' +
    'It is just right.';
  var noWhitespaceLongString =
    '0123456789012345678901234567890123456789012345678901234567890123456789' +
    '0123456789012345678901234567890123456789012345678901234567890123456789';
  var quoteTests = [
    // - base/pathological cases
    {
      name: 'empty string',
      body: '',
      chunks: [],
      snippet: '',
    },
    {
      name: 'just whitespace: one newline',
      body: '\n',
      chunks: ['content', ''],
      snippet: '',
    },
    {
      name: 'just whitespace: multiple newlines',
      body: '\n\n\n',
      chunks: ['content', ''],
      snippet: '',
    },
    {
      name: 'just whitespace: newlines, nbsp',
      body: '\n\xa0\n\n\xa0\n',
      chunks: ['content', ''],
      snippet: '',
    },
    {
      name: 'long body, snippet truncates exactly',
      body: longBodyStr,
      chunks: ['content', longBodyStr],
      snippet: 'This is a very long message that wants to be snippeted to a ' +
               'reasonable length that is reasonable and',
    },
    {
      name: 'long body, snippet truncates with word shrink',
      body: longBodyStr.replace('and', 'andy'),
      chunks: ['content', longBodyStr.replace('and', 'andy')],
      snippet: 'This is a very long message that wants to be snippeted to a ' +
               'reasonable length that is reasonable',
    },
    {
      name: 'long body, no whitespace, snippet truncates exactly',
      body: noWhitespaceLongString,
      chunks: ['content', noWhitespaceLongString],
      snippet: '012345678901234567890123456789012345678901234567890123456789' +
               '0123456789012345678901234567890123456789',
    },
    // - quoting fundamentals
    {
      name: 'no quoting',
      body: j('Foo', 'bar', '', 'baz'),
      chunks: ['content', j('Foo', 'bar', '', 'baz')],
      snippet: 'Foo bar baz',
    },
    {
      name: 'simple bottom posting',
      body: j(
          'John wrote:',
          '> Foo', '>', '> Bar',
          '', 'Baz', '', 'Chaz'
        ),
      chunks: [
          'leadin', j('John wrote:'),
          'q1', j('Foo', '', 'Bar'),
          'content', j('Baz', '', 'Chaz')
        ],
      snippet: 'Baz Chaz',
    },
    {
      name: 'simple top posting',
      body: j(
          'Hats are where it is at.', '',
          'Jim Bob wrote:',
          '> I like hats', '> Yes I do!'
        ),
      chunks: [
          'content', 'Hats are where it is at.',
          'leadin', 'Jim Bob wrote:',
          'q1', j('I like hats', 'Yes I do!'),
        ],
      snippet: 'Hats are where it is at.',
    },
    {
      name: 'interspersed reply',
      body: j(
          'John wrote:', '> I like hats',
          'I concur with this point.',
          '> yes I do!',
          '', 'this point also resonates with me.', '',
          '> I like hats!', '> How bout you?',
          '', 'Verily!'
        ),
      chunks: [
          'leadin', 'John wrote:',
          'q1', 'I like hats',
          'content', 'I concur with this point.',
          'q1', 'yes I do!',
          'content', 'this point also resonates with me.',
          'q1', j('I like hats!', 'How bout you?'),
          'content', 'Verily!',
        ],
      snippet: 'I concur with this point.',
    },
    {
      name: 'german nbsp',
      body: j(
          'Bob Bob <foo@bob.bob> wrote:', '\xa0',
          '> Robots like to dance',
          'Hats!  Hats!',
          ''
        ),
      chunks: [
          'leadin', 'Bob Bob <foo@bob.bob> wrote:',
          'q1', 'Robots like to dance',
          'content', 'Hats!  Hats!',
        ],
      snippet: 'Hats! Hats!',
    },
    {
      name: 'leadin fakeout paranoia',
      body: j(
          '> wrote', 'running all the time', '> wrote', 'cheese', ''
        ),
      chunks: [
          'q1', 'wrote',
          'content', 'running all the time',
          'q1', 'wrote',
          'content', 'cheese'
        ],
      snippet: 'running all the time',
    },
    // - nested quoting
    // nb: we don't bother with lead-in detection on nested levels
    {
      name: 'nest: 2 deep, no spacing',
      body: j(
          'Alice wrote:',
          '> A1', '>',
          '> Bob wrote:',
          '>> B1', '>>', '>> B2',
          '>', '> A2', '> A3', '>',
          '>> B3',
          '',
          '> A4',
          '>> B4',
          'Z1'
        ),
      chunks: [
          'leadin', 'Alice wrote:',
          'q1', j('A1', '', 'Bob wrote:'),
          'q2', j('B1', '', 'B2'),
          'q1', j('A2', 'A3'),
          'q2', j('B3'),
          'content', '',
          'q1', j('A4'),
          'q2', j('B4'),
          'content', j('Z1'),
        ],
      snippet: 'Z1',
    },
    {
      name: 'nest: 2 deep with spacing',
      body: j(
          '> Foo',
          '> ',
          '> On 7/4/12 7:04 AM, Bob wrote:',
          '> > some text',
          '> >',
          '> > some more text'
        ),
      chunks: [
          // quoted leadin gets treated as quoted
          'q1', j('Foo', '', 'On 7/4/12 7:04 AM, Bob wrote:'),
          'q2', j('some text', '', 'some more text'),
        ],
      snippet: '',
      // because of the spacing, we can't roundtrip this
      roundtrip: false,
    },
    // - explicit signature
    {
      name: 'single line signature',
      body: j('Foo', '', '-- ', 'Baron Bob'),
      chunks: [
          'content', 'Foo',
          'signature', '-- \nBaron Bob',
        ],
      snippet: 'Foo',
    },
    {
      name: 'multiple line signature',
      body: j('Foo', '', '-- ', 'Baron Bob', 'King of Kingland'),
      chunks: [
          'content', 'Foo',
          'signature', '-- \nBaron Bob\nKing of Kingland',
        ],
      snippet: 'Foo',
    },
    {
      name: 'signature after quoted, boilerplate consumes content',
      body: j(
          'New text',
          '',
          'Bob wrote:',
          '> Foo',
          '>',
          '> Bar',
          '',
          '-- ',
          'Signature text'
        ),
      chunks: [
          'content', 'New text',
          'leadin', 'Bob wrote:',
          'q1', j('Foo', '', 'Bar'),
          // right here there used to be a content line!
          'signature', '-- \nSignature text',
        ],
      snippet: 'New text',
    },
    {
      name: 'signature after quoted w/post lines, boilerplate consumes content',
      body: j(
          'New text',
          '',
          'Bob wrote:',
          '> Foo',
          '>',
          '> Bar',
          '',
          '-- ',
          'Signature text',
          // these are the post lines we want consumed:
          '',
          ''
        ),
      chunks: [
          'content', 'New text',
          'leadin', 'Bob wrote:',
          'q1', j('Foo', '', 'Bar'),
          // right here there used to be a content line!
          'signature', '-- \nSignature text',
        ],
      snippet: 'New text',
    },
    // - product boilerplate (not as signature)
    {
      name: 'simple product boilerplate',
      body: j('Foo', '', 'Sent from my iPhone'),
      chunks: [
          'content', 'Foo',
          'product', 'Sent from my iPhone',
        ],
      snippet: 'Foo',
    },
    {
      name: 'simple product boilerplate on top-posting',
      body: j(
          'Yes, dance time.', '', 'Sent from my iPad',
          'John wrote:', '> Dance time?'
        ),
      chunks: [
          'content', 'Yes, dance time.',
          'product', 'Sent from my iPad',
          'leadin', 'John wrote:',
          'q1', 'Dance time?',
        ],
      snippet: 'Yes, dance time.',
    },
    {
      name: 'android product boilerplate',
      body: j(
          'Foo', '', 'Sent from my Android toaster runing ToastedBagelMail v2.3'
        ),
      chunks: [
          'content', 'Foo',
          'product', 'Sent from my Android toaster runing ToastedBagelMail v2.3',
        ],
      snippet: 'Foo',
    },
    // - product boilerplate in an explicit signature
    {
      name: 'product as signature',
      body: j('Foo', '', '-- ', 'Sent from my Phone thing'),
      chunks: [
          'content', 'Foo',
          'product', '-- \nSent from my Phone thing',
        ],
      snippet: 'Foo',
    },
    {
      name: 'signature and product',
      body: j('Foo', '', '-- ', 'Baron Bob', '', 'Sent from my Phone thing'),
      chunks: [
          'content', 'Foo',
          'signature', '-- \nBaron Bob',
          'product', 'Sent from my Phone thing',
        ],
      snippet: 'Foo',
    },
    // - legal boilerplate
    {
      name: 'simple legal boilerplate',
      body: j(
          'Foo',
           '________', 'This message is intended only for you.'
        ),
      chunks: [
          'content', 'Foo',
          'disclaimer', j('________', 'This message is intended only for you.'),
        ],
      snippet: 'Foo',
    },
    // - mailing list boilerplate
    {
      name: 'simple mailing list boilerplate',
      body: j(
          'Foo',
          '________', 'dev-b2g mailing list'
        ),
      chunks: [
        'content', 'Foo',
        'list', j('________', 'dev-b2g mailing list'),
      ],
      snippet: 'Foo',
    },
    // - multiple boilerplates at once
    {
      name: 'product, legal, and mailing list boilerplate',
      body: j(
          'Foo', '', 'Sent from Mobile',
          '________', 'dev-b2g mailing list',
          '________', 'This message is intended only for you.'
        ),
      chunks: [
          'content', 'Foo',
          'product', 'Sent from Mobile',
          'list', j('________', 'dev-b2g mailing list'),
          'disclaimer', j('________', 'This message is intended only for you.'),
        ],
      snippet: 'Foo',
    },
  ];

  var eCheck = T.lazyLogger('quoteCheck'), eRawRep = T.lazyLogger('rawRep');
  quoteTests.forEach(function(tdef) {
    T.check(eCheck, tdef.name, function() {
      var i;
      for (i = 0; i < tdef.chunks.length; i += 2) {
        eCheck.expect_namedValue(tdef.chunks[i], tdef.chunks[i+1]);
      }
      var roundtrip = true;
      if (tdef.hasOwnProperty('roundtrip'))
        roundtrip = tdef.roundtrip;

      eCheck.expect_namedValue('snippet', JSON.stringify(tdef.snippet));
      if (roundtrip)
        eCheck.expect_namedValue(
          'forwardText', JSON.stringify(tdef.body.replace('\xa0', '', 'g')));
      eCheck.expect_event('done');

      var rep = $quotechew.quoteProcessTextBody(tdef.body);
      for (i = 0; i < rep.length; i += 2) {
        var etype = rep[i]&0xf, rtype = null;
        switch (etype) {
          case 0x1:
            rtype = 'content';
            break;
          case 0x2:
            rtype = 'signature';
            break;
          case 0x3:
            rtype = 'leadin';
            break;
          case 0x4:
            rtype = 'q' + (((rep[i] >> 8)&0xff) + 1);
            break;
          case 0x5:
            rtype = 'disclaimer';
            break;
          case 0x6:
            rtype = 'list';
            break;
          case 0x7:
            rtype = 'product';
            break;
          case 0x8:
            rtype = 'ads';
            break;
          default:
            rtype = 'unknown:' + etype.toString(16);
            break;
        }
        eCheck.namedValue(rtype, rep[i+1]);
      }
      eRawRep.value(rep.map(function(x, i) {
        if (i%2)
          return x;
        return x.toString(16);
      }));
      var snippetText = $quotechew.generateSnippet(rep, DESIRED_SNIPPET_LENGTH);
      eCheck.namedValue('snippet', JSON.stringify(snippetText));
      if (roundtrip) {
        var forwardText = $quotechew.generateForwardBodyText(rep);
        eCheck.namedValue('forwardText', JSON.stringify(forwardText));
      }
      eCheck.event('done');
    });
  });
});

TD.commonSimple('Empty subject reply', function(eLazy) {
  var scenarios = [
    [null, 'Re: '],
    ['', 'Re: '],
    ['RE:', 'RE:'],
    ['test', 'Re: test'],
    ['Re: test', 'Re: test']
  ];

  for (i = 0; i < scenarios.length; i++) {
    scenario = scenarios[i];
    eLazy.expect_namedValue(scenario[0], scenario[1]);
  }
  for (i = 0; i < scenarios.length; i++) {
    scenario = scenarios[i];
    eLazy.namedValue(scenario[0], $mailchew.generateReplySubject(scenario[0]));
  }
});

TD.commonSimple('Empty forward reply', function(eLazy) {
  var scenarios = [
    [null, 'Fwd: '],
    ['', 'Fwd: '],
    ['FWD:', 'FWD:'],
    ['test', 'Fwd: test'],
    ['Fwd: test', 'Fwd: test']
  ];

  for (i = 0; i < scenarios.length; i++) {
    scenario = scenarios[i];
    eLazy.expect_namedValue(scenario[0], scenario[1]);
  }
  for (i = 0; i < scenarios.length; i++) {
    scenario = scenarios[i];
    eLazy.namedValue(scenario[0],
      $mailchew.generateForwardSubject(scenario[0]));
  }
});

}); // end define
