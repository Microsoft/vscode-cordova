// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as assert from "assert";
import * as path from "path";
import { delay } from "../src/utils/extensionHelper";
import * as rimraf from "rimraf";
import * as vscode from "vscode";
import * as testUtils from "./testUtils";
import { CordovaProjectHelper } from "../src/utils/cordovaProjectHelper";

suite("extensionContext", () => {
    let testProjectPath: string = path.resolve(__dirname, "resources", "testCordovaProject");
    let cordovaTypeDefDir: string = CordovaProjectHelper.getOrCreateTypingsTargetPath(testProjectPath);

    suiteTeardown(() => {
        // Cleanup the target folder for type definitions
        if (CordovaProjectHelper.existsSync(cordovaTypeDefDir)) {
            rimraf.sync(cordovaTypeDefDir);
        }
    });

    test("Verify that the commands registered by Cordova extension are loaded", () => {
        return vscode.commands.getCommands(true)
            .then((results) => {
                let cordovaCmdsAvailable = results.filter((commandName: string) => {
                    return commandName.indexOf("cordova.") > -1;
                });
                assert.deepStrictEqual(cordovaCmdsAvailable, ["cordova.restart", "cordova.prepare", "cordova.build", "cordova.run", "cordova.simulate.android", "cordova.simulate.ios"]);
            });
    });

    suite("smokeTestsContext", () => {
        test("Execute Commands from the command palette", () => {
            return testUtils.addCordovaComponents("platform", testProjectPath, ["android"])
                .then(() => {
                    return vscode.commands.executeCommand("cordova.build");
                }).then(() => {
                    return delay(10000);
                }).then(_res => {
                    let androidBuildPath = path.resolve(testProjectPath, "platforms", "android", "app", "build");
                    assert.ok(CordovaProjectHelper.existsSync(androidBuildPath));
                    return testUtils.removeCordovaComponents("platform", testProjectPath, ["android"]);
                });
        });
    });

    suite("CordovaSimulateContext", () => {
        test("Verify that the simulate command launches the simulate server", () => {
            return testUtils.addCordovaComponents("platform", testProjectPath, ["android"])
                .then(() => vscode.commands.executeCommand("cordova.simulate.android"))
                .then(() => testUtils.isUrlReachable("http://localhost:8000/simulator/index.html"))
                .then((simHostStarted: boolean) => assert(simHostStarted, "The simulation host is running."))
                .then(() => testUtils.isUrlReachable("http://localhost:8000/index.html"))
                .then((appHostStarted: boolean) => assert(appHostStarted, "The application host is running."))
                .finally(() => testUtils.removeCordovaComponents("platform", testProjectPath, ["android"]));
        });
    });
});
