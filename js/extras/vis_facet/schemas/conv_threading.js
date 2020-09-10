/**
 * Conversation-threading visualization.  This is a Vega-ized version of an
 * initially hand-coded d3 visualization.
 *
 * Note that unlike the faceting and overview schemas, this visualization has no
 * backend component defined as part of the visualization.  Those schema types
 * define backend pipelines because they are dynamically deriving state from a
 * collection of conversations/messages/whatever that was not known a priori.
 * (Although they could potentially be optimized by precomputing various things,
 * etc.)
 *
 * Whereas we are a visualization that operates on a single conversation summary
 * object that's already supposed to have pre-computed most of the (expensive)
 * interesting stuff.  Additionally, each invocation of us is independent from
 * the others and only need be instantiated when visually needed.
 *
 * If you want to enhance this visualization/one like it to include data not
 * already available, then do it in the conversation churn mechanism which
 * is/will be extensible.  Alternately, advocate for the creation of an
 * additional visualization type that's basically an 'overview' that also
 * providers per-summary-object visualizations that can rely on the overview
 * state as well.  (It sounds cool and inevitable, but we probably want to
 * iterate on the simpler stuff first and have discussions with the vega
 * developers/community and partake of their wisdom and maybe do some upstream
 * dev first.)
 *
 * XXX running into problem creating the hierarchy for the messages in the
 * conversation.  The scenario is basically:
 * - the view streaming API's insert method uses datalib.duplicate which uses
 *   a JSON-roundtrip to make the data independent but which does not work with
 *   object graphs.  However, arguably it is not appropriate to cram object
 *   graphs into the datasources which think of things array-wise anyways.
 * - the treeify data transform cannot understand pre-existing graph structures
 *   referenced by id.  It uses a non-recursive hieararchical grouping based on
 *   explicit path segments.
 * - lookup assumes a separate data source rather than allowing for
 *   self-joining.
 * - best options would seem to be:
 *   - pre-generating something that can be ingested by datalib as treejson
 *   - create a data transform that can re-establish the link structure.  A
 *     potentially relevant question is whether this is useful outside of this
 *     graph structure lossage case.  It seems like it is not useful since
 *     under (destructive omitting) filtering, the graph structure would be
 *     corrupted.  A "references" header closest-ancestor algorithm could be
 *     more generically useful, such as re-establishing orgchart relative
 *     structure in a subset, but arguably that would be better implemented by
 *
 */
export default {
  name: 'Conversation Threading',
  provider: 'vis_facet',
  type: 'conversation-summary',

  backend: {
    gather: {
      messages: {
        daysAgo: true,
      },
    },
    inputDataSource: 'messages',
    outputDataSource: 'topAuthors',
    extractFrom: 'messages',
    extract: {
      msgId: ['message', 'id'],
      emailAddress: ['message', 'author', 'address'],
      daysAgo: ['daysAgo']
    },
    aggregate: {
      maxDaysAgo: {
        op: 'max',
        field: ['daysAgo'],
        initial: 0
      }
    },
    orderingKey: 'emailAddress',
    vegaData: [
      {
        name: 'messages'
      },
      {
        name: 'binnedMessages',
        source: 'messages',
        transform: [
          {
            type: 'bin',
            field: 'daysAgo',
            min: 0,
            maxbins: 60
          }
        ]
      },
      {
        name: 'allAuthors',
        source: 'binnedMessages',
        transform: [
          {
            type: 'facet',
            groupby: ['emailAddress'],
            summarize: {
              // TODO: ensure that this is summarizing the pre-transform counts,
              // otherwise, move to sum the post-transform counts.
              '*': 'count'
            },
            transform: [
              {
                type: 'aggregate',
                // the binning will be consistent so we can group both, which allows
                // both values to pass through.
                groupby: ['bin_start', 'bin_end'],
                summarize: { '*': 'count'}
              }
            ]
          }
        ]
      },
      {
        name: 'topAuthors',
        source: 'allAuthors',
        transform: [
          {
            type: 'sort',
            by: '-count'
          },
          {
            type: 'rank'
          },
          {
            type: 'filter',
            test: 'datum.rank < 20'
          }
        ]
      }
    ]
  },
  frontend: {
    dataFrom: 'messageTidbits',
    extractFrom: 'messages',
    extract: {
      msgId: ['message', 'id'],
      emailAddress: ['message', 'author', 'address'],
      daysAgo: ['daysAgo']
    },
    injectDataInto: 'messageTidbits',
    spec: {
      width: 300,
      height: 40,
      padding: 0,
      data: [
        {
          name: 'messageTidbits',
          values: []
        },
        {
          name: 'nodes',
          source: 'messageTidbits',
          transform: [
            {
              type: 'treeify',

            },
            {
              type: 'hierarchy',
              mode: 'cluster',

            }
          ]
        }
      ],
      // we might need to let the backend calculate scales and propagate them
      // through as tocMeta.
      scales: [
        {
          name: 'x',
          type: 'linear',
          domain: { data: 'scale-hack', field: 'x' },
          range: [180, 0]
        },
        {
          name: 'y',
          type: 'linear',
          domain: [0, 20],
          range: 'height'
        }
      ],
      marks: [
        {
          type: 'symbol',
          from: { data: 'nodes' },
          properties: {
            update: {
              x: { scale: 'x', field: 'bin_start' },
              x2: { scale: 'x', field: 'bin_end' },
              y: { scale: 'y', field: 'count' },
              y2: { scale: 'y', value: 0 },
              fill: { value: 'steelblue' }
            }
          }
        }
      ]
    }
  }
};
