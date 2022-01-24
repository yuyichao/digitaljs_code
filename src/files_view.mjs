//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { rel_compat2 } from './utils.mjs';

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
    constructor(doc_dir, uri) {
        let name;
        if (rel_compat2(doc_dir, uri)) {
            name = path.relative(doc_dir.path, uri.path);
        }
        else {
            name = path.basename(uri.path);
        }
        super(name, vscode.TreeItemCollapsibleState.None);
        const uri_str = uri.toString();
        this.iconPath = new vscode.ThemeIcon('file');
        this.id = uri_str;
        this.resourceUri = uri;
        this.contextValue = uri_str;
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
        djs.sourcesUpdated(() => {
            vscode.commands.executeCommand('setContext', 'digitaljs.script_running',
                                           djs.scriptRunning);
            vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                           djs.scriptNotRunning);
            this.#onDidChangeTreeData.fire();
        });
    }

    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (!element)
            return [new CircuitFile(this.#djs.doc_uri)];
        const doc_dir = this.#djs.doc_dir_uri;
        console.assert(element instanceof CircuitFile);
        let res = [];
        for (let [uri_str, info] of this.#djs.sources_entries) {
            if (info.deleted)
                continue;
            res.push(new SourceFile(doc_dir, info.uri));
        }
        return res;
    }
}
