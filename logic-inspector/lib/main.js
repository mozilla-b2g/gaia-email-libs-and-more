"use strict";

var _createClass = (function () { function defineProperties(target, props) { for (var key in props) { var prop = props[key]; prop.configurable = true; if (prop.value) prop.writable = true; } Object.defineProperties(target, props); } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

var EL = function (tag) {
  return document.createElement(tag);
};

var getEventColor = function getEventColor(ns, type, details) {
  // See if anything stands out:

  if (/error/i.test(type)) {
    return "#c00"; // red
  }

  if (type === "expect") {
    return "rgba(0, 75, 20, 0.7)"; // greenish
  } else if (type === "match") {
    return "rgb(0, 175, 40)"; // greenish
  } else if (type === "failed-expectation") {
    return "rgb(200, 0, 0)"; // red
  }

  // Otherwise, colorize based upon namespace:

  if (ns === "Console") {
    return "black";
  } else if (/Bridge/.test(ns)) {
    return "#bbb";
  } else if (/Universe/.test(ns)) {
    return "#877";
  } else if (/Account/.test(ns)) {
    return "#008";
  } else if (/Sync/.test(ns)) {
    return "#383";
  }
  var hash = 0;
  for (var i = 0; i < ns.length; i++) {
    hash = (hash << 5) - hash + ns.charCodeAt(i) | 0;
  }
  var hue = (hash & 255) / 256 * 360 | 0;
  return "hsl(" + hue + ", 80%, 40%)";
};

var LogicViewer = (function () {
  function LogicViewer(rootElement) {
    _classCallCheck(this, LogicViewer);

    this.rootElement = rootElement;
    if (window.results.filename) {
      this.renderSuiteResults(window.results);
    } else {
      this.renderIndex(window.results);
    }
  }

  _createClass(LogicViewer, {
    renderIndex: {
      value: function renderIndex(items) {
        React.render(React.createElement(
          "div",
          null,
          React.createElement(
            "div",
            { className: "index-header" },
            React.createElement(
              "strong",
              null,
              "Recent GELAM Test Runs"
            ),
            " ",
            React.createElement(
              "em",
              null,
              "(Automatically reloads.)"
            )
          ),
          React.createElement(TestRunList, { items: items })
        ), this.rootElement);
      }
    },
    renderSuiteResults: {
      value: function renderSuiteResults(data) {
        var variant = data.tests[0] && data.tests[0].variant;
        var result = data.tests.every(function (t) {
          return t.result === "pass";
        }) ? "pass" : "fail";

        React.render(React.createElement(
          "div",
          null,
          React.createElement(
            "a",
            { className: "index-link", href: "index.html" },
            "← All Test Results"
          ),
          React.createElement(SuiteResults, { filename: data.filename,
            variant: variant,
            result: result,
            tests: data.tests })
        ), this.rootElement);
      }
    }
  });

  return LogicViewer;
})();

/**
 * .TestRunList
 *   .TestRun
 */

var TestRunList = React.createClass({
  displayName: "TestRunList",

  render: function render() {
    var results = this.props.items;
    return React.createElement(
      "div",
      { className: "TestRunList" },
      results.map(function (testRun, index) {
        return React.createElement(TestRunSummary, { testRun: testRun, key: index });
      })
    );
  }
});

var TestRunSummary = React.createClass({
  displayName: "TestRunSummary",

  render: function render() {
    var suites = this.props.testRun;
    var timestamp = new Date(suites[0] && suites[0].timestamp);
    return React.createElement(
      "div",
      { className: "TestRunSummary" },
      React.createElement(
        "div",
        { className: "timestamp" },
        timestamp.toLocaleString()
      ),
      suites.map(function (suite, index) {
        return React.createElement(SuiteSummary, { suite: suite, key: index });
      })
    );
  }
});

var SuiteSummary = React.createClass({
  displayName: "SuiteSummary",

  render: function render() {
    var _props$suite = this.props.suite;
    var href = _props$suite.href;
    var filename = _props$suite.filename;
    var tests = _props$suite.tests;

    var variant = tests[0] && tests[0].variant;
    return React.createElement(
      "a",
      { href: href, className: "SuiteSummary" },
      tests.map(function (test, index) {
        return React.createElement(TestSummary, {
          filename: filename,
          test: test, key: index });
      })
    );
  }
});

var TestSummary = React.createClass({
  displayName: "TestSummary",

  render: function render() {
    var filename = this.props.filename;
    var _props$test = this.props.test;
    var name = _props$test.name;
    var variant = _props$test.variant;
    var result = _props$test.result;

    var shortVariant = ({
      "imap:fake": "imap",
      "pop3:fake": "pop3",
      "activesync:fake": "async"
    })[variant] || variant;
    return React.createElement(
      "div",
      { className: ["TestSummary", result, variant.replace(":", "-")].join(" ") },
      React.createElement(
        "span",
        { className: "result" },
        result
      ),
      React.createElement(
        "span",
        { className: "variant" },
        shortVariant
      ),
      React.createElement(
        "span",
        { className: "filename" },
        filename
      ),
      React.createElement(
        "span",
        { className: "name" },
        name
      )
    );
  }
});

//////////////////////////////////////////////

function safeCss(str) {
  return str.replace(/[^a-z0-9-_]/ig, "");
}

var SuiteResults = React.createClass({
  displayName: "SuiteResults",

  render: function render() {
    var _props = this.props;
    var filename = _props.filename;
    var variant = _props.variant;
    var result = _props.result;
    var tests = _props.tests;

    return React.createElement(
      "div",
      { className: ["SuiteResults", result, variant.replace(":", "-")].join(" ") },
      React.createElement(
        "h1",
        { className: "header" },
        React.createElement(
          "span",
          { className: "result" },
          result
        ),
        React.createElement(
          "span",
          { className: "variant" },
          variant
        ),
        React.createElement(
          "span",
          { className: "filename" },
          filename
        )
      ),
      tests.map(function (test, index) {
        return React.createElement(TestResults, { test: test, key: index });
      })
    );
  }
});

var TestResults = React.createClass({
  displayName: "TestResults",

  getInitialState: function getInitialState() {
    return { collapsed: this.props.test.result === "pass" };
  },

  toggleCollapsed: function toggleCollapsed() {
    this.setState({ collapsed: !this.state.collapsed });
  },

  render: function render() {
    var _props$test = this.props.test;
    var result = _props$test.result;
    var name = _props$test.name;
    var events = _props$test.events;

    return React.createElement(
      "div",
      { className: ["TestResults", result, this.state.collapsed ? "collapsed" : ""].join(" ") },
      React.createElement(
        "h2",
        { className: "header", onClick: this.toggleCollapsed },
        React.createElement(
          "div",
          { className: "arrow" },
          "▼"
        ),
        React.createElement(
          "span",
          { className: "name" },
          name
        )
      ),
      React.createElement(
        "div",
        { className: "body" },
        React.createElement(EventList, { events: events })
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
    var events = this.props.events.slice();

    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      if (event.namespace === "LegacyGelamTest" && event.type === "step-begin") {
        event.children = [];
        var nextEvent;
        while (nextEvent = events[i + 1]) {
          if (nextEvent.namespace === "LegacyGelamTest" && nextEvent.type === "step-end") {
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

    return React.createElement(
      "div",
      { className: "EventList" },
      events.map(function (event, index) {
        return React.createElement(Event, { event: event, key: index });
      })
    );
  }
});

var Event = React.createClass({
  displayName: "Event",

  getInitialState: function getInitialState() {
    var collapsed = true;
    if (this.props.event.namespace === "LegacyGelamTest" && this.props.event.type === "step-begin" && this.props.event.details && this.props.event.details.error) {
      collapsed = false;
    }
    return { collapsed: collapsed };
  },

  toggleCollapsed: function toggleCollapsed() {
    this.setState({ collapsed: !this.state.collapsed });
  },

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
    var children = event.children || [];
    var classes = ["Event"];

    if (this.state.collapsed) {
      classes.push("collapsed");
    }

    for (var key in event) {
      var value = event[key];
      if (typeof value === "string" && value.length < 30) {
        classes.push(safeCss(key) + "-" + safeCss(event[key]));
      }
    }

    var styles = {
      color: getEventColor(event.namespace, event.type, event.details)
    };

    switch (event.namespace + "/" + event.type) {
      case "LegacyGelamTest/step-end":
        return null;
      case "LegacyGelamTest/step-begin":
        if (!children.length) {
          return null; // No need to render empty steps.
        }
        classes.push("Step");

        var stepName = event.details.name.replace(/\[([^\]\s]+)([^\]]*)\]/g, function (match, ns, subname) {
          return "<span style=\"color:" + getEventColor(ns) + "\">[<strong>" + ns + "</strong> " + subname + "]</span>";
        });

        if (event.details.error) {
          classes.push("error");
        };
        return React.createElement(
          "div",
          { className: classes.join(" ") },
          React.createElement("div", { className: "header", onClick: this.toggleCollapsed,
            dangerouslySetInnerHTML: { __html: stepName } }),
          React.createElement(
            "div",
            { className: "body" },
            children.map(function (childEvent, key) {
              return React.createElement(Event, { event: childEvent, key: key });
            }),
            React.createElement(
              "div",
              { className: "error-display" },
              event.details.error
            )
          )
        );
      default:
        return React.createElement(
          "div",
          { style: styles, className: classes.join(" ") },
          React.createElement(
            "span",
            { className: "event-time" },
            event.time.toFixed(0),
            "ms"
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
  }
});

var viewer = new LogicViewer(document.body);
