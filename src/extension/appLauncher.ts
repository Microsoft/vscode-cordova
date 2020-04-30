// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { ICordovaLaunchRequestArgs, CordovaDebugSession } from "../debugger/cordovaDebugSession";
import { CordovaProjectHelper, IProjectType } from "../utils/cordovaProjectHelper";
import { TelemetryHelper } from "../utils/telemetryHelper";


export class AppLauncher {
    public async launch(launchArgs: ICordovaLaunchRequestArgs): Promise<void> {
        return new Promise<void>((resolve, reject) => this.initializeTelemetry(launchArgs.cwd)
        .then(() => TelemetryHelper.generate("launch", (generator) => {
            launchArgs.port = launchArgs.port || 9222;
            if (!launchArgs.target) {
                if (launchArgs.platform === "browser") {
                    launchArgs.target = "chrome";
                } else {
                    launchArgs.target = "emulator";
                }
                this.outputLogger(`Parameter target is not set - ${launchArgs.target} will be used`);
            }
            generator.add("target", CordovaDebugSession.getTargetType(launchArgs.target), false);
            launchArgs.cwd = CordovaProjectHelper.getCordovaProjectRoot(launchArgs.cwd);
            if (launchArgs.cwd === null) {
                throw new Error("Current working directory doesn't contain a Cordova project. Please open a Cordova project as a workspace root and try again.");
            }
            launchArgs.timeout = launchArgs.attachTimeout;

            let platform = launchArgs.platform && launchArgs.platform.toLowerCase();

            TelemetryHelper.sendPluginsList(launchArgs.cwd, CordovaProjectHelper.getInstalledPlugins(launchArgs.cwd));

            return Q.all([
                TelemetryHelper.determineProjectTypes(launchArgs.cwd),
                CordovaDebugSession.getRunArguments(launchArgs.cwd),
                CordovaDebugSession.getCordovaExecutable(launchArgs.cwd),
            ]).then(([projectType, runArguments, cordovaExecutable]) => {
                launchArgs.cordovaExecutable = launchArgs.cordovaExecutable || cordovaExecutable;
                launchArgs.env = CordovaProjectHelper.getEnvArgument(launchArgs);
                generator.add("projectType", projectType, false);
                this.outputLogger(`Launching for ${platform} (This may take a while)...`);

                switch (platform) {
                    case "android":
                        generator.add("platform", platform, false);
                        if (this.isSimulateTarget(launchArgs.target)) {
                            return this.launchSimulate(launchArgs, projectType, generator);
                        } else {
                            return this.launchAndroid(launchArgs, projectType, runArguments);
                        }
                    case "ios":
                        generator.add("platform", platform, false);
                        if (this.isSimulateTarget(launchArgs.target)) {
                            return this.launchSimulate(launchArgs, projectType, generator);
                        } else {
                            return this.launchIos(launchArgs, projectType, runArguments);
                        }
                    case "windows":
                        generator.add("platform", platform, false);
                        if (this.isSimulateTarget(launchArgs.target)) {
                            return this.launchSimulate(launchArgs, projectType, generator);
                        } else {
                            throw new Error(`Debugging ${platform} platform is not supported.`);
                        }
                    case "serve":
                        generator.add("platform", platform, false);
                        return this.launchServe(launchArgs, projectType, runArguments);
                    // https://github.com/apache/cordova-serve/blob/4ad258947c0e347ad5c0f20d3b48e3125eb24111/src/util.js#L27-L37
                    case "amazon_fireos":
                    case "blackberry10":
                    case "firefoxos":
                    case "ubuntu":
                    case "wp8":
                    case "browser":
                        generator.add("platform", platform, false);
                        return this.launchSimulate(launchArgs, projectType, generator);
                    default:
                        generator.add("unknownPlatform", platform, true);
                        throw new Error(`Unknown Platform: ${platform}`);
                }
            }).catch((err) => {
                this.outputLogger(err.message || err, true);
                return this.cleanUp().then(() => {
                    throw err;
                });
            }).then(() => {
                // For the browser platforms, we call super.launch(), which already attaches. For other platforms, attach here
                if (platform !== "serve" && platform !== "browser" && !this.isSimulateTarget(launchArgs.target)) {
                    return this.session.customRequest("attach", launchArgs);
                }
            });
        }).done(resolve, reject))
        .catch(err => {
            this.outputLogger(err.message || err, true);
            reject(err);
        }));
    }

    private launchAndroid(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType, runArguments: string[]): Q.Promise<void> {
        let workingDirectory = launchArgs.cwd;

        // Prepare the command line args
        let isDevice = launchArgs.target.toLowerCase() === "device";
        let args = ["run", "android"];

        if (launchArgs.runArguments && launchArgs.runArguments.length > 0) {
            args.push(...launchArgs.runArguments);
        } else if (runArguments && runArguments.length) {
            args.push(...runArguments);
        } else {
            args.push(isDevice ? "--device" : "--emulator", "--verbose");
            if (["device", "emulator"].indexOf(launchArgs.target.toLowerCase()) === -1) {
                args.push(`--target=${launchArgs.target}`);
            }

            // Verify if we are using Ionic livereload
            if (launchArgs.ionicLiveReload) {
                if (CordovaProjectHelper.isIonicAngularProjectByProjectType(projectType)) {
                    // Livereload is enabled, let Ionic do the launch
                    args.push("--livereload");
                } else {
                    this.outputLogger(CordovaDebugSession.NO_LIVERELOAD_WARNING);
                }
            }
        }

        if (args.indexOf("--livereload") > -1) {
            return this.startIonicDevServer(launchArgs, args).then(() => void 0);
        }
        const command = launchArgs.cordovaExecutable || CordovaProjectHelper.getCliCommand(workingDirectory);
        let cordovaResult = cordovaRunCommand(command, args, launchArgs.env, workingDirectory).then((output) => {
            let runOutput = output[0];
            let stderr = output[1];

            // Ionic ends process with zero code, so we need to look for
            // strings with error content to detect failed process
            let errorMatch = /(ERROR.*)/.test(runOutput) || /error:.*/i.test(stderr);
            if (errorMatch) {
                throw new Error(`Error running android`);
            }

            this.outputLogger("App successfully launched");
        }, undefined, (progress) => {
            this.outputLogger(progress[0], progress[1]);
        });

        return cordovaResult;
    }
}
