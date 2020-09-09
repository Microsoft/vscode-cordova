// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

const child_process = require("child_process");
const fs = require("fs");
const gulp = require("gulp");
const mocha = require("gulp-mocha");
const sourcemaps = require("gulp-sourcemaps");
const ts = require("gulp-typescript");
const log = require("fancy-log");
const os = require("os");
const path = require("path");
const Q = require("q");
const typescript = require("typescript");
const libtslint = require("tslint");
const tslint = require("gulp-tslint");
const del = require("del");
const nls = require("vscode-nls-dev");
const vscodeTest = require("vscode-test");
const webpack = require("webpack");
const filter = require("gulp-filter");
const minimist = require("minimist");
const es = require("event-stream");

function executeCordovaCommand(cwd, command) {
  var cordovaCmd = os.platform() === "darwin" ? "cordova" : "cordova.cmd";
  var commandToExecute = cordovaCmd + " " + command;
  return executeCommand(cwd, commandToExecute);
}

function executeCommand(cwd, commandToExecute) {
  var deferred = Q.defer();
  var process = child_process.exec(
    commandToExecute,
    { cwd: cwd },
    (error, stdout, stderr) => {
      if (error) {
        console.error("An error occurred: " + error);
        return;
      }
      console.log(stderr);
      console.log(stdout);
    }
  );
  process.on("error", function (err) {
    console.log("Command failed with error: " + err);
    deferred.reject(err);
  });
  process.stdout.on("close", function (exitCode) {
    if (exitCode) {
      console.log("Command failed with exit code " + exitCode);
      deferred.reject(exitCode);
    } else {
      deferred.resolve({});
    }
  });
  return deferred.promise;
}

var sources = ["src/**/*.ts"];

const buildDir = "src";
const distDir = "dist";
const distSrcDir = `${distDir}/src`;

var tests = ["test/debugger/**/*.ts", "test/*.ts"];

const tsProject = ts.createProject("tsconfig.json");
const ExtensionName = "msjsdiag.vscode-cordova";
const translationProjectName = "vscode-extensions";
const defaultLanguages = [
  { id: "zh-tw", folderName: "cht", transifexId: "zh-hant" },
  { id: "zh-cn", folderName: "chs", transifexId: "zh-hans" },
  { id: "ja", folderName: "jpn" },
  { id: "ko", folderName: "kor" },
  { id: "de", folderName: "deu" },
  { id: "fr", folderName: "fra" },
  { id: "es", folderName: "esn" },
  { id: "ru", folderName: "rus" },
  { id: "it", folderName: "ita" },

  // These language-pack languages are included for VS but excluded from the vscode package
  { id: "cs", folderName: "csy" },
  { id: "tr", folderName: "trk" },
  { id: "pt-br", folderName: "ptb", transifexId: "pt-BR" },
  { id: "pl", folderName: "plk" },
];

var tsConfig = require("./tsconfig.json");
var projectConfig = tsConfig.compilerOptions;
projectConfig.typescript = typescript;

function fixSources() {
  return sourcemaps.mapSources(function (sourcePath) {
    return sourcePath.replace("..", ".");
  });
}

gulp.task("compile-src", function () {
  return gulp
    .src(sources, { base: "." })
    .pipe(sourcemaps.init())
    .pipe(ts(projectConfig))
    .pipe(fixSources())
    .pipe(nls.createMetaDataFiles())
    .pipe(nls.createAdditionalLanguageFiles(defaultLanguages, "i18n"))
    .pipe(nls.bundleMetaDataFiles(ExtensionName, "dist"))
    .pipe(nls.bundleLanguageFiles())
    .pipe(
      sourcemaps.write(".", { includeContent: false, sourceRoot: __dirname })
    )
    .pipe(gulp.dest("out"));
});

gulp.task("compile-test", function () {
  return gulp
    .src(tests, { base: "." })
    .pipe(sourcemaps.init())
    .pipe(ts(projectConfig))
    .pipe(fixSources())
    .pipe(
      sourcemaps.write(".", { includeContent: false, sourceRoot: __dirname })
    )
    .pipe(gulp.dest("out"));
});

gulp.task("tslint-src", function () {
  var program = libtslint.Linter.createProgram("./tsconfig.json");
  return gulp
    .src(sources, { base: "." })
    .pipe(
      tslint({
        formatter: "verbose",
        program: program,
      })
    )
    .pipe(tslint.report());
});

gulp.task("tslint-test", function () {
  var program = libtslint.Linter.createProgram("./tsconfig.json");
  return gulp
    .src(tests, { base: "." })
    .pipe(
      tslint({
        formatter: "verbose",
        program: program,
      })
    )
    .pipe(tslint.report());
});

gulp.task("build-src", gulp.series("compile-src", "tslint-src"));
gulp.task("build-test", gulp.series("compile-test", "tslint-test"));
gulp.task("build", gulp.series("build-src", "build-test"));
gulp.task("tslint", gulp.series("tslint-src", "tslint-test"));

async function runWebpack({
  packages = [],
  devtool = false,
  compileInPlace = false,
  mode = process.argv.includes("watch") ? "development" : "production",
} = options) {
  let configs = [];
  for (const { entry, library, filename } of packages) {
    const config = {
      mode,
      target: "node",
      entry: path.resolve(entry),
      output: {
        path: compileInPlace
          ? path.resolve(path.dirname(entry))
          : path.resolve(distDir),
        filename: filename || path.basename(entry).replace(".js", ".bundle.js"),
        devtoolModuleFilenameTemplate: "../[resource-path]",
      },
      devtool: devtool,
      resolve: {
        extensions: [".js", ".ts", ".json"],
      },
      module: {
        rules: [
          {
            test: /\.ts$/,
            exclude: /node_modules/,
            use: [
              {
                // vscode-nls-dev loader:
                // * rewrite nls-calls
                loader: "vscode-nls-dev/lib/webpack-loader",
                options: {
                  base: path.join(__dirname),
                },
              },
              {
                // configure TypeScript loader:
                // * enable sources maps for end-to-end source maps
                loader: "ts-loader",
                options: {
                  compilerOptions: {
                    sourceMap: true,
                  },
                },
              },
            ],
          },
        ],
      },
      node: {
        __dirname: false,
        __filename: false,
      },
      externals: {
        vscode: "commonjs vscode",
        "cordova-simulate": "commonjs cordova-simulate",
      },
    };

    if (library) {
      config.output.libraryTarget = "commonjs2";
    }

    if (process.argv.includes("--analyze-size")) {
      config.plugins = [
        new (require("webpack-bundle-analyzer").BundleAnalyzerPlugin)({
          analyzerMode: "static",
          reportFilename: path.resolve(
            distSrcDir,
            path.basename(entry) + ".html"
          ),
        }),
      ];
    }

    configs.push(config);
  }

  await new Promise((resolve, reject) =>
    webpack(configs, (err, stats) => {
      if (err) {
        reject(err);
      } else if (stats.hasErrors()) {
        reject(stats);
      } else {
        resolve();
      }
    })
  );
}

// Generates ./dist/nls.bundle.<language_id>.json from files in ./i18n/** *//<src_path>/<filename>.i18n.json
// Localized strings are read from these files at runtime.
const generateSrcLocBundle = () => {
  // Transpile the TS to JS, and let vscode-nls-dev scan the files for calls to localize.
  return tsProject
    .src()
    .pipe(sourcemaps.init())
    .pipe(tsProject())
    .js.pipe(nls.createMetaDataFiles())
    .pipe(nls.createAdditionalLanguageFiles(defaultLanguages, "i18n"))
    .pipe(nls.bundleMetaDataFiles(ExtensionName, "dist"))
    .pipe(nls.bundleLanguageFiles())
    .pipe(
      filter([
        "out/nls.bundle.*.json",
        "out/nls.metadata.header.json",
        "out/nls.metadata.json",
      ])
    )
    .pipe(gulp.dest("dist"));
};

gulp.task("webpack-bundle", async () => {
  const packages = [
    {
      entry: `${buildDir}/cordova.ts`,
      filename: "cordova-extension.js",
      library: true,
    },
  ];
  return runWebpack({ packages });
});

gulp.task(
  "watch",
  gulp.series("build", function (cb) {
    log("Watching build sources...");
    return gulp.watch(sources, gulp.series("build"));
  })
);

gulp.task("run-test", async function () {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = __dirname;
    // The path to the extension test runner script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, "out", "test", "index");
    console.log(extensionTestsPath);
    // Download VS Code, unzip it and run the integration test
    await vscodeTest.runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch (err) {
    console.error(err);
    console.error("Failed to run tests");
    process.exit(1);
  }
});

gulp.task("test", gulp.series("build-test", "run-test"));

gulp.task(
  "prepare-integration-tests",
  gulp.series("build", function () {
    return executeCordovaCommand(
      path.resolve(__dirname, "test", "testProject"),
      "plugin add cordova-plugin-file"
    );
  })
);

gulp.task(
  "watch-build-test",
  gulp.series("build", "run-test", function () {
    return gulp.watch(sources, gulp.series("build", "run-test"));
  })
);

function readJson(file) {
  const contents = fs
    .readFileSync(path.join(__dirname, file), "utf-8")
    .toString();
  return JSON.parse(contents);
}

function writeJson(file, jsonObj) {
  const content = JSON.stringify(jsonObj, null, 2);
  fs.writeFileSync(path.join(__dirname, file), content);
}

gulp.task("release", function () {
  var backupFiles = ["LICENSE.txt", "ThirdPartyNotices.txt", "package.json"];
  var backupFolder = path.resolve(path.join(os.tmpdir(), "vscode-cordova"));
  if (!fs.existsSync(backupFolder)) {
    fs.mkdirSync(backupFolder);
  }

  return Q({})
    .then(function () {
      /* back up LICENSE.txt, ThirdPartyNotices.txt, README.md */
      console.log("Backing up license files to " + backupFolder + "...");
      backupFiles.forEach(function (fileName) {
        fs.writeFileSync(
          path.join(backupFolder, fileName),
          fs.readFileSync(fileName)
        );
      });

      /* copy over the release package license files */
      console.log("Preparing license files for release...");
      fs.writeFileSync("LICENSE.txt", fs.readFileSync("release/LICENSE.txt"));
      fs.writeFileSync(
        "ThirdPartyNotices.txt",
        fs.readFileSync("release/ThirdPartyNotices.txt")
      );
    })
    .then(() => {
      let packageJson = readJson("package.json");
      packageJson.main = "./dist/cordova-extension";
      writeJson("package.json", packageJson);
      log("Creating release package...");
      console.log("Creating release package...");
      return executeCommand(path.resolve(__dirname), "vsce package");
    })
    .finally(function () {
      /* restore backed up files */
      console.log("Restoring modified files...");
      backupFiles.forEach(function (fileName) {
        fs.writeFileSync(
          path.join(__dirname, fileName),
          fs.readFileSync(path.join(backupFolder, fileName))
        );
      });
    });
});

gulp.task("clean-src", function () {
  var pathsToDelete = ["out/src/"];
  return del(pathsToDelete, { force: true });
});

gulp.task("clean-test", function () {
  var pathsToDelete = ["out/test/"];
  return del(pathsToDelete, { force: true });
});

gulp.task("clean", gulp.series("clean-src", "clean-test"));

gulp.task(
  "prod-build",
  gulp.series("clean", "webpack-bundle", generateSrcLocBundle)
);

gulp.task("default", gulp.series("clean", "prod-build"));

// Creates package.i18n.json files for all languages from {workspaceRoot}/i18n folder into project root
gulp.task("add-i18n", () => {
  return gulp
    .src(["package.nls.json"])
    .pipe(nls.createAdditionalLanguageFiles(defaultLanguages, "i18n"))
    .pipe(gulp.dest("."));
});

// Creates MLCP readable .xliff file and saves it locally
gulp.task(
  "translations-export",
  gulp.series("build", function runTranslationExport() {
    return gulp
      .src([
        "package.nls.json",
        "./out/nls.metadata.header.json",
        "./out/nls.metadata.json",
      ])
      .pipe(nls.createXlfFiles(translationProjectName, ExtensionName))
      .pipe(
        gulp.dest(
          path.join("..", `${translationProjectName}-localization-export`)
        )
      );
  })
);

// Imports localization from raw localized MLCP strings to VS Code .i18n.json files
gulp.task(
  "translations-import",
  gulp.series((done) => {
    var options = minimist(process.argv.slice(2), {
      string: "location",
      default: {
        location: "../vscode-translations-import",
      },
    });
    es.merge(
      defaultLanguages.map((language) => {
        let id = language.transifexId || language.id;
        log(
          path.join(
            options.location,
            id,
            "vscode-extensions",
            `${ExtensionName}.xlf`
          )
        );
        return gulp
          .src(
            path.join(
              options.location,
              id,
              "vscode-extensions",
              `${ExtensionName}.xlf`
            )
          )
          .pipe(nls.prepareJsonFiles())
          .pipe(gulp.dest(path.join("./i18n", language.folderName)));
      })
    ).pipe(
      es.wait(() => {
        done();
      })
    );
  }, "add-i18n")
);
