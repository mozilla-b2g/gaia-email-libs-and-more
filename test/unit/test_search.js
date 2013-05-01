/**
 * Test the search filters.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        'mailapi/searchfilter', 'exports'],
       function($tc, $th_imap, $filters, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_search' }, null, [$th_imap.TESTHELPER], ['app']);

TD.commonCase('author filter', function(T) {
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
      eLazy.expect_namedValueD('matches?', sample.result);
      if (sample.result) {
        eLazy.expect_namedValue('offset', sample.index);
        eLazy.expect_namedValue('length',
                                sample.length || sample.phrase.length);
      }

      var author = new $filters.AuthorFilter(sample.phrase);
      var match = {};
      var ret = author.testMessage(sample.headers, '', match);
      eLazy.namedValueD('matches?', !!ret, ret);
      if (!ret)
        return;
      eLazy.namedValue('offset', match.author.matchRuns[0].start);
      eLazy.namedValue('length', match.author.matchRuns[0].length);
    });
  });
});

TD.commonCase('recipient filter', function(T) {
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
      eLazy.expect_namedValueD('matches?', sample.result);
      if (sample.result) {
        eLazy.expect_namedValue('count', 1);
        eLazy.expect_namedValue('offset', sample.index);
        eLazy.expect_namedValue('length',
                                sample.length || sample.phrase.length);
      }

      var recipient = new $filters.RecipientFilter(
        sample.phrase, 1, true, true, true);
      var match = {};
      var ret = recipient.testMessage(sample.header, {}, match);
      eLazy.namedValueD('matches?', ret, match);
      if (!ret)
        return;
      eLazy.namedValue('count', match.recipients.length, 1);
      eLazy.namedValue('offset', match.recipients[0].matchRuns[0].start);
      eLazy.namedValue('length', match.recipients[0].matchRuns[0].length);
    });
  });
});

TD.commonCase('subject filter', function(T) {
  var eLazy = T.lazyLogger('filter');

  var samples = [
    {
      name: 'match multiple times',
      phrase: 'bob',
      header: { subject: 'bobobob' },
      result: true,
      matches: [
        { start: 0, length: 3 },
        { start: 4, length: 3 }
      ]
    },
    {
      name: 'match multiple times ignoring case',
      phrase: /bob/i,
      header: { subject: 'bObObOb' },
      result: true,
      matches: [
        { start: 0, length: 3 },
        { start: 4, length: 3 }
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
    }
  ];

  samples.forEach(function(sample) {
    T.action(sample.name, eLazy, function() {
      eLazy.expect_namedValueD('matches?', sample.result);
      if (sample.result) {
        for (var i = 0; i < sample.matches.length; i++) {
          eLazy.expect_namedValue('matchRun', [sample.matches[i]]);
        }
      }

      var subject = new $filters.SubjectFilter(sample.phrase, 20, 0, 10000);
      var match = {};
      var ret = subject.testMessage(sample.header, {}, match);
      eLazy.namedValueD('matches?', !!ret, match);
      if (!ret)
        return;
      for (i = 0; i < match.subject.length; i++) {
        eLazy.namedValue('matchRun', match.subject[i].matchRuns);
      }
    });
  });
});


// XXX write a body test

}); // end define
