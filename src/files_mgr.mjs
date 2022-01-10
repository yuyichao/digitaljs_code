//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';

export class FilesMgr {
    #script_running
    #script_not_running
    #onChanged
    constructor() {
        this.circuit = undefined;
        this.sources = new Map();
        this.#script_running = {};
        this.#script_not_running = {};
        this.#onChanged = new vscode.EventEmitter();
        this.onChanged = this.#onChanged.event;
    }
    reset(circuit) {
        this.circuit = circuit;
        this.sources.clear();
        this.#script_running = {};
        this.#script_not_running = {};
    }
    refresh() {
        this.#onChanged.fire();
    }
    addSource(uri) {
        if (this.sources.has(uri.path))
            return;
        this.sources.set(uri.path, uri);
        if (path.extname(uri.path) == '.lua') {
            this.#script_not_running[uri.path] = true;
        }
    }
    deleteSource(uri) {
        this.sources.delete(uri.path);
        if (path.extname(uri.path) == '.lua') {
            delete this.#script_not_running[uri.path];
            delete this.#script_running[uri.path];
        }
    }
    scriptStarted(file) {
        delete this.#script_not_running[file];
        this.#script_running[file] = true;
        // The view item doesn't seem to be watching for the context change
        // to redraw the icons so we need to do a full refresh
        // after updating the running state.
        // Ref: https://github.com/microsoft/vscode/issues/140010
        this.#onChanged.fire();
    }
    scriptStopped(file) {
        delete this.#script_running[file];
        this.#script_not_running[file] = true;
        this.#onChanged.fire();
    }
    toJSON() {
        let res = [];
        const circuit_path = path.dirname(this.circuit.path);
        for (let file of this.sources.values())
            res.push(path.relative(circuit_path, file.path));
        return res;
    }
    // Maintain both the running and not running array since there isn't a "not in"
    // when clause that we can use ATM.
    get scriptRunning() {
        return Array.from(Object.keys(this.#script_running));
    }
    get scriptNotRunning() {
        return Array.from(Object.keys(this.#script_not_running));
    }
}

class CircuitFile extends vscode.TreeItem {
    constructor(uri) {
        let name = 'Unnamed circuit';
        if (uri)
            name = path.basename(uri.path);
        super(name, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('circuit-board');
        this.id = 'root-circuit';
        this.contextValue = 'root-circuit';
        this.resourceUri = uri;
    }
}

class SourceFile extends vscode.TreeItem {
    constructor(circuit, uri) {
        let name;
        if (circuit) {
            name = path.relative(path.dirname(circuit.path), uri.path);
        }
        else {
            name = path.basename(uri.path);
        }
        super(name, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('file');
        this.id = uri.toString();
        this.resourceUri = uri;
        this.contextValue = uri.path;
        this.command = { title: 'Open', command: 'vscode.open',
                         arguments: [uri] };
    }
}

export class FilesView {
    #djs
    #onDidChangeTreeData
    constructor(djs) {
        this.#djs = djs;
        this.#onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.#onDidChangeTreeData.event;
        vscode.commands.executeCommand('setContext', 'digitaljs.script_running', []);
        vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running', []);
        djs.files.onChanged(() => {
            vscode.commands.executeCommand('setContext', 'digitaljs.script_running',
                                           djs.files.scriptRunning);
            vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                           djs.files.scriptNotRunning);
            this.#onDidChangeTreeData.fire();
        });
    }

    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        const circuit_file = this.#djs.files.circuit;
        if (!element)
            return [new CircuitFile(circuit_file)];
        console.assert(element instanceof CircuitFile);
        let res = [];
        for (let file of this.#djs.files.sources.values())
            res.push(new SourceFile(circuit_file, file));
        return res;
    }
}
