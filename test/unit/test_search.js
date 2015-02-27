/**
 * Test the search filters.
 **/
define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $filters = require('searchfilter');

var allTests = [];

function commonCase(name, fn) {
  allTests.push(new LegacyGelamTest(name, fn));
}

commonCase('author filter', function(T) {
  var eLazy = T.lazyLogger('filter');

  var samples = [
    { name: 'no match against empty author',
      phrase: 'foo',
      headers: { author: {} },
      result: false,
      index: 0 },
    { name: 'no match against populated author',
      phrase: 'foo',
      headers: { author: { name: 'bar', address: 'barbar' } },
      result: false,
      index: 0 },
    { name: 'match address exactly',
      phrase: 'foo',
      headers: { author: { name: 'bar', address: 'foo' } },
      result: true,
      index: 0 },
    { name: 'match start of address',
      phrase: 'foo',
      headers: { author: { name: 'bar', address: 'foo bar' } },
      result: true,
      index: 0 },
    { name: 'match middle of address with whitespace',
      phrase: 'foo',
      headers: { author: { name: 'bar', address: 'bar foo bar' } },
      result: true,
      index: 4 },
    { name: 'match middle of address without whitespace',
      phrase: 'foo',
      headers: { author: { name: 'bar', address: 'barfoobar' } },
      result: true,
      index: 3 },
    { name: 'match end of address',
      phrase: 'foo',
      headers: { author: { name: 'bar', address: 'bar foo' } },
      result: true,
      index: 4 },
    { name: 'match name exactly',
      phrase: 'foo',
      headers: { author: { name: 'foo', address: null } },
      result: true,
      index: 0 },
    { name: 'match middle of name',
      phrase: 'foo',
      headers: { author: { name: 'afooa', address: null } },
      result: true,
      index: 1 },
    { name: 'match ignoring case',
      phrase: /foo/i,
      headers: { author: { name: null, address: 'F FOOBAR R' } },
      result: true,
      index: 2,
      length: 3 },
    {
      name: 'match variable-length regexp',
      phrase: /fo+/i,
      headers: { author: { name: 'afOoOoa', address: null } },
      result: true,
      index: 1,
      length: 5
    }
  ];

  samples.forEach(function(sample) {
    T.action(sample.name, eLazy, function() {
      eLazy.expect('matches?',  sample.result);
      if (sample.result) {
        eLazy.expect('offset',  sample.index);
        eLazy.expect('length', sample.length || sample.phrase.length);
      }

      var author = new $filters.AuthorFilter(sample.phrase);
      var match = {};
      var ret = author.testMessage(sample.headers, '', match);
      eLazy.log('matches?', !!ret, match);
      if (!ret)
        return;
      eLazy.log('offset', match.author.matchRuns[0].start);
      eLazy.log('length', match.author.matchRuns[0].length);
    });
  });
});

commonCase('recipient filter', function(T) {
  var eLazy = T.lazyLogger('filter');

  var samples = [
    { name: 'no match against empty to',
      phrase: 'foo',
      header: { to: [ {} ] },
      result: false,
      index: 0 },
    { name: 'no match against populated to',
      phrase: 'foo',
      header: { to: [ {}, {}, { name: 'bar', address: 'barbar' } ] },
      result: false,
      index: 0 },
    { name: 'match middle of address',
      phrase: 'foo',
      header: { to: [ {}, {}, { name: 'bar', address: 'bar foobar' } ] },
      result: true,
      index: 4 },
    { name: 'match name ignoring case',
      phrase: /foobar/i,
      header: { to: [ {}, {}, {name: 'FOOBaR'} ] },
      result: true,
      index: 0,
      length: 6 },
    { name: 'match address ignoring case',
      phrase: /foobar/i,
      header: { bcc: [ {}, {}, {address: 'FOOBaR'} ] },
      result: true,
      index: 0,
      length: 6 }
  ];

  samples.forEach(function(sample) {
    T.action(sample.name, eLazy, function() {
      eLazy.expect('matches?',  sample.result);
      if (sample.result) {
        eLazy.expect('count',  1);
        eLazy.expect('offset',  sample.index);
        eLazy.expect('length', sample.length || sample.phrase.length);
      }

      var recipient = new $filters.RecipientFilter(
        sample.phrase, 1, true, true, true);
      var match = {};
      var ret = recipient.testMessage(sample.header, {}, match);
      eLazy.log('matches?', ret, match);
      if (!ret)
        return;
      eLazy.log('count', match.recipients.length, 1);
      eLazy.log('offset', match.recipients[0].matchRuns[0].start);
      eLazy.log('length', match.recipients[0].matchRuns[0].length);
    });
  });
});

commonCase('subject filter', function(T) {
  var eLazy = T.lazyLogger('filter');

  var CONTEXT_BEFORE = 4, CONTEXT_AFTER = 4;

  var samples = [
    {
      name: 'match multiple times',
      phrase: 'bob',
      header: { subject: 'bobobob' },
      result: true,
      matches: [
        {
          text: 'bobobob',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 }
          ],
          path: null
        },
        {
          text: 'bobobob',
          offset: 0,
          matchRuns: [
            { start: 4, length: 3 }
          ],
          path: null
        }
      ]
    },
    {
      name: 'match multiple times ignoring case',
      phrase: /bob/i,
      header: { subject: 'bObObOb' },
      result: true,
      matches: [
        {
          text: 'bObObOb',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 }
          ],
          path: null
        },
        {
          text: 'bObObOb',
          offset: 0,
          matchRuns: [
            { start: 4, length: 3 }
          ],
          path: null
        }
      ]
    },
    {
      name: 'fail to match',
      phrase: /bob/i,
      header: { subject: 'foobar' },
      result: false,
      matches: []
    },
    {
      name: 'do not die on null subject',
      phrase: /bob/i,
      header: { subject: null },
      result: false,
      matches: []
    },
    {
      name: 'context word-break white-space/terminus',
      phrase: 'bob',
      header: { subject: 'ab cd bob dc ba bob xy' },
      result: true,
      matches: [
        {
          text: 'cd bob dc',
          offset: 3,
          matchRuns: [
            { start: 3, length: 3 }
          ],
          path: null
        },
        {
          text: 'ba bob xy',
          offset: 13,
          matchRuns: [
            { start: 3, length: 3 }
          ],
          path: null
        }
      ]
    },
    {
      name: 'context fragments on too-long',
      phrase: 'bob',
      header: { subject: 'longgg bob longgggg bob' },
      result: true,
      matches: [
        {
          text: 'ggg bob lon',
          offset: 3,
          matchRuns: [
            { start: 4, length: 3 }
          ],
          path: null
        },
        {
          text: 'ggg bob',
          offset: 16,
          matchRuns: [
            { start: 4, length: 3 }
          ],
          path: null
        }
      ]
    },
    {
      name: 'context word-break just-right',
      phrase: 'bob',
      header: { subject: 'yay bob hey bob' },
      result: true,
      matches: [
        {
          text: 'yay bob hey',
          offset: 0,
          matchRuns: [
            { start: 4, length: 3 }
          ],
          path: null
        },
        {
          text: 'hey bob',
          offset: 8,
          matchRuns: [
            { start: 4, length: 3 }
          ],
          path: null
        }
      ]
    },
  ];

  samples.forEach(function(sample) {
    T.action(sample.name, eLazy, function() {
      eLazy.expect('matches?',  sample.result);
      if (sample.result) {
        for (var i = 0; i < sample.matches.length; i++) {
          eLazy.expect('match[' + i + ']',  sample.matches[i]);
        }
      }

      var subject = new $filters.SubjectFilter(sample.phrase, 20,
                                               CONTEXT_BEFORE, CONTEXT_AFTER);
      var match = {};
      var ret = subject.testMessage(sample.header, {}, match);
      eLazy.log('matches?', !!ret, match);
      if (!ret)
        return;
      for (i = 0; i < match.subject.length; i++) {
        eLazy.log('match[' + i + ']', match.subject[i]);
      }
    });
  });
});

/**
 * Find matches in quotechew'ed text/plain body.  We're assuming the subject
 * tests took care of testing the edge cases in snippetMatchHelper.
 */
commonCase('body plain', function(T) {
  var eLazy = T.lazyLogger('filter');

  var CONTEXT_BEFORE = 4, CONTEXT_AFTER = 4;

  var CONTENT = 0x1, Q1 = 0x4;

  var bodyQuoteOnePerChunk = {
    bodyReps: [
      {
        type: 'plain',
        content: [
          Q1, 'foo bar',
          CONTENT, 'foo baz'
        ]
      }
    ]
  };
  var bodyQuoteTwoPerChunk = {
    bodyReps: [
      {
        type: 'plain',
        content: [
          Q1, 'foo bar foo',
          CONTENT, 'foo bazo foo'
        ]
      }
    ]
  };


  var samples = [
    {
      name: 'ignore quotes foo x one',
      phrase: /foo/,
      matchQuotes: false,
      header: { },
      body: bodyQuoteOnePerChunk,
      result: true,
      matches: [
        {
          text: 'foo baz',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 }
          ],
          path: [0, 2]
        }
      ]
    },
    {
      name: 'match quotes foo x one',
      phrase: /foo/,
      matchQuotes: true,
      header: { },
      body: bodyQuoteOnePerChunk,
      result: true,
      matches: [
        {
          text: 'foo bar',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 }
          ],
          path: [0, 0]
        },
        {
          text: 'foo baz',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 }
          ],
          path: [0, 2]
        }
      ]
    },
    {
      name: 'ignore quotes foo x two',
      phrase: /foo/,
      matchQuotes: false,
      header: { },
      body: bodyQuoteTwoPerChunk,
      result: true,
      matches: [
        {
          text: 'foo baz',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 }
          ],
          path: [0, 2]
        },
        {
          text: 'azo foo',
          offset: 5,
          matchRuns: [
            { start: 4, length: 3 }
          ],
          path: [0, 2]
        }
      ]
    },
    {
      name: 'match quotes foo x one',
      phrase: /foo/,
      matchQuotes: true,
      header: { },
      body: bodyQuoteTwoPerChunk,
      result: true,
      matches: [
        {
          text: 'foo bar',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 }
          ],
          path: [0, 0]
        },
        {
          text: 'bar foo',
          offset: 4,
          matchRuns: [
            { start: 4, length: 3 }
          ],
          path: [0, 0]
        },
        {
          text: 'foo baz',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 },
          ],
          path: [0, 2]
        },
        {
          text: 'azo foo',
          offset: 5,
          matchRuns: [
            { start: 4, length: 3 }
          ],
          path: [0, 2]
        }
      ]
    },
  ];

  samples.forEach(function(sample) {
    T.action(sample.name, eLazy, function() {
      eLazy.expect('matches?',  sample.result);
      if (sample.result) {
        // the advantage to breaking these out is that the diff algorithm in the
        // ArbPL/loggest UI can do useful things; but this is a little silly.
        for (var i = 0; i < sample.matches.length; i++) {
          eLazy.expect('body[].text', sample.matches[i].text);
          eLazy.expect('body[].offset', sample.matches[i].offset);
          eLazy.expect('body[].matchRuns', sample.matches[i].matchRuns);
          eLazy.expect('body[].path', sample.matches[i].path);
        }
      }

      var bodyFilter = new $filters.BodyFilter(
        sample.phrase, sample.matchQuotes, 20, CONTEXT_BEFORE, CONTEXT_AFTER);
      var match = {};
      var ret = bodyFilter.testMessage(sample.header, sample.body, match);
      eLazy.log('matches?', !!ret, match);
      if (!ret) {
        return;
      }
      for (i = 0; i < match.body.length; i++) {
        eLazy.log('body[].text', match.body[i].text);
        eLazy.log('body[].offset', match.body[i].offset);
        eLazy.log('body[].matchRuns', match.body[i].matchRuns);
        eLazy.log('body[].path', match.body[i].path);
      }
    });
  });
});

commonCase('body html', function(T) {
  var eLazy = T.lazyLogger('filter');

  var CONTEXT_BEFORE = 4, CONTEXT_AFTER = 12;

  var CONTENT = 0x1, Q1 = 0x4;

  var cleverBody = {
    bodyReps: [
      {
        type: 'html',
        content: 'foo<blockquote>bar</blockquote>d<b>ytown</b>'
      }
    ]
  };


  var samples = [
    {
      name: 'no quotes, naive substring with flattened context',
      phrase: /foo/,
      matchQuotes: false,
      header: { },
      body: cleverBody,
      result: true,
      matches: [
        {
          text: 'foodytown',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 }
          ],
          path: null
        }
      ]
    },
    {
      name: 'no quotes, full substring',
      phrase: /foodytown/,
      matchQuotes: false,
      header: { },
      body: cleverBody,
      result: true,
      matches: [
        {
          text: 'foodytown',
          offset: 0,
          matchRuns: [
            { start: 0, length: 9 }
          ],
          path: null
        }
      ]
    },
    {
      name: 'yes quotes, naive substring with flattened context',
      phrase: /foo/,
      matchQuotes: true,
      header: { },
      body: cleverBody,
      result: true,
      matches: [
        {
          text: 'foobardytown',
          offset: 0,
          matchRuns: [
            { start: 0, length: 3 }
          ],
          path: null
        }
      ]
    },
    {
      name: 'yes quotes, full substring',
      phrase: /foobardytown/,
      matchQuotes: true,
      header: { },
      body: cleverBody,
      result: true,
      matches: [
        {
          text: 'foobardytown',
          offset: 0,
          matchRuns: [
            { start: 0, length: 12 }
          ],
          path: null
        }
      ]
    },
  ];

  samples.forEach(function(sample) {
    T.action(sample.name, eLazy, function() {
      eLazy.expect('matches?',  sample.result);
      if (sample.result) {
        // the advantage to breaking these out is that the diff algorithm in the
        // ArbPL/loggest UI can do useful things; but this is a little silly.
        for (var i = 0; i < sample.matches.length; i++) {
          eLazy.expect('body[].text', sample.matches[i].text);
          eLazy.expect('body[].offset', sample.matches[i].offset);
          eLazy.expect('body[].matchRuns', sample.matches[i].matchRuns);
          eLazy.expect('body[].path', sample.matches[i].path);
        }
      }

      var bodyFilter = new $filters.BodyFilter(
        sample.phrase, sample.matchQuotes, 20, CONTEXT_BEFORE, CONTEXT_AFTER);
      var match = {};
      var ret = bodyFilter.testMessage(sample.header, sample.body, match);
      eLazy.log('matches?', !!ret, match);
      if (!ret) {
        return;
      }
      for (i = 0; i < match.body.length; i++) {
        eLazy.log('body[].text', match.body[i].text);
        eLazy.log('body[].offset', match.body[i].offset);
        eLazy.log('body[].matchRuns', match.body[i].matchRuns);
        eLazy.log('body[].path', match.body[i].path);
      }
    });
  });
});

return allTests;

}); // end define
