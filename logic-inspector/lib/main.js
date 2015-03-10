"use strict";

var _prototypeProperties = function (child, staticProps, instanceProps) { if (staticProps) Object.defineProperties(child, staticProps); if (instanceProps) Object.defineProperties(child.prototype, instanceProps); };

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

var EL = function (tag) {
  return document.createElement(tag);
};

var PLEASING_COLORS = [
//  'rgb(240,163,255)',
"rgb(0,117,220)", "rgb(153,63,0)", "rgb(76,0,92)", "rgb(25,25,25)", "rgb(0,92,49)", "rgb(43,206,72)", "rgb(255,204,153)", "rgb(128,128,128)", "rgb(148,255,181)", "rgb(143,124,0)", "rgb(157,204,0)", "rgb(194,0,136)", "rgb(0,51,128)", "rgb(255,164,5)", "rgb(255,168,187)", "rgb(66,102,0)", "rgb(255,0,16)", "rgb(94,241,242)", "rgb(0,153,143)", "rgb(224,255,102)", "rgb(116,10,255)", "rgb(153,0,0)", "rgb(255,255,128)", "rgb(255,255,0)", "rgb(255,80,5)"];

var colors = function colors(i) {
  return PLEASING_COLORS[i] || "black";
};

var LogicViewer = (function () {
  function LogicViewer(rootElement) {
    _classCallCheck(this, LogicViewer);

    this.rootElement = rootElement;
    if (window.results.filename) {
      this.renderFileResults(window.results);
    } else {
      this.renderIndex(window.results);
    }
  }

  _prototypeProperties(LogicViewer, null, {
    renderIndex: {
      value: function renderIndex(results) {
        React.render(React.createElement(IndexList, { results: results }), this.rootElement);
      },
      writable: true,
      configurable: true
    },
    renderFileResults: {
      value: function renderFileResults(data) {
        React.render(React.createElement(
          "div",
          null,
          React.createElement(
            "a",
            { href: "index.html" },
            "[Index]"
          ),
          React.createElement(FileResults, { filename: data.filename, tests: data.tests })
        ), this.rootElement);

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
      },
      writable: true,
      configurable: true
    }
  });

  return LogicViewer;
})();

var TestResultSummary = React.createClass({
  displayName: "TestResultSummary",

  render: function render() {
    return React.createElement(
      "div",
      { className: "TestResultSummary" },
      this.props.test.name,
      " - ",
      this.props.test.variant,
      React.createElement(
        "strong",
        null,
        this.props.test.result
      )
    );
  }
});

var FileSummary = React.createClass({
  displayName: "FileSummary",

  render: function render() {
    var file = this.props.result;
    return React.createElement(
      "div",
      { className: "FileSummary" },
      React.createElement(
        "h1",
        null,
        React.createElement(
          "a",
          { href: file.href },
          file.filename
        )
      ),
      file.tests.map(function (test, index) {
        return React.createElement(TestResultSummary, { test: test, key: index });
      })
    );
  }
});

var TestRunSummary = React.createClass({
  displayName: "TestRunSummary",

  render: function render() {
    return React.createElement(
      "div",
      { className: "TestRunSummary" },
      this.props.result.map(function (result, index) {
        return React.createElement(FileSummary, { result: result, key: index });
      })
    );
  }
});

var IndexList = React.createClass({
  displayName: "IndexList",

  render: function render() {
    var reversedResults = this.props.results.slice();
    reversedResults.reverse();
    return React.createElement(
      "div",
      { className: "IndexList" },
      reversedResults.map(function (result, index) {
        return React.createElement(TestRunSummary, { result: result, key: index });
      })
    );
  }
});

//////////////////////////////////////////////

function safeCss(str) {
  return str.replace(/[^a-z0-9-_]/ig, "");
}

var Event = React.createClass({
  displayName: "Event",

  computeDetails: function computeDetails() {
    var details = this.props.event.details;
    if (!details) {
      return "";
    } else if (details.msg && typeof details.msg === "string") {
      return details.msg;
    } else {
      return JSON.stringify(details).slice(0, 1000);
    }
  },
  render: function render() {
    var event = this.props.event;
    var classes = ["Event"];
    for (var key in event) {
      var value = event[key];
      if (typeof value === "string" && value.length < 30) {
        classes.push("kv-" + safeCss(key) + "-" + safeCss(event[key]));
      }
    }
    return React.createElement(
      "div",
      { className: classes.join(" ") },
      React.createElement(
        "span",
        { className: "event-time" },
        event.time.toFixed(0)
      ),
      React.createElement(
        "span",
        { className: "event-namespace" },
        event.namespace
      ),
      React.createElement(
        "span",
        { className: "event-type" },
        event.type
      ),
      React.createElement(
        "span",
        { className: "event-details" },
        this.computeDetails()
      )
    );
  }
});

var EventList = React.createClass({
  displayName: "EventList",

  render: function render() {
    var eventsByNamespace = this.props.events.reduce(function (map, evt) {
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

    return React.createElement(
      "div",
      { className: "EventList" },
      this.props.events.map(function (e, index) {
        return React.createElement(Event, { event: e, namespaces: namespaces, key: e.$id });
      })
    );
  }
});

var TestResults = React.createClass({
  displayName: "TestResults",

  getInitialState: function getInitialState() {
    return { expanded: this.props.test.result !== "pass" };
  },

  toggleExpanded: function toggleExpanded() {
    this.setState({ expanded: !this.state.expanded });
  },

  render: function render() {
    var test = this.props.test;
    var classes = ["TestResults", "result-" + test.result, this.state.expanded ? "expanded" : ""];

    // .type .result .events
    return React.createElement(
      "div",
      { className: classes.join(" ") },
      React.createElement(
        "h2",
        { className: "TestResultHeader", onClick: this.toggleExpanded },
        test.name,
        " ",
        test.variant
      ),
      React.createElement(EventList, { events: test.events })
    );
  }
});

var FileResults = React.createClass({
  displayName: "FileResults",

  render: function render() {
    return React.createElement(
      "div",
      { className: "FileResults" },
      React.createElement(
        "h1",
        null,
        this.props.filename
      ),
      this.props.tests.map(function (test, index) {
        return React.createElement(TestResults, { test: test, key: index });
      })
    );
  }
});

var viewer = new LogicViewer(document.body);
