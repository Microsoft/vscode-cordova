// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as semver from "semver";
import { CDPMessageHandlerBase, ProcessedCDPMessage, DispatchDirection, ExecutionContext } from "./CDPMessageHandlerBase";
import { CDP_API_NAMES } from "./CDPAPINames";
import { SourcemapPathTransformer } from "../sourcemapPathTransformer";
import { IProjectType } from "../../../utils/cordovaProjectHelper";
import { ICordovaAttachRequestArgs } from "../../requestArgs";
import { CordovaProjectHelper } from "../../../utils/cordovaProjectHelper";

export class SafariCDPMessageHandler extends CDPMessageHandlerBase {
    private readonly Ionic3EvaluateErrorMessage;

    private targetId: string;
    private isIonicProject: boolean;
    private isTargeted: boolean;
    private iOSAppPackagePath: string;
    private isBackcompatConfigured: boolean;
    private customMessageLastId: number;

    constructor(
        sourcemapPathTransformer: SourcemapPathTransformer,
        projectType: IProjectType,
        args: ICordovaAttachRequestArgs
    ) {
        super(sourcemapPathTransformer, projectType, args);
        this.Ionic3EvaluateErrorMessage = "process not defined";
        this.targetId = "";
        this.customMessageLastId = 0;
        this.isTargeted = true;
        this.isBackcompatConfigured = false;
        this.isIonicProject = CordovaProjectHelper.isIonicAngularProjectByProjectType(projectType);

        if (args.ionicLiveReload) {
            this.applicationPortPart = args.devServerPort ? `:${args.devServerPort}` : "";
        }
    }

    public configureHandlerAccordingToProcessedAttachArgs(args: ICordovaAttachRequestArgs): void {
        this.isTargeted = semver.gte(args.iOSVersion, "12.2.0");
        if (!this.isIonicProject) {
            if (args.iOSAppPackagePath) {
                this.iOSAppPackagePath = args.iOSAppPackagePath;
            } else {
                throw new Error("\".app\" file isn't found");
            }
        }
        if (args.devServerAddress) {
            this.applicationServerAddress = args.devServerAddress;
        }
    }

    public processDebuggerCDPMessage(event: any): ProcessedCDPMessage {
        let dispatchDirection = DispatchDirection.FORWARD;
        if (event.method === CDP_API_NAMES.DEBUGGER_SET_BREAKPOINT_BY_URL && !this.ionicLiveReload) {
            event.params = this.fixSourcemapRegexp(event.params);
        }

        if (!this.isBackcompatConfigured && event.method === CDP_API_NAMES.RUNTIME_ENABLE) {
            this.configureTargetForIWDPCommunication();
            this.configureDebuggerForIWDPCommunication();
            this.isBackcompatConfigured = true;
        }

        if (this.isTargeted && !event.method.match(/^Target/)) {
            event = this.wrapRequestInTargetedForm(event);
        }

        return {
            event,
            dispatchDirection,
        };
    }

    public processApplicationCDPMessage(event: any): ProcessedCDPMessage {
        let dispatchDirection = DispatchDirection.FORWARD;
        let communicationPreparationsDone = false;

        if (this.isTargeted) {
            if (!event.method || !event.method.match(/^Target/)) {
                dispatchDirection = DispatchDirection.CANCEL;
                return {
                    event,
                    dispatchDirection,
                };
            }
            if (event.method === CDP_API_NAMES.TARGET_TARGET_CREATED) {
                this.targetId = event.params.targetInfo.targetId;
                communicationPreparationsDone = true;
            }
            if (event.method === CDP_API_NAMES.TARGET_DISPATCH_MESSAGE_FROM_TARGET) {
                event = JSON.parse(event.params.message);
            }
        }

        if (
            event.method === CDP_API_NAMES.DEBUGGER_SCRIPT_PARSED && event.params.url
            && (
                event.params.url.startsWith(`ionic://${this.applicationServerAddress}`)
                || event.params.url.startsWith(`file://${this.iOSAppPackagePath}`)
            )
        ) {
            event.params = this.fixSourcemapLocation(event.params);
        }

        if (event.method === CDP_API_NAMES.CONSOLE_MESSAGE_ADDED) {
            event = this.processDeprecatedConsoleMessage(event);
        }

        if (event.result) {
            if (event.result.properties) {
                event.result = { result: event.result.properties};
            }
            this.fixIonic3RuntimeEvaluateErrorResponse(event);
        }

        return {
            event,
            dispatchDirection,
            communicationPreparationsDone,
        };
    }

    private fixSourcemapLocation(reqParams: any): any {
        let absoluteSourcePath;
        if (this.isIonicProject) {
            absoluteSourcePath = this.sourcemapPathTransformer.getClientPathFromHttpBasedUrl(reqParams.url);
        } else {
            absoluteSourcePath = this.sourcemapPathTransformer.getClientPathFromFileBasedUrl(reqParams.url);
        }

        if (absoluteSourcePath) {
            reqParams.url = "file://" + absoluteSourcePath;
        } else if (!(this.ionicLiveReload && this.debugRequestType === "launch")) {
            reqParams.url = "";
        }
        return reqParams;
    }

    private fixSourcemapRegexp(reqParams: any): any {
        const regExp = /.*\\\/www\\\/(.*\.(js|html))/g;
        let foundStrings = regExp.exec(reqParams.urlRegex);
        if (foundStrings && foundStrings[1]) {
            const uriPart = foundStrings[1].split("\\\\").join("\\/");
            if (this.isIonicProject) {
                reqParams.urlRegex = `ionic:\\/\\/${this.applicationServerAddress}${this.applicationPortPart}\\/${uriPart}`;
            } else {
                const fixedRemotePath = (this.iOSAppPackagePath.split("\/").join("\\/")).split(".").join("\\.");
                reqParams.urlRegex = `file:\\/\\/${fixedRemotePath}\\/www\\/${uriPart}`;
            }
        }
        return reqParams;
    }

    // Js-debug expected empty value or an object, but the target returns a string. This leads to infinite sending of
    // Runtime.Evaluate requests from the debugger to the target.
    private fixIonic3RuntimeEvaluateErrorResponse(event: any) {
        if (event.result.result && event.result.result.value === this.Ionic3EvaluateErrorMessage) {
            delete event.result.result.value;
        }
    }

    private processDeprecatedConsoleMessage(event: any) {
        return {
            method: CDP_API_NAMES.RUNTIME_CONSOLE_API_CALLED,
            params: {
                type: event.params.message.type,
                timestamp: event.params.message.timestamp,
                args: event.params.message.parameters || [{ type: "string", value: event.params.message.text }],
                stackTrace: { callFrames: event.params.message.stack || event.params.message.stackTrace },
                executionContextId: 1,
            },
        };
    }

    private wrapRequestInTargetedForm(request: any) {
        return {
            id: request.id,
            method: CDP_API_NAMES.TARGET_SEND_MESSAGE_TO_TARGET,
            params: {
                id: request.id,
                message: JSON.stringify(request),
                targetId: this.targetId,
            },
        };
    }

    private configureTargetForIWDPCommunication(): void {
        try {
            this.sendCustomRequestToAppTarget(CDP_API_NAMES.CONSOLE_ENABLE, {});
            this.sendCustomRequestToAppTarget(CDP_API_NAMES.DEBUGGER_SET_BREAKPOINTS_ACTIVE, { active: true });
        } catch (err) {
            // Specifically ignore a fail here since it's only for backcompat
        }
    }

    private configureDebuggerForIWDPCommunication(): void {
        const context: ExecutionContext = {
            id: this.customMessageLastId++,
            origin: "",
            name: "IOS Execution Context",
            auxData: {
                isDefault: true,
                type: "page",
                frameId: this.targetId
            }
        };
        try {
            this.sendCustomRequestToDebuggerTarget(CDP_API_NAMES.EXECUTION_CONTEXT_CREATED, { context }, false);
        } catch (err) {
            throw Error("Could not create Execution context");
        }
    }

    private sendCustomRequestToDebuggerTarget(method: string, params: any = {}, addMessageId: boolean = true): void {
        let request: any = {
            method,
            params,
        };

        if (addMessageId) {
            request.id = this.customMessageLastId++;
        }

        this.debuggerTarget?.send(request);
    }

    private sendCustomRequestToAppTarget(method: string, params: any = {}): void {
        let request = {
            id: this.customMessageLastId++,
            method,
            params,
        };

        if (this.isTargeted) {
            request = this.wrapRequestInTargetedForm(request);
        }

        this.applicationTarget?.send(request);
    }
}
