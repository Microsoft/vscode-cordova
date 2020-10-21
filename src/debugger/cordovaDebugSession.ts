// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as vscode from "vscode";
import * as child_process from "child_process";
import * as Q from "q";
import * as path from "path";
import * as fs from "fs";
import * as url from "url";
import * as simulate from "cordova-simulate";
import * as os from "os";
import * as io from "socket.io-client";
import * as execa from "execa";
import * as chromeBrowserHelper from "vscode-js-debug-browsers";
import { LoggingDebugSession, OutputEvent, logger, Logger, ErrorDestination } from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
import { ICordovaLaunchRequestArgs, ICordovaAttachRequestArgs } from "./requestArgs";
import { JsDebugConfigAdapter } from "./jsDebugConfigAdapter";
import * as elementtree from "elementtree";
import { generateRandomPortNumber, retryAsync, promiseGet, findFileInFolderHierarchy } from "../utils/extensionHelper";
import { TelemetryHelper, ISimulateTelemetryProperties, TelemetryGenerator } from "../utils/telemetryHelper";
import { CordovaProjectHelper, IProjectType } from "../utils/cordovaProjectHelper";
import { Telemetry } from "../utils/telemetry";
import { execCommand, cordovaRunCommand, killChildProcess, cordovaStartCommand } from "./extension";
import { CordovaCDPProxy } from "./cdp-proxy/cordovaCDPProxy";
import { SimulationInfo } from "../common/simulationInfo";
import { settingsHome } from "../utils/settingsHelper";
import { LogLevel } from "../utils/log/logHelper";
import { CordovaIosDeviceLauncher } from "./cordovaIosDeviceLauncher";
import { CordovaWorkspaceManager } from "../extension/cordovaWorkspaceManager";
import { CordovaSessionManager } from "../extension/cordovaSessionManager";
import { SourcemapPathTransformer } from "./cdp-proxy/sourcemapPathTransformer";
import * as nls from "vscode-nls";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

const ANDROID_MANIFEST_PATH = path.join("platforms", "android", "AndroidManifest.xml");
const ANDROID_MANIFEST_PATH_8 = path.join("platforms", "android", "app", "src", "main", "AndroidManifest.xml");

// `RSIDZTW<NL` are process status codes (as per `man ps`), skip them
const PS_FIELDS_SPLITTER_RE = /\s+(?:[RSIDZTW<NL]\s+)?/;

export const CANCELLATION_ERROR_NAME = "tokenCanceled";

export enum TargetType {
    Emulator = "emulator",
    Device = "device",
    Chrome = "chrome",
}

export enum PwaDebugType {
    Node = "pwa-node",
    Chrome = "pwa-chrome",
}

export enum PlatformType {
    Android = "android",
    IOS = "ios",
    Windows = "windows",
    Serve = "serve",
    AmazonFireos = "amazon_fireos",
    Blackberry10 = "blackberry10",
    Firefoxos = "firefoxos",
    Ubuntu = "ubuntu",
    Wp8 = "wp8",
    Browser = "browser",
}

interface IOSProcessedParams {
    iOSVersion: string;
    iOSAppPackagePath: string;
    webSocketDebuggerUrl: string;
    ionicDevServerUrl?: string;
}

interface WebviewData {
    devtoolsFrontendUrl: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
}

export class CordovaDebugSession extends LoggingDebugSession {
    private static CHROME_DATA_DIR = "chrome_sandbox_dir"; // The directory to use for the sandboxed Chrome instance that gets launched to debug the app
    private static NO_LIVERELOAD_WARNING = localize("IonicLiveReloadIsOnlySupportedForIonic1", "Warning: Ionic live reload is currently only supported for Ionic 1 projects. Continuing deployment without Ionic live reload...");
    private static SIMULATE_TARGETS: string[] = ["default", "chrome", "chromium", "edge", "firefox", "ie", "opera", "safari"];
    private static pidofNotFoundError = localize("pidofNotFound", "/system/bin/sh: pidof: not found");

    private readonly cdpProxyPort: number;
    private readonly cdpProxyHostAddress: string;
    private readonly stopCommand: string;
    private readonly pwaSessionName: PwaDebugType;

    private workspaceManager: CordovaWorkspaceManager;
    private outputLogger: (message: string, error?: boolean | string) => void;
    private adbPortForwardingInfo: { targetDevice: string, port: number };
    private ionicLivereloadProcess: child_process.ChildProcess;
    private ionicDevServerUrls: string[];
    private simulateDebugHost: SocketIOClient.Socket;
    private telemetryInitialized: boolean;
    private attachedDeferred: Q.Deferred<void>;
    private cdpProxyLogLevel: LogLevel;
    private jsDebugConfigAdapter: JsDebugConfigAdapter;
    private isSettingsInitialized: boolean; // used to prevent parameters reinitialization when attach is called from launch function
    private cordovaCdpProxy: CordovaCDPProxy | null;
    private chromeProc: child_process.ChildProcess;
    private onDidTerminateDebugSessionHandler: vscode.Disposable;
    private cancellationTokenSource: vscode.CancellationTokenSource;

    constructor(private session: vscode.DebugSession, private sessionManager: CordovaSessionManager) {
        super();

        // constants definition
        this.cdpProxyPort = generateRandomPortNumber();
        this.cancellationTokenSource = new vscode.CancellationTokenSource();
        this.cdpProxyHostAddress = "127.0.0.1"; // localhost
        this.stopCommand = "workbench.action.debug.stop"; // the command which simulates a click on the "Stop" button

        if (session.configuration.platform === PlatformType.IOS
            && (session.configuration.target === TargetType.Emulator || session.configuration.target === TargetType.Device)
        ) {
            this.pwaSessionName = PwaDebugType.Node; // the name of Node debug session created by js-debug extension
        } else {
            this.pwaSessionName = PwaDebugType.Chrome; // the name of Chrome debug session created by js-debug extension
        }

        // variables definition
        this.cordovaCdpProxy = null;
        this.telemetryInitialized = false;
        this.jsDebugConfigAdapter = new JsDebugConfigAdapter();
        this.onDidTerminateDebugSessionHandler = vscode.debug.onDidTerminateDebugSession(
            this.handleTerminateDebugSession.bind(this)
        );
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

    public isSimulateTarget(target: string) {
        return CordovaDebugSession.SIMULATE_TARGETS.indexOf(target) > -1;
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        super.initializeRequest(response, args);
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, launchArgs: ICordovaLaunchRequestArgs, request?: DebugProtocol.Request): Promise<void> {
        return new Promise<void>((resolve, reject) => this.initializeTelemetry(launchArgs.cwd)
            .then(() => this.initializeSettings(launchArgs))
            .then(() => TelemetryHelper.generate("launch", (generator) => {
                launchArgs.port = launchArgs.port || 9222;
                if (!launchArgs.target) {
                    if (launchArgs.platform === PlatformType.Browser) {
                        launchArgs.target = "chrome";
                    } else {
                        launchArgs.target = TargetType.Emulator;
                    }
                    this.outputLogger(`Parameter target is not set - ${launchArgs.target} will be used`);
                }
                generator.add("target", CordovaDebugSession.getTargetType(launchArgs.target), false);
                if (launchArgs.cwd === null) {
                    throw new Error(localize("CurrentCWDDoesntContainACordovaProject", "Current working directory doesn't contain a Cordova project. Please open a Cordova project as a workspace root and try again."));
                }
                launchArgs.timeout = launchArgs.attachTimeout;

                let platform = launchArgs.platform && launchArgs.platform.toLowerCase();

                TelemetryHelper.sendPluginsList(launchArgs.cwd, CordovaProjectHelper.getInstalledPlugins(launchArgs.cwd));

                return Q.all([
                    TelemetryHelper.determineProjectTypes(launchArgs.cwd),
                    this.workspaceManager.getRunArguments(launchArgs.cwd),
                    this.workspaceManager.getCordovaExecutable(launchArgs.cwd),
                    ])
                    .then(([projectType, runArguments, cordovaExecutable]) => {
                        launchArgs.cordovaExecutable = launchArgs.cordovaExecutable || cordovaExecutable;
                        launchArgs.allEnv = CordovaProjectHelper.getEnvArgument(launchArgs);
                        generator.add("projectType", projectType, false);
                        this.outputLogger(localize("LaunchingForPlatform", "Launching for {0} (This may take a while)...", platform));

                        switch (platform) {
                            case PlatformType.Android:
                                generator.add("platform", platform, false);
                                if (this.isSimulateTarget(launchArgs.target)) {
                                    return this.launchSimulate(launchArgs, projectType, generator);
                                } else {
                                    return this.launchAndroid(launchArgs, projectType, runArguments);
                                }
                            case PlatformType.IOS:
                                generator.add("platform", platform, false);
                                if (this.isSimulateTarget(launchArgs.target)) {
                                    return this.launchSimulate(launchArgs, projectType, generator);
                                } else {
                                    return this.launchIos(launchArgs, projectType, runArguments);
                                }
                            case PlatformType.Windows:
                                generator.add("platform", platform, false);
                                if (this.isSimulateTarget(launchArgs.target)) {
                                    return this.launchSimulate(launchArgs, projectType, generator);
                                } else {
                                    throw new Error(`Debugging ${platform} platform is not supported.`);
                                }
                            case PlatformType.Serve:
                                generator.add("platform", platform, false);
                                return this.launchServe(launchArgs, projectType, runArguments);
                            // https://github.com/apache/cordova-serve/blob/4ad258947c0e347ad5c0f20d3b48e3125eb24111/src/util.js#L27-L37
                            case PlatformType.AmazonFireos:
                            case PlatformType.Blackberry10:
                            case PlatformType.Firefoxos:
                            case PlatformType.Ubuntu:
                            case PlatformType.Wp8:
                            case PlatformType.Browser:
                                generator.add("platform", platform, false);
                                return this.launchSimulate(launchArgs, projectType, generator);
                            default:
                                generator.add("unknownPlatform", platform, true);
                                throw new Error(localize("UnknownPlatform", "Unknown Platform: {0}", platform));
                        }
                    })
                    .catch((err) => {
                        this.outputLogger(err.message || err, true);
                        return this.cleanUp().then(() => {
                            throw err;
                        });
                    })
                    .then(() => {
                        // For the browser platforms, we call super.launch(), which already attaches. For other platforms, attach here
                        if (platform !== PlatformType.Serve && platform !== PlatformType.Browser && !this.isSimulateTarget(launchArgs.target)) {
                            return this.session.customRequest("attach", launchArgs);
                        }
                    });
                }).done(resolve, reject)
            )
            .catch(err => reject(err))
        )
        .catch(err => this.showError(err, response));
    }

    protected attachRequest(response: DebugProtocol.AttachResponse, attachArgs: ICordovaAttachRequestArgs, request?: DebugProtocol.Request): Promise<void> {
        return new Promise<void>((resolve, reject) => this.initializeTelemetry(attachArgs.cwd)
            .then(() => this.initializeSettings(attachArgs))
            .then(() => TelemetryHelper.generate("attach", (generator) => {
                attachArgs.port = attachArgs.port || 9222;
                attachArgs.target = attachArgs.target || TargetType.Emulator;

                generator.add("target", CordovaDebugSession.getTargetType(attachArgs.target), false);
                attachArgs.timeout = attachArgs.attachTimeout;

                let platform = attachArgs.platform && attachArgs.platform.toLowerCase();
                let target = attachArgs.target && attachArgs.target.toLowerCase();

                TelemetryHelper.sendPluginsList(attachArgs.cwd, CordovaProjectHelper.getInstalledPlugins(attachArgs.cwd));
                return TelemetryHelper.determineProjectTypes(attachArgs.cwd)
                    .then((projectType) => {
                        let sourcemapPathTransformer = new SourcemapPathTransformer(attachArgs, projectType);
                        this.cordovaCdpProxy = new CordovaCDPProxy(
                            this.cdpProxyHostAddress,
                            this.cdpProxyPort,
                            sourcemapPathTransformer,
                            projectType,
                            attachArgs
                        );
                        this.cordovaCdpProxy.setApplicationTargetPort(attachArgs.port);
                        generator.add("projectType", projectType, false);
                        return this.cordovaCdpProxy.createServer(this.cdpProxyLogLevel, this.cancellationTokenSource.token);
                    })
                    .then(() => {
                        if (target === TargetType.Device || target === TargetType.Emulator) {
                            this.outputLogger(localize("AttachingToPlatform", "Attaching to {0}", platform));
                            switch (platform) {
                                case PlatformType.Android:
                                    generator.add("platform", platform, false);
                                    return this.attachAndroid(attachArgs);
                                case PlatformType.IOS:
                                    generator.add("platform", platform, false);
                                    return this.attachIos(attachArgs);
                                default:
                                    generator.add("unknownPlatform", platform, true);
                                    throw new Error(localize("UnknownPlatform", "Unknown Platform: {0}", platform));
                            }
                        } else {
                            return attachArgs;
                        }
                    })
                    .then((processedAttachArgs: ICordovaAttachRequestArgs & { url?: string }) => {
                        this.outputLogger(localize("AttachingToApp", "Attaching to app"));
                        this.outputLogger("", true); // Send blank message on stderr to include a divider between prelude and app starting
                        if (this.cordovaCdpProxy) {
                            if (processedAttachArgs.webSocketDebuggerUrl) {
                                this.cordovaCdpProxy.setBrowserInspectUri(processedAttachArgs.webSocketDebuggerUrl);
                            }
                            this.cordovaCdpProxy.configureCDPMessageHandlerAccordingToProcessedAttachArgs(processedAttachArgs);
                        }
                        this.establishDebugSession(processedAttachArgs, resolve);
                    });
                })
                .catch((err) => {
                    this.outputLogger(err.message || err.format || err, true);
                    return this.cleanUp().then(() => {
                        throw err;
                    });
                })
            )
            .catch(err => reject(err))
        )
        .then(() => {
            this.attachedDeferred.resolve(void 0);
            this.sendResponse(response);
        })
        .catch(err => {
            this.showError(err, response);
        });
    }

    protected showError(error: Error, response: DebugProtocol.Response): void {

        // We can't print error messages after the debugging session is stopped. This could break the extension work.
        if (error.name === CANCELLATION_ERROR_NAME) {
            return;
        }
        const errorString = error.message || error.name || "Error";
        this.sendErrorResponse(
            response,
            { format: errorString, id: 1 },
            undefined,
            undefined,
            ErrorDestination.User
        );
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): Promise<void> {
        await this.cleanUp();
        super.disconnectRequest(response, args, request);
    }

    private handleTerminateDebugSession(debugSession: vscode.DebugSession) {
        if (
            debugSession.configuration.cordovaDebugSessionId === this.session.id
            && debugSession.type === this.pwaSessionName
        ) {
            vscode.commands.executeCommand(this.stopCommand, this.session);
        }
    }

    private establishDebugSession(attachArgs: ICordovaAttachRequestArgs, resolve?: (value?: void | PromiseLike<void> | undefined) => void): void {
        if (this.cordovaCdpProxy) {
            const attachArguments = this.pwaSessionName === PwaDebugType.Chrome ?
                this.jsDebugConfigAdapter.createChromeDebuggingConfig(
                    attachArgs,
                    this.cdpProxyPort,
                    this.pwaSessionName,
                    this.session.id
                ) :
                this.jsDebugConfigAdapter.createSafariDebuggingConfig(
                    attachArgs,
                    this.cdpProxyPort,
                    this.pwaSessionName,
                    this.session.id
                );

            vscode.debug.startDebugging(
                this.workspaceManager.workspaceRoot,
                attachArguments,
                {
                    parentSession: this.session,
                    consoleMode: vscode.DebugConsoleMode.MergeWithParent,
                }
            )
            .then((childDebugSessionStarted: boolean) => {
                if (childDebugSessionStarted) {
                    if (resolve) {
                        resolve();
                    }
                } else {
                    throw new Error(localize("CannotStartChildDebugSession", "Cannot start child debug session"));
                }
            },
                err => {
                    throw err;
                }
            );
        } else {
            throw new Error(localize("CannotConnectToDebuggerWorkerProxyOffline", "Cannot connect to debugger worker: Chrome debugger proxy is offline"));
        }
    }

    private initializeSettings(args: ICordovaAttachRequestArgs | ICordovaLaunchRequestArgs): void {
        if (!this.isSettingsInitialized) {
            this.workspaceManager = CordovaWorkspaceManager.getWorkspaceManagerByProjectRootPath(args.cwd);
            this.isSettingsInitialized = true;
            logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Log);
            this.cdpProxyLogLevel = args.trace ? LogLevel.Custom : LogLevel.None;

            if (args.runtimeVersion) {
                CordovaProjectHelper.nvmSupport(args);
            }
        }
    }

    /**
     * Initializes telemetry.
     */
    private initializeTelemetry(projectRoot: string): Q.Promise<any> {
        if (!this.telemetryInitialized) {
            this.telemetryInitialized = true;
            let version = JSON.parse(fs.readFileSync(findFileInFolderHierarchy(__dirname, "package.json"), "utf-8")).version;
            // Enable telemetry, forced on for now.
            return Telemetry.init("cordova-tools-debug-adapter", version, { isExtensionProcess: false, projectRoot: projectRoot })
                .catch((e) => {
                    this.outputLogger(localize("CouldNotInitializeTelemetry", "Could not initialize telemetry. {0}", e.message || e.error || e.data || e));
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

        if (launchArgs.hasOwnProperty("livereloadDelay")) {
            simulateTelemetryPropts.livereloadDelay = launchArgs.livereloadDelay;
        }

        if (launchArgs.hasOwnProperty("forcePrepare")) {
            simulateTelemetryPropts.forcePrepare = launchArgs.forcePrepare;
        }

        generator.add("simulateOptions", simulateTelemetryPropts, false);

        let simulateInfo: SimulationInfo;

        let getEditorsTelemetry = this.workspaceManager.getVisibleEditorsCount()
            .then((editorsCount) => {
                generator.add("visibleTextEditors", editorsCount, false);
            }).catch((e) => {
                this.outputLogger(localize("CouldntoReadTheVisibleTextEditors", "Could not read the visible text editors. {0}", this.getErrorMessage(e)));
            });

        let launchSimulate = Q(void 0)
            .then(() => {
                let simulateOptions = this.convertLaunchArgsToSimulateArgs(launchArgs);
                return this.workspaceManager.launchSimulateServer(launchArgs.cwd, simulateOptions, projectType);
            }).then((simInfo: SimulationInfo) => {
                simulateInfo = simInfo;
                return this.connectSimulateDebugHost(simulateInfo);
            }).then(() => {
                launchArgs.userDataDir = path.join(settingsHome(), CordovaDebugSession.CHROME_DATA_DIR);
                return this.workspaceManager.launchSimHost(launchArgs.target);
            }).then(() => {
                // Launch Chrome and attach
                launchArgs.simulatePort = CordovaProjectHelper.getPortFromURL(simulateInfo.appHostUrl);
                launchArgs.url = simulateInfo.appHostUrl;
                this.outputLogger(localize("AttachingToApp", "Attaching to app"));

                return this.launchChrome(launchArgs);
            }).catch((e) => {
                this.outputLogger(localize("AnErrorOccuredWhileAttachingToTheDebugger", "An error occurred while attaching to the debugger. {0}", this.getErrorMessage(e)));
                throw e;
            }).then(() => void 0);

        return Q.all([launchSimulate, getEditorsTelemetry]);
    }

    private changeSimulateViewport(data: simulate.ResizeViewportData): Q.Promise<void> {
        return this.attachedDeferred.promise
            .then(() => {
                if (this.cordovaCdpProxy) {
                    this.cordovaCdpProxy.getSimPageTargetAPI()?.Emulation.setDeviceMetricsOverride({
                        width: data.width,
                        height: data.height,
                        deviceScaleFactor: 0,
                        mobile: true,
                    });
                }
            });
    }

    private connectSimulateDebugHost(simulateInfo: SimulationInfo): Q.Promise<void> {
        // Connect debug-host to cordova-simulate
        let viewportResizeFailMessage = localize("ViewportResizingFailed", "Viewport resizing failed. Please try again.");
        let simulateDeferred: Q.Deferred<void> = Q.defer<void>();

        let simulateConnectErrorHandler = (err: any): void => {
            this.outputLogger("Error connecting to the simulated app.");
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
            this.simulateDebugHost.emit("register-debug-host", { handlers: ["resize-viewport"] });
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
        result.forceprepare = launchArgs.forcePrepare;
        result.simulationpath = launchArgs.simulateTempDir;
        result.corsproxy = launchArgs.corsProxy;
        result.livereloaddelay = launchArgs.livereloadDelay;
        result.lang = vscode.env.language;

        return result;
    }

    private launchIos(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType, runArguments: string[]): Q.Promise<void> {
        if (os.platform() !== "darwin") {
            return Q.reject<void>(localize("UnableToLaunchiOSOnNonMacMachnines", "Unable to launch iOS on non-mac machines"));
        }
        let workingDirectory = launchArgs.cwd;
        let errorLogger = (message) => this.outputLogger(message, true);

        this.outputLogger(localize("LaunchingApp", "Launching app (This may take a while)..."));

        let iosDebugProxyPort = launchArgs.iosDebugProxyPort || 9221;

        const command = launchArgs.cordovaExecutable || CordovaProjectHelper.getCliCommand(workingDirectory);
        // Launch the app
        if (launchArgs.target.toLowerCase() === TargetType.Device) {
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
            this.outputLogger(localize("InstallingAndLaunchingAppOnDevice", "Installing and launching app on device"));
            return cordovaRunCommand(command, args, launchArgs.allEnv, workingDirectory)
                .then(() => {
                    return CordovaIosDeviceLauncher.startDebugProxy(iosDebugProxyPort);
                }, undefined, (progress) => {
                    this.outputLogger(progress[0], progress[1]);
                })
                .then(() => void (0));
        } else {
            let target = launchArgs.target.toLowerCase() === TargetType.Emulator ? TargetType.Emulator : launchArgs.target;
            return this.checkIfTargetIsiOSSimulator(target, command, launchArgs.allEnv, workingDirectory).then(() => {
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
                    if (target === TargetType.Emulator) {
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

                return cordovaRunCommand(command, args, launchArgs.allEnv, workingDirectory)
                    .progress((progress) => {
                        this.outputLogger(progress[0], progress[1]);
                    }).catch((err) => {
                        if (target === TargetType.Emulator) {
                            return cordovaRunCommand(command, ["emulate", "ios", "--list"], launchArgs.allEnv, workingDirectory).then((output) => {
                                // List out available targets
                                errorLogger(localize("UnableToRunWithGivenTarget", "Unable to run with given target."));
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
            const message = localize("InvalidTargetPleaseCheckTargetParameter", "Invalid target. Please, check target parameter value in your debug configuration and make sure it's a valid iPhone device identifier. Proceed to https://aka.ms/AA3xq86 for more information.");
            throw new Error(message);
        };
        if (target === TargetType.Emulator) {
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

    private attachIos(attachArgs: ICordovaAttachRequestArgs): Q.Promise<ICordovaAttachRequestArgs> {
        let target = attachArgs.target.toLowerCase() === TargetType.Emulator ? TargetType.Emulator : attachArgs.target;
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

            const retry = function <T>(func, condition, retryCount, cancellationToken): Q.Promise<T> {
                return retryAsync(func, condition, retryCount, 1, attachArgs.attachDelay, localize("UnableToFindWebview", "Unable to find Webview"), cancellationToken);
            };

            const getBundleIdentifier = (): Q.IWhenable<string> => {
                if (attachArgs.target.toLowerCase() === TargetType.Device) {
                    return CordovaIosDeviceLauncher.getBundleIdentifier(attachArgs.cwd)
                        .then(CordovaIosDeviceLauncher.getPathOnDevice);
                } else {
                    return Q.nfcall(fs.readdir, path.join(attachArgs.cwd, "platforms", "ios", "build", "emulator")).then((entries: string[]) => {
                        // TODO requires changes in case of implementing debugging on iOS simulators
                        let filtered = entries.filter((entry) => /\.app$/.test(entry));
                        if (filtered.length > 0) {
                            return filtered[0];
                        } else {
                            throw new Error(localize("UnableToFindAppFile", "Unable to find .app file"));
                        }
                    });
                }
            };

            const getSimulatorProxyPort = (iOSAppPackagePath): Q.IWhenable<{ iOSAppPackagePath: string, targetPort: number, iOSVersion: string }> => {
                return promiseGet(`http://localhost:${attachArgs.port}/json`, localize("UnableToCommunicateWithiOSWebkitDebugProxy", "Unable to communicate with ios_webkit_debug_proxy")).then((response: string) => {
                    try {
                        // An example of a json response from IWDP
                        // [{
                        //     "deviceId": "00008020-XXXXXXXXXXXXXXXX",
                        //     "deviceName": "iPhone name",
                        //     "deviceOSVersion": "13.4.1",
                        //     "url": "localhost:9223"
                        //  }]
                        let endpointsList = JSON.parse(response);
                        let devices = endpointsList.filter((entry) =>
                            attachArgs.target.toLowerCase() === TargetType.Device ? entry.deviceId !== "SIMULATOR"
                                : entry.deviceId === "SIMULATOR"
                        );
                        let device = devices[0];
                        // device.url is of the form 'localhost:port'
                        return {
                            iOSAppPackagePath,
                            targetPort: parseInt(device.url.split(":")[1], 10),
                            iOSVersion: device.deviceOSVersion,
                        };
                    } catch (e) {
                        throw new Error(localize("UnableToFindiOSTargetDeviceOrSimulator", "Unable to find iOS target device/simulator. Please check that \"Settings > Safari > Advanced > Web Inspector = ON\" or try specifying a different \"port\" parameter in launch.json"));
                    }
                });
            };

            const getWebSocketDebuggerUrl = ({ iOSAppPackagePath, targetPort, iOSVersion }): Q.IWhenable<IOSProcessedParams> => {
                return retry(() =>
                    promiseGet(`http://localhost:${targetPort}/json`, localize("UnableToCommunicateWithTarget", "Unable to communicate with target"))
                        .then((response: string) => {
                            try {
                                // An example of a json response from IWDP
                                // [{
                                //     "devtoolsFrontendUrl": "",
                                //     "faviconUrl": "",
                                //     "thumbnailUrl": "/thumb/ionic://localhost/tabs/tab1",
                                //     "title": "Ionic App",
                                //     "url": "ionic://localhost/tabs/tab1",
                                //     "webSocketDebuggerUrl": "ws://localhost:9223/devtools/page/1",
                                //     "appId": "PID:37819"
                                //  }]
                                const webviewsList: Array<WebviewData> = JSON.parse(response);
                                if (webviewsList.length === 0) {
                                    throw new Error(localize("UnableToFindTargetApp", "Unable to find target app"));
                                }
                                const cordovaWebview = this.getCordovaWebview(webviewsList, iOSAppPackagePath, !!attachArgs.ionicLiveReload);
                                if (!cordovaWebview.webSocketDebuggerUrl) {
                                    throw new Error(localize("WebsocketDebuggerUrlIsEmpty", "WebSocket Debugger Url is empty"));
                                }
                                let ionicDevServerUrl;
                                if (this.ionicDevServerUrls) {
                                    ionicDevServerUrl = this.ionicDevServerUrls.find(url => cordovaWebview.url.indexOf(url) === 0);
                                }
                                return {
                                    webSocketDebuggerUrl: cordovaWebview.webSocketDebuggerUrl,
                                    iOSVersion,
                                    iOSAppPackagePath,
                                    ionicDevServerUrl,
                                };
                            } catch (e) {
                                throw new Error(localize("UnableToFindTargetApp", "Unable to find target app"));
                            }
                        }),
                    (result) => !!result,
                    5,
                    this.cancellationTokenSource.token
                );
            };

            const getAttachRequestArgs = (): Q.Promise<ICordovaAttachRequestArgs> =>
                CordovaIosDeviceLauncher.startWebkitDebugProxy(attachArgs.port, attachArgs.webkitRangeMin, attachArgs.webkitRangeMax)
                    .then(getBundleIdentifier)
                    .then(getSimulatorProxyPort)
                    .then(getWebSocketDebuggerUrl)
                    .then((iOSProcessedParams: IOSProcessedParams) => {
                        attachArgs.webSocketDebuggerUrl = iOSProcessedParams.webSocketDebuggerUrl;
                        attachArgs.iOSVersion = iOSProcessedParams.iOSVersion;
                        attachArgs.iOSAppPackagePath = iOSProcessedParams.iOSAppPackagePath;
                        if (iOSProcessedParams.ionicDevServerUrl) {
                            attachArgs.devServerAddress = url.parse(iOSProcessedParams.ionicDevServerUrl).hostname;
                        }
                        return attachArgs;
                    });

            return retry(getAttachRequestArgs, () => true, attachArgs.attachAttempts, this.cancellationTokenSource.token);
        });
    }

    private getCordovaWebview(webviewsList: Array<WebviewData>, iOSAppPackagePath: string, ionicLiveReload: boolean): WebviewData {
        let cordovaWebview = webviewsList.find(webviewData => {
            if (webviewData.url.includes(iOSAppPackagePath)) {
                return true;
            }
            if (!ionicLiveReload && webviewData.url.startsWith("ionic://")) {
                return true;
            }
            if (this.ionicDevServerUrls) {
                return this.ionicDevServerUrls.findIndex(url => webviewData.url.indexOf(url) === 0) >= 0;
            }
            return false;
        });
        return cordovaWebview || webviewsList[0];
    }

    private async cleanUp(): Promise<void> {
        const errorLogger = (message) => this.outputLogger(message, true);

        if (this.chromeProc) {
            this.chromeProc.kill("SIGINT");
            this.chromeProc = null;
        }

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
            await this.cordovaCdpProxy.stopServer();
            this.cordovaCdpProxy = null;
        }
        this.cancellationTokenSource.cancel();
        this.cancellationTokenSource.dispose();

        // Stop IWDP if necessary
        CordovaIosDeviceLauncher.cleanup();

        this.onDidTerminateDebugSessionHandler.dispose();
        this.sessionManager.terminate(this.session);

        await logger.dispose();

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
                    return Q.reject<string[]>(new Error(localize("TheValueForDevServerPortMustBeInInterval", "The value for \"devServerPort\" must be a number between 0 and 65535")));
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
                return localize("ErrorInTheIonicLiveReloadServer", "Error in the Ionic live reload server: {0}", os.EOL + errorMatch[0]);
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

        this.ionicLivereloadProcess = cordovaStartCommand(command, cliArgs, launchArgs.allEnv, launchArgs.cwd);
        this.ionicLivereloadProcess.on("error", (err: { code: string }) => {
            if (err.code === "ENOENT") {
                serverDeferred.reject(new Error(localize("IonicNotFound", "Ionic not found, please run 'npm install –g ionic' to install it globally")));
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
                    exitMessage += os.EOL + localize("InvalidAddress", "Invalid address: please provide a valid IP address or hostname for the \"devServerAddress\" property in launch.json");
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

            const SERVER_URL_RE = /(dev server running|Running dev server|Local):.*(http:\/\/.[^\s]*)/gmi;
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
                    launchArgs.devServerPort = CordovaProjectHelper.getPortFromURL(serverUrls[0]);
                    appDeferred.resolve(serverUrls);
                }
            }

            if (/Multiple network interfaces detected/.test(serverOut)) {
                // Ionic does not know which address to use for the dev server, and requires human interaction; error out and let the user know
                let errorMessage: string = localize("YourMachineHasMultipleNetworkAddresses",
                    `Your machine has multiple network addresses. Please specify which one your device or emulator will use to communicate with the dev server by adding a \"devServerAddress\": \"ADDRESS\" property to .vscode/launch.json.
To get the list of addresses run "ionic cordova run PLATFORM --livereload" (where PLATFORM is platform name to run) and wait until prompt with this list is appeared.`);
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
                    errorMessage += [localize("AvailableAdresses", " Available addresses:")].concat(addresses).join(os.EOL + " ");
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

        this.outputLogger(localize("StartingIonicDevServer", "Starting Ionic dev server (live reload: {0})", launchArgs.ionicLiveReload));

        return serverDeferred.promise.timeout(serverReadyTimeout, localize("StartingIonicDevServerTimedOut", "Starting the Ionic dev server timed out ({0} ms)", serverReadyTimeout)).then(() => {
            this.outputLogger("Building and deploying app");

            return appDeferred.promise.timeout(appReadyTimeout, localize("BuildingAndDeployingTheAppTimedOut", "Building and deploying the app timed out ({0} ms)", appReadyTimeout));
        }).then((ionicDevServerUrls: string[]) => {

            if (!ionicDevServerUrls || !ionicDevServerUrls.length) {
                return Q.reject<string[]>(new Error(localize("UnableToDetermineTheIonicDevServerAddress", "Unable to determine the Ionic dev server address, please try re-launching the debugger")));
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
                env: process.env
            });
            this.chromeProc.unref();
            this.chromeProc.on("error", (err) => {
                const errMsg = localize("ChromeError", "Chrome error: {0}", err.message);
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
            let errorMessage = localize("ServingToTheBrowserIsSupportedForIonicProjects", "Serving to the browser is currently only supported for Ionic projects");

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
            return this.launchChrome(launchArgs);
        });
    }

    private getErrorMessage(e: any): string {
        return e.message || e.error || e.data || e;
    }

    private launchAndroid(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType, runArguments: string[]): Q.Promise<void> {
        let workingDirectory = launchArgs.cwd;

        // Prepare the command line args
        let isDevice = launchArgs.target.toLowerCase() === TargetType.Device;
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
        let cordovaResult = cordovaRunCommand(command, args, launchArgs.allEnv, workingDirectory).then((output) => {
            let runOutput = output[0];
            let stderr = output[1];

            // Ionic ends process with zero code, so we need to look for
            // strings with error content to detect failed process
            let errorMatch = /(ERROR.*)/.test(runOutput) || /error:.*/i.test(stderr);
            if (errorMatch) {
                throw new Error(localize("ErrorRunningAndroid", "Error running android"));
            }

            this.outputLogger(localize("AppSuccessfullyLaunched", "App successfully launched"));
        }, undefined, (progress) => {
            this.outputLogger(progress[0], progress[1]);
        });

        return cordovaResult;
    }

    private attachAndroid(attachArgs: ICordovaAttachRequestArgs): Q.Promise<ICordovaAttachRequestArgs> {
        let errorLogger = (message: string) => this.outputLogger(message, true);
        // Determine which device/emulator we are targeting

        // For devices we look for "device" string but skip lines with "emulator"
        const deviceFilter = (line: string) => /\w+\tdevice/.test(line) && !/emulator/.test(line);
        const emulatorFilter = (line: string) => /device/.test(line) && /emulator/.test(line);

        let adbDevicesResult: Q.Promise<string> = this.runAdbCommand(["devices"], errorLogger)
            .then<string>((devicesOutput) => {

                const targetFilter = attachArgs.target.toLowerCase() === TargetType.Device ? deviceFilter :
                    attachArgs.target.toLowerCase() === TargetType.Emulator ? emulatorFilter :
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
                    throw new Error(localize("UnableToFindAdb", "Unable to find adb. Please ensure it is in your PATH and re-open Visual Studio Code"));
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

                return retryAsync(
                    findAbstractNameFunction,
                    (match) => !!match,
                    5,
                    1,
                    5000,
                    localize("UnableToFindLocalAbstractName", "Unable to find 'localabstract' name of Cordova app"),
                    this.cancellationTokenSource.token
                )
                    .then((abstractName) => {
                        // Configure port forwarding to the app
                        let forwardSocketCommandArguments = ["-s", targetDevice, "forward", `tcp:${attachArgs.port}`, `localabstract:${abstractName}`];
                        this.outputLogger(localize("ForwardingDebugPort", "Forwarding debug port"));
                        return this.runAdbCommand(forwardSocketCommandArguments, errorLogger).then(() => {
                            this.adbPortForwardingInfo = { targetDevice, port: attachArgs.port };
                        });
                    });
            }).then(() => {
                return attachArgs;
            });
    }
}
