/**
 * These classes control the display of an individual test suite's results.
 */

export class SuiteResults extends React.Component {
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
}

class TestResults extends React.Component {
  constructor(props) {
    super(props);
    this.state = { collapsed: this.props.test.result === 'pass' };
  }

  toggleCollapsed() {
    this.setState({ collapsed: !this.state.collapsed });
  }

  render() {
    var {result, name, events} = this.props.test;
    return (
      <div className={['TestResults',
                       result,
                       this.state.collapsed ?
                       'collapsed' : ''].join(' ')}>
        <h2 className="header" onClick={this.toggleCollapsed.bind(this)}>
          <div className="arrow">▼</div>
          <span className="name">{name}</span>
        </h2>
        <div className="body">
          { !this.state.collapsed && <EventList events={events} /> }
        </div>
      </div>
    );
  }
}

class EventList extends React.Component {
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
    var isLegacy = (namespaces.indexOf('LegacyGelamTest') !== -1);

    var idToEvent = {};
    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      idToEvent[event.id] = event;
    }

    if (isLegacy) {
      events = groupEvents(
        events,
        (e) => e.namespace === 'LegacyGelamTest' && e.type === 'step-begin',
        (e) => e.namespace === 'LegacyGelamTest' && e.type === 'step-end');
    }

    events = groupEvents(
      events,
      (e) => e.namespace === 'GelamTest' && e.type === 'begin group',
      (e) => e.namespace === 'GelamTest' && e.type === 'group');

    return (
        <div className={['EventList', (isLegacy ? 'legacy' : 'non-legacy')].join(' ')}>
        {events.map(function(event, index) {
          return <Event event={event} key={index}/>;
        })}
      </div>
    );
  }
}

class Event extends React.Component {

  constructor(props) {
    super(props);
    var collapsed = true;
    if ((this.props.event.namespace === 'LegacyGelamTest' ||
         this.props.event.namespace === 'GelamTest') &&
        this.props.event.details &&
        this.props.event.details.error) {
      collapsed = false;
    }
    this.state = { collapsed: collapsed };
  }

  toggleCollapsed() {
    this.setState({ collapsed: !this.state.collapsed });
  }

  computeDetails() {
    var details = this.props.event.details;
    if (!details) {
      return '';
    } else if (details.string) {
      return details.string;
    } else if (typeof details === 'object') {
      return Object.keys(details).map((key, index) => {
        return (
            <span className="event-detail" key={index}>
              <span className="event-detail-key">{key}</span>
              <span className="event-detail-value">
                {typeof details[key] !== 'object' && (details[key]+'').length < 50 ?
                 details[key] :
                 <span className="complex"
                     title={JSON.stringify(details[key], null, ' ')}>
                   [...]
                 </span>}
              </span>
            </span>
        );
      });
    } else {
      return JSON.stringify(details).slice(0, 1000);
    }
  }

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
      color: getEventColor(event),
    };

    switch(event.namespace + '/' + event.type) {
    case 'LegacyGelamTest/step-end':
    case 'GelamTest/group':
      return null;
    case 'LegacyGelamTest/step-begin':
    case 'GelamTest/begin group':
      if (!children.length) {
        return null; // No need to render empty steps.
      }
      classes.push('Step');

      var stepName =
        event.details.name
            .replace(/\[([^\]\s]+)([^\]]*)\]/g, (match, ns, subname) => {
              return '<span style="color:' + getEventColor({ namespace: ns }) +
                '">[<strong>' + ns + '</strong> ' + subname + ']</span>';
            });

      if (event.details.error) {
        classes.push('error');
      };
      return (
          <div className={classes.join(' ')}>
          <div className="header" onClick={this.toggleCollapsed.bind(this)}
        dangerouslySetInnerHTML={ {__html:stepName} }>
          </div>
               <div className="body">
               {this.state.collapsed ? <div/> : children.map((childEvent, key) => {
                 return <Event event={childEvent} key={key}/>;
               })}
              <div className="error-display">{event.details.error}</div>
            </div>
          </div>
      );
    default:
      return (
          <div style={styles} className={classes.join(' ')}>
          <span className="event-time">{event.time.toFixed(0).toString().slice(-5)}</span>
          <span className="event-namespace">{event.namespace}</span>
          <span className="event-type">{event.type}</span>
          <span className="event-details">{this.computeDetails()}</span>
          </div>
      );
    }
  }
}

/**
 * Given a list of events, and functions which return true when reaching the
 * first and last elements of a group (respectively), recursively group all
 * events inside 'startEvent.children', splicing out the rest.
 *
 * Returns a fresh array.
 */
function groupEvents(events, startFn, endFn) {
  events = events.slice();
  for (var i = 0; i < events.length; i++) {
    var event = events[i];

    if (event.children && event.children.length) {
      event.children = groupEvents(event.children, startFn, endFn);
    }

    if (startFn(event)) {
      event.children = [];
      var nextEvent;
      while ((nextEvent = events[i + 1])) {
        if (endFn(nextEvent)) {
          event.details.error = nextEvent.details.error;
          break;
        } else {
          event.children.push(events.splice(i + 1, 1)[0]);
        }
      }
    }
  }
  return events;
}


/**
 * What color should we render a given log? We can also style things with CSS,
 * but for more complex heuristics, we must peek into the event.
 */
var getEventColor = function({ namespace, type, details }) {
  namespace = namespace || '';
  type = type || '';

  // All of these colors are somewhat random, not intentional -- change at will.

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

  if (namespace === 'Console') {
    return 'black';
  } else if (/Bridge/.test(namespace)) {
    return '#bbb';
  } else if (/Universe/.test(namespace)) {
    return '#877';
  } else if (/Account/.test(namespace)) {
    return '#008';
  } else if (/Sync/.test(namespace)) {
    return '#383';
  }
  var hash = 0;
  for (var i = 0; i < namespace.length; i++) {
    hash = ((hash << 5) - hash) + namespace.charCodeAt(i) | 0;
  }
  var hue = ((hash & 0x0000FF) / 256) * 360 | 0;
  return 'hsl(' + hue + ', 80%, 40%)';
};

function safeCss(str) {
  return str.replace(/[^a-z0-9-_]/ig, '');
}
