// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.


import * as child_process from "child_process";
import * as elementtree from "elementtree";
import * as fs from "fs";
import * as http from "http";
import * as io from "socket.io-client";
import * as messaging from "../common/extensionMessaging";
import * as os from "os";
import * as path from "path";
import * as Q from "q";
import * as simulate from "cordova-simulate";

import {DebugProtocol} from "vscode-debugprotocol";
import {OutputEvent} from "vscode-debugadapter";
import {ChromeDebugAdapter, IAttachRequestArgs, IChromeDebugSessionOpts, ICommonRequestArgs, ChromeDebugSession, ISourceMapPathOverrides, utils as ChromeDebugCoreUtils} from "vscode-chrome-debug-core";
import {Protocol as Crdp} from "devtools-protocol";
import {CordovaIosDeviceLauncher} from "./cordovaIosDeviceLauncher";
import {cordovaRunCommand, cordovaStartCommand, execCommand, killChildProcess} from "./extension";
import {CordovaPathTransformer} from "./cordovaPathTransformer";
import {CordovaProjectHelper} from "../utils/cordovaProjectHelper";
import {ISimulateTelemetryProperties, TelemetryHelper, TelemetryGenerator} from "../utils/telemetryHelper";
import {IProjectType} from "../utils/cordovaProjectHelper";
import {settingsHome} from "../utils/settingsHelper";
import {Telemetry} from "../utils/telemetry";
import {SimulationInfo} from "../common/simulationInfo";

const MISSING_API_ERROR = "Debugger.setAsyncCallStackDepth";
const ANDROID_MANIFEST_PATH = path.join("platforms", "android", "AndroidManifest.xml");
const ANDROID_MANIFEST_PATH_8 = path.join("platforms", "android", "app", "src", "main", "AndroidManifest.xml");

export interface ICordovaAttachRequestArgs extends DebugProtocol.AttachRequestArguments, IAttachRequestArgs {
    cwd: string; /* Automatically set by VS Code to the currently opened folder */
    platform: string;
    target?: string;
    webkitRangeMin?: number;
    webkitRangeMax?: number;
    attachAttempts?: number;
    attachDelay?: number;
    simulatorInExternalBrowser?: boolean;
}

export interface ICordovaLaunchRequestArgs extends DebugProtocol.LaunchRequestArguments, ICordovaAttachRequestArgs {
    iosDebugProxyPort?: number;
    appStepLaunchTimeout?: number;

    // Ionic livereload properties
    ionicLiveReload?: boolean;
    devServerPort?: number;
    devServerAddress?: string;
    devServerTimeout?: number;

    // Chrome debug properties
    url?: string;
    userDataDir?: string;
    runtimeExecutable?: string;
    runtimeArgs?: string[];

    // Cordova-simulate properties
    simulatePort?: number;
    livereload?: boolean;
    forceprepare?: boolean;
    simulateTempDir?: string;
    corsproxy?: boolean;
    runArguments?: string[];
    cordovaExecutable?: string;
    envFile?: string;
    env?: any;
}

export interface ICordovaCommonRequestArgs extends ICommonRequestArgs {
    // Workaround to suit interface ICommonRequestArgs with launch.json cwd argument
    cwd?: string;
}

const WIN_APPDATA = process.env.LOCALAPPDATA || "/";
const DEFAULT_CHROME_PATH = {
    LINUX: "/usr/bin/google-chrome",
    OSX: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    WIN: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    WIN_LOCALAPPDATA: path.join(WIN_APPDATA, "Google\\Chrome\\Application\\chrome.exe"),
    WINx86: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
};
const DEFAULT_CHROMIUM_PATH = {
    LINUX: "/usr/bin/chromium-browser",
    OSX: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    WIN: "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    WIN_LOCALAPPDATA: path.join(WIN_APPDATA, "Chromium\\Application\\chrome.exe"),
    WINx86: "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
};
// `RSIDZTW<NL` are process status codes (as per `man ps`), skip them
const PS_FIELDS_SPLITTER_RE = /\s+(?:[RSIDZTW<NL]\s+)?/;

enum TargetType {
    Emulator = "emulator",
    Device = "device",
    Chrome = "chrome",
}

// Keep in sync with sourceMapPathOverrides package.json default values
const DefaultWebSourceMapPathOverrides: ISourceMapPathOverrides = {
    "webpack:///./~/*": "${cwd}/node_modules/*",
    "webpack:///./*": "${cwd}/*",
    "webpack:///*": "*",
    "webpack:///src/*": "${cwd}/*",
};

export class CordovaDebugAdapter extends ChromeDebugAdapter {
    private static CHROME_DATA_DIR = "chrome_sandbox_dir"; // The directory to use for the sandboxed Chrome instance that gets launched to debug the app
    private static NO_LIVERELOAD_WARNING = "Warning: Ionic live reload is currently only supported for Ionic 1 projects. Continuing deployment without Ionic live reload...";
    private static SIMULATE_TARGETS: string[] = ["default", "chrome", "chromium", "edge", "firefox", "ie", "opera", "safari"];
    private static pidofNotFoundError = "/system/bin/sh: pidof: not found";
    private static simulatorWebsocketPipe: child_process.ChildProcess;

    private outputLogger: (message: string, error?: boolean | string) => void;
    private adbPortForwardingInfo: { targetDevice: string, port: number };
    private ionicLivereloadProcess: child_process.ChildProcess;
    private ionicDevServerUrls: string[];
    private cordovaPathTransformer: CordovaPathTransformer;
    private previousLaunchArgs: ICordovaLaunchRequestArgs;
    private previousAttachArgs: ICordovaAttachRequestArgs;
    private simulateDebugHost: SocketIOClient.Socket;
    private telemetryInitialized: boolean;
    private attachedDeferred: Q.Deferred<void>;


    private chromeProc: child_process.ChildProcess;

    public constructor(opts: IChromeDebugSessionOpts, debugSession: ChromeDebugSession) {
        super(opts, debugSession);
        // Bit of a hack, but chrome-debug-adapter-core no longer provides a way to access the transformer.
        this.cordovaPathTransformer = (<any>global).cordovaPathTransformer;
        this.telemetryInitialized = false;
        this.outputLogger = (message: string, error?: boolean | string) => {
            let category = "console";
            if (error === true) {
                category = "stderr";
            }
            if (typeof error === "string") {
                category = error;
            }

            let newLine = "\n";
            if (category === "stdout" || category === "stderr") {
                newLine = "";
            }
            debugSession.sendEvent(new OutputEvent(message + newLine, category));
        };
        this.attachedDeferred = Q.defer<void>();
    }

    public static getRunArguments(projectRoot: string): Q.Promise<string[]> {
        return new messaging.ExtensionMessageSender(projectRoot).sendMessage(messaging.ExtensionMessage.GET_RUN_ARGUMENTS, [projectRoot]);
    }

    public static getCordovaExecutable(projectRoot: string): Q.Promise<string> {
        return new messaging.ExtensionMessageSender(projectRoot).sendMessage(messaging.ExtensionMessage.GET_CORDOVA_EXECUTABLE, [projectRoot]);
    }

    private static retryAsync<T>(func: () => Q.Promise<T>, condition: (result: T) => boolean, maxRetries: number, iteration: number, delay: number, failure: string): Q.Promise<T> {
        const retry = () => {
            if (iteration < maxRetries) {
                return Q.delay(delay).then(() => CordovaDebugAdapter.retryAsync(func, condition, maxRetries, iteration + 1, delay, failure));
            }

            throw new Error(failure);
        };

        return func()
            .then(result => {
                if (condition(result)) {
                    return result;
                }

                return retry();
            },
            retry);
    }

    private static getBrowserPath(target: string): string {
        const platform = ChromeDebugCoreUtils.getPlatform();
        let defaultPaths = target === "chromium" ? DEFAULT_CHROMIUM_PATH : DEFAULT_CHROME_PATH;
        if (platform === ChromeDebugCoreUtils.Platform.OSX) {
            return ChromeDebugCoreUtils.existsSync(defaultPaths.OSX) ? defaultPaths.OSX : null;
        } else if (platform === ChromeDebugCoreUtils.Platform.Windows) {
            if (ChromeDebugCoreUtils.existsSync(defaultPaths.WINx86)) {
                return defaultPaths.WINx86;
            } else if (ChromeDebugCoreUtils.existsSync(defaultPaths.WIN)) {
                return defaultPaths.WIN;
            } else if (ChromeDebugCoreUtils.existsSync(defaultPaths.WIN_LOCALAPPDATA)) {
                return defaultPaths.WIN_LOCALAPPDATA;
            } else {
                return null;
            }
        } else {
            return ChromeDebugCoreUtils.existsSync(defaultPaths.LINUX) ? defaultPaths.LINUX : null;
        }
    }

    /**
     * Target type for telemetry
     */
    private static getTargetType(target: string): string {
        if (/emulator/i.test(target)) {
            return TargetType.Emulator;
        }

        if (/chrom/i.test(target)) {
            return TargetType.Chrome;
        }

        return TargetType.Device;
    }

    public launch(launchArgs: ICordovaLaunchRequestArgs): Promise<void> {
        this.previousLaunchArgs = launchArgs;

        return new Promise<void>((resolve, reject) => this.initializeTelemetry(launchArgs.cwd)
            .then(() => TelemetryHelper.generate("launch", (generator) => {
                launchArgs.port = launchArgs.port || 9222;
                launchArgs.target = launchArgs.target || (launchArgs.platform === "browser" ? "chrome" : "emulator");
                generator.add("target", CordovaDebugAdapter.getTargetType(launchArgs.target), false);
                launchArgs.cwd = CordovaProjectHelper.getCordovaProjectRoot(launchArgs.cwd);

                let platform = launchArgs.platform && launchArgs.platform.toLowerCase();

                TelemetryHelper.sendPluginsList(launchArgs.cwd, CordovaProjectHelper.getInstalledPlugins(launchArgs.cwd));

                return Q.all([
                    TelemetryHelper.determineProjectTypes(launchArgs.cwd),
                    CordovaDebugAdapter.getRunArguments(launchArgs.cwd),
                    CordovaDebugAdapter.getCordovaExecutable(launchArgs.cwd),
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
                        return this.attach(launchArgs);
                    }
                });
            }).done(resolve, reject)));
    }

    public isSimulateTarget(target: string) {
        return CordovaDebugAdapter.SIMULATE_TARGETS.indexOf(target) > -1;
    }

    public attach(attachArgs: ICordovaAttachRequestArgs): Promise<void> {
        this.previousAttachArgs = attachArgs;

        return new Promise<void>((resolve, reject) => this.initializeTelemetry(attachArgs.cwd)
            .then(() => TelemetryHelper.generate("attach", (generator) => {
            attachArgs.port = attachArgs.port || 9222;
            attachArgs.target = attachArgs.target || "emulator";
            generator.add("target", CordovaDebugAdapter.getTargetType(attachArgs.target), false);
            attachArgs.cwd = CordovaProjectHelper.getCordovaProjectRoot(attachArgs.cwd);
            let platform = attachArgs.platform && attachArgs.platform.toLowerCase();

            TelemetryHelper.sendPluginsList(attachArgs.cwd, CordovaProjectHelper.getInstalledPlugins(attachArgs.cwd));

            return TelemetryHelper.determineProjectTypes(attachArgs.cwd)
                .then((projectType) => generator.add("projectType", projectType, false))
                .then(() => {
                    this.outputLogger(`Attaching to ${platform}`);
                    switch (platform) {
                        case "android":
                            generator.add("platform", platform, false);
                            return this.attachAndroid(attachArgs);
                        case "ios":
                            generator.add("platform", platform, false);
                            return this.attachIos(attachArgs);
                        default:
                            generator.add("unknownPlatform", platform, true);
                            throw new Error(`Unknown Platform: ${platform}`);
                    }
                }).then((processedAttachArgs: IAttachRequestArgs & { url?: string }) => {
                    this.outputLogger("Attaching to app.");
                    this.outputLogger("", true); // Send blank message on stderr to include a divider between prelude and app starting
                    return super.attach(processedAttachArgs)
                        .catch((err) => {
                            if (err.message && err.message.indexOf(MISSING_API_ERROR) > -1) {
                                // Bug in `vscode-chrome-debug-core` calling unimplemented method Debugger.setAsyncCallStackDepth
                                // just ignore it
                                // https://github.com/Microsoft/vscode-cordova/issues/297
                                return void 0;
                            }
                            throw err;
                        })
                        .then(() => {
                            // Safari remote inspector protocol requires setBreakpointsActive
                            // method to be called for breakpoints to work (see #193 and #247)
                            // In case of error do not reject promise but continue debugging
                            super.chrome.Debugger.setBreakpointsActive({ active: true })
                                .catch(() => this.outputLogger("Failed to call \"setBreakpointsActive\" of debugging frontend. Debugging will continue..."));

                            this.attachedDeferred.resolve(void 0);
                        });
                });
        }).catch((err) => {
            this.outputLogger(err.message || err.format || err, true);

            return this.cleanUp().then(() => {
                throw err;
            });
        }).done(resolve, reject)));
    }

    public disconnect(): void {
        this.cleanUp();
        return super.disconnect({});
    }

    public commonArgs(args: ICordovaCommonRequestArgs): void {
        // If we specify skipFileRegExps or skipFiles then vscode-chrome-debug-core attempts to call Debugger.setBlackboxPatterns
        // however in older targets that API is not implemented, and results in errors.
        args.skipFileRegExps = args.skipFiles = null;
        if (args.cwd && (!args.pathMapping || !args.pathMapping["/"])) {
            args.pathMapping = args.pathMapping || {};
            args.pathMapping["/"] = args.cwd;
        }

        args.sourceMaps = typeof args.sourceMaps === "undefined" || args.sourceMaps;
        args.sourceMapPathOverrides = this.getSourceMapPathOverrides(args.cwd, args.sourceMapPathOverrides);
        super.commonArgs(args);
    }

    protected onScriptParsed(script: Crdp.Debugger.ScriptParsedEvent): Promise<void> {
        let sourceMapsEnabled = this.previousLaunchArgs && this.previousLaunchArgs.sourceMaps || this.previousAttachArgs && this.previousAttachArgs.sourceMaps;

        if (sourceMapsEnabled && !script.sourceMapURL && path.extname(script.url) === ".js") {
            // Browsers don't always report source maps for scripts, so even though no source map was reported for this script, parse it in case it has a sourceMappingUrl attribute.
            let clientPath = this.cordovaPathTransformer.getClientPath(script.url);

            if (clientPath) {
                let scriptContent = fs.readFileSync(clientPath).toString();
                let parsedSrcMapUrl = this.findSourceAttribute("sourceMappingURL", scriptContent);

                if (parsedSrcMapUrl) {
                    script.sourceMapURL = parsedSrcMapUrl;
                }
            }
        }

        return super.onScriptParsed(script);
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
                if (projectType.ionic || projectType.ionic2 || projectType.ionic4) {
                    // Livereload is enabled, let Ionic do the launch
                    args.push("--livereload");
                } else {
                    this.outputLogger(CordovaDebugAdapter.NO_LIVERELOAD_WARNING);
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

    private attachAndroid(attachArgs: ICordovaAttachRequestArgs): Q.Promise<IAttachRequestArgs> {
        let errorLogger = (message: string) => this.outputLogger(message, true);
        // Determine which device/emulator we are targeting

        // For devices we look for "device" string but skip lines with "emulator"
        const deviceFilter = (line: string) => /\w+\tdevice/.test(line) && !/emulator/.test(line);
        const emulatorFilter = (line: string) => /device/.test(line) && /emulator/.test(line);

        let adbDevicesResult: Q.Promise<string> = this.runAdbCommand(["devices"], errorLogger)
            .then<string>((devicesOutput) => {

                const targetFilter = attachArgs.target.toLowerCase() === "device" ? deviceFilter :
                    attachArgs.target.toLowerCase() === "emulator" ? emulatorFilter :
                        (line: string) => line.match(attachArgs.target);

                const result = devicesOutput.split("\n")
                    .filter(targetFilter)
                    .map(line => line.replace(/\tdevice/, "").replace("\r", ""))[0];

                if (!result) {
                    errorLogger(devicesOutput);
                    throw new Error(`Unable to find target ${attachArgs.target}`);
                }

                return result;
            }, (err: Error): any => {
                let errorCode: string = (<any>err).code;
                if (errorCode && errorCode === "ENOENT") {
                    throw new Error("Unable to find adb. Please ensure it is in your PATH and re-open Visual Studio Code");
                }

                throw err;
            });

        let packagePromise: Q.Promise<string> = Q.nfcall(fs.readFile, path.join(attachArgs.cwd, ANDROID_MANIFEST_PATH))
            .catch((err) => {
                if (err && err.code === "ENOENT") {
                    return Q.nfcall(fs.readFile, path.join(attachArgs.cwd, ANDROID_MANIFEST_PATH_8));
                }
                throw err;
            })
            .then((manifestContents) => {
                let parsedFile = elementtree.XML(manifestContents.toString());
                let packageKey = "package";
                return parsedFile.attrib[packageKey];
            });

        return Q.all([packagePromise, adbDevicesResult])
            .spread((appPackageName: string, targetDevice: string) => {
            let pidofCommandArguments = ["-s", targetDevice, "shell", "pidof", appPackageName];
            let getPidCommandArguments = ["-s", targetDevice, "shell", "ps"];
            let getSocketsCommandArguments = ["-s", targetDevice, "shell", "cat /proc/net/unix"];

            let findAbstractNameFunction = () =>
                // Get the pid from app package name
                this.runAdbCommand(pidofCommandArguments, errorLogger)
                    .then((pid) => {
                        if (pid && /^[0-9]+$/.test(pid.trim())) {
                            return pid.trim();
                        }

                        throw Error(CordovaDebugAdapter.pidofNotFoundError);

                    }).catch((err) => {
                        if (err.message !== CordovaDebugAdapter.pidofNotFoundError) {
                            return;
                        }

                        return this.runAdbCommand(getPidCommandArguments, errorLogger)
                            .then((psResult) => {
                                const lines = psResult.split("\n");
                                const keys = lines.shift().split(PS_FIELDS_SPLITTER_RE);
                                const nameIdx = keys.indexOf("NAME");
                                const pidIdx = keys.indexOf("PID");
                                for (const line of lines) {
                                    const fields = line.trim().split(PS_FIELDS_SPLITTER_RE).filter(field => !!field);
                                    if (fields.length < nameIdx) {
                                        continue;
                                    }
                                    if (fields[nameIdx] === appPackageName) {
                                        return fields[pidIdx];
                                    }
                                }
                            });
                    })
                    // Get the "_devtools_remote" abstract name by filtering /proc/net/unix with process inodes
                    .then(pid =>
                        this.runAdbCommand(getSocketsCommandArguments, errorLogger)
                            .then((getSocketsResult) => {
                                const lines = getSocketsResult.split("\n");
                                const keys = lines.shift().split(/[\s\r]+/);
                                const flagsIdx = keys.indexOf("Flags");
                                const stIdx = keys.indexOf("St");
                                const pathIdx = keys.indexOf("Path");
                                for (const line of lines) {
                                    const fields = line.split(/[\s\r]+/);
                                    if (fields.length < 8) {
                                        continue;
                                    }
                                    // flag = 00010000 (16) -> accepting connection
                                    // state = 01 (1) -> unconnected
                                    if (fields[flagsIdx] !== "00010000" || fields[stIdx] !== "01") {
                                        continue;
                                    }
                                    const pathField = fields[pathIdx];
                                    if (pathField.length < 1 || pathField[0] !== "@") {
                                        continue;
                                    }
                                    if (pathField.indexOf("_devtools_remote") === -1) {
                                        continue;
                                    }

                                    if (pathField === `@webview_devtools_remote_${pid}`) {
                                        // Matches the plain cordova webview format
                                        return pathField.substr(1);
                                    }

                                    if (pathField === `@${appPackageName}_devtools_remote`) {
                                        // Matches the crosswalk format of "@PACKAGENAME_devtools_remote
                                        return pathField.substr(1);
                                    }
                                    // No match, keep searching
                                }
                            })
                    );

            return CordovaDebugAdapter.retryAsync(findAbstractNameFunction, (match) => !!match, 5, 1, 5000, "Unable to find localabstract name of cordova app")
                .then((abstractName) => {
                    // Configure port forwarding to the app
                    let forwardSocketCommandArguments = ["-s", targetDevice, "forward", `tcp:${attachArgs.port}`, `localabstract:${abstractName}`];
                    this.outputLogger("Forwarding debug port");
                    return this.runAdbCommand(forwardSocketCommandArguments, errorLogger).then(() => {
                        this.adbPortForwardingInfo = { targetDevice, port: attachArgs.port };
                    });
                });
        }).then(() => {
            let args: IAttachRequestArgs = JSON.parse(JSON.stringify(attachArgs));
            return args;
        });
    }

    private launchIos(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType, runArguments: string[]): Q.Promise<void> {
        if (os.platform() !== "darwin") {
            return Q.reject<void>("Unable to launch iOS on non-mac machines");
        }
        let workingDirectory = launchArgs.cwd;
        let errorLogger = (message) => this.outputLogger(message, true);

        this.outputLogger("Launching app (This may take a while)...");

        let iosDebugProxyPort = launchArgs.iosDebugProxyPort || 9221;
        let appStepLaunchTimeout = launchArgs.appStepLaunchTimeout || 5000;

        const command = launchArgs.cordovaExecutable || CordovaProjectHelper.getCliCommand(workingDirectory);
        // Launch the app
        if (launchArgs.target.toLowerCase() === "device") {
            // Workaround for dealing with new build system in XCode 10
            // https://github.com/apache/cordova-ios/issues/407
            let args = ["build", "ios", "--buildFlag=-UseModernBuildSystem=0"];
            if (projectType.ionic || projectType.ionic2 || projectType.ionic4)
                args = ["build", "ios", "--", "--buildFlag=-UseModernBuildSystem=0"];

            if (launchArgs.runArguments && launchArgs.runArguments.length > 0) {
                args.push(...launchArgs.runArguments);
            } else if (runArguments && runArguments.length) {
                args.push(...runArguments);
            } else {
                args.push("--device");
                // Verify if we are using Ionic livereload
                if (launchArgs.ionicLiveReload) {
                    if (projectType.ionic || projectType.ionic2 || projectType.ionic4) {
                        // Livereload is enabled, let Ionic do the launch
                        args = ["run", "ios", "--device", "--livereload"];
                    } else {
                        this.outputLogger(CordovaDebugAdapter.NO_LIVERELOAD_WARNING);
                    }
                }
            }

            if (args.indexOf("--livereload") > -1) {
                if (args[0] === "build") {
                    args[0] = "run";
                }
                return this.startIonicDevServer(launchArgs, args).then(() => void 0);
            }

            // cordova run ios does not terminate, so we do not know when to try and attach.
            // Instead, we try to launch manually using homebrew.
            return cordovaRunCommand(command, args, launchArgs.env, workingDirectory).then(() => {
                let buildFolder = path.join(workingDirectory, "platforms", "ios", "build", "device");

                this.outputLogger("Installing app on device");

                let installPromise = Q.nfcall(fs.readdir, buildFolder).then((files: string[]) => {
                    let ipaFiles = files.filter((file) => /\.ipa$/.test(file));

                    if (ipaFiles.length !== 0) {
                        return path.join(buildFolder, ipaFiles[0]);
                    }

                    // No .ipa was found, look for a .app to convert to .ipa using xcrun
                    let appFiles = files.filter((file) => /\.app$/.test(file));

                    if (appFiles.length === 0) {
                        throw new Error("Unable to find a .app or a .ipa to install");
                    }

                    let appFile = path.join(buildFolder, appFiles[0]);
                    let ipaFile = path.join(buildFolder, path.basename(appFile, path.extname(appFile)) + ".ipa"); // Convert [path]/foo.app to [path]/foo.ipa
                    let execArgs = ["-v", "-sdk", "iphoneos", "PackageApplication", `${appFile}`, "-o", `${ipaFile}`];

                    return execCommand("xcrun", execArgs, errorLogger).then(() => ipaFile).catch((): string => {
                        throw new Error(`Error converting ${path.basename(appFile)} to .ipa`);
                    });
                }).then((ipaFile: string) => {
                    return execCommand("ideviceinstaller", ["-i", ipaFile], errorLogger).catch((err: Error): any => {
                        let errorCode: string = (<any>err).code;
                        if (errorCode && errorCode === "ENOENT") {
                            throw new Error("Unable to find ideviceinstaller. Please ensure it is in your PATH and re-open Visual Studio Code");
                        }
                        throw err;
                    });
                });

                return Q.all([CordovaIosDeviceLauncher.getBundleIdentifier(workingDirectory), installPromise]);
            }, undefined, (progress) => {
                this.outputLogger(progress[0], progress[1]);
            }).spread((appBundleId) => {
                // App is now built and installed. Try to launch
                this.outputLogger("Launching app");
                return CordovaIosDeviceLauncher.startDebugProxy(iosDebugProxyPort).then(() => {
                    return CordovaIosDeviceLauncher.startApp(appBundleId, iosDebugProxyPort, appStepLaunchTimeout);
                });
            }).then(() => void (0));
        } else {
            let target = launchArgs.target.toLowerCase() === "emulator" ? null : launchArgs.target;
            // Workaround for dealing with new build system in XCode 10
            // https://github.com/apache/cordova-ios/issues/407
            let args = ["emulate", "ios", "--buildFlag=-UseModernBuildSystem=0"];
            if (projectType.ionic || projectType.ionic2 || projectType.ionic4)
                args = ["emulate", "ios", "--", "--buildFlag=-UseModernBuildSystem=0"];

            if (launchArgs.runArguments && launchArgs.runArguments.length > 0) {
                args.push(...launchArgs.runArguments);
            } else if (runArguments && runArguments.length) {
                args.push(...runArguments);
            } else {
                if (target) {
                    args.push("--target=" + target);
                }
                // Verify if we are using Ionic livereload
                if (launchArgs.ionicLiveReload) {
                    if (projectType.ionic || projectType.ionic2 || projectType.ionic4) {
                        // Livereload is enabled, let Ionic do the launch
                        args.push("--livereload");
                    } else {
                        this.outputLogger(CordovaDebugAdapter.NO_LIVERELOAD_WARNING);
                    }
                }
            }

            if (args.indexOf("--livereload") > -1) {
                return this.startIonicDevServer(launchArgs, args).then(() => void 0);
            }

            return cordovaRunCommand(command, args, launchArgs.env, workingDirectory)
                .progress((progress) => {
                    this.outputLogger(progress[0], progress[1]);
                }).catch((err) => {
                    if (target) {
                        return cordovaRunCommand(command, ["emulate", "ios", "--list"], launchArgs.env, workingDirectory).then((output) => {
                            // List out available targets
                            errorLogger("Unable to run with given target.");
                            errorLogger(output[0].replace(/\*+[^*]+\*+/g, "")); // Print out list of targets, without ** RUN SUCCEEDED **
                            throw err;
                        });
                    }

                    throw err;
                });
        }
    }

    private attachIos(attachArgs: ICordovaAttachRequestArgs): Q.Promise<IAttachRequestArgs> {
        attachArgs.webkitRangeMin = attachArgs.webkitRangeMin || 9223;
        attachArgs.webkitRangeMax = attachArgs.webkitRangeMax || 9322;
        attachArgs.attachAttempts = attachArgs.attachAttempts || 20;
        attachArgs.attachDelay = attachArgs.attachDelay || 1000;
        // Start the tunnel through to the webkit debugger on the device
        this.outputLogger("Configuring debugging proxy");

        const retry = function<T> (func, condition, retryCount): Q.Promise<T> {
            return CordovaDebugAdapter.retryAsync(func, condition, retryCount, 1, attachArgs.attachDelay, "Unable to find webview");
        };

        const getBundleIdentifier = (): Q.IWhenable<string> => {
            if (attachArgs.target.toLowerCase() === "device") {
                return CordovaIosDeviceLauncher.getBundleIdentifier(attachArgs.cwd)
                    .then(CordovaIosDeviceLauncher.getPathOnDevice)
                    .then(path.basename);
            } else {
                return Q.nfcall(fs.readdir, path.join(attachArgs.cwd, "platforms", "ios", "build", "emulator")).then((entries: string[]) => {
                    let filtered = entries.filter((entry) => /\.app$/.test(entry));
                    if (filtered.length > 0) {
                        return filtered[0];
                    } else {
                        throw new Error("Unable to find .app file");
                    }
                });
            }
        };

        const getIosSimulatorWebInspectorSocket = (): string => {
            const WEBINSPECTOR_SOCKET_REGEXP = /\s+(\S+com\.apple\.webinspectord_sim\.socket)/;
            // lsof -aUc launchd_sim
            // gives a set of records like:
            //   launchd_s 69760 isaac    3u  unix 0x57aa4fceea3937f3      0t0      /private/tmp/com.apple.CoreSimulator.SimDevice.D7082A5C-34B5-475C-994E-A21534423B9E/syslogsock
            //   launchd_s 69760 isaac    5u  unix 0x57aa4fceea395f03      0t0      /private/tmp/com.apple.launchd.2B2u8CkN8S/Listeners
            //   launchd_s 69760 isaac    6u  unix 0x57aa4fceea39372b      0t0      ->0x57aa4fceea3937f3
            //   launchd_s 69760 isaac    8u  unix 0x57aa4fceea39598b      0t0      /private/tmp/com.apple.launchd.2j5k1TMh6i/com.apple.webinspectord_sim.socket
            //   launchd_s 69760 isaac    9u  unix 0x57aa4fceea394c43      0t0      /private/tmp/com.apple.launchd.4zm9JO9KEs/com.apple.testmanagerd.unix-domain.socket
            //   launchd_s 69760 isaac   10u  unix 0x57aa4fceea395f03      0t0      /private/tmp/com.apple.launchd.2B2u8CkN8S/Listeners
            //   launchd_s 69760 isaac   11u  unix 0x57aa4fceea39598b      0t0      /private/tmp/com.apple.launchd.2j5k1TMh6i/com.apple.webinspectord_sim.socket
            //   launchd_s 69760 isaac   12u  unix 0x57aa4fceea394c43      0t0      /private/tmp/com.apple.launchd.4zm9JO9KEs/com.apple.testmanagerd.unix-domain.socket
            // these _appear_ to always be grouped together (so, the records for the particular sim are all in a group, before the next sim, etc.)
            // so starting from the correct UDID, we ought to be able to pull the next record with `com.apple.webinspectord_sim.socket` to get the correct socket
            let stdout: string = "";
            let findSimulatorEntriesProcess = child_process.spawnSync("lsof", ["-aUc", "launchd_sim"], {
                stdio: "pipe",
                encoding: "utf-8",
            });
            stdout = findSimulatorEntriesProcess.output[1].toString();

            const match = WEBINSPECTOR_SOCKET_REGEXP.exec(stdout);
            if (!match) {
                return null;
            }
            let webInspectorSocket = match[1];
            return webInspectorSocket;
        };

        const getSimulatorProxyPort = (packagePath): Q.IWhenable<{ packagePath: string; targetPort: number }> => {
            return this.promiseGet(`http://localhost:${attachArgs.port}/json`, "Unable to communicate with ios_webkit_debug_proxy").then((response: string) => {
                try {
                    if (attachArgs.target.toLowerCase() !== "device") {
                        let simulatorSocket = getIosSimulatorWebInspectorSocket();
                        if (CordovaDebugAdapter.simulatorWebsocketPipe) {
                            CordovaDebugAdapter.simulatorWebsocketPipe.kill();
                            CordovaDebugAdapter.simulatorWebsocketPipe = null;
                        }
                        CordovaDebugAdapter.simulatorWebsocketPipe = child_process.spawn(`mkfifo myfifo & nc -lkv 27753 <myfifo | nc -Uv ${simulatorSocket} >myfifo`);
                    }
                    let endpointsList = JSON.parse(response);
                    let devices = endpointsList.filter((entry) =>
                        attachArgs.target.toLowerCase() === "device" ? entry.deviceId !== "SIMULATOR"
                            : entry.deviceId === "SIMULATOR"
                    );
                    let device = devices[0];
                    // device.url is of the form 'localhost:port'
                    return {
                        packagePath,
                        targetPort: parseInt(device.url.split(":")[1], 10),
                    };
                } catch (e) {
                    throw new Error("Unable to find iOS target device/simulator. Please check that \"Settings > Safari > Advanced > Web Inspector = ON\" or try specifying a different \"port\" parameter in launch.json");
                }
            });
        };

        const findWebViews = ({ packagePath, targetPort }) => {
            return retry(() =>
                this.promiseGet(`http://localhost:${targetPort}/json`, "Unable to communicate with target")
                    .then((response: string) => {
                        try {
                            const webviewsList = JSON.parse(response);
                            const foundWebViews = webviewsList.filter((entry) => {
                                if (this.ionicDevServerUrls) {
                                    return this.ionicDevServerUrls.some(url => entry.url.indexOf(url) === 0);
                                } else {
                                    return entry.url.indexOf(encodeURIComponent(packagePath)) !== -1;
                                }
                            });
                            if (!foundWebViews.length && webviewsList.length === 1) {
                                this.outputLogger("Unable to find target app webview, trying to fallback to the only running webview");
                                return {
                                    relevantViews: webviewsList,
                                    targetPort,
                                };
                            }
                            if (!foundWebViews.length) {
                                throw new Error("Unable to find target app");
                            }
                            return {
                                relevantViews: foundWebViews,
                                targetPort,
                            };
                        } catch (e) {
                            throw new Error("Unable to find target app");
                        }
                    }), (result) => result.relevantViews.length > 0, 5);
        };

        const getAttachRequestArgs = (): Q.Promise<IAttachRequestArgs> =>
            CordovaIosDeviceLauncher.startWebkitDebugProxy(attachArgs.port, attachArgs.webkitRangeMin, attachArgs.webkitRangeMax)
                .then(getBundleIdentifier)
                .then(getSimulatorProxyPort)
                .then(findWebViews)
                .then(({ relevantViews, targetPort }) => {
                    return { port: targetPort, url: relevantViews[0].url };
                })
                .then(({ port, url }) => {
                    const args: IAttachRequestArgs = JSON.parse(JSON.stringify(attachArgs));
                    args.port = port;
                    args.url = url;
                    return args;
                });

        return retry(getAttachRequestArgs, () => true, attachArgs.attachAttempts);
    }

    private launchSimulate(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType, generator: TelemetryGenerator): Q.Promise<any> {
        let simulateTelemetryPropts: ISimulateTelemetryProperties = {
            platform: launchArgs.platform,
            target: launchArgs.target,
            port: launchArgs.port,
            simulatePort: launchArgs.simulatePort,
        };

        if (launchArgs.hasOwnProperty("livereload")) {
            simulateTelemetryPropts.livereload = launchArgs.livereload;
        }

        if (launchArgs.hasOwnProperty("forceprepare")) {
            simulateTelemetryPropts.forceprepare = launchArgs.forceprepare;
        }

        generator.add("simulateOptions", simulateTelemetryPropts, false);

        let messageSender = new messaging.ExtensionMessageSender(launchArgs.cwd);
        let simulateInfo: SimulationInfo;

        let getEditorsTelemetry = messageSender.sendMessage(messaging.ExtensionMessage.GET_VISIBLE_EDITORS_COUNT)
            .then((editorsCount) => {
                generator.add("visibleTextEditors", editorsCount, false);
            }).catch((e) => {
                this.outputLogger("Could not read the visible text editors. " + this.getErrorMessage(e));
            });

        let launchSimulate = Q(void 0)
            .then(() => {
                let simulateOptions = this.convertLaunchArgsToSimulateArgs(launchArgs);
                return messageSender.sendMessage(messaging.ExtensionMessage.START_SIMULATE_SERVER, [launchArgs.cwd, simulateOptions, projectType]);
            }).then((simInfo: SimulationInfo) => {
                simulateInfo = simInfo;
                return this.connectSimulateDebugHost(simulateInfo);
            }).then(() => {
                launchArgs.userDataDir = path.join(settingsHome(), CordovaDebugAdapter.CHROME_DATA_DIR);
                return messageSender.sendMessage(messaging.ExtensionMessage.LAUNCH_SIM_HOST, [launchArgs.cwd, launchArgs.target]);
            }).then(() => {
                // Launch Chrome and attach
                launchArgs.url = simulateInfo.appHostUrl;
                this.outputLogger("Attaching to app");

                return this.launchChrome(launchArgs);
            }).catch((e) => {
                this.outputLogger("An error occurred while attaching to the debugger. " + this.getErrorMessage(e));
                throw e;
            }).then(() => void 0);

        return Q.all([launchSimulate, getEditorsTelemetry]);
    }

    private resetSimulateViewport(): Q.Promise<void> {
        return this.attachedDeferred.promise.then(() =>
            this.chrome.Emulation.clearDeviceMetricsOverride()
        ).then(() =>
            this.chrome.Emulation.setEmulatedMedia({media: ""})
        ).then(() =>
            this.chrome.Emulation.resetPageScaleFactor()
        );
    }

    private changeSimulateViewport(data: simulate.ResizeViewportData): Q.Promise<void> {
        return this.attachedDeferred.promise.then(() =>
            this.chrome.Emulation.setDeviceMetricsOverride({
                width: data.width,
                height: data.height,
                deviceScaleFactor: 0,
                mobile: true,
            })
        );
    }

    private connectSimulateDebugHost(simulateInfo: SimulationInfo): Q.Promise<void> {
        // Connect debug-host to cordova-simulate
        let viewportResizeFailMessage = "Viewport resizing failed. Please try again.";
        let simulateDeferred: Q.Deferred<void> = Q.defer<void>();

        let simulateConnectErrorHandler = (err: any): void => {
            this.outputLogger(`Error connecting to the simulated app.`);
            simulateDeferred.reject(err);
        };

        this.simulateDebugHost = io.connect(simulateInfo.urlRoot);
        this.simulateDebugHost.on("connect_error", simulateConnectErrorHandler);
        this.simulateDebugHost.on("connect_timeout", simulateConnectErrorHandler);
        this.simulateDebugHost.on("connect", () => {
            this.simulateDebugHost.on("resize-viewport", (data: simulate.ResizeViewportData) => {
                this.changeSimulateViewport(data).catch(() => {
                    this.outputLogger(viewportResizeFailMessage, true);
                }).done();
            });
            this.simulateDebugHost.on("reset-viewport", () => {
                this.resetSimulateViewport().catch(() => {
                    this.outputLogger(viewportResizeFailMessage, true);
                }).done();
            });
            this.simulateDebugHost.emit("register-debug-host", { handlers: ["reset-viewport", "resize-viewport"] });
            simulateDeferred.resolve(void 0);
        });

        return simulateDeferred.promise;
    }

    private convertLaunchArgsToSimulateArgs(launchArgs: ICordovaLaunchRequestArgs): simulate.SimulateOptions {
        let result: simulate.SimulateOptions = {};

        result.platform = launchArgs.platform;
        result.target = launchArgs.target;
        result.port = launchArgs.simulatePort;
        result.livereload = launchArgs.livereload;
        result.forceprepare = launchArgs.forceprepare;
        result.simulationpath = launchArgs.simulateTempDir;
        result.corsproxy = launchArgs.corsproxy;

        return result;
    }

    private launchServe(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType, runArguments: string[]): Q.Promise<void> {
        let errorLogger = (message) => this.outputLogger(message, true);

        // Currently, "ionic serve" is only supported for Ionic projects
        if (!projectType.ionic && !projectType.ionic2 && !projectType.ionic4) {
            let errorMessage = "Serving to the browser is currently only supported for Ionic projects";

            errorLogger(errorMessage);

            return Q.reject<void>(new Error(errorMessage));
        }

        let args = ["serve"];

        if (launchArgs.runArguments && launchArgs.runArguments.length > -1) {
            args.push(...launchArgs.runArguments);
        } else if (runArguments && runArguments.length) {
            args.push(...runArguments);
        } else {
            // Set up "ionic serve" args
            args.push("--nobrowser");

            if (!launchArgs.ionicLiveReload) {
                args.push("--nolivereload");
            }
        }


        // Deploy app to browser
        return Q(void 0).then(() => {
            return this.startIonicDevServer(launchArgs, args);
        }).then((devServerUrls: string[]) => {
            // Prepare Chrome launch args
            launchArgs.url = devServerUrls[0];
            launchArgs.userDataDir = path.join(settingsHome(), CordovaDebugAdapter.CHROME_DATA_DIR);

            // Launch Chrome and attach
            this.outputLogger("Attaching to app");
            return this.launchChrome(launchArgs);
        });
    }

    /**
     * Starts an Ionic livereload server ("serve" or "run / emulate --livereload"). Returns a promise fulfilled with the full URL to the server.
     */
    private startIonicDevServer(launchArgs: ICordovaLaunchRequestArgs, cliArgs: string[]): Q.Promise<string[]> {
        if (!launchArgs.runArguments || launchArgs.runArguments.length === 0) {
            if (launchArgs.devServerAddress) {
                cliArgs.push("--address", launchArgs.devServerAddress);
            }

            if (launchArgs.hasOwnProperty("devServerPort")) {
                if (typeof launchArgs.devServerPort === "number" && launchArgs.devServerPort >= 0 && launchArgs.devServerPort <= 65535) {
                    cliArgs.push("--port", launchArgs.devServerPort.toString());
                } else {
                    return Q.reject<string[]>(new Error("The value for \"devServerPort\" must be a number between 0 and 65535"));
                }
            }
        }

        let isServe: boolean = cliArgs[0] === "serve";
        let errorRegex: RegExp = /error:.*/i;
        let serverReady: boolean = false;
        let appReady: boolean = false;
        let serverReadyTimeout: number = launchArgs.devServerTimeout || 30000;
        let appReadyTimeout: number = launchArgs.devServerTimeout || 120000; // If we're not serving, the app needs to build and deploy (and potentially start the emulator), which can be very long
        let serverDeferred = Q.defer<void>();
        let appDeferred = Q.defer<string[]>();
        let serverOut: string = "";
        let serverErr: string = "";
        const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
        let getServerErrorMessage = (channel: string) => {
            let errorMatch = errorRegex.exec(channel);

            if (errorMatch) {
                return "Error in the Ionic live reload server:" + os.EOL + errorMatch[0];
            }

            return null;
        };

        let getRegexToResolveAppDefer = (cliArgs: string[]): RegExp => {
            // Now that the server is ready, listen for the app to be ready as well. For "serve", this is always true, because no build and deploy is involved. For android, we need to
            // wait until we encounter the "launch success", for iOS device, the server output is different and instead we need to look for:
            //
            // ios devices:
            // (lldb)     run
            // success
            //
            // ios simulators:
            // "build succeeded"

            let isIosDevice: boolean = cliArgs.indexOf("ios") !== -1 && cliArgs.indexOf("--device") !== -1;
            let isIosSimulator: boolean = cliArgs.indexOf("ios") !== -1 && cliArgs.indexOf("emulate") !== -1;
            let iosDeviceAppReadyRegex: RegExp = /\(lldb\)\W+run\r?\nsuccess/;
            let iosSimulatorAppReadyRegex: RegExp = /build succeeded/i;
            let appReadyRegex: RegExp = /launch success/i;

            if (isIosDevice) {
                return iosDeviceAppReadyRegex;
            }

            if (isIosSimulator) {
                return iosSimulatorAppReadyRegex;
            }

            return appReadyRegex;
        };

        const command = launchArgs.cordovaExecutable || CordovaProjectHelper.getCliCommand(launchArgs.cwd);

        this.ionicLivereloadProcess = cordovaStartCommand(command, cliArgs, launchArgs.env, launchArgs.cwd);
        this.ionicLivereloadProcess.on("error", (err: { code: string }) => {
            if (err.code === "ENOENT") {
                serverDeferred.reject(new Error("Ionic not found, please run 'npm install –g ionic' to install it globally"));
            } else {
                serverDeferred.reject(err);
            }
        });
        this.ionicLivereloadProcess.on("exit", (() => {
            this.ionicLivereloadProcess = null;

            let exitMessage: string = "The Ionic live reload server exited unexpectedly";
            let errorMsg = getServerErrorMessage(serverErr);

            if (errorMsg) {
                // The Ionic live reload server has an error; check if it is related to the devServerAddress to give a better message
                if (errorMsg.indexOf("getaddrinfo ENOTFOUND") !== -1 || errorMsg.indexOf("listen EADDRNOTAVAIL") !== -1) {
                    exitMessage += os.EOL + "Invalid address: please provide a valid IP address or hostname for the \"devServerAddress\" property in launch.json";
                } else {
                    exitMessage += os.EOL + errorMsg;
                }
            }

            if (!serverDeferred.promise.isPending() && !appDeferred.promise.isPending()) {
                // We are already debugging; disconnect the session
                this.outputLogger(exitMessage, true);
                this.disconnect();
                throw new Error(exitMessage);
            } else {
                // The Ionic dev server wasn't ready yet, so reject its promises
                serverDeferred.reject(new Error(exitMessage));
                appDeferred.reject(new Error(exitMessage));
            }
        }).bind(this));

        let serverOutputHandler = (data: Buffer) => {
            serverOut += data.toString();
            this.outputLogger(data.toString(), "stdout");

            // Listen for the server to be ready. We check for the "Running dev server:  http://localhost:<port>/" and "dev server running: http://localhost:<port>/" strings to decide that.

            // Example output of Ionic 1 dev server:
            //
            // [OK] Development server running!
            //      Local: http://localhost:8100
            //      External: http://10.0.75.1:8100, http://172.28.124.161:8100, http://169.254.80.80:8100, http://192.169.8.39:8100

            // Example output of Ionic 2 dev server:
            //
            // Running live reload server: undefined
            // Watching: 0=www/**/*, 1=!www/lib/**/*
            // Running dev server:  http://localhost:8100
            // Ionic server commands, enter:
            // restart or r to restart the client app from the root
            // goto or g and a url to have the app navigate to the given url
            // consolelogs or c to enable/disable console log output
            // serverlogs or s to enable/disable server log output
            // quit or q to shutdown the server and exit
            //
            // ionic $

            // Example output of Ionic dev server (for Ionic2):
            //
            // > ionic-hello-world@ ionic:serve <path>
            // > ionic-app-scripts serve "--v2" "--address" "0.0.0.0" "--port" "8100" "--livereload-port" "35729"
            // ionic-app-scripts
            // watch started
            // build dev started
            // clean started
            // clean finished
            // copy started
            // transpile started
            // transpile finished
            // webpack started
            // copy finished
            // webpack finished
            // sass started
            // sass finished
            // build dev finished
            // watch ready
            // dev server running: http://localhost:8100/

            const SERVER_URL_RE  = /(dev server running|Running dev server|Local):.*(http:\/\/.[^\s]*)/gmi;
            let localServerMatchResult = SERVER_URL_RE.exec(serverOut);
            if (!serverReady && localServerMatchResult) {
                serverReady = true;
                serverDeferred.resolve(void 0);
            }

            if (serverReady && !appReady) {
                let regex: RegExp = getRegexToResolveAppDefer(cliArgs);

                if (isServe || regex.test(serverOut)) {
                    appReady = true;
                    const serverUrls = [localServerMatchResult[2]];
                    const externalUrls = /External:\s(.*)$/im.exec(serverOut);
                    if (externalUrls) {
                        const urls = externalUrls[1].split(", ").map(x => x.trim());
                        serverUrls.push(...urls);
                    }
                    appDeferred.resolve(serverUrls);
                }
            }

            if (/Address Selection:/.test(serverOut)) {
                // Ionic does not know which address to use for the dev server, and requires human interaction; error out and let the user know
                let errorMessage: string = "Your machine has multiple network addresses. Please specify which one your device or emulator will use to communicate with the dev server by adding a \"devServerAddress\": \"ADDRESS\" property to .vscode/launch.json.";
                let addresses: string[] = [];
                let addressRegex = /(\d+\) .*)/gm;
                let match: string[] = addressRegex.exec(serverOut);

                while (match) {
                    addresses.push(match[1]);
                    match = addressRegex.exec(serverOut);
                }

                if (addresses) {
                    // Give the user the list of addresses that Ionic found
                    errorMessage += [" Available addresses:"].concat(addresses).join(os.EOL + " ");
                }

                serverDeferred.reject(new Error(errorMessage));
            }

            let errorMsg = getServerErrorMessage(serverOut);

            if (errorMsg) {
                appDeferred.reject(new Error(errorMsg));
            }
        };

        this.ionicLivereloadProcess.stdout.on("data", serverOutputHandler);
        this.ionicLivereloadProcess.stderr.on("data", (data: Buffer) => {
            serverErr += data.toString();

            let errorMsg = getServerErrorMessage(serverErr);

            if (errorMsg) {
                appDeferred.reject(new Error(errorMsg));
            }
        });
        this.outputLogger(`Starting Ionic dev server (live reload: ${launchArgs.ionicLiveReload})`);

        return serverDeferred.promise.timeout(serverReadyTimeout, `Starting the Ionic dev server timed out (${serverReadyTimeout} ms)`).then(() => {
            this.outputLogger("Building and deploying app");

            return appDeferred.promise.timeout(appReadyTimeout, `Building and deploying the app timed out (${appReadyTimeout} ms)`);
        }).then((ionicDevServerUrls: string[]) => {

            if (!ionicDevServerUrls || !ionicDevServerUrls.length) {
                return Q.reject<string[]>(new Error("Unable to determine the Ionic dev server address, please try re-launching the debugger"));
            }

            // The dev server address is the captured group at index 1 of the match
            this.ionicDevServerUrls = ionicDevServerUrls;

            // When ionic 2 cli is installed, output includes ansi characters for color coded output.
            this.ionicDevServerUrls = this.ionicDevServerUrls.map(url => url.replace(ansiRegex, ""));
            return Q(this.ionicDevServerUrls);
        });
    }

    private promiseGet(url: string, reqErrMessage: string): Q.Promise<string> {
        let deferred = Q.defer<string>();
        let req = http.get(url, function(res) {
            let responseString = "";
            res.on("data", (data: Buffer) => {
                responseString += data.toString();
            });
            res.on("end", () => {
                deferred.resolve(responseString);
            });
        });
        req.on("error", (err: Error) => {
            this.outputLogger(reqErrMessage);
            deferred.reject(err);
        });
        return deferred.promise;
    }

    private cleanUp(): Q.Promise<void> {
        const errorLogger = (message) => this.outputLogger(message, true);

        if (this.chromeProc) {
            this.chromeProc.kill("SIGINT");
            this.chromeProc = null;
        }

        // Clean up this session's attach and launch args
        this.previousLaunchArgs = null;
        this.previousAttachArgs = null;

        // Stop ADB port forwarding if necessary
        let adbPortPromise: Q.Promise<void>;

        if (this.adbPortForwardingInfo) {
            const adbForwardStopArgs =
                ["-s", this.adbPortForwardingInfo.targetDevice,
                    "forward",
                    "--remove", `tcp:${this.adbPortForwardingInfo.port}`];
            adbPortPromise = this.runAdbCommand(adbForwardStopArgs, errorLogger)
                .then(() => void 0);
        } else {
            adbPortPromise = Q<void>(void 0);
        }

        // Kill the Ionic dev server if necessary
        let killServePromise: Q.Promise<void>;

        if (this.ionicLivereloadProcess) {
            this.ionicLivereloadProcess.removeAllListeners("exit");
            killServePromise = killChildProcess(this.ionicLivereloadProcess).finally(() => {
                this.ionicLivereloadProcess = null;
            });
        } else {
            killServePromise = Q<void>(void 0);
        }

        // Clear the Ionic dev server URL if necessary
        if (this.ionicDevServerUrls) {
            this.ionicDevServerUrls = null;
        }

        // Close the simulate debug-host socket if necessary
        if (this.simulateDebugHost) {
            this.simulateDebugHost.close();
            this.simulateDebugHost = null;
        }

        // Wait on all the cleanups
        return Q.allSettled([adbPortPromise, killServePromise]).then(() => void 0);
    }

    private launchChrome(args: ICordovaLaunchRequestArgs): Promise<void> {
        return super.launch(args).then(() => {
            const chromePath: string = args.runtimeExecutable || CordovaDebugAdapter.getBrowserPath(args.target);
            if (!chromePath) {
                return Promise.reject(new Error(`Can't find Chrome - install it or set the "runtimeExecutable" field in the launch config.`));
            }

            const port = args.port || 9222;
            const chromeArgs: string[] = ["--remote-debugging-port=" + port];

            chromeArgs.push(...["--no-first-run", "--no-default-browser-check"]);
            if (args.runtimeArgs) {
                chromeArgs.push(...args.runtimeArgs);
            }

            if (args.userDataDir) {
                chromeArgs.push("--user-data-dir=" + args.userDataDir);
            }

            const launchUrl = args.url;
            chromeArgs.push(launchUrl);

            this.chromeProc = child_process.spawn(chromePath, chromeArgs, {
                detached: true,
                stdio: ["ignore"],
            });
            this.chromeProc.unref();
            this.chromeProc.on("error", (err) => {
                const errMsg = "Chrome error: " + err;
                this.terminateSession(errMsg);
            });

            return this.doAttach(port, launchUrl, args.address)
                .catch((err) => {
                    if (err.message && err.message.indexOf(MISSING_API_ERROR) > -1) {
                        // Bug in `vscode-chrome-debug-core` calling unimplemented method Debugger.setAsyncCallStackDepth
                        // just ignore it
                        // https://github.com/Microsoft/vscode-cordova/issues/297
                        return void 0;
                    }
                    throw err;
                })
                .then(() => {
                    this.attachedDeferred.resolve(void 0);
                });
        });
    }

    /**
     * Initializes telemetry.
     */
    private initializeTelemetry(projectRoot: string): Q.Promise<any> {
        if (!this.telemetryInitialized) {
            this.telemetryInitialized = true;
            let version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf-8")).version;
            // Enable telemetry, forced on for now.
            return Telemetry.init("cordova-tools-debug-adapter", version, { isExtensionProcess: false, projectRoot: projectRoot })
                .catch((e) => {
                    this.outputLogger("Could not initialize telemetry." + e.message || e.error || e.data || e);
                });
        } else {
            return Q.resolve(void 0);
        }
    }

    /**
     * Searches the specified code text for an attribute comment. Supported forms are line or
     * block comments followed by # (or @, though this is deprecated):
     * //# attribute=..., /*# attribute=... * /, //@ attribute=..., and /*@ attribute=... * /
     * @param attribute Name of the attribute to find
     * @param codeContent Source code to search for attribute comment
     * @return The attribute's value, or null if not exactly one is found
     */
    private findSourceAttribute(attribute: string, codeContent: string): string {
        if (codeContent) {
            let prefixes = ["//#", "/*#", "//@", "/*@"];
            let findString: string;
            let index = -1;
            let endIndex = -1;

            // Use pound-sign definitions first, but fall back to at-sign
            // The last instance of the attribute comment takes precedence
            for (let i = 0; index < 0 && i < prefixes.length; i++) {
                findString = "\n" + prefixes[i] + " " + attribute + "=";
                index = codeContent.lastIndexOf(findString);
            }

            if (index >= 0) {
                if (index >= 0) {
                    if (findString.charAt(2) === "*") {
                        endIndex = codeContent.indexOf("*/", index + findString.length);
                    } else {
                        endIndex = codeContent.indexOf("\n", index + findString.length);
                    }

                    if (endIndex < 0) {
                        endIndex = codeContent.length;
                    }

                    return codeContent.substring(index + findString.length, endIndex).trim();
                }
            }

            return null;
        }
    }

    private runAdbCommand(args, errorLogger): Q.Promise<string> {
        const originalPath = process.env["PATH"];
        if (process.env["ANDROID_HOME"]) {
            process.env["PATH"] += path.delimiter + path.join(process.env["ANDROID_HOME"], "platform-tools");
        }
        return execCommand("adb", args, errorLogger).finally(() => {
            process.env["PATH"] = originalPath;
        });
    }

    private getErrorMessage(e: any): string {
        return e.message || e.error || e.data || e;
    }

    private getSourceMapPathOverrides(cwd: string, sourceMapPathOverrides?: ISourceMapPathOverrides): ISourceMapPathOverrides {
        return sourceMapPathOverrides ? this.resolveWebRootPattern(cwd, sourceMapPathOverrides, /*warnOnMissing=*/true) :
                this.resolveWebRootPattern(cwd, DefaultWebSourceMapPathOverrides, /*warnOnMissing=*/false);
    }
    /**
     * Returns a copy of sourceMapPathOverrides with the ${cwd} pattern resolved in all entries.
     */
    private resolveWebRootPattern(cwd: string, sourceMapPathOverrides: ISourceMapPathOverrides, warnOnMissing: boolean): ISourceMapPathOverrides {
        const resolvedOverrides: ISourceMapPathOverrides = {};
        // tslint:disable-next-line:forin
        for (let pattern in sourceMapPathOverrides) {
            const replacePattern = this.replaceWebRootInSourceMapPathOverridesEntry(cwd, pattern, warnOnMissing);
            const replacePatternValue = this.replaceWebRootInSourceMapPathOverridesEntry(cwd, sourceMapPathOverrides[pattern], warnOnMissing);
            resolvedOverrides[replacePattern] = replacePatternValue;
        }
        return resolvedOverrides;
    }

    private replaceWebRootInSourceMapPathOverridesEntry(cwd: string, entry: string, warnOnMissing: boolean): string {
        const cwdIndex = entry.indexOf("${cwd}");
        if (cwdIndex === 0) {
            if (cwd) {
                return entry.replace("${cwd}", cwd);
            } else if (warnOnMissing) {
                this.outputLogger("Warning: sourceMapPathOverrides entry contains ${cwd}, but cwd is not set");
            }
        } else if (cwdIndex > 0) {
            this.outputLogger("Warning: in a sourceMapPathOverrides entry, ${cwd} is only valid at the beginning of the path");
        }
        return entry;
    }
}
