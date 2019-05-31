// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

var child_process = require('child_process');
var fs = require('fs');
var gulp = require('gulp');
var mocha = require('gulp-mocha');
var sourcemaps = require('gulp-sourcemaps');
var ts = require('gulp-typescript');
var log = require('gulp-util').log;
var os = require('os');
var path = require('path');
var Q = require('q');
var typescript = require('typescript');
var libtslint = require('tslint');
var tslint = require('gulp-tslint');
var del = require('del');
var webpack = require("webpack-stream");

function executeCordovaCommand(cwd, command) {
    var cordovaCmd = os.platform() === 'darwin' ? 'cordova' : 'cordova.cmd';
    var commandToExecute = cordovaCmd + ' ' + command;
    return executeCommand(cwd, commandToExecute);
}

function executeCommand(cwd, commandToExecute) {
    var deferred = Q.defer();
    var process = child_process.exec(commandToExecute, { cwd: cwd }, (error, stdout, stderr) => {
        if (error) {
            console.error('An error occurred: ' + error);
            return;
        }
        console.log(stderr);
        console.log(stdout);
    });
    process.on('error', function (err) {
        console.log('Command failed with error: ' + err);
        deferred.reject(err);
    });
    process.stdout.on('close', function (exitCode) {
        if (exitCode) {
            console.log('Command failed with exit code ' + exitCode);
            deferred.reject(exitCode);
        }
        else {
            deferred.resolve({});
        }
    });
    return deferred.promise;
}

var sources = [
    'src/**/*.ts'
];

var tests = [
    'test/debugger/**/*.ts',
    'test/*.ts'
];

var tsConfig = require('./tsconfig.json');
var projectConfig = tsConfig.compilerOptions;
projectConfig.typescript = typescript;

function fixSources() {
    return sourcemaps.mapSources(function(sourcePath) {
        return sourcePath.replace('..', '.');
    });
}

gulp.task('compile-src', function () {
    return gulp.src(sources, { base: '.' })
        // .pipe(sourcemaps.init())
        // .pipe(ts(projectConfig))
        // .pipe(fixSources())
        .pipe(webpack(require("./webpack.config.js")))
        .pipe(sourcemaps.write('.', { includeContent: false, sourceRoot: __dirname }))
        .pipe(gulp.dest('out/src'));
});

gulp.task('compile-test', function () {
    return gulp.src(tests, { base: '.' })
        .pipe(sourcemaps.init())
        .pipe(ts(projectConfig))
        .pipe(fixSources())
        .pipe(sourcemaps.write('.', { includeContent: false, sourceRoot: __dirname }))
        .pipe(gulp.dest('out'));
});

gulp.task('tslint-src', function () {
    var program = libtslint.Linter.createProgram('./tsconfig.json');
    return gulp.src(sources, { base: '.' })
        .pipe(tslint({
            formatter: 'verbose',
            program: program
        }))
        .pipe(tslint.report());
});

gulp.task('tslint-test', function () {
    var program = libtslint.Linter.createProgram('./tsconfig.json');
    return gulp.src(tests, { base: '.' })
        .pipe(tslint({
            formatter: 'verbose',
            program: program
        }))
        .pipe(tslint.report());
});

gulp.task('build-src', gulp.series('compile-src', 'tslint-src'));
gulp.task('build-test', gulp.series('compile-test', 'tslint-test'));
gulp.task('build', gulp.series('build-src', 'build-test'));
gulp.task('tslint', gulp.series('tslint-src', 'tslint-test'));

gulp.task('watch', gulp.series('build', function (cb) {
    log('Watching build sources...');
    return gulp.watch(sources, gulp.series('build'));
}));

gulp.task('run-test', function () {
    return gulp.src('out/test/debugger/**/*.js', { read: false })
        .pipe(mocha({ ui: 'bdd' }))
        .on('error', function (e) {
            log(e ? e.toString() : 'error in test task!');
            this.emit('end');
        });
});

gulp.task('test', gulp.series('build-test', 'run-test'));

gulp.task('prepare-integration-tests', gulp.series('build', function () {
    return executeCordovaCommand(path.resolve(__dirname, 'test', 'testProject'), 'plugin add cordova-plugin-file');
}));

gulp.task('watch-build-test', gulp.series('build', 'run-test', function () {
        return gulp.watch(sources, gulp.series('build', 'run-test'));
    })
);

gulp.task('release', function () {
    var licenseFiles = ['LICENSE.txt', 'ThirdPartyNotices.txt'];
    var backupFolder = path.resolve(path.join(os.tmpdir(), 'vscode-cordova'));
    if (!fs.existsSync(backupFolder)) {
        fs.mkdirSync(backupFolder);
    }

    return Q({})
        .then(function () {
            /* back up LICENSE.txt, ThirdPartyNotices.txt, README.md */
            console.log('Backing up license files to ' + backupFolder + '...');
            licenseFiles.forEach(function (fileName) {
                fs.writeFileSync(path.join(backupFolder, fileName), fs.readFileSync(fileName));
            });

            /* copy over the release package license files */
            console.log('Preparing license files for release...');
            fs.writeFileSync('LICENSE.txt', fs.readFileSync('release/releaselicense.txt'));
            fs.writeFileSync('ThirdPartyNotices.txt', fs.readFileSync('release/release3party.txt'));
        }).then(() => {
            console.log('Creating release package...');
            return executeCommand(path.resolve(__dirname), 'vsce package');
        }).finally(function () {
            /* restore backed up files */
            console.log('Restoring modified files...');
            licenseFiles.forEach(function (fileName) {
                fs.writeFileSync(path.join(__dirname, fileName), fs.readFileSync(path.join(backupFolder, fileName)));
            });
        });
});

gulp.task('clean-src', function () {
    var pathsToDelete = [
        'out/src/',
    ]
    return del(pathsToDelete, { force: true });
});

gulp.task('clean-test', function () {
    var pathsToDelete = [
        'out/test/',
    ]
    return del(pathsToDelete, { force: true });
});

gulp.task('clean', gulp.series('clean-src', 'clean-test'));

gulp.task('default', gulp.series('clean', 'build', 'run-test'));
