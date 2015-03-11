var EL = (tag) => document.createElement(tag);


var getEventColor = function(ns, type, details) {
  // See if anything stands out:

  if (/error/i.test(type)) {
    return '#c00'; // red
  }

  if (type === 'expect') {
    return 'rgba(0, 75, 20, 0.7)'; // greenish
  } else if (type === 'match') {
    return 'rgb(0, 175, 40)'; // greenish
  } else if (type === 'failed-expectation') {
    return 'rgb(200, 0, 0)'; // red
  }

  // Otherwise, colorize based upon namespace:

  if (ns === 'Console') {
    return 'black';
  } else if (/Bridge/.test(ns)) {
    return '#bbb';
  } else if (/Universe/.test(ns)) {
    return '#877';
  } else if (/Account/.test(ns)) {
    return '#008';
  } else if (/Sync/.test(ns)) {
    return '#383';
  }
  var hash = 0;
  for (var i = 0; i < ns.length; i++) {
    hash = ((hash << 5) - hash) + ns.charCodeAt(i) | 0;
  }
  var hue = ((hash & 0x0000FF) / 256) * 360 | 0;
  return 'hsl(' + hue + ', 80%, 40%)';
}

class LogicViewer {

  constructor(rootElement) {
    this.rootElement = rootElement;
    if (window.results.filename) {
      this.renderSuiteResults(window.results);
    } else {
      this.renderIndex(window.results);
    }
  }

  renderIndex(items) {
    React.render(
      <div>
        <div className="index-header">
        <strong>Recent GELAM Test Runs</strong> <em>(Automatically reloads.)</em>
        </div>
        <TestRunList items={items} />
      </div>,
      this.rootElement);
  }

  renderSuiteResults(data) {
    var variant = data.tests[0] && data.tests[0].variant;
    var result = data.tests.every((t) => t.result === 'pass') ? 'pass' : 'fail';

    React.render(
        <div>
        <a className="index-link" href="index.html">
        &larr; All Test Results</a>
        <SuiteResults filename={data.filename}
                      variant={variant}
                      result={result}
                      tests={data.tests}/>
        </div>, this.rootElement);
  }

}

/**
 * .TestRunList
 *   .TestRun
 */

var TestRunList = React.createClass({
  render() {
    var results = this.props.items;
    return (
      <div className="TestRunList">
        {results.map(function(testRun, index) {
            return <TestRunSummary testRun={testRun} key={index}/>;
        })}
      </div>
    );
  }
});

var TestRunSummary = React.createClass({
  render() {
    var suites = this.props.testRun;
    var timestamp = new Date(suites[0] && suites[0].timestamp);
    return (
        <div className="TestRunSummary">
        <div className="timestamp">{timestamp.toLocaleString()}</div>
        {suites.map(function(suite, index) {
          return <SuiteSummary suite={suite} key={index}/>;
        })}
      </div>
    );
  }
});

var SuiteSummary = React.createClass({
  render() {
    var { href, filename, tests } = this.props.suite;
    var variant = tests[0] && tests[0].variant;
    return (
      <a href={href} className="SuiteSummary">
          {tests.map((test, index) => {
            return <TestSummary
                     filename={filename}
                     test={test} key={index} />
          })}
      </a>
    );
  }
});

var TestSummary = React.createClass({
  render() {
    var filename = this.props.filename;
    var {name, variant, result} = this.props.test;
    var shortVariant = {
      'imap:fake': 'imap',
      'pop3:fake': 'pop3',
      'activesync:fake': 'async'
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
});



//////////////////////////////////////////////

function safeCss(str) {
  return str.replace(/[^a-z0-9-_]/ig, '');
}


var SuiteResults = React.createClass({
  render() {
    var { filename, variant, result, tests } = this.props;
    return (
      <div className={['SuiteResults',
                       result,
                       variant.replace(':', '-')].join(' ')}>
        <h1 className="header">
          <span className="result">{result}</span>
          <span className="variant">{variant}</span>
          <span className="filename">{filename}</span>
        </h1>
        {tests.map((test, index) => {
          return <TestResults test={test} key={index} />
        })}
      </div>
    );
  }
});




var TestResults = React.createClass({
  getInitialState() {
    return { collapsed: this.props.test.result === 'pass' };
  },

  toggleCollapsed: function() {
    this.setState({ collapsed: !this.state.collapsed });
  },

  render() {
    var {result, name, events} = this.props.test;
    return (
      <div className={['TestResults',
                       result,
                       this.state.collapsed ?
                       'collapsed' : ''].join(' ')}>
        <h2 className="header" onClick={this.toggleCollapsed}>
          <div className="arrow">▼</div>
          <span className="name">{name}</span>
        </h2>
        <div className="body">
          <EventList events={events} />
        </div>
      </div>
    );
  }
});

var EventList = React.createClass({
  render() {
    let eventsByNamespace = this.props.events.reduce((map, evt) => {
      if (!map[evt.namespace]) {
        map[evt.namespace] = [];
      }
      map[evt.namespace].push(evt);
      return map;
    }, {});

    var namespaces = Object.keys(eventsByNamespace);
    var events = this.props.events.slice();

    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      if (event.namespace === 'LegacyGelamTest' && event.type === 'step-begin') {
        event.children = [];
        var nextEvent;
        while ((nextEvent = events[i + 1])) {
          if (nextEvent.namespace === 'LegacyGelamTest' &&
              nextEvent.type === 'step-end') {
            event.details.error = nextEvent.details.error;
            break;
          } else {
            event.children.push(events.splice(i + 1, 1)[0]);
          }
        }
      }
    }

    var idToElement = {};
    var idToEvent = {};
    for (var i = 0; i < events.length; i++) {
      idToEvent[events[i].$id] = events[i];
    }

    return (
        <div className="EventList">
        {events.map(function(event, index) {
          return <Event event={event} key={index}/>;
        })}
      </div>
    );
  }
});

var Event = React.createClass({
  getInitialState() {
    var collapsed = true;
    if (this.props.event.namespace === 'LegacyGelamTest' &&
        this.props.event.type === 'step-begin' &&
        this.props.event.details &&
        this.props.event.details.error) {
      collapsed = false;
    }
    return { collapsed: collapsed };
  },

  toggleCollapsed() {
    this.setState({ collapsed: !this.state.collapsed });
  },

  computeDetails() {
    var details = this.props.event.details;
    if (!details) {
      return '';
    } else if (details.msg && typeof details.msg === 'string') {
      return details.msg;
    } else {
      return JSON.stringify(details).slice(0, 1000);
    }
  },

  render() {
    var event = this.props.event;
    var children = event.children || [];
    var classes = ['Event'];

    if (this.state.collapsed) {
      classes.push('collapsed');
    }

    for (var key in event) {
      var value = event[key];
      if (typeof value === 'string' && value.length < 30) {
        classes.push( safeCss(key) + '-' + safeCss(event[key]));
      }
    }

    var styles = {
      color: getEventColor(event.namespace, event.type, event.details)
    };

    switch(event.namespace + '/' + event.type) {
    case 'LegacyGelamTest/step-end':
      return null;
    case 'LegacyGelamTest/step-begin':
      if (!children.length) {
        return null; // No need to render empty steps.
      }
      classes.push('Step');

      var stepName =
        event.details.name
            .replace(/\[([^\]\s]+)([^\]]*)\]/g, (match, ns, subname) => {
              return '<span style="color:' + getEventColor(ns) +
                '">[<strong>' + ns + '</strong> ' + subname + ']</span>';
            });

      if (event.details.error) {
        classes.push('error');
      };
      return (
          <div className={classes.join(' ')}>
          <div className="header" onClick={this.toggleCollapsed}
        dangerouslySetInnerHTML={ {__html:stepName} }>
          </div>
               <div className="body">
               {children.map((childEvent, key) => {
                 return <Event event={childEvent} key={key}/>;
               })}
              <div className="error-display">{event.details.error}</div>
            </div>
          </div>
      );
    default:
      return (
          <div style={styles} className={classes.join(' ')}>
          <span className="event-time">{event.time.toFixed(0)}ms</span>
          <span className="event-namespace">{event.namespace}</span>
          <span className="event-type">{event.type}</span>
          <span className="event-details">{this.computeDetails()}</span>
          </div>
      );
    }
  }
});

var viewer = new LogicViewer(document.body);
