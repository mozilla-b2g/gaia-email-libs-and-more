class LogicViewer {

  constructor(rootElement) {
    this.rootElement = rootElement;
    this.data = null;
  }

  load(path) {
    d3.xhr(path, (error, xhr) => {
      var json = JSON.parse(
        xhr.responseText
          .replace('##### LOGGEST-TEST-RUN-BEGIN #####', '')
          .replace('##### LOGGEST-TEST-RUN-END #####', ''));

      if (error) {
        console.warn(error);
      } else {
        this.data = json;
        this.refresh();
      }
    });
  }

  refresh() {

    let eventsByNamespace = this.data.events.reduce((map, evt) => {
      if (!map[evt.namespace]) {
        map[evt.namespace] = [];
      }
      map[evt.namespace].push(evt);
      return map;
    }, {});

    var namespaces = Object.keys(eventsByNamespace);

    var force = cola.d3adaptor()
          .linkDistance(30)
          .size([window.innerWidth, window.innerHeight]);

    var indexMap = {};
    var maxIndex = this.data.events.length - 1;

    var EL = (tag) => document.createElement(tag);

    var table = EL('table');
    var thead = table.createTHead();
    var headerRow = thead.insertRow(0);
    for (var i = 0; i < namespaces.length; i++) {
      var cell = headerRow.appendChild(EL('th'));
      cell.textContent = namespaces[i];
    }

    var row table.insertRow();

    var graph = {
      nodes: this.data.events
        .map((e, idx) => {
          indexMap[e.id] = idx;
          return {
            label: idx + ': ' + e.namespace + '/' + e.type,
            width: 100,
            height: 20
          }
        }),
      links: this.data.events
        .filter(e => !!e.details.sourceEventId)
        .map(e => {
          return { source: indexMap[e.details.sourceEventId],
                   target: indexMap[e.id] }
        })
        // .concat(this.data.events.reduce((arr, e, idx) => {
        //   if(idx < maxIndex)
        //     arr.push({ source: idx, target: idx + 1 });
        //   return arr;
        // }, [])
               ,
      constraints: [
      ],
      groups: []
    };




    var rootNodeIndex = graph.nodes.push({ label: 'root', className: 'root' }) - 1;

    Object.keys(eventsByNamespace).forEach((ns) => {
      // Add a namespace header at the top.
      var len = graph.nodes.push({
        label: ns,
        className: 'namespace'
      });
      var events = eventsByNamespace[ns];

      graph.groups.push({
        leaves: events.map((e) => indexMap[e.id])
      });
      console.log("LEAVES", JSON.stringify(graph.groups))

      graph.links.push({
        type: 'time',
        source: rootNodeIndex,
        target: len - 1
      });

      graph.links.push({ type: 'time',
                         source: len - 1,
                         target: indexMap[events[0].id] });



      // Point every event at the next chronological event
      for (var i = 0; i < events.length - 1; i++) {
        graph.links.push({
          type: 'time',
          source: indexMap[events[i].id],
          target: indexMap[events[i + 1].id]
        });
      }
    });

    let COLUMN_WIDTH = 200;

    console.log(graph);

    // if (true) {
    //   graph.constraints = graph.constraints.concat(
    //     Object.keys(eventsByNamespace).map((ns) => {
    //       return {
    //         //type: 'alignment',
    //         axis: 'x',
    //         left: 0, 
    //         offsets: eventsByNamespace[ns].map((e) => {
    //           return { node: indexMap[e.id], offset: 0 };
    //         })
    //       };
    //     }));
    // }
    for (var i = 0; i < this.data.events.length - 1; i++) {
      graph.constraints.push({"axis":"y", "left":i, "right":i+1, "gap": 30});
    }

    force
      .nodes(graph.nodes)
      .links(graph.links)
      .groups(graph.groups)
        .avoidOverlaps(true)
        .handleDisconnected(false)
      .constraints(graph.constraints)
//      .flowLayout('y', 100)
      .symmetricDiffLinkLengths(50)
//      .avoidOverlaps(true)
      .start();

    var svg = d3.select("body").append("svg")
          .style("position", "absolute")
          .attr("width", window.innerWidth)
          .attr("height", window.innerHeight);

    var group = svg.selectAll(".group")
          .data(graph.groups)
          .enter().append("rect")
          .attr("rx", 8).attr("ry", 8)
          .attr("class", "group")
          //.style("fill", function (d, i) { return color(i); });

    svg.append("svg:defs").selectAll("marker")
      .data(["arrow"])
      .enter().append("svg:marker")
      .attr("id", String)
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 10)
      .attr("refY", -1.5)
      .attr("markerWidth", 3)
      .attr("markerHeight", 3)
      .attr("orient", "auto")
      .append("svg:path")
      .attr("d", "M0,-5L10,0L0,5");

    var node = d3.select("body").selectAll('.node')
      .data(graph.nodes)
      .enter().append('div')
          .attr('class', (d) => {
            return 'node ' + (d.className || '');
          })
          .style('position', 'absolute')
          .text((d) => d.label )
          .each(function(d) {
            d.width = this.clientWidth;
            d.height = this.clientHeight;
          })
          .call(force.drag);

    var link = svg.selectAll('.link')
      .data(graph.links)
      .enter().append('line')
          .attr("marker-end", "url(#arrow)")
          .attr('class', 'link');

    force.on("tick", function () {
      link.each(function (d) {
        cola.vpsc.makeEdgeBetween(d, d.source.bounds, d.target.bounds, 5);
      });

      link.attr("x1", function (d) { return d.sourceIntersection.x; })
        .attr("y1", function (d) { return d.sourceIntersection.y; })
        .attr("x2", function (d) { return d.targetIntersection.x; })
        .attr("y2", function (d) { return d.targetIntersection.y; });

      // label.each(function (d) {
      //   var b = this.getBBox();
      //   d.width = b.width + 2 * margin + 8;
      //   d.height = b.height + 2 * margin + 8;
      // });

      node.style("transform", function (d) {
        return 'translate(' + d.bounds.x + 'px, ' + d.bounds.y + 'px)';
      }).style("width", function (d) { return d.bounds.width(); })
        .style("height", function (d) { return d.bounds.height(); })

      group.attr("x", function (d) { return d.bounds.x; })
        .attr("y", function (d) { return d.bounds.y; })
        .attr("width", function (d) { return d.bounds.width(); })
        .attr("height", function (d) { return d.bounds.height(); });



      // label.attr("transform", function (d) {
      //   return "translate(" + d.x + margin + "," + (d.y + margin - d.height/2) + ")";
      // });
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
  }

}

var viewer = new LogicViewer(document.getElementById('root'));
viewer.load("test-logs/logic_test-imap_fake.log");
