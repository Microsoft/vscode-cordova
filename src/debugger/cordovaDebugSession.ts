// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as vscode from "vscode";
import * as child_process from "child_process";
import * as Q from "q";
import * as path from "path";
import * as fs from "fs";
import * as simulate from "cordova-simulate";
import * as os from "os";
import * as io from "socket.io-client";
import * as execa from "execa";
import * as chromeBrowserHelper from "vscode-js-debug-browsers";
import { LoggingDebugSession, OutputEvent } from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
// import { CordovaCDPProxy } from "./cdp-proxy/cordovaCDPProxy";
import * as elementtree from "elementtree";
import { generateRandomPortNumber, retryAsync, promiseGet } from "../utils/extensionHelper";
import { TelemetryHelper, ISimulateTelemetryProperties, TelemetryGenerator } from "../utils/telemetryHelper";
import { CordovaProjectHelper, IProjectType } from "../utils/cordovaProjectHelper";
import { Telemetry } from "../utils/telemetry";
import { execCommand, cordovaRunCommand, killChildProcess, cordovaStartCommand } from "./extension";
import { CordovaCDPProxy } from "./cdp-proxy/cordovaCDPProxy";
import { SimulationInfo } from "../common/simulationInfo";
import { settingsHome } from "../utils/settingsHelper";
import { CordovaIosDeviceLauncher } from "./cordovaIosDeviceLauncher";
import { PluginSimulator } from "../extension/simulate";
import { CordovaCommandHelper } from "../utils/cordovaCommandHelper";

// enum DebugSessionStatus {
//     FirstConnection,
//     FirstConnectionPending,
//     ConnectionAllowed,
//     ConnectionPending,
//     ConnectionDone,
//     ConnectionFailed,
// }

const ANDROID_MANIFEST_PATH = path.join("platforms", "android", "AndroidManifest.xml");
const ANDROID_MANIFEST_PATH_8 = path.join("platforms", "android", "app", "src", "main", "AndroidManifest.xml");

export interface ICordovaAttachRequestArgs extends DebugProtocol.AttachRequestArguments, IAttachRequestArgs {
    timeout: number;
    cwd: string; /* Automatically set by VS Code to the currently opened folder */
    platform: string;
    target?: string;
    webkitRangeMin?: number;
    webkitRangeMax?: number;
    attachAttempts?: number;
    attachDelay?: number;
    attachTimeout?: number;
    simulatorInExternalBrowser?: boolean;

    // Ionic livereload properties
    ionicLiveReload?: boolean;
}

export interface ICordovaLaunchRequestArgs extends DebugProtocol.LaunchRequestArguments, ICordovaAttachRequestArgs {
    timeout: number;
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

// interface DebuggingProperties {
//     platform: string;
//     target?: string;
// }

// `RSIDZTW<NL` are process status codes (as per `man ps`), skip them
const PS_FIELDS_SPLITTER_RE = /\s+(?:[RSIDZTW<NL]\s+)?/;

enum TargetType {
    Emulator = "emulator",
    Device = "device",
    Chrome = "chrome",
}

export interface IStringDictionary<T> {
    [name: string]: T;
}
export type ISourceMapPathOverrides = IStringDictionary<string>;
// Keep in sync with sourceMapPathOverrides package.json default values
const DefaultWebSourceMapPathOverrides: ISourceMapPathOverrides = {
    "webpack:///./~/*": "${cwd}/node_modules/*",
    "webpack:///./*": "${cwd}/*",
    "webpack:///*": "*",
    "webpack:///src/*": "${cwd}/*",
    "./*": "${cwd}/*",
};

export interface IAttachRequestArgs extends DebugProtocol.AttachRequestArguments {
    cwd: string; /* Automatically set by VS Code to the currently opened folder */
    port: number;
    url?: string;
    address?: string;
    trace?: string;
}

export interface ILaunchRequestArgs extends DebugProtocol.LaunchRequestArguments, IAttachRequestArgs { }

export class CordovaDebugSession extends LoggingDebugSession {


    private static CHROME_DATA_DIR = "chrome_sandbox_dir"; // The directory to use for the sandboxed Chrome instance that gets launched to debug the app
    private static NO_LIVERELOAD_WARNING = "Warning: Ionic live reload is currently only supported for Ionic 1 projects. Continuing deployment without Ionic live reload...";
    private static SIMULATE_TARGETS: string[] = ["default", "chrome", "chromium", "edge", "firefox", "ie", "opera", "safari"];
    private static pidofNotFoundError = "/system/bin/sh: pidof: not found";
    // Workaround to handle breakpoint location requests correctly on some platforms
    // private static debuggingProperties: DebuggingProperties;


    public pluginSimulator: PluginSimulator;

    private outputLogger: (message: string, error?: boolean | string) => void;
    private adbPortForwardingInfo: { targetDevice: string, port: number };
    private ionicLivereloadProcess: child_process.ChildProcess;
    private ionicDevServerUrls: string[];
    // private previousLaunchArgs: ICordovaLaunchRequestArgs;
    // private previousAttachArgs: ICordovaAttachRequestArgs;
    private simulateDebugHost: SocketIOClient.Socket;
    private telemetryInitialized: boolean;
    private attachedDeferred: Q.Deferred<void>;
    // private debugSessionStatus: DebugSessionStatus;

    private readonly cdpProxyPort: number;
    private readonly cdpProxyHostAddress: string;
    // private readonly terminateCommand: string;
    // private readonly pwaNodeSessionName: string;

    // private projectRootPath: string;
    // private isSettingsInitialized: boolean; // used to prevent parameters reinitialization when attach is called from launch function
    private cordovaCdpProxy: CordovaCDPProxy | null;
    private chromeProc: child_process.ChildProcess;
    // private nodeSession: vscode.DebugSession | null;
    // private debugSessionStatus: DebugSessionStatus;
    private onDidStartDebugSessionHandler: vscode.Disposable;
    private onDidTerminateDebugSessionHandler: vscode.Disposable;


    constructor(private session: vscode.DebugSession) {
        super();

        // constants definition
        this.cdpProxyPort = generateRandomPortNumber();
        this.cdpProxyHostAddress = "127.0.0.1"; // localhost
        // this.terminateCommand = "terminate"; // the "terminate" command is sent from the client to the debug adapter in order to give the debuggee a chance for terminating itself
        // this.pwaNodeSessionName = "pwa-node"; // the name of node debug session created by js-debug extension

        // variables definition
        // this.isSettingsInitialized = false;
        this.cordovaCdpProxy = null;
        // this.debugSessionStatus = DebugSessionStatus.FirstConnection;
        this.telemetryInitialized = false;
        this.pluginSimulator = new PluginSimulator();
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
            this.sendEvent(new OutputEvent(message + newLine, category));
        };
        this.attachedDeferred = Q.defer<void>();
    }

    public static getRunArguments(fsPath: string): Q.Promise<string[]> {
        return Q.resolve(CordovaCommandHelper.getRunArguments(fsPath));
    }


    public static getCordovaExecutable(fsPath: string): Q.Promise<string> {
        return Q.resolve(CordovaCommandHelper.getCordovaExecutable(fsPath));
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

    /**
     * Sends telemetry
     */
    public sendTelemetry(extensionId: string, extensionVersion: string, appInsightsKey: string, eventName: string, properties: { [key: string]: string }, measures: { [key: string]: number }): Q.Promise<any> {
        Telemetry.sendExtensionTelemetry(extensionId, extensionVersion, appInsightsKey, eventName, properties, measures);
        return Q.resolve({});
    }

    /**
     * Prepares for simulate debugging. The server and simulate host are launched here.
     * The application host is launched by the debugger.
     *
     * Returns info about the running simulate server
     */
    public simulate(fsPath: string, simulateOptions: simulate.SimulateOptions, projectType: IProjectType): Q.Promise<SimulationInfo> {
        return this.launchSimulateServer(fsPath, simulateOptions, projectType)
            .then((simulateInfo: SimulationInfo) => {
               return this.launchSimHost(simulateOptions.target).then(() => simulateInfo);
            });
    }

    /**
     * Launches the simulate server. Only the server is launched here.
     *
     * Returns info about the running simulate server
     */
    public launchSimulateServer(fsPath: string, simulateOptions: simulate.SimulateOptions, projectType: IProjectType): Q.Promise<SimulationInfo> {
        return this.pluginSimulator.launchServer(fsPath, simulateOptions, projectType);
    }

    /**
     * Launches sim-host using an already running simulate server.
     */
    public launchSimHost(target: string): Q.Promise<void> {
        return this.pluginSimulator.launchSimHost(target);
    }

    /**
     * Returns the number of currently visible editors.
     */
    public getVisibleEditorsCount(): Q.Promise<number> {
        // visibleTextEditors is null proof (returns empty array if no editors visible)
        return Q.resolve(vscode.window.visibleTextEditors.length);
    }

    public isSimulateTarget(target: string) {
        return CordovaDebugSession.SIMULATE_TARGETS.indexOf(target) > -1;
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        super.initializeRequest(response, args);
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, launchArgs: ICordovaLaunchRequestArgs, request?: DebugProtocol.Request): Promise<void> {
        // this.previousLaunchArgs = launchArgs;
        // CordovaDebugSession.debuggingProperties = {
        //     platform: launchArgs.platform,
        //     target: launchArgs.target,
        // };

    }

    protected attachRequest(response: DebugProtocol.AttachResponse, attachArgs: ICordovaAttachRequestArgs, request?: DebugProtocol.Request): Promise<void>  {
        // this.previousAttachArgs = attachArgs;
        // CordovaDebugSession.debuggingProperties = {
        //     platform: attachArgs.platform,
        //     target: attachArgs.target,
        // };

        return new Promise<void>((resolve, reject) => this.initializeTelemetry(attachArgs.cwd)
            .then(() => TelemetryHelper.generate("attach", (generator) => {
            attachArgs.port = attachArgs.port || 9222;
            attachArgs.target = attachArgs.target || "emulator";

            this.cordovaCdpProxy = new CordovaCDPProxy(
                this.cdpProxyHostAddress,
                this.cdpProxyPort
            );
            generator.add("target", CordovaDebugSession.getTargetType(attachArgs.target), false);
            attachArgs.cwd = CordovaProjectHelper.getCordovaProjectRoot(attachArgs.cwd);
            attachArgs.timeout = attachArgs.attachTimeout;

            let platform = attachArgs.platform && attachArgs.platform.toLowerCase();
            let target = attachArgs.target && attachArgs.target.toLowerCase();

            TelemetryHelper.sendPluginsList(attachArgs.cwd, CordovaProjectHelper.getInstalledPlugins(attachArgs.cwd));

            this.cordovaCdpProxy.setApplicationTargetPort(attachArgs.port);
            return this.cordovaCdpProxy.createServer()
                .then(() => TelemetryHelper.determineProjectTypes(attachArgs.cwd))
                .then((projectType) => generator.add("projectType", projectType, false))
                .then(() => {
                    if (target === "device" || target === "emulator") {
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
                    } else {
                        return attachArgs;
                    }
                })
                .then((processedAttachArgs: IAttachRequestArgs & { url?: string }) => {
                    this.outputLogger("Attaching to app.");
                    this.outputLogger("", true); // Send blank message on stderr to include a divider between prelude and app starting
                    this.establishDebugSession();
                })
                .catch((err) => {
                    reject(err);
                });
        }).catch((err) => {
            this.outputLogger(err.message || err.format || err, true);
            return this.cleanUp().then(() => {
                throw err;
            });
        }).done(resolve, reject)));
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
        if (this.cordovaCdpProxy) {
            this.cordovaCdpProxy.stopServer();
            this.cordovaCdpProxy = null;
        }

        if (this.pluginSimulator) {
            this.pluginSimulator.dispose();
            this.pluginSimulator = null;
        }

        this.onDidStartDebugSessionHandler.dispose();
        this.onDidTerminateDebugSessionHandler.dispose();

        super.disconnectRequest(response, args, request);
    }

    private establishDebugSession(resolve?: (value?: void | PromiseLike<void> | undefined) => void): void {
        if (this.cordovaCdpProxy) {
            const attachArguments = {
                type: "pwa-chrome",
                request: "attach",
                name: "Attach",
                port: this.cdpProxyPort,
                smartStep: false,
                // The unique identifier of the debug session. It is used to distinguish Cordova extension's
                // debug sessions from other ones. So we can save and process only the extension's debug sessions
                // in vscode.debug API methods "onDidStartDebugSession" and "onDidTerminateDebugSession".
                cordovaDebugSessionId: this.session.id,
                // sourceMapPathOverrides: this.getSourceMapPathOverrides(vscode.workspace.workspaceFolders[0].uri.fsPath, DefaultWebSourceMapPathOverrides),
                // webRoot: path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "www"),
            };

            vscode.debug.startDebugging(
                // this.appLauncher.getWorkspaceFolder(),
                vscode.workspace.workspaceFolders[0],
                attachArguments,
                this.session
            )
            .then((childDebugSessionStarted: boolean) => {
                if (childDebugSessionStarted) {
                    if (resolve) {
                        resolve();
                    }
                } else {
                    throw new Error("Cannot start child debug session");
                }
            },
            err => {
                throw err;
            });
        } else {
            throw new Error("Cannot connect to debugger worker: Chrome debugger proxy is offline");
        }
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

    private runAdbCommand(args, errorLogger): Q.Promise<string> {
        const originalPath = process.env["PATH"];
        if (process.env["ANDROID_HOME"]) {
            process.env["PATH"] += path.delimiter + path.join(process.env["ANDROID_HOME"], "platform-tools");
        }
        return execCommand("adb", args, errorLogger).finally(() => {
            process.env["PATH"] = originalPath;
        });
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

        let simulateInfo: SimulationInfo;

        let getEditorsTelemetry = this.getVisibleEditorsCount()
            .then((editorsCount) => {
                generator.add("visibleTextEditors", editorsCount, false);
            }).catch((e) => {
                this.outputLogger("Could not read the visible text editors. " + this.getErrorMessage(e));
            });

        let launchSimulate = Q(void 0)
            .then(() => {
                let simulateOptions = this.convertLaunchArgsToSimulateArgs(launchArgs);
                return this.launchSimulateServer(launchArgs.cwd, simulateOptions, projectType);
            }).then((simInfo: SimulationInfo) => {
                simulateInfo = simInfo;
                return this.connectSimulateDebugHost(simulateInfo);
            }).then(() => {
                launchArgs.userDataDir = path.join(settingsHome(), CordovaDebugSession.CHROME_DATA_DIR);
                return this.launchSimHost(launchArgs.target);
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
        return this.attachedDeferred.promise;
        // .promise.then(() =>
        //     this.chrome.Emulation.clearDeviceMetricsOverride()
        // ).then(() =>
        //     this.chrome.Emulation.setEmulatedMedia({media: ""})
        // ).then(() =>
        //     this.chrome.Emulation.resetPageScaleFactor()
        // );
    }

    private changeSimulateViewport(data: simulate.ResizeViewportData): Q.Promise<void> {
        return this.attachedDeferred.promise;
        // .then(() =>
        //     this.chrome.Emulation.setDeviceMetricsOverride({
        //         width: data.width,
        //         height: data.height,
        //         deviceScaleFactor: 0,
        //         mobile: true,
        //     })
        // );
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

    private launchIos(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType, runArguments: string[]): Q.Promise<void> {
        if (os.platform() !== "darwin") {
            return Q.reject<void>("Unable to launch iOS on non-mac machines");
        }
        let workingDirectory = launchArgs.cwd;
        let errorLogger = (message) => this.outputLogger(message, true);

        this.outputLogger("Launching app (This may take a while)...");

        let iosDebugProxyPort = launchArgs.iosDebugProxyPort || 9221;

        const command = launchArgs.cordovaExecutable || CordovaProjectHelper.getCliCommand(workingDirectory);
        // Launch the app
        if (launchArgs.target.toLowerCase() === "device") {
            // Workaround for dealing with new build system in XCode 10
            // https://github.com/apache/cordova-ios/issues/407
            let args = ["run", "ios", "--device", "--buildFlag=-UseModernBuildSystem=0"];

            if (launchArgs.runArguments && launchArgs.runArguments.length > 0) {
                args.push(...launchArgs.runArguments);
            } else if (runArguments && runArguments.length) {
                args.push(...runArguments);
            } else if (launchArgs.ionicLiveReload) { // Verify if we are using Ionic livereload
                if (CordovaProjectHelper.isIonicAngularProjectByProjectType(projectType)) {
                    // Livereload is enabled, let Ionic do the launch
                    // '--external' parameter is required since for iOS devices, port forwarding is not yet an option (https://github.com/ionic-team/native-run/issues/20)
                    args.push("--livereload", "--external");
                } else {
                    this.outputLogger(CordovaDebugSession.NO_LIVERELOAD_WARNING);
                }
            }

            if (args.indexOf("--livereload") > -1) {
                return this.startIonicDevServer(launchArgs, args).then(() => void 0);
            }

            // cordova run ios does not terminate, so we do not know when to try and attach.
            // Therefore we parse the command's output to find the special key, which means that the application has been successfully launched.
            this.outputLogger("Installing and launching app on device");
            return cordovaRunCommand(command, args, launchArgs.env, workingDirectory)
                .then(() => {
                    return CordovaIosDeviceLauncher.startDebugProxy(iosDebugProxyPort);
                }, undefined, (progress) => {
                    this.outputLogger(progress[0], progress[1]);
                })
                .then(() => void (0));
        } else {
            let target = launchArgs.target.toLowerCase() === "emulator" ? "emulator" : launchArgs.target;
            return this.checkIfTargetIsiOSSimulator(target, command, launchArgs.env, workingDirectory).then(() => {
                // Workaround for dealing with new build system in XCode 10
                // https://github.com/apache/cordova-ios/issues/407
                let args = ["emulate", "ios", "--buildFlag=-UseModernBuildSystem=0"];
                if (CordovaProjectHelper.isIonicAngularProjectByProjectType(projectType))
                    args = ["emulate", "ios", "--", "--buildFlag=-UseModernBuildSystem=0"];

                if (launchArgs.runArguments && launchArgs.runArguments.length > 0) {
                    args.push(...launchArgs.runArguments);
                } else if (runArguments && runArguments.length) {
                    args.push(...runArguments);
                } else {
                    if (target === "emulator") {
                        args.push("--target=" + target);
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

                return cordovaRunCommand(command, args, launchArgs.env, workingDirectory)
                    .progress((progress) => {
                        this.outputLogger(progress[0], progress[1]);
                    }).catch((err) => {
                        if (target === "emulator") {
                            return cordovaRunCommand(command, ["emulate", "ios", "--list"], launchArgs.env, workingDirectory).then((output) => {
                                // List out available targets
                                errorLogger("Unable to run with given target.");
                                errorLogger(output[0].replace(/\*+[^*]+\*+/g, "")); // Print out list of targets, without ** RUN SUCCEEDED **
                                throw err;
                            });
                        }

                        throw err;
                    });
            });
        }
    }

    private checkIfTargetIsiOSSimulator(target: string, cordovaCommand: string, env: any, workingDirectory: string): Q.Promise<void> {
        const simulatorTargetIsNotSupported = () => {
            const message = "Invalid target. Please, check target parameter value in your debug configuration and make sure it's a valid iPhone device identifier. Proceed to https://aka.ms/AA3xq86 for more information.";
            throw new Error(message);
        };
        if (target === "emulator") {
            simulatorTargetIsNotSupported();
        }
        return cordovaRunCommand(cordovaCommand, ["emulate", "ios", "--list"], env, workingDirectory).then((output) => {
            // Get list of emulators as raw strings
            output[0] = output[0].replace(/Available iOS Simulators:/, "");

            // Clean up each string to get real value
            const emulators = output[0].split("\n").map((value) => {
                let match = value.match(/(.*)(?=,)/gm);
                if (!match) {
                    return null;
                }
                return match[0].replace(/\t/, "");
            });

            return (emulators.indexOf(target) >= 0);
        })
        .then((result) => {
            if (result) {
                simulatorTargetIsNotSupported();
            }
        });
    }

    private attachIos(attachArgs: ICordovaAttachRequestArgs): Q.Promise<IAttachRequestArgs> {
        let target = attachArgs.target.toLowerCase() === "emulator" ? "emulator" : attachArgs.target;
        let workingDirectory = attachArgs.cwd;
        const command = CordovaProjectHelper.getCliCommand(workingDirectory);
        // TODO add env support for attach
        const env = CordovaProjectHelper.getEnvArgument(attachArgs);
        return this.checkIfTargetIsiOSSimulator(target, command, env, workingDirectory).then(() => {
            attachArgs.webkitRangeMin = attachArgs.webkitRangeMin || 9223;
            attachArgs.webkitRangeMax = attachArgs.webkitRangeMax || 9322;
            attachArgs.attachAttempts = attachArgs.attachAttempts || 20;
            attachArgs.attachDelay = attachArgs.attachDelay || 1000;
            // Start the tunnel through to the webkit debugger on the device
            this.outputLogger("Configuring debugging proxy");

            const retry = function<T> (func, condition, retryCount): Q.Promise<T> {
                return retryAsync(func, condition, retryCount, 1, attachArgs.attachDelay, "Unable to find webview");
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

            const getSimulatorProxyPort = (packagePath): Q.IWhenable<{ packagePath: string; targetPort: number }> => {
                return promiseGet(`http://localhost:${attachArgs.port}/json`, "Unable to communicate with ios_webkit_debug_proxy").then((response: string) => {
                    try {
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
                    promiseGet(`http://localhost:${targetPort}/json`, "Unable to communicate with target")
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
        });
    }

    private cleanUp(): Q.Promise<void> {
        const errorLogger = (message) => this.outputLogger(message, true);

        if (this.chromeProc) {
            this.chromeProc.kill("SIGINT");
            this.chromeProc = null;
        }

        // Clean up this session's attach and launch args
        // this.previousLaunchArgs = null;
        // this.previousAttachArgs = null;

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

        if (this.cordovaCdpProxy) {
            this.cordovaCdpProxy.stopServer();
            this.cordovaCdpProxy = null;
        }

        // Wait on all the cleanups
        return Q.allSettled([adbPortPromise, killServePromise]).then(() => void 0);
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
        const isIonic4: boolean = CordovaProjectHelper.isIonicCliVersionGte(launchArgs.cwd, "4.0.0");
        let getServerErrorMessage = (channel: string) => {

            // Skip Ionic 4 searching port errors because, actually, they are not errors
            // https://github.com/ionic-team/ionic-cli/blob/4ee312ad983922ff4398b5900dcfcaebb6ef57df/packages/%40ionic/utils-network/src/index.ts#L85
            if (isIonic4) {
                const skipErrorMatch = /utils-network error while checking/.test(channel);
                if (skipErrorMatch) {
                    return null;
                }
            }

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
            let iosDeviceAppReadyRegex: RegExp = /created bundle at path|\(lldb\)\W+run\r?\nsuccess/i;
            let iosSimulatorAppReadyRegex: RegExp = /build succeeded/i;
            let appReadyRegex: RegExp = /launch success|run successful/i;

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
                this.stop();
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

            if (/Multiple network interfaces detected/.test(serverOut)) {
                // Ionic does not know which address to use for the dev server, and requires human interaction; error out and let the user know
                let errorMessage: string = `Your machine has multiple network addresses. Please specify which one your device or emulator will use to communicate with the dev server by adding a \"devServerAddress\": \"ADDRESS\" property to .vscode/launch.json.
To get the list of addresses run "ionic cordova run PLATFORM --livereload" (where PLATFORM is platform name to run) and wait until prompt with this list is appeared.`;
                let addresses: string[] = [];
                let addressRegex = /(\d+\) .*)/gm;
                let match: string[] = addressRegex.exec(serverOut);

                while (match) {
                    addresses.push(match[1]);
                    match = addressRegex.exec(serverOut);
                }

                if (addresses.length > 0) {
                    // Give the user the list of addresses that Ionic found
                    // NOTE: since ionic started to use inquirer.js for showing _interactive_ prompts this trick does not work as no output
                    // of prompt are sent from ionic process which we starts with --no-interactive parameter
                    errorMessage += [" Available addresses:"].concat(addresses).join(os.EOL + " ");
                }

                serverDeferred.reject(new Error(errorMessage));
            }

            let errorMsg = getServerErrorMessage(serverOut);

            if (errorMsg) {
                appDeferred.reject(new Error(errorMsg));
            }
        };

        let serverErrorOutputHandler = (data: Buffer) => {
            serverErr += data.toString();

            let errorMsg = getServerErrorMessage(serverErr);

            if (errorMsg) {
                appDeferred.reject(new Error(errorMsg));
            }
        };

        this.ionicLivereloadProcess.stdout.on("data", serverOutputHandler);
        this.ionicLivereloadProcess.stderr.on("data", (data: Buffer) => {
            if (isIonic4) {
                // Ionic 4 writes all logs to stderr completely ignoring stdout
                serverOutputHandler(data);
            }
            serverErrorOutputHandler(data);
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

    private async launchChrome(args: ICordovaLaunchRequestArgs): Promise<void> {
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


        const chromeFinder = new chromeBrowserHelper.ChromeBrowserFinder(process.env, fs.promises, execa);
        const chromePath = await chromeFinder.findAll();
        if (chromePath[0]) {
            this.chromeProc = child_process.spawn(chromePath[0].path, chromeArgs, {
                detached: true,
                stdio: ["ignore"],
            });
            this.chromeProc.unref();
            this.chromeProc.on("error", (err) => {
                const errMsg = "Chrome error: " + err;
                this.outputLogger(errMsg, true);
                this.stop();
            });

            this.session.customRequest("attach", args);
        }

    }

    private launchServe(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType, runArguments: string[]): Q.Promise<void> {
        let errorLogger = (message) => this.outputLogger(message, true);

        // Currently, "ionic serve" is only supported for Ionic projects
        if (!CordovaProjectHelper.isIonicAngularProjectByProjectType(projectType)) {
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
            launchArgs.userDataDir = path.join(settingsHome(), CordovaDebugSession.CHROME_DATA_DIR);

            // Launch Chrome and attach
            this.outputLogger("Attaching to app");
            return this.launchChrome(launchArgs);
        });
    }

    private getErrorMessage(e: any): string {
        return e.message || e.error || e.data || e;
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

                        throw Error(CordovaDebugSession.pidofNotFoundError);

                    }).catch((err) => {
                        if (err.message !== CordovaDebugSession.pidofNotFoundError) {
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

            return retryAsync(findAbstractNameFunction, (match) => !!match, 5, 1, 5000, "Unable to find localabstract name of cordova app")
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
