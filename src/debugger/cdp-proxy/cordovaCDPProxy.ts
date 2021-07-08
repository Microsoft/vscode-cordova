// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import {
    Connection,
    Server,
    WebSocketTransport
} from "vscode-cdp-proxy";
import * as semver from "semver";
import { IncomingMessage } from "http";
import { OutputChannelLogger } from "../../utils/log/outputChannelLogger";
import { DebuggerEndpointHelper } from "./debuggerEndpointHelper";
import { LogLevel } from "../../utils/log/logHelper";
import { CancellationToken } from "vscode";
import { SourcemapPathTransformer } from "./sourcemapPathTransformer";
import { PlatformType } from "../cordovaDebugSession";
import { IProjectType } from "../../utils/cordovaProjectHelper";
import { SimulateHelper } from "../../utils/simulateHelper";
import { CDPMessageHandlerBase, DispatchDirection } from "./CDPMessageHandlers/CDPMessageHandlerBase";
import { ChromeCDPMessageHandler } from "./CDPMessageHandlers/chromeCDPMessageHandler";
import { SafariCDPMessageHandler } from "./CDPMessageHandlers/safariCDPMessageHandler";
import { ICordovaAttachRequestArgs } from "../requestArgs";
import { TargetType } from "../cordovaDebugSession";

export class CordovaCDPProxy {

    private readonly PROXY_LOG_TAGS = {
        DEBUGGER_COMMAND: "Command Debugger To Target",
        APPLICATION_COMMAND: "Command Target To Debugger",
        DEBUGGER_REPLY: "Reply From Debugger To Target",
        APPLICATION_REPLY: "Reply From Target To Debugger",
    };

    private server: Server | null;
    private hostAddress: string;
    private port: number;
    private debuggerTarget: Connection | null;
    private applicationTarget: Connection | null;
    private simPageTarget: Connection | null;
    private logger: OutputChannelLogger;
    private debuggerEndpointHelper: DebuggerEndpointHelper;
    private applicationTargetPort: number;
    private logLevel: LogLevel;
    private cancellationToken: CancellationToken | undefined;
    private CDPMessageHandler: CDPMessageHandlerBase;
    private communicationPreparationsDone: boolean;
    private browserInspectUri: string;
    private isSimulate: boolean;

    constructor(
        hostAddress: string,
        port: number,
        sourcemapPathTransformer: SourcemapPathTransformer,
        projectType: IProjectType,
        args: ICordovaAttachRequestArgs,
        logLevel: LogLevel = LogLevel.None
    ) {
        this.port = port;
        this.hostAddress = hostAddress;
        this.logLevel = logLevel;
        this.logger = OutputChannelLogger.getChannel("Cordova Chrome Proxy", true, false, true);
        this.debuggerEndpointHelper = new DebuggerEndpointHelper();
        this.browserInspectUri = args.webSocketDebuggerUrl || "";
        this.isSimulate = !!(SimulateHelper.isSimulateTarget(args.target) && args.simulatePort);
        if (args.platform === PlatformType.IOS && (args.target === TargetType.Emulator || args.target === TargetType.Device)) {
            this.CDPMessageHandler = new SafariCDPMessageHandler(sourcemapPathTransformer, projectType, args);
            this.communicationPreparationsDone = false;
        } else {
            this.CDPMessageHandler = new ChromeCDPMessageHandler(sourcemapPathTransformer, projectType, args);
            this.communicationPreparationsDone = true;
        }
    }

    public createServer(logLevel: LogLevel, cancellationToken: CancellationToken): Promise<void> {
        this.cancellationToken = cancellationToken;
        this.logLevel = logLevel;
        return Server.create({ port: this.port, host: this.hostAddress })
            .then((server: Server) => {
                this.server = server;
                this.server.onConnection(this.onConnectionHandler.bind(this));
            });
    }

    public async stopServer(): Promise<void> {
        if (this.simPageTarget) {
            await this.simPageTarget.close();
            this.simPageTarget = null;
        }
        if (this.applicationTarget) {
            await this.applicationTarget.close();
            this.applicationTarget = null;
        }
        if (this.server) {
            this.server.dispose();
            this.server = null;
        }

        this.browserInspectUri = "";
        this.cancellationToken = undefined;
    }

    public setApplicationTargetPort(applicationTargetPort: number): void {
        this.applicationTargetPort = applicationTargetPort;
    }

    public setBrowserInspectUri(browserInspectUri: string): void {
        this.browserInspectUri = browserInspectUri;
    }

    public configureCDPMessageHandlerAccordingToProcessedAttachArgs(args: ICordovaAttachRequestArgs): void {
        if (
            args.iOSVersion
            && !this.communicationPreparationsDone
            && semver.lt(args.iOSVersion, "12.2.0")
        ) {
            this.communicationPreparationsDone = true;
        }
        this.CDPMessageHandler.configureHandlerAccordingToProcessedAttachArgs(args);
    }

    public getSimPageTargetAPI(): any | undefined {
        return this.simPageTarget?.api;
    }

    private async onConnectionHandler([debuggerTarget]: [Connection, IncomingMessage]): Promise<void> {
        this.debuggerTarget = debuggerTarget;

        this.debuggerTarget.pause(); // don't listen for events until the target is ready

        if (!this.browserInspectUri) {
            if (this.cancellationToken) {
                this.browserInspectUri = await this.debuggerEndpointHelper.retryGetWSEndpoint(
                    `http://localhost:${this.applicationTargetPort}`,
                    20,
                    this.cancellationToken
                );
            } else {
                this.browserInspectUri = await this.debuggerEndpointHelper.getWSEndpoint(`http://localhost:${this.applicationTargetPort}`);
            }
        }
        if (this.isSimulate) {
            // There is a problem that the browser endpoint cannot handle "Emulation" domain requests, so we attach to
            // the application page endpoint, since each page is processed in a separate process.
            // But the application page endpoint does not handle "Target" domain requests, that's why we store both browser
            // and app page connections.
            const simPageInspectUri = await this.debuggerEndpointHelper.getWSEndpoint(`http://localhost:${this.applicationTargetPort}`, this.isSimulate);
            this.simPageTarget = new Connection(await WebSocketTransport.create(simPageInspectUri));
        }

        this.applicationTarget = new Connection(await WebSocketTransport.create(this.browserInspectUri));

        this.applicationTarget.onError(this.onApplicationTargetError.bind(this));
        this.debuggerTarget.onError(this.onDebuggerTargetError.bind(this));

        this.applicationTarget.onCommand(this.handleApplicationTargetCommand.bind(this));
        this.debuggerTarget.onCommand(this.handleDebuggerTargetCommand.bind(this));

        this.applicationTarget.onReply(this.handleApplicationTargetReply.bind(this));
        this.debuggerTarget.onReply(this.handleDebuggerTargetReply.bind(this));

        this.applicationTarget.onEnd(this.onApplicationTargetClosed.bind(this));
        this.debuggerTarget.onEnd(this.onDebuggerTargetClosed.bind(this));

        this.CDPMessageHandler.setApplicationTarget(this.applicationTarget);
        this.CDPMessageHandler.setDebuggerTarget(this.debuggerTarget);

        // dequeue any messages we got in the meantime
        this.unpauseDebuggerTarget();
    }

    private handleDebuggerTargetCommand(event: any) {
        this.logger.logWithCustomTag(this.PROXY_LOG_TAGS.DEBUGGER_COMMAND, JSON.stringify(event, null , 2), this.logLevel);
        const processedMessage = this.CDPMessageHandler.processDebuggerCDPMessage(event);

        if (processedMessage.dispatchDirection === DispatchDirection.BACK) {
            this.debuggerTarget?.send(processedMessage.event);
        } else if (processedMessage.dispatchDirection === DispatchDirection.FORWARD) {
            this.applicationTarget?.send(processedMessage.event);
        }
    }

    private handleApplicationTargetCommand(event: any) {
        this.logger.logWithCustomTag(this.PROXY_LOG_TAGS.APPLICATION_COMMAND, JSON.stringify(event, null , 2), this.logLevel);
        const processedMessage = this.CDPMessageHandler.processApplicationCDPMessage(event);

        if (processedMessage.communicationPreparationsDone) {
            this.communicationPreparationsDone = true;
            this.unpauseDebuggerTarget();
        }

        if (processedMessage.dispatchDirection === DispatchDirection.BACK) {
            this.applicationTarget?.send(processedMessage.event);
        } else if (processedMessage.dispatchDirection === DispatchDirection.FORWARD) {
            this.debuggerTarget?.send(processedMessage.event);
        }
    }

    private handleDebuggerTargetReply(event: any) {
        this.logger.logWithCustomTag(this.PROXY_LOG_TAGS.DEBUGGER_REPLY, JSON.stringify(event, null , 2), this.logLevel);
        const processedMessage = this.CDPMessageHandler.processDebuggerCDPMessage(event);

        if (processedMessage.dispatchDirection === DispatchDirection.BACK) {
            this.debuggerTarget?.send(processedMessage.event);
        } else if (processedMessage.dispatchDirection === DispatchDirection.FORWARD) {
            this.applicationTarget?.send(processedMessage.event);
        }
    }

    private handleApplicationTargetReply(event: any) {
        this.logger.logWithCustomTag(this.PROXY_LOG_TAGS.APPLICATION_REPLY, JSON.stringify(event, null , 2), this.logLevel);
        const processedMessage = this.CDPMessageHandler.processApplicationCDPMessage(event);

        if (processedMessage.dispatchDirection === DispatchDirection.BACK) {
            this.applicationTarget?.send(processedMessage.event);
        } else if (processedMessage.dispatchDirection === DispatchDirection.FORWARD) {
            this.debuggerTarget?.send(processedMessage.event);
        }
    }

    private onDebuggerTargetError(err: Error) {
        this.logger.log(`Error on debugger transport: ${err}`);
    }

    private onApplicationTargetError(err: Error) {
        this.logger.log(`Error on application transport: ${err}`);
    }

    private async onApplicationTargetClosed() {
        this.applicationTarget = null;
    }

    private async onDebuggerTargetClosed() {
        this.CDPMessageHandler.processDebuggerCDPMessage({method: "close"});
        this.debuggerTarget = null;
        this.communicationPreparationsDone = false;
        this.browserInspectUri = "";
    }

    private unpauseDebuggerTarget(): void {
        if (this.debuggerTarget && this.communicationPreparationsDone) {
            this.debuggerTarget.unpause();
        }
    }
}
