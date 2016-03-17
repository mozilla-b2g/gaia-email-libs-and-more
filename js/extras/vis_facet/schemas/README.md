This directory contains various example schemas that are all intended to work
with a stock GELAM back-end.  They are wrapped into JS script files rather than
JSON files for current bundling simplicity and consistency across both AMD and
webpack loaders.  Since both support loader plugins, we can also probably switch
to a text or JSON loader module if we don't entirely punt on the issue and make
it the app's responsibility to manage such schemas.

Note that these are currently "super schemas" in that they are made up of:
* The back-end Vega data transforms to run to create data sources that will be
  shipped to the front end where they will be visualized.
* The actual Vega visualization to run on the front-end.  (Possibly multiple
  times if faceting is at play.)

The alternate implementation considered was to use normal Vega schemas for each
visualization and extract the data-transforms that need to be run on the
back-end.  This may still be viable and a better idea, but it'd arguably still
be an experimental hack, albeit a more confusing hack because of the inherent
schema mutation.  Ideally things will become more obvious or once we have a
basic prototype working we can ask intelligent questions since we'll know our
needs better.
