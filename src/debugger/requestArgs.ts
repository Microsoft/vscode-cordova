// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { ISourceMapPathOverrides } from "./jsDebugConfigAdapter";
import { DebugProtocol } from "vscode-debugprotocol";

export interface ICordovaAttachRequestArgs extends DebugProtocol.AttachRequestArguments {
    cwd: string; /* Automatically set by VS Code to the currently opened folder */
    port: number;
    request: string;
    url?: string;
    address?: string;
    trace?: string;
    timeout?: number;
    platform: string;
    target?: string;
    envFile?: string;
    env?: any;
    allEnv?: any;
    skipFiles?: [];
    sourceMaps?: boolean;
    sourceMapPathOverrides?: ISourceMapPathOverrides;
    webSocketDebuggerUrl?: string;
    webkitRangeMin?: number;
    webkitRangeMax?: number;
    attachAttempts?: number;
    attachDelay?: number;
    attachTimeout?: number;
    simulatorInExternalBrowser?: boolean;
    runtimeVersion?: string;

    // iOS debug properties
    iOSVersion?: string;
    iOSAppPackagePath?: string;

    // Ionic livereload properties
    ionicLiveReload?: boolean;
    devServerPort?: number;
    devServerAddress?: string;

    // Cordova-simulate properties
    simulatePort?: number;
    livereload?: boolean;
}

export interface ICordovaLaunchRequestArgs extends DebugProtocol.LaunchRequestArguments, ICordovaAttachRequestArgs {
    iosDebugProxyPort?: number;
    appStepLaunchTimeout?: number;

    // Ionic livereload properties
    devServerTimeout?: number;

    // Chrome debug properties
    userDataDir?: string;
    runtimeExecutable?: string;
    runtimeArgs?: string[];

    // Cordova-simulate properties
    forcePrepare?: boolean;
    simulateTempDir?: string;
    corsProxy?: boolean;
    livereloadDelay?: number;
    runArguments?: string[];
    cordovaExecutable?: string;
}
