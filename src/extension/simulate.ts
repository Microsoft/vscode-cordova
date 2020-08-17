// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as Q from "q";
import * as path from "path";
import * as CordovaSimulate from "cordova-simulate";
import { CordovaSimulateTelemetry } from "../utils/cordovaSimulateTelemetry";
import { IProjectType, CordovaProjectHelper } from "../utils/cordovaProjectHelper";
import { SimulationInfo } from "../common/simulationInfo";
import { PlatformType } from "../debugger/cordovaDebugSession";
import * as vscode from "vscode";
import * as cp from "child_process";
import customRequire from "../common/customRequire";
import { OutputChannelLogger } from "../utils/log/outputChannelLogger";
import { findFileInFolderHierarchy } from "../utils/extensionHelper";

/**
 * Plugin simulation entry point.
 */
export class PluginSimulator implements vscode.Disposable {
    private registration: vscode.Disposable;

    private simulator: CordovaSimulate.Simulator;
    private simulationInfo: SimulationInfo;
    private readonly CORDOVA_SIMULATE_PACKAGE = "cordova-simulate";
    private simulatePackage: typeof CordovaSimulate;
    private packageInstallProc: cp.ChildProcess | null = null;

    public simulate(fsPath: string, simulateOptions: CordovaSimulate.SimulateOptions, projectType: IProjectType): Q.Promise<any> {
        return this.launchServer(fsPath, simulateOptions, projectType)
            .then(() => this.launchSimHost(simulateOptions.target))
            .then(() => this.launchAppHost(simulateOptions.target));
    }

    public launchAppHost(target: string): Q.Promise<void> {
        return this.getPackage()
            .then(simulate => {
                return simulate.launchBrowser(target, this.simulationInfo.appHostUrl);
            });
    }

    public launchSimHost(target: string): Q.Promise<void> {
        if (!this.simulator) {
            return Q.reject<void>(new Error("Launching sim host before starting simulation server"));
        }
        return this.getPackage()
            .then(simulate => {
                return simulate.launchBrowser(target, this.simulator.simHostUrl());
            });
    }

    public launchServer(fsPath: string, simulateOptions: CordovaSimulate.SimulateOptions, projectType: IProjectType): Q.Promise<SimulationInfo> {
        const uri = vscode.Uri.file(fsPath);
        const workspaceFolder = <vscode.WorkspaceFolder>vscode.workspace.getWorkspaceFolder(uri);
        simulateOptions.dir = workspaceFolder.uri.fsPath;
        if (!simulateOptions.simulationpath) {
            simulateOptions.simulationpath = path.join(workspaceFolder.uri.fsPath, ".vscode", "simulate");
        }

        return this.getPackage()
            .then(() => {
                if (this.isServerRunning()) {
                    /* close the server old instance */
                    return this.simulator.stopSimulation();
                }
            })
            .then(() => {
                let simulateTelemetryWrapper = new CordovaSimulateTelemetry();
                simulateOptions.telemetry = simulateTelemetryWrapper;

                this.simulator = new this.simulatePackage.Simulator(simulateOptions);
                let platforms = CordovaProjectHelper.getInstalledPlatforms(workspaceFolder.uri.fsPath);

                let platform = simulateOptions.platform;
                let isPlatformMissing = platform && platforms.indexOf(platform) < 0;

                if (isPlatformMissing) {
                    let command = "cordova";
                    if (CordovaProjectHelper.isIonicAngularProjectByProjectType(projectType)) {
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
                        if ((projectType.isIonic2 || projectType.isIonic3) && platform && platform !== PlatformType.Browser) {
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
            this.simulator.stopSimulation().done(() => { }, () => { });
            this.simulator = null;
        }
    }

    public getPackage(): Q.Promise<typeof CordovaSimulate> {
        if (this.simulatePackage) {
            return Q.resolve(this.simulatePackage);
        }
        // Don't do the require if we don't actually need it
        try {
            const simulate = customRequire(this.CORDOVA_SIMULATE_PACKAGE) as typeof CordovaSimulate;
            this.simulatePackage = simulate;
            return Q.resolve(this.simulatePackage);
        } catch (e) {
            if (e.code === "MODULE_NOT_FOUND") {
                OutputChannelLogger.getMainChannel().log("cordova-simulate dependency not present. Installing it...");
            } else {
                throw e;
            }
        }

        if (!this.packageInstallProc) {
            this.packageInstallProc = cp.spawn(process.platform === "win32" ? "npm.cmd" : "npm",
                ["install", this.CORDOVA_SIMULATE_PACKAGE, "--verbose", "--no-save"],
                { cwd: path.dirname(findFileInFolderHierarchy(__dirname, "package.json")) });

            this.packageInstallProc.once("exit", (code: number) => {
                if (code === 0) {
                    return Q.resolve(customRequire(this.CORDOVA_SIMULATE_PACKAGE));
                } else {
                    OutputChannelLogger.getMainChannel().log("Error while installing cordova-simulate");
                    Q.reject("Error while installing cordova-simulate");
                }
            });

            let lastDotTime = 0;
            const printDot = () => {
                const now = Date.now();
                if (now - lastDotTime > 1500) {
                    lastDotTime = now;
                    OutputChannelLogger.getMainChannel().append(".");
                }
            };

            this.packageInstallProc.stdout.on("data", () => {
                printDot();
            });

            this.packageInstallProc.stderr.on("data", (data: Buffer) => {
                printDot();
            });
        } else {
            const packageCheck = setInterval(() => {
                if (this.simulatePackage) {
                    clearInterval(packageCheck);
                    return Q.resolve(this.simulatePackage);
                }
            }, 1000);
        }
    }

    private isServerRunning(): boolean {
        return this.simulator && this.simulator.isRunning();
    }
}
