"use strict";

var _prototypeProperties = function (child, staticProps, instanceProps) { if (staticProps) Object.defineProperties(child, staticProps); if (instanceProps) Object.defineProperties(child.prototype, instanceProps); };

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

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
        var eventsByNamespace = this.data.events.reduce(function (map, evt) {
          if (!map[evt.namespace]) {
            map[evt.namespace] = [];
          }
          map[evt.namespace].push(evt);
          return map;
        }, {});

        var force = cola.d3adaptor().linkDistance(30).size([window.innerWidth, window.innerHeight]);

        var indexMap = {};
        var maxIndex = this.data.events.length - 1;

        var graph = {
          nodes: this.data.events.map(function (e, idx) {
            indexMap[e.id] = idx;
            return {
              label: idx + ": " + e.namespace + "/" + e.type,
              width: 100,
              height: 20
            };
          }),
          links: this.data.events.filter(function (e) {
            return !!e.details.sourceEventId;
          }).map(function (e) {
            return { source: indexMap[e.details.sourceEventId],
              target: indexMap[e.id] };
          })
          // .concat(this.data.events.reduce((arr, e, idx) => {
          //   if(idx < maxIndex)
          //     arr.push({ source: idx, target: idx + 1 });
          //   return arr;
          // }, [])
          ,
          constraints: []
        };

        var rootNodeIndex = graph.nodes.push({ label: "root", className: "root" }) - 1;

        Object.keys(eventsByNamespace).forEach(function (ns) {
          // Add a namespace header at the top.
          var len = graph.nodes.push({
            label: ns,
            className: "namespace"
          });
          var events = eventsByNamespace[ns];

          graph.links.push({
            type: "time",
            source: rootNodeIndex,
            target: len - 1
          });

          graph.links.push({ type: "time",
            source: len - 1,
            target: indexMap[events[0].id] });

          // Point every event at the next chronological event
          for (var i = 0; i < events.length - 1; i++) {
            graph.links.push({
              type: "time",
              source: indexMap[events[i].id],
              target: indexMap[events[i + 1].id]
            });
          }
        });

        if (true) {
          graph.constraints = graph.constraints.concat(Object.keys(eventsByNamespace).map(function (ns) {
            return {
              type: "alignment",
              axis: "x",
              offsets: eventsByNamespace[ns].map(function (e) {
                return { node: indexMap[e.id], offset: 0 };
              })
            };
          }));
        }
        for (var i = 0; i < this.data.events.length - 1; i++) {
          graph.constraints.push({ axis: "y", left: i, right: i + 1, gap: 30 });
        }

        console.log(graph);

        force.nodes(graph.nodes).links(graph.links).constraints(graph.constraints)
        //      .flowLayout('y', 100)
        .symmetricDiffLinkLengths(50)
        //      .avoidOverlaps(true)
        .start();

        var svg = d3.select("body").append("svg").style("position", "absolute").attr("width", window.innerWidth).attr("height", window.innerHeight);

        svg.append("svg:defs").selectAll("marker").data(["arrow"]).enter().append("svg:marker").attr("id", String).attr("viewBox", "0 -5 10 10").attr("refX", 10).attr("refY", -1.5).attr("markerWidth", 3).attr("markerHeight", 3).attr("orient", "auto").append("svg:path").attr("d", "M0,-5L10,0L0,5");

        var node = d3.select("body").selectAll(".node").data(graph.nodes).enter().append("div").attr("class", function (d) {
          return "node " + (d.className || "");
        }).style("position", "absolute").text(function (d) {
          return d.label;
        }).each(function (d) {
          d.width = this.clientWidth;
          d.height = this.clientHeight;
        }).call(force.drag);

        var link = svg.selectAll(".link").data(graph.links).enter().append("line").attr("marker-end", "url(#arrow)").attr("class", "link");

        force.on("tick", function () {
          link.each(function (d) {
            cola.vpsc.makeEdgeBetween(d, d.source.bounds, d.target.bounds, 5);
          });

          link.attr("x1", function (d) {
            return d.sourceIntersection.x;
          }).attr("y1", function (d) {
            return d.sourceIntersection.y;
          }).attr("x2", function (d) {
            return d.targetIntersection.x;
          }).attr("y2", function (d) {
            return d.targetIntersection.y;
          });

          // label.each(function (d) {
          //   var b = this.getBBox();
          //   d.width = b.width + 2 * margin + 8;
          //   d.height = b.height + 2 * margin + 8;
          // });

          node.style("transform", function (d) {
            return "translate(" + d.bounds.x + "px, " + d.bounds.y + "px)";
          }).style("width", function (d) {
            return d.bounds.width();
          }).style("height", function (d) {
            return d.bounds.height();
          });
        });

        // // Add headers for each namespace.
        // function E(tag) {
        //   return document.createElement(tag);
        // }
        // let table = document.body.appendChild(E('table'));
        // let tr = table.appendChild(E('tr'));
        // for (let key of Object.keys(eventsByNamespace)) {
        //   let td = tr.appendChild(E('td'));
        //   td.textContent = key;
        // }
      },
      writable: true,
      configurable: true
    }
  });

  return LogicViewer;
})();

var viewer = new LogicViewer(document.getElementById("root"));
viewer.load("test-logs/logic_test-imap_fake.log");
// label.attr("transform", function (d) {
//   return "translate(" + d.x + margin + "," + (d.y + margin - d.height/2) + ")";
// });
