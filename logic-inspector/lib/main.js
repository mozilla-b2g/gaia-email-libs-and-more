"use strict";

var _prototypeProperties = function (child, staticProps, instanceProps) { if (staticProps) Object.defineProperties(child, staticProps); if (instanceProps) Object.defineProperties(child.prototype, instanceProps); };

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

var EL = function (tag) {
  return document.createElement(tag);
};

var LogicViewer = (function () {
  function LogicViewer(rootElement) {
    _classCallCheck(this, LogicViewer);

    this.rootElement = rootElement;
    this.data = null;
  }

  _prototypeProperties(LogicViewer, null, {
    load: {
      value: function load(path) {
        var _this = this;

        d3.xhr(path, function (error, xhr) {
          var json = JSON.parse(xhr.responseText.replace("##### LOGGEST-TEST-RUN-BEGIN #####", "").replace("##### LOGGEST-TEST-RUN-END #####", ""));

          if (error) {
            console.warn(error);
          } else {
            _this.data = json;
            _this.refresh();
          }
        });
      },
      writable: true,
      configurable: true
    },
    refresh: {
      value: function refresh() {

        var colors = d3.scale.category20();

        var eventsByNamespace = this.data.events.reduce(function (map, evt) {
          if (!map[evt.ns]) {
            map[evt.ns] = [];
          }
          map[evt.ns].push(evt);
          return map;
        }, {});

        var namespaces = Object.keys(eventsByNamespace);
        var events = this.data.events;

        var table = EL("table");
        var thead = table.createTHead();
        var tbody = table.createTBody();
        var headerRow = thead.insertRow(0);
        var timeCell = headerRow.appendChild(EL("th"));
        timeCell.textContent = "time";
        for (var i = 0; i < namespaces.length; i++) {
          var cell = headerRow.appendChild(EL("th"));
          cell.textContent = namespaces[i];
        }

        var idToEvent = {};
        var idToElement = {};
        var numEdges = 0;

        jsPlumb.setContainer(this.rootElement);
        jsPlumb.importDefaults({
          PaintStyle: { lineWidth: 2, strokeStyle: "#666" },
          Connector: ["Flowchart", { stub: 3, cornerRadius: 3 }],
          Anchors: ["Bottom", "Top"],
          Endpoint: "Blank"
        });

        this.rootElement.appendChild(table);

        var links = [];

        for (var i = 0; i < events.length; i++) {
          var event = events[i];
          var cell;
          var el;
          idToEvent[event.id] = event;
          var row = tbody.appendChild(EL("tr"));
          row.appendChild(EL("td")).textContent = event.time.toFixed(2) + "ms";
          for (var j = 0; j < namespaces.length; j++) {
            cell = row.appendChild(EL("td"));
            if (namespaces[j] === event.ns + "") {
              el = cell.appendChild(EL("div"));
              el.className = "event";
              idToElement[event.id] = el;

              // delete event.time;
              // delete event.id;
              var dl = el.appendChild(EL("dl"));
              for (var k in event) {
                var dt = dl.appendChild(EL("dt"));
                var dd = dl.appendChild(EL("dd"));
                dt.classList.add("kv-" + k);
                dd.classList.add("kv-" + k);
                dt.textContent = k;
                dd.textContent = JSON.stringify(event[k]);
                dl.appendChild(dt);
                dl.appendChild(dd);
              }
              break;
            }
          }

          if (event.asyncSources) {
            event.asyncSources.forEach(function (sourceId) {
              var source = idToElement[sourceId];
              var target = el;
              var color = colors(++numEdges % 20);
              source.style.marginBottom = "10px";
              target.style.marginTop = "10px";
              links.push({
                source: source,
                target: target,
                cssClass: "asyncType-" + event.asyncType,
                overlays: [
                //            "Arrow",
                ["Label", { label: event.asyncType,
                  cssClass: "asyncType-" + event.asyncType,
                  id: "foo" }]]
              });
            });
          }
        }

        links.forEach(function (link) {
          jsPlumb.connect(link);
        });
      },
      writable: true,
      configurable: true
    }
  });

  return LogicViewer;
})();

var viewer = new LogicViewer(document.getElementById("root"));
viewer.load("test-logs/logic_test-imap_fake.log");
