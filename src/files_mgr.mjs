//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';

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

export class FilesMgr {
    #onDidChangeTreeData
    #script_running
    #script_not_running
    constructor() {
        this.circuit = undefined;
        this.sources = new Map();
        this.#script_running = {};
        this.#script_not_running = {};
        this.#onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.#onDidChangeTreeData.event;
        vscode.commands.executeCommand('setContext', 'digitaljs.script_running', []);
        vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running', []);
    }
    reset(circuit) {
        this.circuit = circuit;
        this.sources.clear();
        this.#script_running = {};
        this.#script_not_running = {};
        vscode.commands.executeCommand('setContext', 'digitaljs.script_running', []);
        vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running', []);
    }
    refresh() {
        this.#onDidChangeTreeData.fire();
    }
    addSource(uri) {
        if (this.sources.has(uri.path))
            return;
        this.sources.set(uri.path, uri);
        if (path.extname(uri.path) == '.lua') {
            this.#script_not_running[uri.path] = true;
            vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                           Array.from(Object.keys(this.#script_not_running)));
        }
    }
    deleteSource(uri) {
        this.sources.delete(uri.path);
        if (path.extname(uri.path) == '.lua') {
            delete this.#script_not_running[uri.path];
            delete this.#script_running[uri.path];
            vscode.commands.executeCommand('setContext', 'digitaljs.script_running',
                                           Array.from(Object.keys(this.#script_running)));
            vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                           Array.from(Object.keys(this.#script_not_running)));
        }
    }
    scriptStarted(file) {
        delete this.#script_not_running[file];
        this.#script_running[file] = true;
        vscode.commands.executeCommand('setContext', 'digitaljs.script_running',
                                       Array.from(Object.keys(this.#script_running)));
        vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                       Array.from(Object.keys(this.#script_not_running)));
        // The view item doesn't seem to be watching for the context change
        // to redraw the icons so we need to refresh it after updating the running state.
        this.#onDidChangeTreeData.fire();
    }
    scriptStopped(file) {
        delete this.#script_running[file];
        this.#script_not_running[file] = true;
        vscode.commands.executeCommand('setContext', 'digitaljs.script_running',
                                       Array.from(Object.keys(this.#script_running)));
        vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                       Array.from(Object.keys(this.#script_not_running)));
        this.#onDidChangeTreeData.fire();
    }
    toJSON() {
        let res = [];
        const circuit_path = path.dirname(this.circuit.path);
        for (let file of this.sources.values())
            res.push(path.relative(circuit_path, file.path));
        return res;
    }

    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (!element)
            return [new CircuitFile(this.circuit)];
        console.assert(element instanceof CircuitFile);
        let res = [];
        for (let file of this.sources.values())
            res.push(new SourceFile(this.circuit, file));
        return res;
    }
}
