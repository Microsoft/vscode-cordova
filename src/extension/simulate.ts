// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import {Hash} from "../utils/hash";
import * as Q from "q";
import * as path from "path";
import {Simulator, SimulateOptions, launchBrowser} from "cordova-simulate";
import {CordovaSimulateTelemetry} from "../utils/cordovaSimulateTelemetry";
import {IProjectType, CordovaProjectHelper} from "../utils/cordovaProjectHelper";
import {SimulationInfo} from "../common/simulationInfo";
import * as vscode from "vscode";
import { CordovaCommandHelper } from "../utils/cordovaCommandHelper";

/**
 * Content provider hosting the simulation UI inside a document.
 */
class SimHostContentProvider implements vscode.TextDocumentContentProvider {
    private simHostUrl: string;
    private simulateUri: vscode.Uri;
    private changeEmitter = new vscode.EventEmitter<vscode.Uri>();

    constructor(simHostUrl: string, simulateUri: vscode.Uri) {
        this.simHostUrl = simHostUrl;
        this.simulateUri = simulateUri;
    }

    get onDidChange() {
        return this.changeEmitter.event;
    }

    public fireChange() {
        this.changeEmitter.fire(this.simulateUri);
    }

    public provideTextDocumentContent(): string {
        // always return different html so that the tab is properly reloaded and events are fired
        return `<!DOCTYPE html>
                <html>
                <head>
                    <style>
                        html, body {
                            height: 100%;
                            margin: 0;
                            overflow: hidden;
                        }

                        .intrinsic-container iframe {
                            position: absolute;
                            top:0;
                            left: 0;
                            border: 0;
                            width: 100%;
                            height: 100%;
                        }
                    </style>
                </head>
                <body>
                    <div style="display: none">
                        Always be changing ${Math.random()}
                    </div>
                    <div class="intrinsic-container">
                        <iframe src="${this.simHostUrl}" ></iframe>
                    </div>
                </body>
                </html>`;
    }
}

/**
 * Plugin simulation entry point.
 */
export class PluginSimulator implements vscode.Disposable {
    private registration: vscode.Disposable;

    private simulator: Simulator;
    private simulationInfo: SimulationInfo;

    public simulate(fsPath: string, simulateOptions: SimulateOptions, projectType: IProjectType): Q.Promise<any> {
        return this.launchServer(fsPath, simulateOptions, projectType)
            .then(() => this.launchSimHost(fsPath, simulateOptions.target))
            .then(() => this.launchAppHost(simulateOptions.target));
    }

    public launchAppHost(target: string): Q.Promise<void> {
        return launchBrowser(target, this.simulationInfo.appHostUrl);
    }

    public launchSimHost(fsPath: string, target: string, runInBrowser?: boolean): Q.Promise<void> {
        if (!this.simulator) {
            return Q.reject<void>(new Error("Launching sim host before starting simulation server"));
        }

        const isSetInLaunchArgs = runInBrowser;
        const isSetInSettings = CordovaCommandHelper.getSimulatorInExternalBrowserSetting(fsPath)
            && runInBrowser !== false;

        if (isSetInLaunchArgs || isSetInSettings) {
            return launchBrowser(target, this.simulator.simHostUrl());
        }

        const uri = vscode.Uri.file(fsPath);
        const workspaceFolder = <vscode.WorkspaceFolder>vscode.workspace.getWorkspaceFolder(uri);
        const simulateProtocol = "cordova-simulate-" + Hash.hashCode(workspaceFolder.uri.fsPath);
        const simulateUri = vscode.Uri.parse(simulateProtocol + "://authority/cordova-simulate");

        let provider = new SimHostContentProvider(this.simulator.simHostUrl(), simulateUri);
        this.registration = vscode.workspace.registerTextDocumentContentProvider(simulateProtocol, provider);

        return Q(vscode.commands.executeCommand("vscode.previewHtml", simulateUri, vscode.ViewColumn.Two).then(() => provider.fireChange()));
    }

    public launchServer(fsPath: string, simulateOptions: SimulateOptions, projectType: IProjectType): Q.Promise<SimulationInfo> {
        const uri = vscode.Uri.file(fsPath);
        const workspaceFolder = <vscode.WorkspaceFolder>vscode.workspace.getWorkspaceFolder(uri);
        simulateOptions.dir = workspaceFolder.uri.fsPath;
        if (!simulateOptions.simulationpath) {
            simulateOptions.simulationpath = path.join(workspaceFolder.uri.fsPath, ".vscode", "simulate");
        }

        return Q({}).then(() => {
            if (this.isServerRunning()) {
                /* close the server old instance */
                return this.simulator.stopSimulation();
            }
        })
        .then(() => {
                let simulateTelemetryWrapper = new CordovaSimulateTelemetry();
                simulateOptions.telemetry = simulateTelemetryWrapper;

                this.simulator = new Simulator(simulateOptions);
                let platforms = CordovaProjectHelper.getInstalledPlatforms(workspaceFolder.uri.fsPath);

                let platform = simulateOptions.platform;
                let isPlatformMissing = platform && platforms.indexOf(platform) < 0;

                if (isPlatformMissing) {
                    let command = "cordova";
                    if (projectType.ionic || projectType.ionic2  || projectType.ionic4) {
                        const isIonicCliVersionGte3 = CordovaProjectHelper.isIonicCliVersionGte3(workspaceFolder.uri.fsPath);
                        command = "ionic" + (isIonicCliVersionGte3 ? " cordova" : "");
                    }

                    throw new Error(`Couldn't find platform ${platform} in project, please install it using '${command} platform add ${platform}'`);
                }

                return this.simulator.startSimulation()
                    .then(() => {
                        if (!this.simulator.isRunning()) {
                            throw new Error("Error starting the simulation");
                        }

                        this.simulationInfo = {
                            appHostUrl: this.simulator.appUrl(),
                            simHostUrl: this.simulator.simHostUrl(),
                            urlRoot: this.simulator.urlRoot(),
                        };
                        if (projectType.ionic2 && platform && platform !== "browser") {
                            this.simulationInfo.appHostUrl = `${this.simulationInfo.appHostUrl}?ionicplatform=${simulateOptions.platform}`;
                        }
                        return this.simulationInfo;
                    });
            });
    }

    public dispose(): void {
        if (this.registration) {
            this.registration.dispose();
            this.registration = null;
        }

        if (this.simulator) {
            this.simulator.stopSimulation().done(() => {}, () => {});
            this.simulator = null;
        }
    }

    private isServerRunning(): boolean {
        return this.simulator && this.simulator.isRunning();
    }
}
