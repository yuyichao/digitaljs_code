//

'use strict';

const path = require("path");
const webpack = require('webpack');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

const outputDirectory = "dist";

function main_view_config(env, argv) {
    const devMode = argv.mode !== "production";
    return {
        name: 'main-view',
        entry: "./view/main.js",
        output: {
            path: path.join(__dirname, outputDirectory),
            filename: "view-bundle.js"
        },
        module: {
            rules: [
                {
                    test: /\.css$/,
                    use: [devMode ? "style-loader" : MiniCssExtractPlugin.loader, "css-loader"]
                },
                {
                    test: /\.scss$/,
                    use: [devMode ? "style-loader" : MiniCssExtractPlugin.loader, "css-loader",
                          "sass-loader"]
                },
                {
                    test: /\.(png|woff|woff2|eot|ttf|svg)$/,
                    type: 'asset/inline'
                },
                {
                    test: require.resolve('jquery'),
                    loader: 'expose-loader',
                    options: {
                        exposes: ['$']
                    }
                },
            ]
        },
        resolve: {
            alias: {
                [path.resolve(__dirname, './node_modules/digitaljs/src/engines/worker-worker.mjs')]: false
            }
        },
        plugins: [
        ].concat(devMode ? [] : [new MiniCssExtractPlugin()]),
    };
}

function status_view_config(env, argv) {
    const devMode = argv.mode !== "production";
    return {
        name: 'status-view',
        entry: "./view/status_view.js",
        output: {
            path: path.join(__dirname, outputDirectory),
            filename: "status_view.js"
        },
        module: {
            rules: [
                {
                    test: require.resolve('jquery'),
                    loader: 'expose-loader',
                    options: {
                        exposes: ['$']
                    }
                },
            ]
        },
        plugins: [
        ],
    };
}

function synth_view_config(env, argv) {
    const devMode = argv.mode !== "production";
    return {
        name: 'synth-view',
        entry: "./view/synth_view.js",
        output: {
            path: path.join(__dirname, outputDirectory),
            filename: "synth_view.js"
        },
        plugins: [
        ],
    };
}

function digitaljs_worker_config(env, argv) {
    const devMode = argv.mode !== "production";
    return {
        name: 'web_worker',
        target: 'webworker',
        entry: "./node_modules/digitaljs/src/engines/worker-worker.mjs",
        output: {
            path: path.join(__dirname, outputDirectory),
            filename: "digitaljs-sym-worker.js"
        },
        plugins: [
            new webpack.optimize.LimitChunkCountPlugin({
                maxChunks: 1
            })
        ]
    };
}

function web_ext_config(env, argv) {
    const devMode = argv.mode !== "production";
    return {
        name: 'web-ext',
        target: 'webworker',
        entry: {
            extension: "./extension.js",
        },
        output: {
            path: path.join(__dirname, outputDirectory),
            filename: "web-extension.js",
            libraryTarget: 'commonjs',
            devtoolModuleFilenameTemplate: '../../[resource-path]'
        },
        resolve: {
            alias: {
                path: require.resolve('path-browserify'),
                crypto: require.resolve('crypto-browserify'),
                stream: require.resolve('stream-browserify'),
            },
            fallback: {
                https: false
            }
        },
        module: {
            rules: [
            ]
        },
        plugins: [
            new webpack.ProvidePlugin({
                process: 'process/browser' // provide a shim for the global `process` variable
            })
        ],
        externals: {
            vscode: 'commonjs vscode' // ignored because it doesn't exist
        },
    };
}

function local_ext_config(env, argv) {
    const devMode = argv.mode !== "production";
    return {
        name: 'local-ext',
        target: 'node',
        entry: {
            extension: "./extension.js",
        },
        output: {
            path: path.join(__dirname, outputDirectory),
            filename: "local-extension.js",
            libraryTarget: 'commonjs',
            devtoolModuleFilenameTemplate: '../../[resource-path]'
        },
        module: {
            rules: [
            ]
        },
        plugins: [
        ],
        externals: {
            vscode: 'commonjs vscode' // ignored because it doesn't exist
        },
    };
}

module.exports = [main_view_config, status_view_config, synth_view_config,
                  digitaljs_worker_config, web_ext_config, local_ext_config];
