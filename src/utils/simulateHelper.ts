// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { SimulateTargets } from "../extension/simulate";

export class SimulateHelper {
    public static isSimulateTarget(target: string): boolean {
        return Object.values(SimulateTargets).includes(target as SimulateTargets);
    }
}
