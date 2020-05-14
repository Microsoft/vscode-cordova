// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as vscode from "vscode";
import * as child_process from "child_process";
import * as Q from "q";
import * as path from "path";
import * as fs from "fs";
import * as simulate from "cordova-simulate";
import { LoggingDebugSession, OutputEvent } from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
// import { CordovaCDPProxy } from "./cdp-proxy/cordovaCDPProxy";
import * as elementtree from "elementtree";
import { generateRandomPortNumber, retryAsync, promiseGet } from "../utils/extensionHelper";
import { TelemetryHelper} from "../utils/telemetryHelper";
import { CordovaProjectHelper } from "../utils/cordovaProjectHelper";
import { Telemetry } from "../utils/telemetry";
import { execCommand, cordovaRunCommand, killChildProcess } from "./extension";
import { CordovaCDPProxy } from "./cdp-proxy/cordovaCDPProxy";
import { CordovaIosDeviceLauncher } from "./cordovaIosDeviceLauncher";
import { PluginSimulator } from "../extension/simulate";
import { CordovaCommandHelper } from "../utils/cordovaCommandHelper";
import { AppLauncher } from "../extension/appLauncher";

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
    private static pidofNotFoundError = "/system/bin/sh: pidof: not found";
    // Workaround to handle breakpoint location requests correctly on some platforms
    // private static debuggingProperties: DebuggingProperties;

    private outputLogger: (message: string, error?: boolean | string) => void;
    private adbPortForwardingInfo: { targetDevice: string, port: number };
    private ionicLivereloadProcess: child_process.ChildProcess;
    private ionicDevServerUrls: string[];
    // private previousLaunchArgs: ICordovaLaunchRequestArgs;
    // private previousAttachArgs: ICordovaAttachRequestArgs;

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

    public appLauncher: AppLauncher;

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

        this.appLauncher.pluginSimulator = new PluginSimulator();
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
     * Sends telemetry
     */
    public sendTelemetry(extensionId: string, extensionVersion: string, appInsightsKey: string, eventName: string, properties: { [key: string]: string }, measures: { [key: string]: number }): Q.Promise<any> {
        Telemetry.sendExtensionTelemetry(extensionId, extensionVersion, appInsightsKey, eventName, properties, measures);
        return Q.resolve({});
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

        return this.appLauncher.launch(launchArgs)
        .catch((err) => {
            this.outputLogger(err.message || err, true);
            return this.cleanUp().then(() => {
                throw err;
            });
        })
        .then(() => {
            let platform = launchArgs.platform && launchArgs.platform.toLowerCase();
            // For the browser platforms, we call super.launch(), which already attaches. For other platforms, attach here
            if (platform !== "serve" && platform !== "browser" && !this.appLauncher.isSimulateTarget(launchArgs.target)) {
                return this.session.customRequest("attach", launchArgs);
            }
        });
    }

    protected attachRequest(response: DebugProtocol.AttachResponse, attachArgs: ICordovaAttachRequestArgs, request?: DebugProtocol.Request): Promise<void>  {
        // this.previousAttachArgs = attachArgs;
        // CordovaDebugSession.debuggingProperties = {
        //     platform: attachArgs.platform,
        //     target: attachArgs.target,
        // };

        this.appLauncher.attach(attachArgs)
        .then((processedAttachArgs: IAttachRequestArgs & { url?: string }) => {
            this.outputLogger("Attaching to app.");
            this.outputLogger("", true); // Send blank message on stderr to include a divider between prelude and app starting
            this.establishDebugSession();
        }).catch((err) => {
            this.outputLogger(err.message || err.format || err, true);
            return this.cleanUp().then(() => {
                throw err;
            });
        });
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
        if (this.cordovaCdpProxy) {
            this.cordovaCdpProxy.stopServer();
            this.cordovaCdpProxy = null;
        }

        if (this.appLauncher.pluginSimulator) {
            this.appLauncher.pluginSimulator.dispose();
            this.appLauncher.pluginSimulator = null;
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



    private runAdbCommand(args, errorLogger): Q.Promise<string> {
        const originalPath = process.env["PATH"];
        if (process.env["ANDROID_HOME"]) {
            process.env["PATH"] += path.delimiter + path.join(process.env["ANDROID_HOME"], "platform-tools");
        }
        return execCommand("adb", args, errorLogger).finally(() => {
            process.env["PATH"] = originalPath;
        });
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
        if (this.appLauncher.simulateDebugHost) {
            this.appLauncher.simulateDebugHost.close();
            this.appLauncher.simulateDebugHost = null;
        }

        if (this.cordovaCdpProxy) {
            this.cordovaCdpProxy.stopServer();
            this.cordovaCdpProxy = null;
        }

        // Wait on all the cleanups
        return Q.allSettled([adbPortPromise, killServePromise]).then(() => void 0);
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
