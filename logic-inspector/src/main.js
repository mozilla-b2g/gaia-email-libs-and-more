var EL = (tag) => document.createElement(tag);

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

    let colors= d3.scale.category20();

    let eventsByNamespace = this.data.events.reduce((map, evt) => {
      if (!map[evt.ns]) {
        map[evt.ns] = [];
      }
      map[evt.ns].push(evt);
      return map;
    }, {});

    var namespaces = Object.keys(eventsByNamespace);
    var events = this.data.events;

    var table = EL('table');
    var thead = table.createTHead();
    var tbody = table.createTBody();
    var headerRow = thead.insertRow(0);
    var timeCell = headerRow.appendChild(EL('th'));
    timeCell.textContent = 'time';
    for (var i = 0; i < namespaces.length; i++) {
      var cell = headerRow.appendChild(EL('th'));
      cell.textContent = namespaces[i];
    }

    var idToEvent = {};
    var idToElement = {};
    let numEdges = 0;

    jsPlumb.setContainer(this.rootElement);
    jsPlumb.importDefaults({
      PaintStyle : { lineWidth: 2, strokeStyle : "#666" },
      Connector: ['Flowchart', { stub: 3, cornerRadius: 3 }],
      Anchors:['Bottom', 'Top'],
      Endpoint: 'Blank'
    });

    this.rootElement.appendChild(table);

    var links = [];

    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      var cell;
      var el;
      idToEvent[event.id] = event;
      var row = tbody.appendChild(EL('tr'));
      row.appendChild(EL('td')).textContent = event.time.toFixed(2) + 'ms';
      for (var j = 0; j < namespaces.length; j++) {
        cell = row.appendChild(EL('td'));
        if (namespaces[j] === event.ns + '') {
          el = cell.appendChild(EL('div'));
          el.className = 'event';
          idToElement[event.id] = el;

          // delete event.time;
          // delete event.id;
          var dl = el.appendChild(EL('dl'));
          for (var k in event) {
            var dt = dl.appendChild(EL('dt'));
            var dd = dl.appendChild(EL('dd'));
            dt.classList.add('kv-' + k);
            dd.classList.add('kv-' + k);
            dt.textContent = k;
            dd.textContent = JSON.stringify(event[k]);
            dl.appendChild(dt);
            dl.appendChild(dd);
          }
          break;
        }
      }

      if (event.asyncSources) {
        event.asyncSources.forEach((sourceId) => {
          var source = idToElement[sourceId];
          var target = el;
          var color = colors((++numEdges) % 20);
          source.style.marginBottom = '10px';
          target.style.marginTop = '10px';
          links.push({
            source: source,
            target: target,
            cssClass: 'asyncType-' + event.asyncType,
            overlays: [
              //            "Arrow",
              [ "Label", { label: event.asyncType,
                           cssClass: 'asyncType-' + event.asyncType,
                           id: "foo" } ]
            ]
          });
        });
      }
    }


    links.forEach((link) => {
      jsPlumb.connect(link);
    });

  }

}

var viewer = new LogicViewer(document.getElementById('root'));
viewer.load("test-logs/logic_test-imap_fake.log");
