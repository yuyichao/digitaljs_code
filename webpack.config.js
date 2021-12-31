const path = require("path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

const outputDirectory = "dist";

module.exports = (env, argv) => {
    const devMode = argv.mode !== "production";
    return {
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
        plugins: [
        ].concat(devMode ? [] : [new MiniCssExtractPlugin()]),
    };
};
