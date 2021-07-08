// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

"use strict";

import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as pl from "plist";
import * as xcode from "xcode";
import { delay } from "../utils/extensionHelper";
import { ChildProcess } from "../common/node/childProcess";
import * as nls from "vscode-nls";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

export class CordovaIosDeviceLauncher {
    private static nativeDebuggerProxyInstance: child_process.ChildProcess;
    private static webDebuggerProxyInstance: child_process.ChildProcess;

    public static cleanup(): void {
        if (CordovaIosDeviceLauncher.nativeDebuggerProxyInstance) {
            CordovaIosDeviceLauncher.nativeDebuggerProxyInstance.kill("SIGHUP");
            CordovaIosDeviceLauncher.nativeDebuggerProxyInstance = null;
        }
        if (CordovaIosDeviceLauncher.webDebuggerProxyInstance) {
            CordovaIosDeviceLauncher.webDebuggerProxyInstance.kill();
            CordovaIosDeviceLauncher.webDebuggerProxyInstance = null;
        }
    }

    public static getBundleIdentifier(projectRoot: string): Promise<string> {
        return fs.promises.readdir(path.join(projectRoot, "platforms", "ios")).then((files: string[]) => {
            let xcodeprojfiles = files.filter((file: string) => /\.xcodeproj$/.test(file));
            if (xcodeprojfiles.length === 0) {
                throw new Error(localize("UnableToFindXCodeProjFile", "Unable to find xcodeproj file"));
            }
            let xcodeprojfile = xcodeprojfiles[0];
            let projectName = /^(.*)\.xcodeproj/.exec(xcodeprojfile)[1];
            let filepath = path.join(projectRoot, "platforms", "ios", projectName, projectName + "-Info.plist");
            let plist = pl.parse(fs.readFileSync(filepath, "utf8"));
            // Since Cordova 9, no plain value is used, so we need to take it from project.pbxproj
            if (plist.CFBundleIdentifier === "$(PRODUCT_BUNDLE_IDENTIFIER)") {
                return this.getBundleIdentifierFromPbxproj(path.join(projectRoot, "platforms", "ios", xcodeprojfile));
            } else {
                return plist.CFBundleIdentifier;
            }
        });
    }

    public static startDebugProxy(proxyPort: number): Promise<child_process.ChildProcess> {
        if (CordovaIosDeviceLauncher.nativeDebuggerProxyInstance) {
            CordovaIosDeviceLauncher.nativeDebuggerProxyInstance.kill("SIGHUP"); // idevicedebugserver does not exit from SIGTERM
            CordovaIosDeviceLauncher.nativeDebuggerProxyInstance = null;
        }

        return CordovaIosDeviceLauncher.mountDeveloperImage().then(() => {
            return new Promise((resolve, reject) => {
                CordovaIosDeviceLauncher.nativeDebuggerProxyInstance = child_process.spawn("idevicedebugserverproxy", [proxyPort.toString()]);
                CordovaIosDeviceLauncher.nativeDebuggerProxyInstance.on("error", function (err: any): void {
                    reject(err);
                });
                // Allow 200ms for the spawn to error out, ~125ms isn't uncommon for some failures
                return delay(200).then(() => resolve(CordovaIosDeviceLauncher.nativeDebuggerProxyInstance));
            });
        });
    }

    public static startWebkitDebugProxy(proxyPort: number, proxyRangeStart: number, proxyRangeEnd: number): Promise<void> {
        if (CordovaIosDeviceLauncher.webDebuggerProxyInstance) {
            CordovaIosDeviceLauncher.webDebuggerProxyInstance.kill();
            CordovaIosDeviceLauncher.webDebuggerProxyInstance = null;
        }

        return new Promise((resolve, reject) => {
            let portRange = `null:${proxyPort},:${proxyRangeStart}-${proxyRangeEnd}`;
            CordovaIosDeviceLauncher.webDebuggerProxyInstance = child_process.spawn("ios_webkit_debug_proxy", ["-c", portRange]);
            CordovaIosDeviceLauncher.webDebuggerProxyInstance.on("error", function () {
                reject(new Error(localize("UnableToStartIosWebkitDebugProxy", "Unable to start ios_webkit_debug_proxy.")));
            });
            // Allow some time for the spawned process to error out
            return delay(250).then(() => resolve(void 0));
        });
    }

    public static getPathOnDevice(packageId: string): Promise<string> {
        const cp = new ChildProcess();
        return cp.execToString("ideviceinstaller -l -o xml > /tmp/$$.ideviceinstaller && echo /tmp/$$.ideviceinstaller")
            .catch(function (err: any): any {
                if (err.code === "ENOENT") {
                    throw new Error(localize("UnableToStartiDeviceInstaller", "Unable to find ideviceinstaller."));
                }
                throw err;
            }).then((stdout: string) => {
                // First find the path of the app on the device
                let filename: string = stdout.trim();
                if (!/^\/tmp\/[0-9]+\.ideviceinstaller$/.test(filename)) {
                    throw new Error(localize("UnableToListInstalledApplicationsOnDevice", "Unable to list installed applications on device"));
                }

                let list: any[] = pl.parse(fs.readFileSync(filename, "utf8"));
                fs.unlinkSync(filename);
                for (let i: number = 0; i < list.length; ++i) {
                    if (list[i].CFBundleIdentifier === packageId) {
                        let path: string = list[i].Path;
                        return path;
                    }
                }

                throw new Error(localize("ApplicationNotInstalledOnTheDevice", "Application not installed on the device"));
            });
    }

    public static encodePath(packagePath: string): string {
        // Encode the path by converting each character value to hex
        return packagePath.split("").map((c: string) => c.charCodeAt(0).toString(16)).join("").toUpperCase();
    }

    private static getBundleIdentifierFromPbxproj(xcodeprojFilePath: string): Promise<string> {
        const pbxprojFilePath = path.join(xcodeprojFilePath, "project.pbxproj");
        const pbxproj = xcode.project(pbxprojFilePath).parseSync();
        const target = pbxproj.getFirstTarget();
        const configListUUID = target.firstTarget.buildConfigurationList;
        const configListsMap = pbxproj.pbxXCConfigurationList();
        const targetConfigs = configListsMap[configListUUID].buildConfigurations;
        const targetConfigUUID = targetConfigs[0].value; // 0 is "Debug, 1 is Release" - usually they have the same associated bundleId, it's highly unlikely someone would change it
        const allConfigs = pbxproj.pbxXCBuildConfigurationSection();
        const bundleId = allConfigs[targetConfigUUID].buildSettings.PRODUCT_BUNDLE_IDENTIFIER;
        return Promise.resolve(bundleId);
    }

    private static mountDeveloperImage(): Promise<void> {
        return CordovaIosDeviceLauncher.getDiskImage()
            .then((path: string) => {
                let imagemounter: child_process.ChildProcess = child_process.spawn("ideviceimagemounter", [path, path + ".signature"]);
                return new Promise((resolve, reject) => {
                    let stdout: string = "";
                    imagemounter.stdout.on("data", function (data: any): void {
                        stdout += data.toString();
                    });
                    imagemounter.on("close", function (code: number): void {
                        if (code !== 0) {
                            if (stdout.indexOf("Error:") !== -1) {
                                resolve(); // Technically failed, but likely caused by the image already being mounted.
                            } else if (stdout.indexOf("No device found, is it plugged in?") !== -1) {
                                reject(localize("UnableToFindDevice", "Unable to find device. Is the device plugged in?"));
                            }

                            reject(localize("UnableToMountDeveloperDiskImage", "Unable to mount developer disk image."));
                        } else {
                            resolve();
                        }
                    });
                    imagemounter.on("error", function (err: any): void {
                        reject(err);
                    });
                });
            });
    }

    private static getDiskImage(): Promise<string> {
        const cp = new ChildProcess();
        // Attempt to find the OS version of the iDevice, e.g. 7.1
        let versionInfo: Promise<string> = cp.execToString("ideviceinfo -s -k ProductVersion")
            .then(stdout => {
                // Versions for DeveloperDiskImage seem to be X.Y, while some device versions are X.Y.Z
                return /^(\d+\.\d+)(?:\.\d+)?$/gm.exec(stdout.trim())[1];
            })
            .catch(err => {
                throw new Error(localize("UnableToGetDeviceOSVersion", "Unable to get device OS version. Details: {0}", err.message));
            });

        // Attempt to find the path where developer resources exist.
        let pathInfo: Promise<string> = cp.execToString("xcrun -sdk iphoneos --show-sdk-platform-path").then(stdout => {
            let sdkpath: string = stdout.trim();
            return sdkpath;
        });

        // Attempt to find the developer disk image for the appropriate
        return Promise.all([versionInfo, pathInfo]).then(([version, sdkpath]) => {
            let find: child_process.ChildProcess = child_process.spawn("find", [sdkpath, "-path", "*" + version + "*", "-name", "DeveloperDiskImage.dmg"]);
            return new Promise<string>((resolve, reject) => {
                find.stdout.on("data", function (data: any): void {
                    let dataStr: string = data.toString();
                    let path: string = dataStr.split("\n")[0].trim();
                    if (!path) {
                        reject(localize("UnableToFindDeveloperDiskImage", "Unable to find developer disk image."));
                    } else {
                        resolve(path);
                    }
                });
                find.on("close", function (): void {
                    reject(localize("UnableToFindDeveloperDiskImage", "Unable to find developer disk image."));
                });
            });
        });
    }
}
