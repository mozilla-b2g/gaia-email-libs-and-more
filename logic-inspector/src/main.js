var EL = (tag) => document.createElement(tag);


var PLEASING_COLORS = [
//  'rgb(240,163,255)',
  'rgb(0,117,220)',
  'rgb(153,63,0)',
  'rgb(76,0,92)',
  'rgb(25,25,25)',
  'rgb(0,92,49)',
  'rgb(43,206,72)',
  'rgb(255,204,153)',
  'rgb(128,128,128)',
  'rgb(148,255,181)',
  'rgb(143,124,0)',
  'rgb(157,204,0)',
  'rgb(194,0,136)',
  'rgb(0,51,128)',
  'rgb(255,164,5)',
  'rgb(255,168,187)',
  'rgb(66,102,0)',
  'rgb(255,0,16)',
  'rgb(94,241,242)',
  'rgb(0,153,143)',
  'rgb(224,255,102)',
  'rgb(116,10,255)',
  'rgb(153,0,0)',
  'rgb(255,255,128)',
  'rgb(255,255,0)',
  'rgb(255,80,5)'
];

let colors = function(i) {
  return PLEASING_COLORS[i] || 'black';
}


class LogicViewer {

  constructor(rootElement) {
    this.rootElement = rootElement;
    if (window.results.filename) {
      this.renderFileResults(window.results);
    } else {
      this.renderIndex(window.results);
    }
  }

  renderIndex(results) {
    React.render(<IndexList results={results} />, this.rootElement);
  }

  renderFileResults(data) {
    React.render(
        <div>
          <a href="index.html">[Index]</a>
          <FileResults filename={data.filename} tests={data.tests}/>
        </div>, this.rootElement);

    // jsPlumb.setContainer(this.rootElement);
    // jsPlumb.importDefaults({
    //   PaintStyle : { lineWidth: 2, strokeStyle : "#666" },
    //   Connector: ['Flowchart', { stub: 3, cornerRadius: 3 }],
    //   Anchors:['Bottom', 'Top'],
    //   Endpoint: 'Blank'
    // });

    // var container = E('div');
    // this.rootElement.appendChild(container);


    // events.forEach((event) => {
    //   var el = cell.appendChild(EL('div'));
    //   el.className = 'event';
    //   idToElement[event.$id] = el;
    //   el.textContent = event.$type;
    // });
    //   var cell;
    //   var el;
    //   var row = tbody.appendChild(EL('tr'));
    //   row.appendChild(EL('td')).textContent = event.$time.toFixed(2) + 'ms';
    //   for (var j = 0; j < namespaces.length; j++) {
    //     cell = row.appendChild(EL('td'));
    //     if (namespaces[j] === event.ns + '') {

    //       el.textContent = event.$type;
    //       // delete event.time;
    //       // delete event.id;
    //       // var dl = el.appendChild(EL('dl'));
    //       // for (var k in event) {
    //       //   var dt = dl.appendChild(EL('dt'));
    //       //   var dd = dl.appendChild(EL('dd'));
    //       //   dt.classList.add('kv-' + k);
    //       //   dd.classList.add('kv-' + k);
    //       //   dt.textContent = k;
    //       //   dd.textContent = JSON.stringify(event[k]);
    //       //   dl.appendChild(dt);
    //       //   dl.appendChild(dd);
    //       // }
    //       break;
    //     }
    //   }

    // for (var i = 0; i < events.length; i++) {
    //   var event = events[i];
    //   var cell;
    //   var el;
    //   idToEvent[event.$id] = event;
    //   var row = tbody.appendChild(EL('tr'));
    //   row.appendChild(EL('td')).textContent = event.$time.toFixed(2) + 'ms';
    //   for (var j = 0; j < namespaces.length; j++) {
    //     cell = row.appendChild(EL('td'));
    //     if (namespaces[j] === event.ns + '') {
    //       el = cell.appendChild(EL('div'));
    //       el.className = 'event';
    //       idToElement[event.$id] = el;

    //       el.textContent = event.$type;
    //       // delete event.time;
    //       // delete event.id;
    //       // var dl = el.appendChild(EL('dl'));
    //       // for (var k in event) {
    //       //   var dt = dl.appendChild(EL('dt'));
    //       //   var dd = dl.appendChild(EL('dd'));
    //       //   dt.classList.add('kv-' + k);
    //       //   dd.classList.add('kv-' + k);
    //       //   dt.textContent = k;
    //       //   dd.textContent = JSON.stringify(event[k]);
    //       //   dl.appendChild(dt);
    //       //   dl.appendChild(dd);
    //       // }
    //       break;
    //     }
    //   }
      // var links = [];

      // if (event.asyncSources) {
      //   event.asyncSources.forEach((sourceId) => {
      //     var source = idToElement[sourceId];
      //     var target = el;
      //     var color = colors((++numEdges) % 20);
      //     source.style.marginBottom = '10px';
      //     target.style.marginTop = '10px';
      //     links.push({
      //       source: source,
      //       target: target,
      //       cssClass: 'asyncType-' + event.asyncType,
      //       overlays: [
      //         //            "Arrow",
      //         [ "Label", { label: event.asyncType,
      //                      cssClass: 'asyncType-' + event.asyncType,
      //                      id: "foo" } ]
      //       ]
      //     });
      //   });
    //   }
    // }


    // links.forEach((link) => {
    //   jsPlumb.connect(link);
    // });

  }

}

var TestResultSummary = React.createClass({
  render() {
    return (
        <div className="TestResultSummary">
        { this.props.test.name } - { this.props.test.variant }
        <strong>{ this.props.test.result }</strong>
        </div>
    );
  }
});

var FileSummary = React.createClass({
  render() {
    var file = this.props.result;
    return (
        <div className="FileSummary">
        <h1><a href={file.href}>{file.filename}</a></h1>
        {file.tests.map((test, index) => {
          return <TestResultSummary test={test} key={index}/>
        })}
      </div>
    );
  }
});

var TestRunSummary = React.createClass({
  render() {
    return (
        <div className="TestRunSummary">
        {
          this.props.result.map(function(result, index) {
            return <FileSummary result={result} key={index}/>;
          })
        }
      </div>
    );
  }
});

var IndexList = React.createClass({
  render() {
    var reversedResults = this.props.results.slice();
    reversedResults.reverse();
    return (
        <div className="IndexList">
        {
          reversedResults.map(function(result, index) {
            return <TestRunSummary result={result} key={index}/>;
          })
        }
      </div>
    );
  }
});

//////////////////////////////////////////////

function safeCss(str) {
  return str.replace(/[^a-z0-9-_]/ig, '');
}

var Event = React.createClass({
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
    var classes = ['Event'];
    for (var key in event) {
      var value = event[key];
      if (typeof value === 'string' && value.length < 30) {
        classes.push('kv-' + safeCss(key) + '-' + safeCss(event[key]));
      }
    }
    return (
        <div className={classes.join(' ')}>
        <span className="event-time">{event.time.toFixed(0)}</span>
        <span className="event-namespace">{event.namespace}</span>
        <span className="event-type">{event.type}</span>
        <span className="event-details">{this.computeDetails()}</span>
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
    var events = this.props.events;

    var idToElement = {};
    var idToEvent = {};
    for (var i = 0; i < events.length; i++) {
      idToEvent[events[i].$id] = events[i];
    }

    return (
        <div className="EventList">
        {this.props.events.map(function(e, index) {
          return <Event event={e} namespaces={namespaces} key={e.$id}/>;
        })}
      </div>
    );
  }
});

var TestResults = React.createClass({
  getInitialState() {
    return { expanded: this.props.test.result !== 'pass' };
  },

  toggleExpanded: function() {
    this.setState({ expanded: !this.state.expanded });
  },

  render() {
    var test = this.props.test;
    var classes = [
      'TestResults',
      'result-' + test.result,
      this.state.expanded ? 'expanded' : ''
    ];

    // .type .result .events
    return (
      <div className={classes.join(' ')}>
        <h2 className="TestResultHeader" onClick={this.toggleExpanded}>
        {test.name} {test.variant}</h2>
        <EventList events={test.events} />
      </div>
    );
  }
});

var FileResults = React.createClass({
  render() {
    return (
        <div className="FileResults">
        <h1>{this.props.filename}</h1>
        {this.props.tests.map((test, index) => {
          return <TestResults test={test} key={index} />
        })}
        </div>
    );
  }
});


var viewer = new LogicViewer(document.body);
