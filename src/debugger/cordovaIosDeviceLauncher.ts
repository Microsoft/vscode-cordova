// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

"use strict";

import * as child_process from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as pl from "plist";
import * as Q from "q";

let promiseExec = Q.denodeify(child_process.exec);

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

    public static getBundleIdentifier(projectRoot: string): Q.Promise<string> {
        return Q.nfcall(fs.readdir, path.join(projectRoot, "platforms", "ios")).then((files: string[]) => {
            let xcodeprojfiles = files.filter((file: string) => /\.xcodeproj$/.test(file));
            if (xcodeprojfiles.length === 0) {
                throw new Error("Unable to find xcodeproj file");
            }
            let xcodeprojfile = xcodeprojfiles[0];
            let projectName = /^(.*)\.xcodeproj/.exec(xcodeprojfile)[1];
            let filepath = path.join(projectRoot, "platforms", "ios", projectName, projectName + "-Info.plist");
            let plist = pl.parse(fs.readFileSync(filepath, "utf8"));
            return plist.CFBundleIdentifier;
        });
    }

    public static startDebugProxy(proxyPort: number): Q.Promise<child_process.ChildProcess> {
        if (CordovaIosDeviceLauncher.nativeDebuggerProxyInstance) {
            CordovaIosDeviceLauncher.nativeDebuggerProxyInstance.kill("SIGHUP"); // idevicedebugserver does not exit from SIGTERM
            CordovaIosDeviceLauncher.nativeDebuggerProxyInstance = null;
        }

        return CordovaIosDeviceLauncher.mountDeveloperImage().then(function (): Q.Promise<child_process.ChildProcess> {
            let deferred = Q.defer<child_process.ChildProcess>();
            CordovaIosDeviceLauncher.nativeDebuggerProxyInstance = child_process.spawn("idevicedebugserverproxy", [proxyPort.toString()]);
            CordovaIosDeviceLauncher.nativeDebuggerProxyInstance.on("error", function (err: any): void {
                deferred.reject(err);
            });
            // Allow 200ms for the spawn to error out, ~125ms isn't uncommon for some failures
            Q.delay(200).then(() => deferred.resolve(CordovaIosDeviceLauncher.nativeDebuggerProxyInstance));

            return deferred.promise;
        });
    }

    public static startWebkitDebugProxy(proxyPort: number, proxyRangeStart: number, proxyRangeEnd: number): Q.Promise<any> {
        if (CordovaIosDeviceLauncher.webDebuggerProxyInstance) {
            CordovaIosDeviceLauncher.webDebuggerProxyInstance.kill();
            CordovaIosDeviceLauncher.webDebuggerProxyInstance = null;
        }

        let sim = CordovaIosDeviceLauncher.getWebInspectorSocket();
        console.log(sim);
        let deferred = Q.defer();
        let portRange = `null:${proxyPort},:${proxyRangeStart}-${proxyRangeEnd}`;
        CordovaIosDeviceLauncher.webDebuggerProxyInstance = child_process.spawn("ios_webkit_debug_proxy", ["-c", portRange]);
        CordovaIosDeviceLauncher.webDebuggerProxyInstance.on("error", function () {
            deferred.reject(new Error("Unable to start ios_webkit_debug_proxy."));
        });
        // Allow some time for the spawned process to error out
        Q.delay(250).then(() => deferred.resolve({}));

        return deferred.promise;
    }

    // Attempt to start the app on the device, using the debug server proxy on a given port.
    // Returns a socket speaking remote gdb protocol with the debug server proxy.
    public static startApp(packageId: string, proxyPort: number, appLaunchStepTimeout: number): Q.Promise<string> {
        // When a user has many apps installed on their device, the response from ideviceinstaller may be large (500k or more)
        // This exceeds the maximum stdout size that exec allows, so we redirect to a temp file.
        return CordovaIosDeviceLauncher.getPathOnDevice(packageId).then(function (path: string): Q.Promise<string> { return CordovaIosDeviceLauncher.startAppViaDebugger(proxyPort, path, appLaunchStepTimeout); });
    }

    public static getPathOnDevice(packageId: string): Q.Promise<string> {
        return promiseExec("ideviceinstaller -l -o xml > /tmp/$$.ideviceinstaller && echo /tmp/$$.ideviceinstaller")
        .catch(function (err: any): any {
            if (err.code === "ENOENT") {
                throw new Error("Unable to find ideviceinstaller.");
            }
            throw err;
        }).spread<string>(function (stdout: string): string {
            // First find the path of the app on the device
            let filename: string = stdout.trim();
            if (!/^\/tmp\/[0-9]+\.ideviceinstaller$/.test(filename)) {
                throw new Error("Unable to list installed applications on device");
            }

            let list: any[] = pl.parse(fs.readFileSync(filename, "utf8"));
            fs.unlink(filename);
            for (let i: number = 0; i < list.length; ++i) {
                if (list[i].CFBundleIdentifier === packageId) {
                    let path: string = list[i].Path;
                    return path;
                }
            }

            throw new Error("Application not installed on the device");
        });
    }

    public static startAppViaDebugger(portNumber: number, packagePath: string, appLaunchStepTimeout: number): Q.Promise<string> {
        let encodedPath: string = CordovaIosDeviceLauncher.encodePath(packagePath);

        // We need to send 3 messages to the proxy, waiting for responses between each message:
        // A(length of encoded path),0,(encoded path)
        // Hc0
        // c
        // We expect a '+' for each message sent, followed by a $OK#9a to indicate that everything has worked.
        // For more info, see http://www.opensource.apple.com/source/lldb/lldb-167.2/docs/lldb-gdb-remote.txt
        let socket: net.Socket = new net.Socket();
        let initState: number = 0;
        let endStatus: number = null;
        let endSignal: number = null;

        let deferred1: Q.Deferred<net.Socket> = Q.defer<net.Socket>();
        let deferred2: Q.Deferred<net.Socket> = Q.defer<net.Socket>();
        let deferred3: Q.Deferred<net.Socket> = Q.defer<net.Socket>();

        socket.on("data", function (data: any): void {
            data = data.toString();
            while (data[0] === "+") { data = data.substring(1); }
            // Acknowledge any packets sent our way
            if (data[0] === "$") {
                socket.write("+");
                if (data[1] === "W") {
                    // The app process has exited, with hex status given by data[2-3]
                    let status: number = parseInt(data.substring(2, 4), 16);
                    endStatus = status;
                    socket.end();
                } else if (data[1] === "X") {
                    // The app rocess exited because of signal given by data[2-3]
                    let signal: number = parseInt(data.substring(2, 4), 16);
                    endSignal = signal;
                    socket.end();
                } else if (data.substring(1, 3) === "OK") {
                    // last command was received OK;
                    if (initState === 1) {
                        deferred1.resolve(socket);
                    } else if (initState === 2) {
                        deferred2.resolve(socket);
                    } else if (initState === 3) {
                        // iOS 10 no longer responds with output O message, so we assume the app is started after the device acknowledges our request to begin execution.
                        deferred3.resolve(socket);
                        initState++;
                    }
                } else if (data[1] === "O") {
                    // STDOUT was written to, and the rest of the input until reaching a '#' is a hex-encoded string of that output
                    if (initState === 3) {
                        deferred3.resolve(socket);
                        initState++;
                    }
                } else if (data[1] === "E") {
                    // An error has occurred, with error code given by data[2-3]: parseInt(data.substring(2, 4), 16)
                    deferred1.reject("Unable to launch application.");
                    deferred2.reject("Unable to launch application.");
                    deferred3.reject("Unable to launch application.");
                }
            } else if (data === "" && initState === 3) {
                // On iOS 10.2.1 (and maybe others) after 'c' message debug server doesn't respond with '$OK', see also
                // http://www.embecosm.com/appnotes/ean4/embecosm-howto-rsp-server-ean4-issue-2.html#sec_exchange_cont
                deferred3.resolve(socket);
                initState++;
            }
        });

        socket.on("end", function (): void {
            deferred1.reject("Unable to launch application.");
            deferred2.reject("Unable to launch application.");
            deferred3.reject("Unable to launch application.");
        });

        socket.on("error", function (err: Error): void {
            deferred1.reject(err);
            deferred2.reject(err);
            deferred3.reject(err);
        });

        socket.connect(portNumber, "localhost", function (): void {
            // set argument 0 to the (encoded) path of the app
            let cmd: string = CordovaIosDeviceLauncher.makeGdbCommand("A" + encodedPath.length + ",0," + encodedPath);
            initState++;
            socket.write(cmd);
            setTimeout(function (): void {
                deferred1.reject("Timeout launching application. Is the device locked?");
            }, appLaunchStepTimeout);
        });

        return deferred1.promise.then(function (sock: net.Socket): Q.Promise<net.Socket> {
            // Set the step and continue thread to any thread
            let cmd: string = CordovaIosDeviceLauncher.makeGdbCommand("Hc0");
            initState++;
            sock.write(cmd);
            setTimeout(function (): void {
                deferred2.reject("Timeout launching application. Is the device locked?");
            }, appLaunchStepTimeout);
            return deferred2.promise;
        }).then(function (sock: net.Socket): Q.Promise<net.Socket> {
            // Continue execution; actually start the app running.
            let cmd: string = CordovaIosDeviceLauncher.makeGdbCommand("c");
            initState++;
            sock.write(cmd);
            setTimeout(function (): void {
                deferred3.reject("Timeout launching application. Is the device locked?");
            }, appLaunchStepTimeout);
            return deferred3.promise;
        }).then(() => packagePath);
    }

    public static encodePath(packagePath: string): string {
        // Encode the path by converting each character value to hex
        return packagePath.split("").map((c: string) => c.charCodeAt(0).toString(16)).join("").toUpperCase();
    }

    private static getWebInspectorSocket() {

        const WEBINSPECTOR_SOCKET_REGEXP = /\s+(\S+com\.apple\.webinspectord_sim\.socket)/;
        // lsof -aUc launchd_sim
        // gives a set of records like:
        //   launchd_s 69760 isaac    3u  unix 0x57aa4fceea3937f3      0t0      /private/tmp/com.apple.CoreSimulator.SimDevice.D7082A5C-34B5-475C-994E-A21534423B9E/syslogsock
        //   launchd_s 69760 isaac    5u  unix 0x57aa4fceea395f03      0t0      /private/tmp/com.apple.launchd.2B2u8CkN8S/Listeners
        //   launchd_s 69760 isaac    6u  unix 0x57aa4fceea39372b      0t0      ->0x57aa4fceea3937f3
        //   launchd_s 69760 isaac    8u  unix 0x57aa4fceea39598b      0t0      /private/tmp/com.apple.launchd.2j5k1TMh6i/com.apple.webinspectord_sim.socket
        //   launchd_s 69760 isaac    9u  unix 0x57aa4fceea394c43      0t0      /private/tmp/com.apple.launchd.4zm9JO9KEs/com.apple.testmanagerd.unix-domain.socket
        //   launchd_s 69760 isaac   10u  unix 0x57aa4fceea395f03      0t0      /private/tmp/com.apple.launchd.2B2u8CkN8S/Listeners
        //   launchd_s 69760 isaac   11u  unix 0x57aa4fceea39598b      0t0      /private/tmp/com.apple.launchd.2j5k1TMh6i/com.apple.webinspectord_sim.socket
        //   launchd_s 69760 isaac   12u  unix 0x57aa4fceea394c43      0t0      /private/tmp/com.apple.launchd.4zm9JO9KEs/com.apple.testmanagerd.unix-domain.socket
        // these _appear_ to always be grouped together (so, the records for the particular sim are all in a group, before the next sim, etc.)
        // so starting from the correct UDID, we ought to be able to pull the next record with `com.apple.webinspectord_sim.socket` to get the correct socket
        let stdout: string = "";
        let findSimulatorEntriesProcess = child_process.spawnSync("lsof", ["-aUc", "launchd_sim"], {
            stdio: "pipe",
            encoding: "utf-8",
        });
        stdout = findSimulatorEntriesProcess.output[1].toString();

        const match = WEBINSPECTOR_SOCKET_REGEXP.exec(stdout);
        if (!match) {
            return null;
        }
        let webInspectorSocket = match[1];
        return webInspectorSocket;
      }

    private static mountDeveloperImage(): Q.Promise<any> {
        return CordovaIosDeviceLauncher.getDiskImage()
            .then(function (path: string): Q.Promise<any> {
            let imagemounter: child_process.ChildProcess = child_process.spawn("ideviceimagemounter", [path, path + ".signature"]);
            let deferred: Q.Deferred<any> = Q.defer();
            let stdout: string = "";
            imagemounter.stdout.on("data", function (data: any): void {
                stdout += data.toString();
            });
            imagemounter.on("close", function (code: number): void {
                if (code !== 0) {
                    if (stdout.indexOf("Error:") !== -1) {
                        deferred.resolve({}); // Technically failed, but likely caused by the image already being mounted.
                    } else if (stdout.indexOf("No device found, is it plugged in?") !== -1) {
                        deferred.reject("Unable to find device. Is the device plugged in?");
                    }

                    deferred.reject("Unable to mount developer disk image.");
                } else {
                    deferred.resolve({});
                }
            });
            imagemounter.on("error", function(err: any): void {
                deferred.reject(err);
            });
            return deferred.promise;
        });
    }

    private static getDiskImage(): Q.Promise<string> {
        // Attempt to find the OS version of the iDevice, e.g. 7.1
        let versionInfo: Q.Promise<any> = promiseExec("ideviceinfo -s -k ProductVersion")
            .spread<string>(function (stdout: string): string {
                // Versions for DeveloperDiskImage seem to be X.Y, while some device versions are X.Y.Z
                return /^(\d+\.\d+)(?:\.\d+)?$/gm.exec(stdout.trim())[1];
            })
            .catch(function (e): string {
                throw new Error(`Unable to get device OS version. Details: ${e.message}`);
            });

        // Attempt to find the path where developer resources exist.
        let pathInfo: Q.Promise<any> = promiseExec("xcrun -sdk iphoneos --show-sdk-platform-path").spread<string>(function (stdout: string): string {
            let sdkpath: string = stdout.trim();
            return sdkpath;
        });

        // Attempt to find the developer disk image for the appropriate
        return Q.all([versionInfo, pathInfo]).spread<string>(function (version: string, sdkpath: string): Q.Promise<string> {
            let find: child_process.ChildProcess = child_process.spawn("find", [sdkpath, "-path", "*" + version + "*", "-name", "DeveloperDiskImage.dmg"]);
            let deferred: Q.Deferred<string> = Q.defer<string>();

            find.stdout.on("data", function (data: any): void {
                let dataStr: string = data.toString();
                let path: string = dataStr.split("\n")[0].trim();
                if (!path) {
                    deferred.reject("Unable to find developer disk image");
                } else {
                    deferred.resolve(path);
                }
            });
            find.on("close", function (): void {
                deferred.reject("Unable to find developer disk image");
            });

            return deferred.promise;
        });
    }

    private static makeGdbCommand(command: string): string {
        let commandString: string = "$" + command + "#";
        let stringSum: number = 0;
        for (let i: number = 0; i < command.length; i++) {
            stringSum += command.charCodeAt(i);
        }

        /* tslint:disable:no-bitwise */
        // We need some bitwise operations to calculate the checksum
        stringSum = stringSum & 0xFF;
        /* tslint:enable:no-bitwise */
        let checksum: string = stringSum.toString(16).toUpperCase();
        if (checksum.length < 2) {
            checksum = "0" + checksum;
        }

        commandString += checksum;
        return commandString;
    }
}

process.on("exit", CordovaIosDeviceLauncher.cleanup);
