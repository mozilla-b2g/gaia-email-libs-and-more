/**
 * These classes control the display of the "test run index",
 * i.e. "index.html".
 */
export class TestRunList extends React.Component {
  render() {
    var results = this.props.items;
    return (
      <div className="TestRunList">
        {results.map(function(testRun, index) {
            return <TestRunSummary testRun={testRun} index={index} key={index}/>;
        })}
      </div>
    );
  }
}

class TestRunSummary extends React.Component {
  render() {
    var result = this.props.testRun.result === 'success' ? 'pass' : 'fail';
    var suites = this.props.testRun.suites.slice();
    var failed = suites.filter((suite) => suite.result === 'fail');
    var passed = suites.filter((suite) => suite.result !== 'fail');
    suites = failed.concat(passed);
    var timestamp = new Date(suites[0] && suites[0].timestamp);
    // Only the topmost (most recent test run) link reloads automatically by
    // default. It's kinda gross, but I haven't come up with anything better.
    var noreload = this.props.index > 0;
    return (
        <div className={['TestRunSummary', result].join(' ')}>
        <div className="timestamp">{timestamp.toLocaleString()}</div>
        {suites.map(function(suite, index) {
          return <SuiteSummary noreload={noreload} suite={suite}  key={index}/>;
        })}
      </div>
    );
  }
}

class SuiteSummary extends React.Component {
  render() {
    var { href, filename, tests, result } = this.props.suite;
    var variant = tests[0] && tests[0].variant;
    return (
      <a href={'?href=' + href + (this.props.noreload ? '&noreload=1' : '')}
         className={['SuiteSummary', result].join(' ')}>
          {tests.map((test, index) => {
            return <TestSummary
                     filename={filename}
                     test={test} key={index} />
          })}
      </a>
    );
  }
}

class TestSummary extends React.Component {
  render() {
    var filename = this.props.filename;
    var {name, variant, result} = this.props.test;
    var shortVariant = {
      'imap:fake': 'imap',
      'pop3:fake': 'pop3',
      'activesync:fake': 'A.S.'
    }[variant] || variant;
    return (
        <div className={['TestSummary',
                         result,
                         variant.replace(':', '-')].join(' ')}>
          <span className="result">{ result }</span>
          <span className="variant">{ shortVariant }</span>
          <span className="filename">{ filename }</span>
          <span className="name">{ name }</span>
        </div>
    );
  }
}
