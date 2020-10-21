// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as child_process from "child_process";
import { CordovaProjectHelper } from "../utils/cordovaProjectHelper";
import * as Q from "q";
import * as path from "path";
import * as nls from "vscode-nls";
import { findFileInFolderHierarchy } from "../utils/extensionHelper";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

// suppress the following strings because they are not actual errors:
const errorsToSuppress = ["Run an Ionic project on a connected device"];

export function execCommand(command: string, args: string[], errorLogger: (message: string) => void): Q.Promise<string> {
    let deferred = Q.defer<string>();
    let proc = child_process.spawn(command, args, { stdio: "pipe" , env: process.env});
    let stderr = "";
    let stdout = "";
    proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
    });
    proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
    });
    proc.on("error", (err: Error) => {
        deferred.reject(err);
    });
    proc.on("close", (code: number) => {
        if (code !== 0) {
            errorLogger(stderr);
            errorLogger(stdout);
            deferred.reject(localize("ErrorRunningCommand", "Error running {0} {1}", command, args.join(" ")));
        }
        deferred.resolve(stdout);
    });

    return deferred.promise;
}

export function cordovaRunCommand(command: string, args: string[], env, cordovaRootPath: string): Q.Promise<string[]> {
    let defer = Q.defer<string[]>();
    let isIonicProject = CordovaProjectHelper.isIonicAngularProject(cordovaRootPath);
    let output = "";
    let stderr = "";
    let cordovaProcess = cordovaStartCommand(command, args, env, cordovaRootPath);

    // Prevent these lines to be shown more than once
    // to prevent debug console pollution
    let isShown = {
        "Running command": false,
        "cordova prepare": false,
        "cordova platform add": false,
    };

    cordovaProcess.stderr.on("data", data => {
        stderr += data.toString();
        for (let i = 0; i < errorsToSuppress.length; i++) {
            if (data.toString().indexOf(errorsToSuppress[i]) >= 0) {
                return;
            }
        }
        defer.notify([data.toString(), "stderr"]);
    });
    cordovaProcess.stdout.on("data", (data: Buffer) => {
        let str = data.toString().replace(/\u001b/g, "").replace(/\[2K\[G/g, ""); // Erasing `[2K[G` artifacts from DEBUG CONSOLE output
        output += str;
        for (let message in isShown) {
            if (str.indexOf(message) > -1) {
                if (!isShown[message]) {
                    isShown[message] = true;
                    defer.notify([str, "stdout"]);
                }
                return;
            }
        }
        defer.notify([str, "stdout"]);

        if (isIonicProject && str.indexOf("LAUNCH SUCCESS") >= 0) {
            defer.resolve([output, stderr]);
        }
    });
    cordovaProcess.on("exit", exitCode => {
        if (exitCode) {
            defer.reject(new Error(localize("CommandFailedWithExitCode", "{0} {1} failed with exit code {2}", command, args.join(" "), exitCode)));
        } else {
            defer.resolve([output, stderr]);
        }
    });
    cordovaProcess.on("error", error => {
        defer.reject(error);
    });

    return defer.promise;
}

export function cordovaStartCommand(command: string, args: string[], env: any, cordovaRootPath: string): child_process.ChildProcess {
    const isIonic = CordovaProjectHelper.isIonicAngularProject(cordovaRootPath);
    const isIonicServe: boolean = args.indexOf("serve") >= 0;

    if (isIonic && !isIonicServe) {
        const isIonicCliVersionGte3 = CordovaProjectHelper.isIonicCliVersionGte3(cordovaRootPath, command);

        if (isIonicCliVersionGte3) {
            args.unshift("cordova");
        }
    }

    if (isIonic) {
        args.push("--no-interactive");
    } else {
        args.push("--no-update-notifier");
    }

    return child_process.spawn(command, args, { cwd: cordovaRootPath, env: Object.assign(process.env, env)});
}

export function killTree(processId: number): void {
    const cmd = process.platform === "win32" ?
        "taskkill.exe /F /T /PID" :
        path.join(findFileInFolderHierarchy(__dirname, "scripts"), "terminateProcess.sh");

    try {
        child_process.execSync(`${cmd} ${processId}`);
    } catch (err) {
    }
}

export function killChildProcess(childProcess: child_process.ChildProcess): Q.Promise<void> {
    killTree(childProcess.pid);
    return Q<void>(void 0);
}
