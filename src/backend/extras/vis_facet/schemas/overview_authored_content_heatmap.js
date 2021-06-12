/**
 * A heatmap where the x-axis is binned over time and the y-axis is binned over
 * authored body size, the amount of content in the message believed to be
 * freshly authored (as opposed to quoting or mailing list footers, etc.).
 * This might be extended to use a different color encoding scheme or multiple
 * displays in cases where a boolean or ordinal value shows interesting
 * different patterns.
 *
 * The choice of heatmap was made primarily because the goal is to be decimating
 * the data in the worker.  Although a scatter plot can be super interesting,
 * shipping over all N datapoints defeats part of the goal of this example.
 */
export default {
  name: 'Authored Size by Time',
  provider: 'vis_facet',
  type: 'overview',

  backend: {
    gather: {
      messages: {
        daysAgo: true
      },
    },
    inputDataSource: 'messages',
    outputDataSource: 'aggrid',
    extractFrom: 'messages',
    extract: {
      msgId: ['message', 'id'],
      authoredBodySize: ['message', 'authoredBodySize'],
      daysAgo: ['daysAgo'],
    },
    aggregate: {
    },
    // Our overview generates a single output item, so this doesn't matter, but
    // we need to pick something because "undefined" is embarassing.
    // (Note that, regrettably, there is not going to be any stability on
    orderingKey: '_id',
    vegaData: [
      {
        name: 'messages'
      },
      // Bin every message into a grid square.
      {
        name: 'grid',
        source: 'messages',
        transform: [
          // perform log scaling on the authoredBodySize to avoid outliers
          // forcing most things into the lowest bins.
          {
            type: 'formula',
            field: 'logSize',
            expr: 'log(datum.authoredBodySize)/LN10'
          },
          // Bin!  Note that binning just annotates values on and each binning
          // operation is orthogonal so it's not like we risk having different
          // scales for each row/column.
          {
            type: 'bin',
            field: 'daysAgo',
            min: 0,
            maxbins: 60,
            output: {
              start: 'daysAgo_start',
              end: 'daysAgo_end'
            }
          },
          {
            type: 'bin',
            field: 'logSize',
            min: 0,
            maxbins: 20,
            output: {
              start: 'size_start',
              end: 'size_end'
            }
          }
        ]
      },
      // Aggregate up counts for each grid square.  This is the decimated data
      // we send over the wire.
      {
        name: 'aggrid',
        source: 'grid',
        transform: [
          {
            type: 'aggregate',
            // because we're aggregating, we need to explicitly group on all
            // the data we want propagated, which means the bin ends in addition
            // to their starts.
            groupby: [
              'daysAgo_start',
              'daysAgo_end',
              'size_start',
              'size_end'
            ],
            summarize: { '*': 'count' }
          }
        ]
      }
    ]
  },
  frontend: {
    dataFrom: 'values',
    injectDataInto: 'aggrid',
    tocMetaData: [],
    spec: {
      width: 667,
      height: 64,
      padding: 0,
      data: [
        {
          name: 'aggrid',
          values: []
        }
      ],
      // we might need to let the backend calculate scales and propagate them
      // through as tocMeta.
      scales: [
        {
          name: 'x',
          type: 'linear',
          domain: { data: 'aggrid', field: ['daysAgo_start', 'daysAgo_end'] },
          range: [667, 0]
        },
        {
          name: 'y',
          type: 'linear',
          domain: { data: 'aggrid', field: ['size_start', 'size_end'] },
          range: 'height'
        },
        {
          name: 'c',
          type: 'quantize',
          domain: { data: 'aggrid', field: 'count' },
          range: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6',
                  '#4292c6', '#2171b5', '#08519c', '#08306b']
        }
      ],
      marks: [
        {
          type: 'rect',
          from: { data: 'aggrid' },
          properties: {
            enter: {
              x: { scale: 'x', field: 'daysAgo_start' },
              x2: { scale: 'x', field: 'daysAgo_end' },
              y: { scale: 'y', field: 'size_start' },
              y2: { scale: 'y', field: 'size_end' },
              fill: { scale: 'c', field: 'count' }
            }
          }
        }
      ]
    }
  }
};

