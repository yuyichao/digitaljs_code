//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { run_yosys } from './requests.mjs';
import { Sources } from './sources.mjs';
import { write_txt_file } from './utils.mjs';

const default_synth_options = {
    opt: false,
    transform: true,
    // lint: true,
    fsm: 'no', // (no)/yes/nomap
    fsmexpand: false
};

export class Document {
    #sources
    #extra_data = {}
    #synth_options = { ...default_synth_options }
    #circuit = { devices: {}, connectors: [], subcircuits: {} }
    #tick = 0

    // Events
    sourcesUpdated // fired for all updates
    synthOptionUpdated
    #synthOptionUpdated // not fired for updates from synthesis panel
    circuitUpdated
    #circuitUpdated // not fired for updates from main circuit views

    tickUpdated // from circuit view to other view
    #tickUpdated
    showMarker
    #showMarker
    constructor(doc_uri, data) {
        this.#sources = new Sources();
        this.sourcesUpdated = this.#sources.onChanged;
        this.#load(doc_uri, data);
        this.#synthOptionUpdated = new vscode.EventEmitter();
        this.synthOptionUpdated = this.#synthOptionUpdated.event;
        this.#circuitUpdated = new vscode.EventEmitter();
        this.circuitUpdated = this.#circuitUpdated.event;

        this.#tickUpdated = new vscode.EventEmitter();
        this.tickUpdated = this.#tickUpdated.event;
        this.#showMarker = new vscode.EventEmitter();
        this.showMarker = this.#showMarker.event;
    }
    dispose() {
        this.#sources.dispose();
    }

    // Properties
    get uri() {
        return this.#sources.doc_uri;
    }
    get sources() {
        return this.#sources;
    }
    get tick() {
        return this.#tick;
    }
    set tick(tick) {
        if (tick == this.#tick)
            return;
        this.#tick = tick;
        this.#tickUpdated.fire(tick);
    }
    get synth_options() {
        return this.#synth_options;
    }
    set synth_options(synth_options) {
        // TODO create edit.
        this.#synth_options = { ...synth_options };
    }
    get circuit() {
        return this.#circuit;
    }

    // Loading and saving
    #load_sources(doc_uri, data) {
        if (data.sources) {
            this.#sources.load(doc_uri, data.sources);
            return;
        }
        if (data.source_map) {
            const sources = [];
            for (const name in data.source_map)
                sources.push({ ...data.source_map[name], name });
            this.#sources.load(doc_uri, sources);
        }
        else {
            this.#sources.doc_uri = doc_uri;
        }
        if (data.files) {
            for (const file of data.files) {
                this.#sources.addSource(vscode.Uri.joinPath(doc_uri, '..', file));
            }
        }
    }
    #load(doc_uri, data) {
        this.#load_sources(doc_uri, data);
        delete data.files;
        delete data.source_map;
        delete data.sources;

        if (data.options)
            this.#synth_options = { ...default_synth_options, ...data.options };
        delete data.options;

        this.#circuit = { devices: {}, connectors: [], subcircuits: {} };
        for (const fld of ['devices', 'connectors', 'subcircuits']) {
            const v = data[fld];
            if (v)
                this.#circuit[fld] = v;
            delete data[fld];
        }
        this.#extra_data = data;
    }
    #toBackup() {
        return {
            sources: this.#sources.toBackup(),
            options: this.#synth_options,
            ...this.#circuit,
            ...this.#extra_data,
        };
    }
    #toSave() {
        const [sources, has_fullpath] = this.#sources.toSave();
        if (has_fullpath)
            vscode.window.showWarningMessage(`Saved project contains full path to source file.`);
        return {
            sources: sources,
            options: this.#synth_options,
            ...this.#circuit,
            ...this.#extra_data,
        };
    }
    async saveAs(doc_uri) {
        const origin_doc = this.#sources.doc_uri;
        if (doc_uri)
            this.#sources.doc_uri = doc_uri;
        if (!this.#sources.doc_uri)
            return vscode.window.showErrorMessage('Please select a path to save as.');
        try {
            const str = JSON.stringify(this.#toSave());
            await write_txt_file(this.#sources.doc_uri, str);
        }
        catch (e) {
            const saving_uri = this.#sources.doc_uri;
            this.#sources.doc_uri = origin_doc;
            console.error(e);
            return vscode.window.showErrorMessage(`Saving to ${saving_uri} failed: ${e}`);
        }
        vscode.window.showInformationMessage(`Circuit saved to ${this.#sources.doc_uri}`);
        // Update file list since the main document might have changed.
        this.#sources.refresh();
    }
    save() {
        return this.saveAs();
    }
    async revert(data) {
        this.#load(this.#sources.doc_uri, data);
        this.tick = 0;
        this.clearMarker();
        this.#sources.refresh();
        this.#circuitUpdated.fire(this.#circuit);
        this.#synthOptionUpdated.fire();
    }
    async backup(dest) {
        const str = JSON.stringify(this.#toBackup());
        await write_txt_file(dest, str);
        return {
            id: dest.toString(),
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(dest);
                }
                catch {
                    // noop
                }
            }
        };
    }

    // Actions
    addSources(files) {
        // TODO create edit.
        for (const file of files)
            this.#sources.addSource(file);
        this.#sources.refresh();
    }
    removeSource(file) {
        // TODO create edit.
        this.#sources.deleteSource(file);
        this.#sources.refresh();
    }
    async doSynth() {
        // Load a snapshot of the options up front
        const res = await this.#sources.doSynth({
            optimize: this.#synth_options.opt,
            fsm: this.#synth_options.fsm == "no" ? "" : this.#synth_options.fsm,
            fsmexpand: this.#synth_options.fsmexpand,
            lint: false,
            transform: this.#synth_options.transform,
        });
        if (!res)
            return;
        // TODO create edit.
        this.#circuit = res.output;
        this.tick = 0;
        this.#circuitUpdated.fire(res.output);
        return true;
    }
    processMarker(markers) {
        const editor_map = {};
        const getEditorInfo = (name) => {
            let edit_info = editor_map[name];
            if (edit_info)
                return edit_info;
            const src_info = this.sources.findByName(name);
            if (!src_info)
                return;
            const editor = src_info.findEditor();
            if (!editor)
                return;
            edit_info = { editor, markers: [] };
            editor_map[name] = edit_info;
            return edit_info;
        };
        for (const marker of markers) {
            const edit_info = getEditorInfo(marker.name);
            if (!edit_info)
                continue;
            edit_info.markers.push(new vscode.Range(marker.from_line, marker.from_col,
                                                    marker.to_line, marker.to_col));
        }
        this.#showMarker.fire(editor_map);
    }
    clearMarker() {
        this.#showMarker.fire({});
    }
    updateCircuit(message) {
        // TODO create edit.
        this.#circuit = message.circuit;
    }
}
