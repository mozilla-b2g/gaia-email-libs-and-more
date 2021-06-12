/**
 * Lightly modified version of facet_activity_sparkline altered to aggregate
 * based on sender domain rather than specific email addresses.  Really it's
 * just some label changes plus the change in "gather" and "extract".
 */
export default {
  name: 'Domain Activity Sparkline',
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
        authorDomain: true
      },
    },
    inputDataSource: 'messages',
    outputDataSource: 'topAuthors',
    extractFrom: 'messages',
    extract: {
      msgId: ['message', 'id'],
      emailAddress: ['authorDomain'],
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
    header: 'Prolific Domains',
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

