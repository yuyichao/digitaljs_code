//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { hash_sha512 } from './utils.mjs';

class SourceInfo {
    constructor(uri, sha512) {
        this.uri = uri;
        this.sha512 = sha512;
    }
    findEditor() {
        const uri_str = this.uri.toString();
        const editor = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() == uri_str);
        if (!editor)
            return;
        const doc = editor.document;
        // Check the content against the hash and cache the result.
        // The `onDidChangeTextDocument` event handler will clear this
        // when the document changes.
        if (this.match === undefined)
            this.match = this.sha512 == hash_sha512(doc.getText());
        return this.match ? editor : undefined;
    }
    toWorkspace() {
        return { uri: this.uri.toString(), sha512: this.sha512 };
    }
    toCircuit(circuit_dir) {
        // Remove time stamps and convert file paths to relative path.
        return { relpath: path.relative(circuit_dir, this.uri.path), sha512: this.sha512 };
    }
    static fromWorkspace(data) {
        if (!data.uri || !data.sha512)
            return;
        return new SourceInfo(vscode.Uri.parse(data.uri), data.sha512);
    }
    static fromCircuit(circuit_uri, json) {
        if (!json.relpath || !json.sha512)
            return;
        return new SourceInfo(vscode.Uri.joinPath(circuit_uri, '..', json.relpath),
                              json.sha512);
    }
}

export class SourceMap {
    #map
    #reverse_map
    constructor() {
        this.clear();
    }
    entries() {
        return Object.entries(this.#map);
    }
    find(key) {
        return this.#map[key];
    }
    clear() {
        this.#map = {};
        this.#reverse_map = undefined;
    }
    newEntry(key, uri, sha512) {
        const info = new SourceInfo(uri, sha512);
        this.#map[key] = info;
        return info;
    }
    storeMapWorkspace() {
        const res = {};
        for (const key in this.#map)
            res[key] = this.#map[key].toWorkspace();
        return res;
    }
    storeMapCircuit(circuit) {
        const circuit_dir = path.dirname(circuit.path);
        const res = {};
        for (const key in this.#map)
            res[key] = this.#map[key].toCircuit(circuit_dir);
        return res;
    }
    loadMapWorkspace(storage) {
        this.clear();
        if (!storage)
            return;
        for (const key in storage) {
            const info = SourceInfo.fromWorkspace(storage[key]);
            if (!info)
                continue;
            this.#map[key] = info;
        }
    }
    loadMapCircuit(circuit, source_map_in) {
        this.clear();
        if (!source_map_in)
            return;
        for (const key in source_map_in) {
            const info = SourceInfo.fromCircuit(circuit, source_map_in[key]);
            if (!info)
                continue;
            this.#map[key] = info;
        }
    }
    reverseMap() {
        // Compute lazily
        if (this.#reverse_map)
            return this.#reverse_map;
        const map = this.#map
        const reverse_map = {};
        for (const key in map)
            reverse_map[map[key].uri.toString()] = key;
        this.#reverse_map = reverse_map;
        return reverse_map;
    }
}
