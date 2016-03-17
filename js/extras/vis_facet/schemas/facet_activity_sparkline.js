define(function() {
'use strict';

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
return {
  name: 'Activity Sparkline',
  provider: 'vis_facet',
  type: 'facet',

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
            max: 60,
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
            test: 'datum.rank < 10'
          }
        ]
      }
    ]
  },
  frontend: {
    labelFrom: 'emailAddress',
    dataFrom: 'values',
    injectDataInto: 'bars',
    spec: {
      width: 60,
      height: 20,
      padding: 0,
      data: {
        name: 'bars'
      },
      // we might need to let the backend calculate scales and propagate them
      // through as tocMeta.
      scales: [
        {
          name: 'x',
          type: 'linear',
          domain: [60, 0], // daysAgo, so we want 0 on the right.
          range: 'width',
        },
        {
          name: 'y',
          type: 'linear',
          domain: [0, 10],
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
              x2: { scale: 'x2', field: 'bin_end' },
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
});
