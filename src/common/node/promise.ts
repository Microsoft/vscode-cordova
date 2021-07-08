// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

export class DeferredPromise<T> {
    private resolveSelf: (value: T | PromiseLike<T>) => void;
    private rejectSelf: (reason?: any) => void;
    private _promise: Promise<T>;

    constructor() {
        this._promise = new Promise<T>((resolve, reject) => {
            this.resolveSelf = resolve;
            this.rejectSelf = reject;
        });
    }

    public resolve(val: T): void {
        this.resolveSelf(val);
    }

    public reject(reason: any): void {
        this.rejectSelf(reason);
    }

    public get promise(): Promise<T> {
        return this._promise;
    }
}
