
/**
 * This class is the entry point for logic-inspector. Based upon the JSON test
 * results we stored (passed through loggest-chrome-runner.js in GELAM) in the
 * static HTML file in which we're running, we either show the index view (a
 * list of all test runs) or a test-run-specific page showing all the logs from
 * one test suite.
 */

import { SuiteResults } from "./test-suite-results";
import { TestRunList } from "./index";

class LogicInspector extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      indexData: [],
      href: null,
      autoReload: true,
      data: null
    };
  }

  onClick(event) {
    var target = event.target;
    do {
      if (target.href) {
        if (target.href[0] === '?') {
          event.preventDefault();
          this.navigate(target.href);
        }
        return;
      }
    } while ((target = target.parentNode));
  }

  componentWillMount() {
    var updateIndex = () => {
      this.fetch('test-logs/index.json').then((indexData) => {
        this.setState({ indexData: indexData });

        // If we're viewing test suite results, maybe reload it.
        if (this.state.href && this.state.data && this.state.autoReload) {
          var latestHref = null;
          indexData.some((testRunSummary) => {
            return testRunSummary.suites.some((result) => {
              if (result.filename === this.state.data.filename &&
                  result.variant === this.state.data.variant) {
                latestHref = result.href;
                return true; // break out!
              }
            });
          });
          if (latestHref !== this.state.href) {
            console.log('Loading new results:', latestHref);
            this.navigate('?href=' + latestHref, /* isRefresh: */ true);
          }
        }
      });
    };

    setInterval(updateIndex, 1000);
    updateIndex();

    window.onpopstate = () => {
      this.navigate(document.location.href);
    };

    this.navigate(document.location.href, /* isRefresh: */ true);
  }

  navigate(url, isReload) {
    var href = LogicInspector.getUrlParam('href', url);
    var autoReload = !LogicInspector.getUrlParam('noreload', url);
    this.setState({
      href: href,
      autoReload: autoReload
    });

    var normalizedUrl = '?' +
                        (href ? 'href=' + href : '') +
                        (autoReload ? '' : '&noreload=true');
    if (isReload) {
      history.replaceState(null, '', normalizedUrl);
    } else {
      history.pushState(null, '', normalizedUrl);
    }

    if (href) {
      this.fetch(href).then((data) => {
        this.setState({ data: data });
      });
    }
  }

  // From http://stackoverflow.com/questions/8460265
  static getUrlParam(name, href) {
    href = href || window.location.href;
    name = new RegExp('[?&]' + name.replace(/([[\]])/, '\\$1') + '=([^&#]*)');
    return (href.match(name) || ['', ''])[1];
  }

  fetch(url) {
    return new Promise(function(resolve, reject) {
      var req = new XMLHttpRequest();
      console.log('want to load', url);
      req.open('GET', url, true);
      req.responseType = 'json';
      req.addEventListener('load', function() {
        if (req.status == 200 || req.status == 0)
          resolve(req.response);
        else
          reject(req.status);
      }, false);
      req.addEventListener('timeout', function() {
        reject('timeout');
      });
      req.timeout = 30 * 1000;
      req.send(null);
    });
  }

  render() {
    if (this.state.href) {
      var data = this.state.data;
      if (!data) {
        return null; // wait for it to load
      }
      var variant = data.tests[0] && data.tests[0].variant;
      var result = data.tests.every((t) => t.result === 'pass') ? 'pass' : 'fail';
      return (
        <div onClick={this.onClick.bind(this)}>
          <div className={['autoreload-info',
                          this.state.autoReload ? 'reload' : 'noreload'].join(' ')}></div>

          <a className="index-link" href="?">
          &larr; All Test Results</a>
          <SuiteResults filename={data.filename}
                        variant={variant}
                        result={result}
                        tests={data.tests}/>
        </div>
      );
    } else {
      var items = this.state.indexData;
      return (
        <div onClick={this.onClick.bind(this)}>
          <div className="index-header">
            <strong>Recent GELAM Test Runs</strong> <em>(Automatically reloads.)</em>
          </div>
          <TestRunList items={items} />
        </div>
      );
    }
  }

}

React.render(<LogicInspector />, document.body);
