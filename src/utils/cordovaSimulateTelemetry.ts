// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { Telemetry } from "./telemetry";
import { TelemetryGenerator, TelemetryHelper } from "./telemetryHelper";

/**
 * This class is a telemetry wrapper compatible with cordova-simulate's telemetry. Cordova-simulate expects an object with a sendTelemetry() function, and calls it every time there is a
 * telemetry event. This wrapper creates a telemetry event compatible with vscode-cordova's telemetry, based on cordova-simulate's event, and sends it using the Telemetry module.
 */
export class CordovaSimulateTelemetry {
    public sendTelemetry(eventName: string, props: Telemetry.ITelemetryProperties, piiProps: Telemetry.ITelemetryProperties): void {
        let fullEventName = "cordova-simulate-" + eventName;
        let generator = new TelemetryGenerator(fullEventName);
        let telemetryEvent = new Telemetry.TelemetryEvent(fullEventName);

        Object.keys(props).forEach((prop) => {
            generator.add(prop, props[prop], false);
        });

        Object.keys(piiProps).forEach((prop) => {
            generator.add(prop, piiProps[prop], true);
        });

        TelemetryHelper.addTelemetryEventProperties(telemetryEvent, generator.getTelemetryProperties());
        Telemetry.send(telemetryEvent);
    }
}
