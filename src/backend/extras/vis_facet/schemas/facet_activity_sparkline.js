/**
 * Create a top-N list of author facets, each of which contains limited author
 * summary info (email address for now), plus a histogram of author activity.
 *
 * Our conceptual pipeline and their instances look like this:
 * - "messages":  { id, emailAddress, daysAgo }
 *   This is where GELAM crams the extracted data in via the streaming API.
 *   This is done outside Vega to ensure we've created a minimal data
 *   representation for vega to hold onto.  (We categorically don't want to
 *   have a full representation of every message stored in memory.)
 *   `daysAgo` is a computed extractor
 * - "binnedMessages": {... bin_start, bin_end }
 *   We run a binning transform on the messages before fragmenting the streams
 *   so that all facets are consistently binned.  We will destructively
 *   aggregate the bins inside the author facets.
 * - "allAuthors": { emailAddress: "foo@bar", key: "foo@bar", count: 100,
 *   values: [{ bin_start: x, bin_end: x, count: 10 }, ...]}
 *   We facet by the email address and run an aggregation inside the faceted
 *   values so that we only have the per-bin counts and the specific data points
 *   that we're counting are discarded.  This aggregation is one of our two
 *   fundamental reductions.  We don't sort the email facets; we defer that to
 *   topAuthors.
 * - "topAuthors":
 *   We sort the authors by total message count, establish a rank, then filter
 *   it down to the top N authors using that rank.  We currently don't re-sort
 *   alphabetically or anything
 */
export default {
  name: 'Activity Sparkline',
  provider: 'vis_facet',
  type: 'facet',

  filterAction: {
    filterName: 'authorAddress',
    extractFilterValueFrom: 'emailAddress'
  },

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
    // The Table-of-Contents used to send the data to the frontend needs to be
    // told what the ordering key to use on the data from the "outputDataSource"
    // should be.  We could use the "rank" if we wanted but the belief is the
    // user is more likely to prefer some type of alphabetical ordering.
    // (Although this email address ordering is probably not it!)
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
            test: 'datum.rank < 5'
          }
        ]
      }
    ]
  },
  frontend: {
    header: 'Prolific Authors',
    labelFrom: 'emailAddress',
    dataFrom: 'values',
    injectDataInto: 'bars',
    tocMetaData: [
      {
        table: 'scale-hack',
        sourceField: 'maxDaysAgo',
        targetField: 'x',
        otherValues: [0]
      }
    ],
    spec: {
      width: 180,
      height: 20,
      padding: 0,
      data: [
        {
          name: 'bars',
          values: []
        },
        {
          name: 'scale-hack',
          values: []
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
          type: 'rect',
          from: { data: 'bars' },
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

