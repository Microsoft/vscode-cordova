// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as net from "net";
import * as Q from "q";
import {PluginSimulator} from "./simulate";
import {SimulationInfo} from "../common/simulationInfo";
import {SimulateOptions} from "cordova-simulate";
import * as vscode from "vscode";

import {
    ErrorMarker,
    ExtensionMessage,
    ExtensionMessageSender,
    MessageWithArguments
} from "../common/extensionMessaging";

import {IProjectType, CordovaProjectHelper} from "../utils/cordovaProjectHelper";
import {Telemetry} from "../utils/telemetry";
import { CordovaCommandHelper } from "../utils/cordovaCommandHelper";

export class ExtensionServer implements vscode.Disposable {
    public pluginSimulator: PluginSimulator;
    private serverInstance: net.Server = null;
    private messageHandlerDictionary: { [id: number]: ((...argArray: any[]) => Q.Promise<any>) } = {};
    private pipePath: string;

    public constructor(pluginSimulator: PluginSimulator, projectRoot: string) {
        let messageSender = new ExtensionMessageSender(projectRoot);
        this.pipePath = messageSender.getExtensionPipePath();
        this.pluginSimulator = pluginSimulator;

        // Register handlers for all messages
        this.messageHandlerDictionary[ExtensionMessage.SEND_TELEMETRY] = this.sendTelemetry;
        this.messageHandlerDictionary[ExtensionMessage.LAUNCH_SIM_HOST] = this.launchSimHost;
        this.messageHandlerDictionary[ExtensionMessage.SIMULATE] = this.simulate;
        this.messageHandlerDictionary[ExtensionMessage.START_SIMULATE_SERVER] = this.launchSimulateServer;
        this.messageHandlerDictionary[ExtensionMessage.GET_VISIBLE_EDITORS_COUNT] = this.getVisibleEditorsCount;
        this.messageHandlerDictionary[ExtensionMessage.GET_RUN_ARGUMENTS] = this.getRunArguments;
        this.messageHandlerDictionary[ExtensionMessage.GET_CORDOVA_EXECUTABLE] = this.getCordovaExecutable;
    }

    /**
     * Starts the server.
     */
    public setup(): Q.Promise<void> {

        let deferred = Q.defer<void>();

        let launchCallback = (error: any) => {
            if (error) {
                deferred.reject(error);
            } else {
                deferred.resolve(null);
            }
        };

        this.serverInstance = net.createServer(this.handleSocket.bind(this));
        this.serverInstance.on("error", this.recoverServer.bind(this));
        this.serverInstance.listen(this.pipePath, launchCallback);

        return deferred.promise;
    }

    /**
     * Stops the server.
     */
    public dispose(): void {
        if (this.serverInstance) {
            this.serverInstance.close();
            this.serverInstance = null;
        }

        if (this.pluginSimulator) {
            this.pluginSimulator.dispose();
            this.pluginSimulator = null;
        }
    }

    /**
     * Sends telemetry
     */
    private sendTelemetry(extensionId: string, extensionVersion: string, appInsightsKey: string, eventName: string, properties: { [key: string]: string }, measures: { [key: string]: number }): Q.Promise<any> {
        Telemetry.sendExtensionTelemetry(extensionId, extensionVersion, appInsightsKey, eventName, properties, measures);
        return Q.resolve({});
    }

    /**
     * Prepares for simulate debugging. The server and simulate host are launched here.
     * The application host is launched by the debugger.
     *
     * Returns info about the running simulate server
     */
    private simulate(fsPath: string, simulateOptions: SimulateOptions, projectType: IProjectType): Q.Promise<SimulationInfo> {
        return this.launchSimulateServer(fsPath, simulateOptions, projectType)
            .then((simulateInfo: SimulationInfo) => {
               return this.launchSimHost(fsPath, simulateOptions.target).then(() => simulateInfo);
            });
    }

    /**
     * Launches the simulate server. Only the server is launched here.
     *
     * Returns info about the running simulate server
     */
    private launchSimulateServer(fsPath: string, simulateOptions: SimulateOptions, projectType: IProjectType): Q.Promise<SimulationInfo> {
        return this.pluginSimulator.launchServer(fsPath, simulateOptions, projectType);
    }

    /**
     * Launches sim-host using an already running simulate server.
     */
    private launchSimHost(fsPath: string, target: string): Q.Promise<void> {
        return this.pluginSimulator.launchSimHost(fsPath, target);
    }

    /**
     * Returns the number of currently visible editors.
     */
    private getVisibleEditorsCount(): Q.Promise<number> {
        // visibleTextEditors is null proof (returns empty array if no editors visible)
        return Q.resolve(vscode.window.visibleTextEditors.length);
    }

    /**
     * Extension message handler.
     */
    private handleExtensionMessage(messageWithArgs: MessageWithArguments): Q.Promise<any> {
        let handler = this.messageHandlerDictionary[messageWithArgs.message];
        if (handler) {
            return handler.apply(this, messageWithArgs.args);
        } else {
            return Q.reject("Invalid message: " + messageWithArgs.message);
        }
    }

    /**
     * Handles connections to the server.
     */
    private handleSocket(socket: net.Socket): void {
        let handleError = (e: any) => {
            let errorMessage = e ? e.message || e.error || e.data || e : "";
            socket.end(ErrorMarker + errorMessage);
        };

        let dataCallback = (data: any) => {
            try {
                let messageWithArgs: MessageWithArguments = JSON.parse(data);
                this.handleExtensionMessage(messageWithArgs)
                    .then(result => {
                        socket.end(JSON.stringify(result));
                    })
                    .catch((e) => { handleError(e); })
                    .done();
            } catch (e) {
                handleError(e);
            }
        };

        socket.on("data", dataCallback);
    }

    /**
     * Recovers the server in case the named socket we use already exists, but no other instance of VSCode is active.
     */
    private recoverServer(error: any): void {
        let errorHandler = (e: any) => {
            /* The named socket is not used. */
            if (e.code === "ECONNREFUSED") {
                CordovaProjectHelper.deleteDirectoryRecursive(this.pipePath);
                this.serverInstance.listen(this.pipePath);
            }
        };

        /* The named socket already exists. */
        if (error.code === "EADDRINUSE") {
            let clientSocket = new net.Socket();
            clientSocket.on("error", errorHandler);
            clientSocket.connect(this.pipePath, function () {
                clientSocket.end();
            });
        }
    }

    private getRunArguments(fsPath: string): Q.Promise<string[]> {
        return Q.resolve(CordovaCommandHelper.getRunArguments(fsPath));
    }


    private getCordovaExecutable(fsPath: string): Q.Promise<string> {
        return Q.resolve(CordovaCommandHelper.getCordovaExecutable(fsPath));
    }
}
