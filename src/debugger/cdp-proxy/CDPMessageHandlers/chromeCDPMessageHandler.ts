// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as url from "url";
import { CDPMessageHandlerBase, ProcessedCDPMessage, DispatchDirection } from "./CDPMessageHandlerBase";
import { CDP_API_NAMES } from "./CDPAPINames";
import { SourcemapPathTransformer } from "../sourcemapPathTransformer";
import { IProjectType } from "../../../utils/cordovaProjectHelper";
import { ICordovaAttachRequestArgs } from "../../requestArgs";
import { CordovaProjectHelper } from "../../../utils/cordovaProjectHelper";
import { PlatformType } from "../../cordovaDebugSession";

export class ChromeCDPMessageHandler extends CDPMessageHandlerBase {
    private isSimulate: boolean;

    constructor(
        sourcemapPathTransformer: SourcemapPathTransformer,
        projectType: IProjectType,
        args: ICordovaAttachRequestArgs
    ) {
        super(sourcemapPathTransformer, projectType, args);

        if (args.platform === PlatformType.Serve || args.ionicLiveReload) {
            this.applicationPortPart = args.devServerPort ? `:${args.devServerPort}` : "";
        }
        if (args.simulatePort) {
            this.applicationPortPart = `:${args.simulatePort}`;
            this.isSimulate = true;
        } else {
            this.isSimulate = false;
        }
    }

    public processDebuggerCDPMessage(event: any): ProcessedCDPMessage {
        let dispatchDirection = DispatchDirection.FORWARD;
        if (
            event.method === CDP_API_NAMES.DEBUGGER_SET_BREAKPOINT_BY_URL
            && (CordovaProjectHelper.isIonicAngularProjectByProjectType(this.projectType) || this.isSimulate)
        ) {
            event.params = this.fixIonicSourcemapRegexp(event.params);
        }

        return {
            event,
            dispatchDirection,
        };
    }

    public processApplicationCDPMessage(event: any): ProcessedCDPMessage {
        let dispatchDirection = DispatchDirection.FORWARD;
        if (
            event.method === CDP_API_NAMES.DEBUGGER_SCRIPT_PARSED
            && event.params.url
            && event.params.url.startsWith(`http://${this.applicationServerAddress}`)
        ) {
            this.tryToGetIonicDevServerPortFromURL(event.params.url);
            event.params = this.fixSourcemapLocation(event.params);
        }

        return {
            event,
            dispatchDirection,
        };
    }

    public configureHandlerAccordingToProcessedAttachArgs(args: ICordovaAttachRequestArgs): void { }

    private fixSourcemapLocation(reqParams: any): any {
        let absoluteSourcePath = this.sourcemapPathTransformer.getClientPathFromHttpBasedUrl(reqParams.url);
        if (absoluteSourcePath) {
            if (process.platform === "win32") {
                reqParams.url = "file:///" + absoluteSourcePath.split("\\").join("/"); // transform to URL standard
            } else {
                reqParams.url = "file://" + absoluteSourcePath;
            }
        } else if (!(this.platform === PlatformType.Serve || (this.ionicLiveReload && this.debugRequestType === "launch"))) {
            reqParams.url = "";
        }
        return reqParams;
    }

    private fixIonicSourcemapRegexp(reqParams: any): any {
        const regExp = process.platform === "win32" ?
            /.*\\\\\[wW\]\[wW\]\[wW\]\\\\(.*\\.\[jJ\]\[sS\])/g :
            /.*\\\/www\\\/(.*\.js)/g;
        let foundStrings = regExp.exec(reqParams.urlRegex);
        if (foundStrings && foundStrings[1]) {
            const uriPart = foundStrings[1].split("\\\\").join("\\/");
            reqParams.urlRegex = `http:\\/\\/${this.applicationServerAddress}${this.applicationPortPart}\\/${uriPart}`;
        }
        return reqParams;
    }

    private tryToGetIonicDevServerPortFromURL(sourceURL: string) {
        if (this.ionicLiveReload && !this.applicationPortPart) {
            try {
                const devServerPort = url.parse(sourceURL).port;
                if (devServerPort) {
                    this.applicationPortPart = `:${devServerPort}`;
                }
            } catch (err) {
                // do nothing, try to check another URL
            }
        }
    }
}
