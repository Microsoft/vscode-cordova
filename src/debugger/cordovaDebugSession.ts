// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as vscode from "vscode";
import * as Q from "q";
import { LoggingDebugSession, OutputEvent } from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
// import { CordovaCDPProxy } from "./cdp-proxy/cordovaCDPProxy";
import { generateRandomPortNumber} from "../utils/extensionHelper";
import { Telemetry } from "../utils/telemetry";
import { killChildProcess } from "./extension";
import { CordovaCDPProxy } from "./cdp-proxy/cordovaCDPProxy";
import { CordovaCommandHelper } from "../utils/cordovaCommandHelper";
import { AppLauncher } from "../extension/appLauncher";
import { ICordovaAttachRequestArgs, IAttachRequestArgs, ISourceMapPathOverrides, ICordovaLaunchRequestArgs } from "./cordovaRequestInterfaces";
import { CordovaProjectHelper } from "../utils/cordovaProjectHelper";

// enum DebugSessionStatus {
//     FirstConnection,
//     FirstConnectionPending,
//     ConnectionAllowed,
//     ConnectionPending,
//     ConnectionDone,
//     ConnectionFailed,
// }


// interface DebuggingProperties {
//     platform: string;
//     target?: string;
// }


// Keep in sync with sourceMapPathOverrides package.json default values
const DefaultWebSourceMapPathOverrides: ISourceMapPathOverrides = {
    "webpack:///./~/*": "${cwd}/node_modules/*",
    "webpack:///./*": "${cwd}/*",
    "webpack:///*": "*",
    "webpack:///src/*": "${cwd}/*",
    "./*": "${cwd}/*",
};

export class CordovaDebugSession extends LoggingDebugSession {

    public appLauncher: AppLauncher;
    // Workaround to handle breakpoint location requests correctly on some platforms
    // private static debuggingProperties: DebuggingProperties;

    private outputLogger: (message: string, error?: boolean | string) => void;

    // private previousLaunchArgs: ICordovaLaunchRequestArgs;
    // private previousAttachArgs: ICordovaAttachRequestArgs;
    // private debugSessionStatus: DebugSessionStatus;

    private readonly cdpProxyPort: number;
    // private readonly terminateCommand: string;
    // private readonly pwaNodeSessionName: string;

    // private projectRootPath: string;
    // private isSettingsInitialized: boolean; // used to prevent parameters rueinitialization when attach is called from launch function
    private cordovaCdpProxy: CordovaCDPProxy | null;

    // private nodeSession: vscode.DebugSession | null;
    // private debugSessionStatus: DebugSessionStatus;
    private onDidStartDebugSessionHandler: vscode.Disposable;
    private onDidTerminateDebugSessionHandler: vscode.Disposable;

    constructor(private session: vscode.DebugSession) {
        super();

        // constants definition
        this.cdpProxyPort = generateRandomPortNumber();
        // this.terminateCommand = "terminate"; // the "terminate" command is sent from the client to the debug adapter in order to give the debuggee a chance for terminating itself
        // this.pwaNodeSessionName = "pwa-node"; // the name of node debug session created by js-debug extension

        // variables definition
        // this.isSettingsInitialized = false;
        this.cordovaCdpProxy = null;
        // this.debugSessionStatus = DebugSessionStatus.FirstConnection;

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
        this.appLauncher = AppLauncher.getAppLauncherByProjectRootPath(CordovaProjectHelper.getCordovaProjectRoot(launchArgs.cwd));
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
        this.appLauncher = AppLauncher.getAppLauncherByProjectRootPath(CordovaProjectHelper.getCordovaProjectRoot(attachArgs.cwd));
        return this.appLauncher.attach(attachArgs)
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
                sourceMapPathOverrides: this.getSourceMapPathOverrides(this.appLauncher.workspaceFolder.uri.fsPath, DefaultWebSourceMapPathOverrides),
                // webRoot: path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "www"),
            };

            vscode.debug.startDebugging(
                // this.appLauncher.getWorkspaceFolder(),
                this.appLauncher.workspaceFolder,
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

    private cleanUp(): Q.Promise<void> {

        if (this.appLauncher.chromeProc) {
            this.appLauncher.chromeProc.kill("SIGINT");
            this.appLauncher.chromeProc = null;
        }

        // Clean up this session's attach and launch args
        // this.previousLaunchArgs = null;
        // this.previousAttachArgs = null;

        // Stop ADB port forwarding if necessary
        let adbPortPromise: Q.Promise<void>;

        if (this.appLauncher.adbPortForwardingInfo) {
            const adbForwardStopArgs =
                ["-s", this.appLauncher.adbPortForwardingInfo.targetDevice,
                    "forward",
                    "--remove", `tcp:${this.appLauncher.adbPortForwardingInfo.port}`];
            adbPortPromise = this.appLauncher.runAdbCommand(adbForwardStopArgs)
                .then(() => void 0);
        } else {
            adbPortPromise = Q<void>(void 0);
        }

        // Kill the Ionic dev server if necessary
        let killServePromise: Q.Promise<void>;

        if (this.appLauncher.ionicLivereloadProcess) {
            this.appLauncher.ionicLivereloadProcess.removeAllListeners("exit");
            killServePromise = killChildProcess(this.appLauncher.ionicLivereloadProcess).finally(() => {
                this.appLauncher.ionicLivereloadProcess = null;
            });
        } else {
            killServePromise = Q<void>(void 0);
        }

        // Clear the Ionic dev server URL if necessary
        if (this.appLauncher.ionicDevServerUrls) {
            this.appLauncher.ionicDevServerUrls = null;
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
