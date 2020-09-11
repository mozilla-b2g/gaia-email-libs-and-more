/**
 * This is the glodastrophe webpack script whittled down.
 */

var webpack = require('webpack');
var path = require('path');
var buildPath = path.resolve(__dirname, 'build');
var nodeModulesPath = path.resolve(__dirname, 'node_modules');
var TransferWebpackPlugin = require('transfer-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');

var config = {
  mode: 'development',
  entry: {
    main: path.resolve(__dirname, 'js/main.jsx'),
  },
  // Render source-map file for final build
  devtool: 'source-map',
  resolve: {
    modules: [
      path.resolve(__dirname, 'js'),
      "node_modules"
    ],
    extensions: [".js", ".jsx"],
  },
  //output config
  output: {
    path: buildPath,    //Path of output file
    filename: '[name].js',  //Name of output file
    globalObject: 'globalThis'
  },
  plugins: [
    new CleanWebpackPlugin(),
    //Minify the bundle
    /*
    new webpack.optimize.UglifyJsPlugin({
      compress: {
        //supresses warnings, usually from module minification
        warnings: false
      }
    }),
    */
    // This prevents a million billion unique hash bundles from being created,
    // but it would be better to have explicitly named chunks since there is the
    // intent that account types are dynamically loaded.  This may result in
    // wanting 1-3 chunks per account type in the worker.
    new webpack.optimize.LimitChunkCountPlugin({
      maxChunks: 1
    }),
    //Allows error warnings but does not stop compiling. Will remove when eslint is added
    //new webpack.NoErrorsPlugin(),
    //Transfer Files
    new TransferWebpackPlugin([
      { from: 'static', to: '' },
    ], __dirname),
    new webpack.DefinePlugin({
      "process.env": {
        NODE_ENV: JSON.stringify("production")
      }
    })
  ],
  module: {
    // Most of these aren't necessary for logic but leaving intact for now.
    rules: [
      // don't attempt to process the viz.js compiled file...
      {
        test: /\.render\.js$/,
        use: ['file-loader']
      },
      {
        test: /\.jsx$/,
        exclude: /node_modules/,
        loader: 'babel-loader'
      },
      {
        test: /\.css$/,
        use: [
          'style-loader',
          'css-loader'
        ]
      },
      {
        test: /\.ftl$/i,
        use: 'raw-loader',
      },
      {
        test: /\.worker\.js$/,
        loader: 'worker-loader',
        options: {
          name: 'gelam-worker.js'
        }
      },
      // "url" loader works like "file" loader except that it embeds assets
      // smaller than specified limit in bytes as data URLs to avoid requests.
      // A missing `test` is equivalent to a match.
      {
        test: [/\.bmp$/, /\.gif$/, /\.jpe?g$/, /\.png$/],
        loader: require.resolve('url-loader'),
        options: {
          limit: 10000,
          name: 'static/media/[name].[hash:8].[ext]',
        },
      },
      // "file" loader makes sure assets end up in the `build` folder.
      // When you `import` an asset, you get its filename.
      {
        test: [/\.eot$/, /\.ttf$/, /\.svg$/, /\.woff$/, /\.woff2$/],
        loader: require.resolve('file-loader'),
        options: {
          name: 'static/media/[name].[hash:8].[ext]',
        },
      },
    ]
  },
};

module.exports = config;
