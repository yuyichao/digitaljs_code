//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { run_yosys } from './requests.mjs';
import { hash_sha512, get_dirname_uri, read_txt_file, rel_compat2 } from './utils.mjs';

class SourceInfo {
    // Keeps information about a source file both for input to synthesis
    // and for storing debug info from synthesis result.
    match = undefined
    constructor(uri, name, sha512, deleted) {
        this.uri = uri;
        this.name = name; // display name
        this.sha512 = sha512;
        // A deleted file is one that exists in the compiled circuit
        // but has been deleted from the source
        // (therefore won't be used in the next synthesis)
        this.deleted = deleted;
    }
    // Find the visible that has the same content as the source file when it was synthesized.
    findEditor() {
        if (!this.sha512)
            return;
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
    #toBaseJSON() {
        return { name: this.name, sha512: this.sha512, deleted: this.deleted };
    }
    toBackup() {
        return { uri: this.uri.toString(), ...this.#toBaseJSON() };
    }
    toSave(doc_dir_uri) {
        // Convert file paths to relative path if possible since this will make
        // the project more "portable".
        if (rel_compat2(doc_dir_uri, this.uri))
            return { relpath: path.relative(doc_dir_uri.path, this.uri.path),
                     ...this.#toBaseJSON() };
        return this.toBackup();
    }
    static load(doc_uri, data) {
        if (!data.relpath || !doc_uri) {
            if (!data.uri)
                return;
            return new SourceInfo(vscode.Uri.parse(data.uri),
                                  data.name, data.sha512, data.deleted);
        }
        return new SourceInfo(vscode.Uri.joinPath(doc_uri, '..', data.relpath),
                              data.name, data.sha512, data.deleted);
    }
}

export class Sources {
    #doc_uri
    #doc_dir_uri = false
    // from uri string to source info
    #map = {}
    // from display name to source info
    #name_map = {}
    #textDocChanged
    #onChanged
    #script_running = {}
    #script_not_running = {}
    constructor() {
        this.#textDocChanged = vscode.workspace.onDidChangeTextDocument((e) => {
            const uri_str = e.document.uri.toString();
            const info = this.#map[uri_str];
            if (!info)
                return;
            // Force recompute of matching state next time.
            info.match = undefined;
        });
        this.#onChanged = new vscode.EventEmitter();
        this.onChanged = this.#onChanged.event;
    }
    dispose() {
        this.#textDocChanged.dispose();
    }
    get doc_uri() {
        return this.#doc_uri;
    }
    set doc_uri(uri) {
        this.#doc_dir_uri = false;
        this.#doc_uri = uri;
    }
    get doc_dir_uri() {
        if (this.#doc_dir_uri === false)
            this.#doc_dir_uri = get_dirname_uri(this.#doc_uri);
        return this.#doc_dir_uri;
    }

    // Query
    entries() {
        return Object.entries(this.#map);
    }
    findByName(name) {
        return this.#name_map[name];
    }
    findByURI(uri) {
        return this.#map[uri.toString()];
    }
    // Maintain both the running and not running array since there isn't a "not in"
    // when clause that we can use ATM.
    get scriptRunning() {
        return Array.from(Object.keys(this.#script_running));
    }
    get scriptNotRunning() {
        return Array.from(Object.keys(this.#script_not_running));
    }

    // Add/remove files
    #clearCache() {
        this.#name_map = {};
        for (const [uri_str, info] of Object.entries(this.#map)) {
            if (info.deleted) {
                delete this.#map[uri_str];
                continue;
            }
            info.name = undefined;
            info.sha512 = undefined;
        }
    }
    addSource(uri) {
        const uri_str = uri.toString();
        const info = this.#map[uri_str];
        if (info) {
            info.deleted = false;
        }
        else {
            this.#map[uri_str] = new SourceInfo(uri);
        }
        if (path.extname(uri.path) == '.lua') {
            this.#script_not_running[uri_str] = true;
        }
    }
    deleteSource(uri) {
        const uri_str = uri.toString();
        const info = this.#map[uri_str];
        if (!info)
            return;
        if (!info.sha512) {
            // If we don't have any compiled info for the file, simply delete it
            delete this.#map[uri_str];
        }
        else {
            // Otherwise just mark it as deleted
            info.deleted = true;
        }
        if (path.extname(uri.path) == '.lua') {
            delete this.#script_not_running[uri_str];
            delete this.#script_running[uri_str];
        }
    }
    scriptStarted(uri_str) {
        delete this.#script_not_running[uri_str];
        this.#script_running[uri_str] = true;
        // The view item doesn't seem to be watching for the context change
        // to redraw the icons so we need to do a full refresh
        // after updating the running state.
        // Ref: https://github.com/microsoft/vscode/issues/140010
        this.#onChanged.fire();
    }
    scriptStopped(uri_str) {
        delete this.#script_running[uri_str];
        this.#script_not_running[uri_str] = true;
        this.#onChanged.fire();
    }

    // Save and restore
    toBackup() {
        const res = [];
        for (const key in this.#map)
            res.push(this.#map[key].toBackup());
        return res;
    }
    toSave(doc_dir) {
        const doc_dir_uri = doc_dir ? get_dirname_uri(doc_dir) : this.doc_dir_uri;
        const res = [];
        let has_fullpath = false;
        for (const key in this.#map) {
            const data = this.#map[key].toSave(doc_dir_uri);
            res.push(data);
            if (data.uri) {
                has_fullpath = true;
            }
        }
        return [res, has_fullpath];
    }
    #preLoad() {
        this.#map = {};
        this.#name_map = {};
        this.#script_running = {};
        this.#script_not_running = {};
    }
    #postLoad() {
        for (const uri_str in this.#map) {
            const info = this.#map[uri_str];
            if (info.name)
                this.#name_map[info.name] = info;
            if (path.extname(info.uri.path) == '.lua') {
                this.#script_not_running[uri_str] = true;
            }
        }
    }
    load(doc_uri, data) {
        this.doc_uri = doc_uri;
        this.#preLoad();
        if (!data)
            return;
        for (const item of data) {
            const info = SourceInfo.load(doc_uri, item);
            if (!info)
                continue;
            this.#map[info.uri.toString()] = info;
        }
        this.#postLoad();
    }
    async #withSave(cb) {
        const doc_uri = this.doc_uri;
        const backup = this.toBackup();
        let res;
        try {
            res = await cb();
        }
        finally {
            if (!res) {
                this.load(doc_uri, backup);
            }
        }
        return res;
    }

    // Synthesis
    #basenamesMap() {
        // Sort files by basenames to compute the best short names for the files.
        const basenames_map = {};
        for (const [uri_str, info] of this.entries()) {
            if (info.deleted || path.extname(info.uri.path) == '.lua') {
                info.name = undefined;
                continue;
            }
            let key = path.basename(info.uri.path);
            const files = basenames_map[key];
            if (!files) {
                basenames_map[key] = [info];
            }
            else {
                files.push(info);
            }
        }
        if (Object.keys(basenames_map).length == 0) {
            vscode.window.showErrorMessage(`No source file added for synthesis.`);
            return;
        }
        return basenames_map;
    }
    #prescanSources(basenames_map) {
        // Compute a short version of the file name
        const doc_uri = this.doc_dri_uri;
        for (const basename in basenames_map) {
            const infos = basenames_map[basename];
            if (infos.length == 1) {
                // Unique basename
                infos[0].name = basename;
                continue;
            }
            for (const info of infos) {
                if (rel_compat2(doc_uri, info.uri)) {
                    info.name = path.relative(doc_uri.path, info.uri.path);
                }
                else {
                    info.name = info.uri.path;
                }
            }
        }
    }
    async #loadSources() {
        const data = {};
        const docs = {};
        // These are the potentially modified documents
        // load from here first if they exist.
        for (const doc of vscode.workspace.textDocuments)
            docs[doc.uri.toString()] = doc;
        for (const [uri_str, info] of this.entries()) {
            if (!info.name) // deleted or lua scripts
                continue;
            const uri = info.uri;
            const doc = docs[uri_str];
            const content = doc ? doc.getText() : await read_txt_file(uri);
            info.sha512 = hash_sha512(content);
            data[info.name] = content;
        }
        return data;
    }
    async doSynth(opts) {
        const basenames_map = this.#basenamesMap();
        if (!basenames_map)
            return;
        // If the synthesis failed for some reason, we'll restore the old state
        return this.#withSave(async () => {
            this.#clearCache();
            this.#prescanSources(basenames_map);
            const data = await this.#loadSources();
            let res;
            try {
                res = await run_yosys(data, opts);
            }
            catch (e) {
                const error = e.error;
                if (error === undefined) {
                    console.error(e);
                    await vscode.window.showErrorMessage(`Unknown yosys2digitaljs error.`);
                    return;
                }
                await vscode.window.showErrorMessage(`Synthesis error: ${error}`);
                return;
            }
            this.#script_running = {};
            this.#script_not_running = {};
            this.#postLoad();
            return res;
        });
    }

    // Misc
    refresh() {
        this.#onChanged.fire();
    }
}
