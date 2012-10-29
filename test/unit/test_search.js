/**
 * Test the search filters.
 **/

var $filters = require('mailapi/searchfilter');

function run_test_author() {
  var results = [
    { phrase: 'foo',
      headers: { author: {} },
      result: false,
      index: 0 },
    { phrase: 'foo',
      headers: { author: { name: 'bar', address: 'barbar' } },
      result: false,
      index: 0 },
    { phrase: 'foo',
      headers: { author: { name: 'bar', address: 'bar foo bar' } },
      result: true,
      index: 4 },
    { phrase: 'foo',
      headers: { author: { name: 'foo', address: null } },
      result: true,
      index: 0 },
    { phrase: 'foo',
      headers: { author: { name: 'afooa', address: null } },
      result: true,
      index: 1 },
    { phrase: 'foo',
      headers: { author: { name: null, address: 'foo' } },
      result: true,
      index: 0 },
    { phrase: /foo/i,
      headers: { author: { name: null, address: 'F FOOBAR R' } },
      result: true,
      index: 2 }
  ];

  for (let i = 0; i < results.length; ++i) {
    var author = new $filters.AuthorFilter(results[i].phrase);
    var match = {};
    var ret = author.testMessage(results[i].headers, '', match);
    do_check_eq(ret, results[i].result);

    if (!ret) {
      continue;
    }

    do_check_eq(match.author.matchRuns[0].start, results[i].index);
  }
}

function run_test_recipient() {
  var results = [
    { phrase: 'foo',
      body: { to: [ {} ] },
      result: false,
      index: 0 },
    { phrase: 'foo',
      body: { to: [ {}, {}, { name: 'bar', address: 'barbar' } ] },
      result: false,
      index: 0 },
    { phrase: 'foo',
      body: { to: [ {}, {}, { name: 'bar', address: 'bar foobar' } ] },
      result: true,
      index: 4 },
    { phrase: /foobar/i,
      body: { to: [ {}, {}, {name: 'FOOBaR'} ] },
      result: true,
      index: 0 },
    { phrase: /foobar/i,
      body: { bcc: [ {}, {}, {address: 'FOOBaR'} ] },
      result: true,
      index: 0 }
  ];

  for (let i = 0; i < results.length; ++i) {
    var recipient = new $filters.RecipientFilter(results[i].phrase, 1, true, true, true);
    var match = {};
    var ret = recipient.testMessage({}, results[i].body, match);
    do_check_eq(ret, results[i].result);

    if (!ret) {
      continue;
    }

    do_check_eq(match.recipients.length, 1);
    do_check_eq(match.recipients[0].matchRuns[0].start, results[i].index);
  }
}

function run_test_subject() {
  var results = [
    { phrase: 'bob',
      header: { subject: 'bobobob' },
      result: true,
      matches: 2 },
    { phrase: /bob/i,
      header: { subject: 'bObObOb' },
      result: true,
      matches: 2 },
    { phrase: /bob/i,
      header: { subject: 'foobar' },
      result: false,
      matches: 0 }
  ];

  for (let i = 0; i < results.length; ++i) {
    var subject = new $filters.SubjectFilter(results[i].phrase, 20, 0, 10000);
    var match = {};
    var ret = subject.testMessage(results[i].header, {}, match);
    do_check_eq(ret, results[i].result);

    if (!ret) {
      continue;
    }

    do_check_eq(match.subject.length, results[i].matches);
  }
}

function run_test_body() {
  // XXX This part must be completed
}

function run_test() {
  run_test_author();
  run_test_recipient();
  run_test_subject();
  run_test_body();
}
