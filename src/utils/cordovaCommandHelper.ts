// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as child_process from "child_process";
import * as Q from "q";
import * as os from "os";
import * as util from "util";
import { window, WorkspaceConfiguration, workspace, Uri } from "vscode";

import { TelemetryHelper } from "./telemetryHelper";
import { OutputChannelLogger } from "./outputChannelLogger";
import { CordovaProjectHelper } from "./cordovaProjectHelper";

export class CordovaCommandHelper {
    private static CORDOVA_CMD_NAME: string = os.platform() === "win32" ? "cordova.cmd" : "cordova";
    private static IONIC_CMD_NAME: string = os.platform() === "win32" ? "ionic.cmd" : "ionic";
    private static CORDOVA_TELEMETRY_EVENT_NAME: string = "cordovaCommand";
    private static IONIC_TELEMETRY_EVENT_NAME: string = "ionicCommand";
    private static CORDOVA_DISPLAY_NAME: string = "Cordova";
    private static IONIC_DISPLAY_NAME: string = "Ionic";

    public static executeCordovaCommand(projectRoot: string, command: string, useIonic: boolean = false) {
        let telemetryEventName: string = CordovaCommandHelper.CORDOVA_TELEMETRY_EVENT_NAME;
        let cliCommandName: string = CordovaCommandHelper.CORDOVA_CMD_NAME;
        let cliDisplayName: string = CordovaCommandHelper.CORDOVA_DISPLAY_NAME;

        if (useIonic) {
            telemetryEventName = CordovaCommandHelper.IONIC_TELEMETRY_EVENT_NAME;
            cliCommandName = CordovaCommandHelper.IONIC_CMD_NAME;
            cliDisplayName = CordovaCommandHelper.IONIC_DISPLAY_NAME;
        }

        return CordovaCommandHelper.selectPlatform(projectRoot, command)
            .then((platform) => {
                TelemetryHelper.generate(telemetryEventName, (generator) => {
                    generator.add("command", command, false);
                    let logger = OutputChannelLogger.getMainChannel();
                    let commandToExecute = `${cliCommandName} ${command}`;

                    if (platform) {
                        commandToExecute += ` ${platform}`;
                        // Workaround for dealing with new build system in XCode 10
                        // https://github.com/apache/cordova-ios/issues/407
                        if (platform === "ios") {
                            commandToExecute += " --buildFlag='-UseModernBuildSystem=0'";
                        }
                    }

                    const runArgs = CordovaCommandHelper.getRunArguments(projectRoot);
                    if (runArgs.length) {
                        commandToExecute += ` ${runArgs.join(" ")}`;
                    }

                    logger.log(`########### EXECUTING: ${commandToExecute} ###########`);
                    const env = CordovaProjectHelper.getEnvArgument({
                        env: CordovaCommandHelper.getEnvArgs(projectRoot),
                        envFile: CordovaCommandHelper.getEnvFile(projectRoot),
                    });
                    let process = child_process.exec(commandToExecute, { cwd: projectRoot, env });

                    let deferred = Q.defer();
                    process.on("error", (err: any) => {
                        // ENOENT error will be thrown if no Cordova.cmd or ionic.cmd is found
                        if (err.code === "ENOENT") {
                            window.showErrorMessage(util.format("%s not found, please run \"npm install –g %s\" to install %s globally", cliDisplayName, cliDisplayName.toLowerCase(), cliDisplayName));
                        }
                        deferred.reject(err);
                    });

                    process.stderr.on("data", (data: any) => {
                        logger.append(data);
                    });

                    process.stdout.on("data", (data: any) => {
                        logger.append(data);
                    });

                    process.stdout.on("close", () => {
                        logger.log(`########### FINISHED EXECUTING: ${commandToExecute} ###########`);
                        deferred.resolve({});
                    });

                    return TelemetryHelper.determineProjectTypes(projectRoot)
                        .then((projectType) => generator.add("projectType", projectType, false))
                        .then(() => deferred.promise);
                });
            });
    }

    /**
     * Get command line run arguments from settings.json
     */
    public static getRunArguments(fsPath: string): string[] {
        return CordovaCommandHelper.getSetting(fsPath, "runArguments") || [];
    }

    public static getCordovaExecutable(fsPath: string): string {
        return CordovaCommandHelper.getSetting(fsPath, "cordovaExecutable") || "";
    }

    public static getEnvArgs(fsPath: string): any {
        return CordovaCommandHelper.getSetting(fsPath, "env");
    }

    public static getEnvFile(fsPath: string): string {
        return CordovaCommandHelper.getSetting(fsPath, "envFile") || "";
    }

    private static getSetting(fsPath: string, configKey: string): any {
        let uri = Uri.file(fsPath);
        const workspaceConfiguration: WorkspaceConfiguration = workspace.getConfiguration("cordova", uri);
        if (workspaceConfiguration.has(configKey)) {
            return workspaceConfiguration.get(configKey);
        }
    }

    private static selectPlatform(projectRoot, command): Q.Promise<string> {
        let platforms = CordovaProjectHelper.getInstalledPlatforms(projectRoot);
        platforms = CordovaCommandHelper.filterAvailablePlatforms(platforms);

        return Q({})
            .then(() => {
                if (["prepare", "build", "run"].indexOf(command) > -1) {
                    if (platforms.length > 1) {
                        platforms.unshift("all");
                        return window.showQuickPick(platforms)
                            .then((platform) => {
                                if (!platform) {
                                    throw new Error("Platform selection was canceled. Please select target platform to continue!");
                                }

                                if (platform === "all") {
                                    return "";
                                }

                                return platform;
                            });
                    } else if (platforms.length === 1) {
                        return platforms[0];
                    } else {
                        throw new Error("No any platforms installed");
                    }
                }

                return "";
            });
    }

    private static filterAvailablePlatforms(platforms: string[]): string[] {
        const osPlatform = os.platform();

        return platforms.filter((platform) => {
            switch (platform) {
                case "ios":
                case "osx":
                    return osPlatform === "darwin";
                case "windows":
                    return osPlatform === "win32";
                default:
                    return true;
            }
        });
    }
}
