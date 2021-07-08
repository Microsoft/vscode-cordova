// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as should from "should";
import * as fs from "fs";
import * as sinon from "sinon";
import * as plist from "plist";

import { CordovaIosDeviceLauncher } from "../../src/debugger/cordovaIosDeviceLauncher";

suite("cordovaIosDeviceLauncher", function () {
    let readdirMock;
    let readFileSyncMock;
    let parseMock;

    suiteTeardown(() => {
        readdirMock.restore();
        readFileSyncMock.restore();
        parseMock.restore();
    });

    test("should be able to find the bundle identifier", () => {
        readdirMock = (sinon.stub(fs.promises, "readdir") as any).returns(Promise.resolve(["foo", "bar.xcodeproj"]));
        readFileSyncMock = sinon.stub(fs, "readFileSync").returns("");
        parseMock = sinon.stub(plist, "parse").returns({CFBundleIdentifier: "test.bundle.identifier"});

        return CordovaIosDeviceLauncher.getBundleIdentifier("testApp").then((bundleId) => {
            should.equal(bundleId, "test.bundle.identifier");
        });
    });
});
