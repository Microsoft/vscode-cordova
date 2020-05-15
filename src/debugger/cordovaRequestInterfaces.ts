// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { DebugProtocol } from "vscode-debugadapter/node_modules/vscode-debugprotocol";


export interface IStringDictionary<T> {
    [name: string]: T;
}
export type ISourceMapPathOverrides = IStringDictionary<string>;

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

export interface IAttachRequestArgs extends DebugProtocol.AttachRequestArguments {
    cwd: string; /* Automatically set by VS Code to the currently opened folder */
    port: number;
    url?: string;
    address?: string;
    trace?: string;
}

export interface ILaunchRequestArgs extends DebugProtocol.LaunchRequestArguments, IAttachRequestArgs { }